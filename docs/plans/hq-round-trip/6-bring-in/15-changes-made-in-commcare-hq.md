# Step 6, part 15: Changes made in CommCare HQ

This part plans what happens after an app is in both places and someone changes it in CommCare HQ.
Today a publish that meets such a change stops and offers two ways on: publish over the change, or
(from part 10) stop publishing there. This part adds the third: bring the change in to Nova. It is
built on two rules. Where Nova holds nothing unpublished, CommCare HQ's changes come in with no
warning and nothing Nova holds is lost, which is the round trip: Nova to CommCare HQ, an edit there,
back to Nova, back to CommCare HQ. Where Nova holds unpublished changes, nothing is merged: the
person reads what changed in CommCare HQ and exactly what taking its version removes from Nova, and
chooses one side whole. The part also closes the one change a person can make in CommCare HQ that
no publish sees today, a picture or sound replaced under an unchanged path, and it adds the one
read Nova makes unasked: a check, after the builder is drawn, of whether CommCare HQ's copy moved.

Another part is cited as "part NN (file name), section N". Citations are `path::symbol`: Nova at
`main` `1f103305`, and the Dimagi checkouts at the pins `proof/pins.json` names: commcare-hq
`d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect
`046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. HQ paths are under `corehq/apps/`
unless a path starts elsewhere; `models/`, `views/` and `util.py` alone are under `app_manager/`.

**Versions.** Nothing here reaches a tool the Solutions Architect holds, a description served to
it, or the authoring guide, so nothing here is a reason for the step's one move of
`lib/models.ts::MODEL_CONTEXT_VERSION` and nothing here adds an entry to `scripts/test-schema.ts`:
the two tools of section 10 are MCP's alone, and `lib/mcp/__tests__/servedSchemas.test.ts` holds
what a client receives. Nothing here changes how Preview runs an app, so nothing here moves
`lib/db/appTests.ts::RUNTIME_VERSION`. It adds three routes under `/api/commcare`, which is on the
main host's allowlist by path segment (`lib/hostnames.ts::HOSTNAME_ALLOWLIST`), so `lib/hostnames.ts`
is untouched. Its DDL is in two places. Part 10's migration holds the baseline's columns
(`10-identity-and-the-ledger.md`, section 11): statement 10 adds `nova_revision`, `media_files`
and the origin `changes`, and statement 10b fills `nova_revision` for the rows a publish already
wrote. One migration of this part's own admits the app change kind (section 4.2).

| Section | Owns |
|---|---|
| 2 | how CommCare HQ's change is computed: the base, the two readings, their shared inputs, the plan in order, what CommCare HQ rewrites by itself, where it runs and what it costs |
| 3 | the pair every comparison stands on: `nova_revision`, and when a deployment has no usable pair |
| 4 | applying it: the one batch, the kind `hq-changes`, open tabs and undo, the ledger and the baseline afterwards |
| 5 | the round trip loses nothing: the property, the take check, every case where it bends |
| 6 | when Nova has unpublished changes: the reference document, both lists and their words, what "Use CommCare HQ's version" does, why nothing puts the changes back |
| 7 | the media file: what identifies a file in CommCare HQ, the record each baseline holds, how a publish, a review and the two lighter reads use it, what "publish over" does to such a file, a deployment with no record |
| 8 | the check when the builder opens, and why it cannot block the builder |
| 9 | the experience: where a person meets it, the two requests, the panel state by state, the publish dialog around it, every stop |
| 10 | MCP: two tools, and what three existing tools gain |

Part 13 (`13-the-experience.md`) keeps the layout of the Publishing card and the publish dialog
(its sections 11.1 to 11.3), the "Stop publishing here" control and its strings. This part owns the
panel, every sentence about a change brought in, and the choices the drift stop gains.

---

## Decisions in brief

1. **CommCare HQ's change is the difference of two readings of two of CommCare HQ's own answers**
   (2.1): the source the baseline stores, and the app as served now, through one reader and one
   identity map. Their difference is ordinary Nova mutations keyed by Nova's UUIDs. Nova's own
   emission is on neither side, so everything CommCare HQ and the reader do to an app cancels.
2. **A stored baseline is read by the reader as it is** (2.2), through two small pure functions and
   no new storage: a form's position token is as good a key into one source as a minted id.
3. **"Nothing unpublished in Nova" means what Nova would publish reads the same as what it
   published** (5.1, P0). A note, a review mark, a persona or a worker property's label changed
   since the publish is nothing CommCare HQ ever receives, so it neither causes a choice nor is
   lost.
4. **Then the mutations are applied to the app as it stands, in one gated batch** (2.5, 4.1).
   Nothing is rebuilt from CommCare HQ's app and nothing else is touched.
5. **Otherwise there is no merge** (6). The person reads two lists and chooses: use CommCare HQ's
   version, publish over it, or stop publishing here. Nova's list names exactly what the first
   choice removes, by place and with every question named, and every line is returned.
6. **One column carries the pair** (3): `app_deployment_baselines.nova_revision`, the revision of
   the Nova app whose document the stored source describes. No identity map is stored (part 10,
   section 10): the map is computed from the document at that revision.
7. **A taken change is one app change of a new kind, `hq-changes`** (4.2), committed at the head
   the person reviewed through `applyBlueprintChange`, the function an autosave commits through,
   so the case schema and the worker rows follow it, with the ledger moved in the same
   transaction. Open tabs reload, which clears their undo history, and say why.
8. **Three narrowing rules keep a change set to what CommCare HQ's app can say** (2.5, 5.2): it
   never deletes or relabels a worker or location property, a translation whose source was
   reworded keeps its text and is marked for review, and no declared case property leaves the
   catalog, so saved case data keeps its definition.
9. **A take check finds a misfit, and the thing CommCare HQ changed then takes the reader's
   spelling** (2.5, 5.2). Taking the change and then reading Nova's document as the reader would
   must give the same document as reading first and taking second. Where Nova's own spelling of
   a menu or a form CommCare HQ changed breaks that, the menu or form takes the reader's
   spelling, which prints the same bytes, and the change is taken. A misfit after that is a
   defect of Nova's, never a limit a person is asked to live with.
10. **A case property renamed in Nova since the reference holds "Use CommCare HQ's version" back**
    (6.3) until it is renamed back, because that rename moved saved case data.
11. **A discard is not undoable and Nova says so** (6.4). The list is the warning, it can be copied
    whole, and no second question is asked.
12. **Every baseline holds which CommCare HQ file stands at each path this app publishes** (7.2):
    `app_deployment_baselines.media_files`, written from CommCare HQ's own report of each media
    upload, from the source at a bring-in, and never from what Nova sent.
13. **A file replaced in CommCare HQ under an unchanged path is a change like any other** (7.4 to
    7.7): it stops a publish, it is listed, bringing it in takes the file, and only a person's
    "publish over" writes Nova's file back. A path Nova holds no record for is settled by the
    file's content before any upload, so no publish writes over a replaced file unseen.
14. **Nova checks CommCare HQ once when the builder opens an app** (8), after the builder is drawn,
    by a plain request no render and no edit waits on. It writes nothing, says nothing where it
    fails, and shows one quiet button where something changed.
15. **A person meets one panel in three places** (9.1): the publish stop, the Publishing card, and
    the button of decision 14.
16. **Bringing changes in is two plain requests with nothing stored between them** (9.2), as
    bringing an app in is (part 12, `12-the-reading-and-the-birth.md`, section 2): a review that
    writes nothing and answers a digest, and a bring-in that computes everything again and acts
    only where its digest is the one sent.
17. **A save in CommCare HQ that changed nothing no longer asks anything** (9.3, S3): Nova records
    what CommCare HQ holds and the publish goes ahead by itself.
18. **What the next publish will write its own way is said before that publish** (2.5, step 13;
    9.4).
19. **MCP gains `read_hq_changes` and `bring_in_hq_changes`** (10). Neither is given to the
    Solutions Architect.

---

## Executed during planning

Read, not run. Nothing here was executed against a database, CommCare HQ or the proof lane.

- **`lib/deployment`**: `CLAUDE.md` ("Baselines", "What the check cannot close", "One publish
  lifecycle", "Placements", "No lock spans the CommCare HQ round trips", "Surfaces");
  `hqSourceBaseline.ts` whole (`normalizeHqAppSource`, `project`, `ownedProjection`,
  `AppChangePart`, `diffHqAppSource`); `remoteChanges.ts` whole; `preflight.ts` (the `target-app`,
  `hq-changes` and `web-apps` edges, `appRemoteChange`, `PreflightResult`,
  `hqAppSourceReadFailure`); `types.ts::AppOwnership`; `service.ts::publishAppToHq` from the
  resource pushes to its return (the second read, the import, the read-back "Before the media
  upload", `recordRemoteResource`, `uploadMediaBytes`); `store.ts` (`recordRemoteResource`,
  `recordCreatedRemoteApp`, `writeAppBaseline`, `readAppBaseline`, `withDeploymentRow`);
  `actions.ts` (`refreshDeploymentAction`, `readDeploymentsAction`, `DeploymentView`).
- **`lib/commcare`**: `client.ts` (`uploadAppMediaBundle`, `pollMediaBundleStatus`,
  `MediaBundleUploadResult`); `multimedia/assetWirePath.ts::wirePathFor`;
  `multimedia/hqJsonExportArchive.ts::bulkUploadAssets`; `multimedia/bulkUploadZip.ts`;
  `lib/media/uploadOutcome.ts`; `lib/domain/mediaRefs.ts::describeCarrier`.
- **`lib/db`**: `types.ts` (`APP_CHANGE_KINDS`, `EDITOR_APP_CHANGE_KINDS`,
  `COLLABORATION_FRAME_KINDS`, `BlueprintMutationAppChangeKind`, `AppChangeDoc`);
  `canonicalCommitKernel.ts` (`CanonicalCommitRequest` and its head test, the dedup latch,
  `CanonicalCommitTransactionHooks` with its `beforeWrite` hook and its `sidecars`, and the
  `removeCaseProperty` loop of `commitCanonicalBatch`); `commitGuard.ts` (`AppHeadMovedError`,
  `MutationBatchIdCollisionError`, `appChangeFingerprintMatches`); `canonicalCommitSidecars.ts`
  (its header: "the closed, typed SQL-only operations"); `applyBlueprintChange.ts` whole;
  `placementAuthority.ts::PLACEMENT_RECORDING_KINDS`; `apps.ts` (`commitGuardedBatch`,
  `commitAppProjectMoveInTransaction`, `appendSyntheticBatchInTransaction` and the replay
  equality of its private `commitPreparedSyntheticBatch`); `classifyCaseTypeChanges.ts` (its
  header); `lib/case-store/postgres/store.ts::applySchemaChangeInTransaction` (its
  `removedProperties` check) and `lib/case-store/errors.ts::CasePropertyHasSavedValuesError`;
  `pg.ts` (`media_assets`: `content_hash`, `extension`, `original_filename`); the migration
  `lib/case-store/migrations/20261110000000_hq_round_trip_case_writes_publish_placement.ts`, whose
  body is the admit routine this part replaces once more.
- **`lib/doc` and `lib/agent`**: `diffDocsToMutations.ts` (`DiffSemanticProvenance`,
  `CasePropertySemanticProvenanceRequiredError`, `diffLocalization`,
  `LocalizationEndpointNotRepresentableError`, and the catalog diff that emits
  `removeCaseProperty` and `retireCaseType`); `casePropertyRenames.ts`
  (`isCasePropertyRenameShapedEndpointDelta`, `invertCasePropertyRenameMutation`);
  `lib/agent/change-set/baseLoader.ts` (`loadCanonicalBlueprintAtSequence`,
  `greatestFoldBaselineSeq`); `lib/domain/users.ts::userDataValuesSchema`;
  `lib/domain/effectiveCaseTypes.ts::effectiveCaseTypes`;
  `lib/commcare/validator/errors.ts` (`USER_PROPERTY_SLUG_DUPLICATE`,
  `LOCATION_PROPERTY_SLUG_DUPLICATE`).
- **The builder**: `components/builder/BuilderProvider.tsx` (its provider tree and lifecycle),
  `LocationRecoveryEffect.tsx` (an effect component that renders nothing), `BuilderHeader.tsx`
  (where `AppNoticeChip` sits), `app-setup/usePublishingRecords.ts`, `PublishDialogBody.tsx`
  (`RemoteChangeChoice` and the `discardRemoteChanges` it fills); `lib/session/store.ts`
  (`deploymentRecordsRevision`, `requestPublishDialog`), `lib/session/hooks.tsx` (the builder
  phase, `useCanEdit`), `lib/session/builderTypes.ts::BuilderPhase`;
  `app/api/apps/[id]/stream/route.ts` (its `reload` event and `containsDisruptiveChange`);
  `lib/collab/reconciler.ts` ("Reload reconciliation") and `ReconcilerProvider.tsx`'s `reload`
  listener.
- **Next.js**: `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, "Sequential
  dispatch on the client": "Next.js dispatches Server Actions one at a time per client. If a user
  triggers three actions in quick succession, the second waits for the first to finish", and for
  parallel work "use a Route Handler for non-mutation requests".
- **The proof lane**: `proof/corpus/documents.ts` (`HqSideSaves`, `HqSideSaveKinds`);
  `proof/observe/hqside.py` (each save through the view a person's save reaches);
  `proof/editors/vellum.py::open_and_save`; `proof/observe/publish.py::upload_media`, which
  every unit whose publish sends a file runs (`proof/observe/unit.py`) and which already reads
  `matched_files` from HQ's own processing of Nova's upload; `proof/hq/operations.py::held_app`;
  `proof/README.md`, "The run started by hand".
- **CommCare HQ, the app**: `models/applications.py` (`ApplicationBase._meta_fields`,
  `ApplicationBase._update_excluded_fields`, which holds `name`, `comment`, `multimedia_map`,
  `build_profiles` and the meta fields; `_merge_source_into_app`, which skips every key of that
  list and then applies its `extra_properties`; `overwrite_app_from_source`, which after the
  merge calls `_update_valid_domains_for_media`; `Application.export_json`;
  `Application.scrub_source`; `Application.set_media_versions`);
  `views/app_import_api.py::_handle_import_app`;
  `util.py::update_form_unique_ids`; `models/base.py::form_id_references`;
  `models/forms.py` (`validation_cache`, a `CachedStringProperty` popped from the form's data); the
  views a lane save reaches, by name: `views/forms.py` (`patch_xform`, `edit_form_attr`,
  `edit_form_actions`, `new_form`, `delete_form`), `views/modules.py` (`edit_module_attr`,
  `edit_module_detail_screens`), `views/apps.py::rearrange`.
- **CommCare HQ, media** (`hqmedia/`): `models.py` (`CommCareMultimedia.file_hash`,
  `generate_hash`, `get_by_hash`, `get_by_data`, `attach_data`, `get_media_info`;
  `HQMediaMapItem` and `gen_unique_id`; `ApplicationMediaMixin.multimedia_map`, `create_mapping`,
  `remove_unused_mappings`, `multimedia_map_for_build`, `get_media_objects`);
  `_design/views/by_hash/map.js`; `tasks.py::process_bulk_upload_zip`;
  `cache.py` (`BaseMultimediaStatusCache.get_response`, `BulkMultimediaStatusCache.get_response`
  and `add_matched_path`); `views.py` (`BaseProcessFileUploadView.process_upload`,
  `ProcessImageFileUploadView`, `ProcessAudioFileUploadView`, `ProcessVideoFileUploadView`,
  `ViewMultimediaFile`); `app_manager/views/app_import_api.py` (`upload_multimedia_api`,
  `multimedia_status_api`).
- **Vellum**: `src/javaRosa/itextWidget.js`, the `defaultLanguage-itext-changed` event and its
  listener.
- **The plan**: parts 05, 10, 12 and 13 at every section this part cites; of part 01 its sections
  6.5 and 9.4; of part 06 its section 2.2; of part 09 its sections 9.1, 12.3 and 14.2; of part 11
  its sections 8.1, 9 and 14.2; of part 14 its sections 6.5 and 12.4 and its Departures.

Facts verified at source that this part leans on:

- **Verified (an update writes the app's name, and no entry of its media map).** `name` and
  `multimedia_map` are in `ApplicationBase._update_excluded_fields`, and `_merge_source_into_app`
  copies a key of the body only where it is not in that list. The name still arrives:
  `_handle_import_app` passes the request's `app_name` as an extra property, which
  `_merge_source_into_app` applies after the merge, and `lib/commcare/client.ts::importApp` sends
  `app_name` on every publish. So a rename in Nova is an ordinary unpublished change, which the
  next publish sends. Nothing of the kind exists for the media map: an update writes none of its
  entries, and only prunes the paths nothing references any more
  (`_update_valid_domains_for_media` reads the media through
  `get_media_objects(remove_unused=True)`, whose `remove_unused_mappings` prunes nothing while
  the app has form errors). So no import of Nova's moves what a path points to.
- **Verified (what identifies a file).** `multimedia_map` is keyed by "the paths to each file in
  the final application media zip" (`jr://file/...`), and each item holds `multimedia_id`, the id
  of one `CommCareMultimedia` document. Every upload finds its document by content:
  `get_by_data(data)` is `get_by_hash(generate_hash(data))`, an MD5 of the bytes, and answers the
  first document of that hash or a new one. `attach_data` stores the bytes under an attachment id
  made from that hash and only where the document does not hold it. So one id is one file's bytes
  for good, and two different files never share an id. The converse has one exception: `by_hash`
  can hold two documents of one hash (part 10, "Executed during planning", reads the same), so two
  ids can be the same bytes.
- **Verified (what a replace under one path changes).** A person's upload over an existing path is
  `BaseProcessFileUploadView.process_upload`: `get_by_data`, `attach_data`, then
  `self.app.create_mapping(multimedia, self.form_path)`. `create_mapping` builds a fresh
  `HQMediaMapItem` with the new document's id, a `unique_id` hashed from the path and that id, the
  document's type, and no `version`, and saves the app. The path's key does not change. Uploading
  the bytes already there finds the same document, so the id does not change.
- **Verified (what an upload through Nova's publish returns).** `process_bulk_upload_zip` matches
  each zip entry to an app path, finds the document by `get_by_data`, calls `attach_data` (which
  returns `True` on every call) and so `create_mapping(multimedia, form_path, save=False)` for
  every matched path, then records `multimedia.get_media_info(form_path, ...)` with
  `status.add_matched_path`, and saves the app once at its end. `get_media_info` holds `path` (the
  app's own spelling of the path), `uid` (the hash) and `m_id`, the document's id.
  `BulkMultimediaStatusCache.get_response` serves them as `matched_files`, a map from media class
  to those entries, in the answer Nova's `pollMediaBundleStatus` already reads `matched_count` and
  `unmatched_files` from. Nova reads neither `matched_files` nor `m_id` today.
- **Verified (the report's id is the id the map holds).** In `process_bulk_upload_zip` one
  `multimedia` object is handed to `create_mapping`, which writes `multimedia._id` as the item's
  `multimedia_id`, and to `get_media_info`, which reports that same `_id` as `m_id`. The app is
  saved once after the loop, inside the `try`: a save that fails marks the status with an error,
  which section 7.8 reads as no entry. So for a report with no error, each `m_id` is the id the
  app's map holds at that `path`. W4 keeps the equality held as the pins move.
- **Verified (the order of a publish).** `publishAppToHq` reads the app back and writes the `push`
  baseline before the media upload, so a baseline's own `multimedia_map` never holds what that
  publish uploaded. The record of section 7 is therefore a column of its own, written after the
  upload settles.
- **Verified (a discard already covers the media map).** `appRemoteChange` sets `observedDigest`
  to the digest of the whole normalized read, and `normalizeHqAppSource` keeps `multimedia_map`. A
  file replaced after a person was shown a stop moves the digest, and the publish asks again.
- **Verified (Server Actions queue in a tab).** The Next.js guide quoted above. A check made as a
  Server Action would hold every other Server Action of the tab behind CommCare HQ's answer, so
  section 8's check is a Route Handler's `fetch`.
- **Verified (the document at a revision is reconstructible at or after the app's greatest fold
  baseline, and not behind it).** `loadCanonicalBlueprintAtSequence` folds the permanent
  `app_changes` from the baseline `greatestFoldBaselineSeq` answers. Part 10's section 10 draws
  the consequence: no identity map is stored.
- **Verified (one function commits a batch and keeps case data's schema current with it).** An
  autosave, an MCP call and a private checkpoint commit through
  `lib/db/applyBlueprintChange.ts::applyBlueprintChange`. It calls `commitGuardedBatch` with a
  `beforeWrite` hook that marks a retired case type's schema inactive in the commit's own
  transaction, and after the commit it syncs each changed case type's schema and each changed
  worker's row. `commitGuardedBatch` alone does neither. Two callers reach it directly:
  `recordPublishPlacements`, for a batch of holds that can change no schema, and a chat run
  (`lib/agent/generationContext.ts`), which goes through `applyBlueprintChange` for a batch that
  retires a case type or renames a property and materializes every other schema when its run
  ends.
- **Verified (a removed case property that holds saved values is refused).** For each
  `removeCaseProperty` of a batch whose property leaves the effective catalog,
  `commitCanonicalBatch` calls `applySchemaChangeInTransaction` with `removedProperties`, which
  throws `CasePropertyHasSavedValuesError` where a case or a set-aside value holds the property,
  and the kernel answers it as a rejected commit. A property that only a question's save gave,
  with no declaration, takes another road: nothing emits `removeCaseProperty` for it, the
  schema sync drops it, and "rows keep the orphaned values" until each row's next write
  (`classifyCaseTypeChanges.ts`'s header). A retired case type's rows are kept and its schema
  marked inactive.
- **Verified (the kernel's hooks).** `beforeWrite` runs inside the commit's transaction after the
  gate has passed and before the batch is written, with the transaction and the sequence the
  commit takes, for "server-owned callers only"; a dedup hit returns before it. `sidecars` are
  "closed, typed SQL-only" arms that live in `lib/db`, and no production module of `lib/db`
  imports `lib/deployment`'s code.
- **Verified (the dedup latch compares the actor).** A batch id already committed answers the
  earlier commit only where `appChangeFingerprintMatches` holds, which compares the mutations,
  the kind, the run and `actorUserId`. Otherwise the kernel throws
  `MutationBatchIdCollisionError`.
- **Verified (a Project move writes a batch, and deployments move with the app).**
  `commitAppProjectMoveInTransaction` appends a `project-move` row that carries `[]` or the
  batch that rewrites every media reference to the destination Project's asset ids
  (`remapAssetRefs`), and re-tenants the app's `app_deployments` rows in the same transaction.

**Unverified, each with what holds it.**

| What is unverified | What holds it |
|---|---|
| That the reader gives one document for a source as read and for the same source after `normalizeHqAppSource` | `baselineSource.test.ts`, over every retained read ("Written and not yet run", W1) |
| Whether any process of CommCare HQ other than a person's save rewrites a working app's source between two reads (a lazy migration on load, for one) | Nothing needs to: such a rewrite either reads as the same document, and is recorded as a save that changed nothing (9.3, S3), or it changed what the app holds, and is listed |
| That the lane's form builder driver can script a label edit as it scripts a save | W3, with the decided fallback |
| Whether a column, a case operation or a link (the three kinds keyed by content and an ordinal; part 10, section 2.2) holds content no reading carries | `notCarried.test.ts` (part 09, section 9.1), which names none today |
| That taking the reader's spelling of a touched menu or form (2.5, step 9) settles every misfit of the take check | W2, which fails on any sample it does not settle |
| The time a review's synchronous pieces take on an app at the cap | `lib/deployment/hqChanges/__tests__/cap.test.ts` ("Tests"), in ordinary CI, as part 12's holds a read |

---

## Written and not yet run

Four checks wait on execution. Each names where it runs and what the session does for every
outcome. None waits on a person and none runs on a laptop.

**W1. A stored baseline reads to the document its read gave.** Where: the work's own CI,
`lib/deployment/hqChanges/__tests__/baselineSource.test.ts` ("Tests").

- **It passes.** Nothing more.
- **It fails on a retained read.** The reader reads a value that belongs to one read (a minted
  form id) into the document. That is a defect of the reader module that owns the slot: the session
  fixes it there, since a document holds no form id by the plan's own decision (the top-level file
  `../6-bring-in.md`, "What changed from the outline, and why", the item "No `Form.xmlns` slot"),
  and the test passes without a change here.

**W2. The round trip over generated documents.** Where: the work's own CI, `plan.fuzz.test.ts`.

- **It passes.** No sample answered `differs`. Nothing more: no rate is recorded anywhere.
- **A sample answers `differs` with check `commutes`.** Taking the reader's spelling of the
  touched menus and forms (2.5, step 9) did not settle it, so a pair's members stopped printing
  alike because of something outside the menu or form CommCare HQ changed. The session widens
  `plan.ts::touchedBy` to hold the entity the shrunk sample shows the pair to depend on (a
  sibling form of a touched menu, say), states the dependency in a comment there and adds the
  sample as a case of `plan.test.ts`. The check itself is never loosened.
- **A sample answers `differs` with any other check, or a throw escapes `planFromDocuments`.** A
  defect: in the reader where two readings of one emission differ, in a canon row where its two
  members do not print alike, in this part's narrowing where a planted thing is lost. The session
  fixes it in the module the shrunk sample names. No class of sample is allowed to fail.

**W3. The round trip through CommCare HQ's own code and its form builder.** Where: the lane, in
the `mechanics` dispatch the session starts for the step's new targeted documents (part 14,
`14-proof.md`, section 12.4), which names this part's ten documents ("Tests", "The lane").

- **Every document holds what it states.** Five checks for a `brings-in` document, and the
  stated outcome for the two that state `proceeds` ("Tests", "The lane"). Nothing more.
- **The driver cannot change a label by scripting the page as a person would.** The session makes
  the edit by calling the form builder's own model of the form in the page (setting the question's
  label for the default language through the builder's own object for that question) and leaves
  the save the builder's own press. The document's `hq-side.json` says which way the edit was
  made. What the builder rewrites on a save is what the document proves, and both ways go through
  that save.
- **A check fails.** A defect in the module the failing check names (the reader, this part's plan,
  the publish). The session fixes it, proves it green where CI can fail it, and dispatches that
  document again.

**W4. CommCare HQ's upload report names the file each path now holds.** It holds at the pin by
reading ("Executed during planning"), so the design does not wait on it. The lane keeps it held as
the pins move. Where: `proof/observe/publish.py::upload_media`, the observation every unit whose
publish sends a file already runs. It gains one hold: after HQ processes Nova's upload, for every
entry of `matched_files`, `held_app(unit, app_id).multimedia_map[entry["path"]].multimedia_id ==
entry["m_id"]`, raised as a named error like its `MediaNotProcessed`. So it runs for
`targeted-hq-changes-media` in W3's `mechanics` dispatch, with no dispatch of its own, and in
every later lane run that publishes a file to CommCare HQ's own code.

- **It holds.** The record of section 7.2 is written from the report, as planned.
- **It does not.** The report is then no witness of the map. The session changes the one source of
  7.2's publish row: `publishAppToHq` makes one more source read after the upload settles
  (`readHqAppSource`, whose `multimediaMap` part 05 types) and writes the record from that map at
  the paths the publish uploaded. The column, its writer, the comparison and every test of section
  7 stand, with the retained answer of that read in place of the report's. The cost is one source
  read per publish that uploads a file, and a window one read wide in which a replace becomes part
  of the record, which `lib/deployment/CLAUDE.md` ("What the check cannot close") then names.

---

## 1. What Nova does today

- **A change in CommCare HQ stops a publish and offers one way on.** `preflight.ts`'s `target-app`
  edge reads the app's source, and `appRemoteChange` compares it with the stored baseline by
  `hqSourceBaseline.ts::diffHqAppSource`. Any part is one `DeploymentRemoteChange`, the verdict
  `hq_changed` lists it by menu and form (`remoteChanges.ts::describeAppChange`), and the person
  ticks "Publish over this". Part 10 adds "Stop publishing here" beside it (its section 8).
- **The comparison is of what Nova writes, and nothing else.** `ownedProjection` reads `modules`,
  each form with its attachment, `name`, `langs`, `application_version`,
  `location_fixture_restore`, `auto_gps_capture` where the ownership holds it, the owned add-ons
  and profile part, and Nova's part of `translations`. It reads no `multimedia_map`, no
  `logo_refs` and no `build_profiles`.
- **A save that changed no value can still stop a publish.** HQ's pages write keys Nova does not,
  and the form builder re-spells XML (`lib/deployment/CLAUDE.md`, "Baselines").
- **A baseline is CommCare HQ's own answer.** `hqSourceBaseline.ts`: "A baseline is always HQ's own
  read, never what Nova sent." It stores `normalizeHqAppSource(source).normalized`: the whole
  answer, each form's XForm included, with each form id replaced by its position token.
- **The baseline and the revision it describes travel together without saying so.**
  `publishAppToHq` writes the app mapping's `pushed_revision` and the `push` baseline in one call of
  `recordRemoteResource`. Nothing else pairs a stored source with a Nova document.
- **Every publish uploads every referenced file, over whatever stands at its path.**
  `uploadMediaBytes` sends `buildMediaBulkUploadZip(prepared.assets)`. Nothing is read of what
  CommCare HQ held there, and the upload's report is read for its counts and its unmatched files
  alone. A file a person replaced in CommCare HQ under that path is written over with no word.
- **Nova reads CommCare HQ only when a person asks.** A publish, Check status, and part 01's
  "Refresh from CommCare HQ" (`01-the-bar-and-the-manifest.md`, section 6.5). Opening the builder
  reads nothing of CommCare HQ.
- **A server-written app change reloads every open tab.** `app/api/apps/[id]/stream/route.ts`
  sends `reload` with the reason `app-changed` for a suffix that holds a kind outside
  `COLLABORATION_FRAME_KINDS`, and the reconciler's reload fetches the committed document, folds
  the tab's unacknowledged edits onto it and clears the undo history.
- **Nova words a change for a person nowhere.** The drift list names where
  (`describeAppChange`), the agent's tool rows name the tool, and no surface words a mutation.
- **A commit from the builder or an MCP client keeps the case schema current, and a publish's own
  commit does not need to.** `applyBlueprintChange` and what it adds to the kernel are in
  "Executed during planning".
- **Nothing reads a baseline back through a reader, and nothing brings a change in.** No reader
  exists on `main` (`lib/commcare/reader` is this step's), and `readAppBaseline` has one caller,
  `preflight.ts`, which reads the source for the publish's comparisons alone. The name
  `hq-changes` is taken today by one thing, the preflight edge that makes that comparison
  (`preflight.ts`, with `hqChangesConfirmedDetail` and its neighbors in `remoteChanges.ts`). The
  app change kind of section 4.2 shares the name and never meets the edge in code: one is a
  member of `APP_CHANGE_KINDS`, the other an edge id of the preflight graph.

---

## 2. How the change is computed

### 2.1 The base

Three bases were possible for "what Nova last left in CommCare HQ".

| Base | What it is | Verdict |
|---|---|---|
| `canonDocument(D_ref)` | Nova's document at the published revision, in the reader's image (part 09, `09-acceptance-and-the-first-publish.md`, section 9) | not exact |
| a re-read of Nova's own emission of `D_ref` | `expandDoc`, then the reader, as acceptance's check 3 does (part 09, section 5) | not exact, for the same reason |
| a reading of the baseline's stored source | CommCare HQ's own answer right after Nova's push, or at the bring-in | chosen |

The first two are not exact because what CommCare HQ holds after a push is not Nova's emission, by
CommCare HQ's own rule and by no defect:

- Nova's publish never writes `logo_refs` (`lib/deployment/CLAUDE.md`, "One publish lifecycle":
  "Publish writes no `logo_refs`"). Against `canonDocument(D_ref)` an app whose logo a person set
  in CommCare HQ would read as "CommCare HQ changed the logo" on every comparison.
- `multimedia_map`, `build_profiles`, `comment` and the rest of `_update_excluded_fields`, the
  name apart ("Executed during planning"), stay CommCare HQ's.
- On an app Nova brought in, a language's display name and each setting the project space holds
  no value for stay CommCare HQ's too (part 01, sections 7.2 and 7.3).
- A baseline whose origin is `cutover` holds whatever CommCare HQ held when it was recorded, edits
  made there before then included (`lib/deployment/CLAUDE.md`, "What the check cannot close").

Two readings of two of CommCare HQ's answers need nothing modeled: whatever CommCare HQ keeps of
its own is in both and cancels. It also means the fixed point `read(emit(D)) = canon(D)` (part
09, section 9; proof 6) is no longer what decides that an unchanged app is unchanged. That is
true by the reader's purity: one function over equal inputs. The fixed point stays what makes a
taken change safe to publish back, and acceptance checks it on the reading of CommCare HQ now
(2.5).

### 2.2 The two readings

```ts
// lib/deployment/hqChanges/readings.ts (new, server-only)
export interface HqChangeReadings {
	/** The reading of the baseline's source. */
	readonly base: Extract<ReadOutcome, { readonly kind: "read" }>;
	/** The reading of CommCare HQ's app now. */
	readonly now: ReadOutcome;
}
```

Both are `lib/commcare/reader/index.ts::readHqApp` (part 06, `06-the-reader-forms.md`, section
2.2). They differ in three arguments and share every other:

| `ReaderInput` | Base reading | Reading now |
|---|---|---|
| `source` | `sourceFromBaseline(baseline.source)` | the source of part 05's bracketed read (`05-reading-commcare-hq.md`, section 8.2), as a bring-in reads it |
| `modules` | `alignedFromSource(source)` | part 05's alignment, with each form's real id and CommCare HQ's question summary |
| `media` | section 7.6's index for the base | section 7.6's index for now |
| `resolver` | `matchingResolver(appId, map)`, a fresh one | `matchingResolver(appId, map)`, a fresh one |
| `appId`, `target`, `lookup`, `organization`, `appStrings`, `recordDialect`, `saveOnlyEditedApplied` | the same values, built once | the same values |

`map` is `externalIdentityMap(D_ref, identity)` (part 10, section 2.5): `D_ref` is section 6.1's
reference document and `identity` is `targetWireIdentity(overrides)` over
`store.ts::readDeploymentIdentityOverrides`, the identity a publish to this deployment sends. So
every entity CommCare HQ still holds under the key Nova published it with carries Nova's UUID in
both readings, and an entity CommCare HQ added is minted UUIDv5 over the app's id and its key
(part 10, section 2.1), the same in both. `D_ref` holds the head's worker properties and location
properties under the slugs they were published with (6.1), so a slug CommCare HQ's change starts
reading binds to the property Nova already holds under that slug, read before or not.
`externalIdentityMap` is total only over a document that holds one entity for each key (part 10,
section 2.5), and `D_ref` can hold two worker or location properties of one slug (6.1, step 3,
"One slug, two properties"). `readings.ts` therefore hands it `D_ref` less the second of such a
pair, the one the published document did not hold, so the slug binds to the published property.

```ts
// lib/deployment/hqChanges/baselineSource.ts (new, pure)
/** Part 05's parse of a source, over a baseline's normalized value. */
export function sourceFromBaseline(normalized: unknown): HqAppSource;
/** One aligned menu per menu of `source`, each form `{ uniqueId, xmlns, source, questions: [] }`. */
export function alignedFromSource(source: HqAppSource): readonly HqAlignedModule[];
```

The reader takes more than a source, and each extra input was checked against what a baseline
holds:

- **The source.** A baseline stores CommCare HQ's whole answer, each form's XForm text included
  (`Application.export_json` puts every attachment's text under `_attachments`), with each form id
  replaced by a position token, the four reference paths of `models/base.py::form_id_references`
  rewritten to the same tokens, and `admin_password` and report config uuids removed.
  `sourceFromBaseline` is part 05's parse over that value: a form's `readUniqueId` is its token and
  its `attachment` the text under `<token>.xml`. A form id in a source is "a key into this read
  only, never an identity" (part 05, section 7, `HqAppSourceForm`), and the tokens are consistent
  keys, so the reader resolves a link or a case list form through them as through a read's own ids.
- **`modules`.** `alignedFromSource` gives the shape part 09's `alignedFromEmission` already gives
  the reader for a source no CommCare HQ summarized (its section 5.1). The reader reads nothing of
  a form's `questions`, and a form's real id is read by part 10's identity rows, never by the
  reader. The base reading's identities are not used: only its document and its facts are.
- **`lookup`, `organization`.** These are the Project's and the deployment's, not the source's,
  and both readings are handed the same ones (2.3).
- **`build_spec`, `multimedia_map`, `logo_refs`.** The baseline's own, since a baseline is the
  whole answer. Nothing is borrowed from the other source.

**The one property this rests on** is W1's: for every retained read under `proof/hq-reads/`, the
reader gives the same document for the source as read and for
`sourceFromBaseline(normalizeHqAppSource(raw).normalized)`.

**Where the base reading is an account.** A baseline of an app Nova published reads clean unless
the Project's data changed under it since (a table or a level the app reads was removed, a column
or a tag renamed), or a deploy changed what Nova holds. Either way there is no base. The review
answers `unavailable`, with the reason `base-needs-project-data` where every finding of the base
reading is at a lookup table or the organization, and `base-unreadable` otherwise (9.5 words the
two apart, because only the second is Nova's to fix).

### 2.3 The inputs both readings share

- **Lookup tables.** The Project's catalog as it stands, bound by tag (`11-project-data.md`). A
  review reached from a publish stop follows that publish's own refresh of the tables managed in
  CommCare HQ (part 11, section 8.1, `reReadManagedTablesForPublish`); one opened from the card
  reads the copies Nova holds and refreshes nothing, because a review writes nothing. Where the
  changed app reads something such a copy lacks, the reading now answers part 11's own findings
  for that table (its section 13) and nothing is taken. A tag the changed app reads and the
  Project does not hold is read from CommCare HQ as a bring-in reads it (part 11, section 5),
  under the ids part 11 derives from the review's `readingId` (9.2). It is in neither reading's
  way, because the base does not read it.
- **Levels.** CommCare HQ's levels as part 11 reads them. The map holds each level by its code, so
  a level keeps its UUID, and both readings are handed the same levels, so no change set names one.
- **Everything else** of `ReaderInput` is built once for the request, as part 12's `gatherFromHq`
  builds it (its section 3.3, step 6.1).

Media is the one input the two readings do not share whole. Section 7.6 gives each its index.

### 2.4 `HQ_READING_DELTA`: a delta that moves no saved rows

`diffDocsToMutations` throws `CasePropertySemanticProvenanceRequiredError` where two documents
differ in a way a case property rename would plan
(`lib/doc/casePropertyRenames.ts::isCasePropertyRenameShapedEndpointDelta`), because endpoint
snapshots cannot decide whether saved rows should move. For a reading the decision is made, and it
is no: a question renamed in CommCare HQ stops writing one property and starts writing another,
CommCare HQ moves no case data for it, and Nova's case rows are Nova's own. So
`lib/doc/diffDocsToMutations.ts::DiffSemanticProvenance` gains a third arm:

```ts
/** The delta is known to move no saved case rows: it is emitted as a removed and an added property. */
export interface NoSavedRowsMoveProvenance {
	readonly movesNoSavedRows: "hq-reading";
	readonly casePropertyRename?: never;
	readonly recordedNonRenameForward?: never;
}
export const HQ_READING_DELTA = { movesNoSavedRows: "hq-reading" } as const;
```

With it the function skips the refusal and runs the ordinary granular diff. What becomes of the
old property's saved values is then decided by the third narrowing rule of 2.5, step 7, because
the kernel refuses a `removeCaseProperty` whose property holds saved values ("Executed during
planning"). A property the app declares keeps its declaration, so its saved values keep their
definition and nothing is shed. A property that only the question's save gave has no declaration
to keep: it leaves the effective catalog, each row keeps its value until that row's next write
sheds it (`lib/db/classifyCaseTypeChanges.ts`: "rows keep the orphaned values"), and the first
of 9.3's case data lines says so to the person. A source-guard test holds the arm to its call
sites in
`plan.ts`. Step 11 of 2.5 may use it because step 10 has already set aside the one delta that does
move rows: a rename made in Nova (6.3).

### 2.5 The plan

```ts
// lib/deployment/hqChanges/plan.ts (new, pure)
export type HqChangePlan =
	/** The readings are one document. */
	| { readonly kind: "nothing"; readonly publishChanges: readonly FirstPublishChangeId[] }
	| { readonly kind: "changes";
	    /** Which document the changes are applied to (step 6). */
	    readonly appliedTo: "head" | "published";
	    /** That document with CommCare HQ's changes applied: the document the app takes. */
	    readonly target: BlueprintDoc;
	    /** `diffDocsToMutations(D_now, target, HQ_READING_DELTA)`. Empty: the app already holds them. */
	    readonly batch: readonly Mutation[];
	    readonly hqChanges: DocumentChanges;    // 6.2, over (the document applied to, target)
	    readonly novaChanges: DocumentChanges;  // 6.2: what the take removes of Nova's changes
	    /** The menus and forms that took the reader's spelling before the changes (step 9). */
	    readonly respelled: readonly Uuid[];
	    /** Case properties the app's effective catalog holds now and the target's does not, on a
	     *  case type the target keeps (9.3, the case data lines). */
	    readonly removedCaseProperties: readonly { readonly caseType: string; readonly name: string }[];
	    /** Case types the app holds now and the target does not (9.3). */
	    readonly removedCaseTypes: readonly string[];
	    /** Case property renames made in Nova since the reference. Not empty: no batch (6.3). */
	    readonly renamedInNova: readonly CasePropertyRename[];
	    readonly publishChanges: readonly FirstPublishChangeId[];
	  }
	/** CommCare HQ's app now holds something Nova cannot hold. */
	| { readonly kind: "account"; readonly findings: readonly Finding[] }
	/** A change Nova names and cannot take as a change (5.3). */
	| { readonly kind: "held"; readonly reason: HqChangeHeld }
	/** A defect of Nova's: the change did not fit, and nothing is taken (9.5, U6). */
	| { readonly kind: "differs"; readonly check: HqChangeCheck; readonly signature: string };

export function planHqChanges(input: {
	readonly reference: Extract<ReferenceDocument, { readonly kind: "ok" }>;  // 6.1
	readonly now: BlueprintDoc;             // the app at the head
	readonly readings: HqChangeReadings;
	/** What part 09's `acceptReading` answered for `readings.now`, in that part's own answer type. */
	readonly accepted: ReturnType<typeof acceptReading>;
}): HqChangePlan;

/** Steps 4 to 12, over four documents. What the fuzz test drives. */
export function planFromDocuments(input: {
	readonly ref: BlueprintDoc; readonly now: BlueprintDoc;
	readonly base: BlueprintDoc; readonly theirs: BlueprintDoc;
	readonly renamesSince: readonly CasePropertyRename[];
}): Exclude<HqChangePlan, { readonly kind: "account" }>;

/** This plan's own checks. */
export const HQ_CHANGE_PLAN_CHECKS = ["apply", "commutes", "replay"] as const;
export type HqChangePlanCheck = (typeof HQ_CHANGE_PLAN_CHECKS)[number];
/** Which check failed: one of this plan's, or one of acceptance's (`ACCEPTANCE_CHECKS`, part 09). */
export type HqChangeCheck = AcceptanceCheck | HqChangePlanCheck;
/** The menus and forms a change set names: see step 9. */
export function touchedBy(doc: BlueprintDoc, mutations: readonly Mutation[]): readonly Uuid[];
```

`CasePropertyRename` (`{ caseType, from, to }`) and `HqChangeHeld` (`"languages-reordered" |
"runs-elsewhere"`, the two changes Nova names and cannot take, which are this part's own and no
finding code) are declared in `lib/publish/hqChangesKinds.ts` ("Copy"), because the sentences
that word them live in `lib/publish`, which imports nothing of `lib/deployment`. This file and
`types.ts` import them from there.

A `differs` plan's `signature` is part 09's `differenceSignature` (its section 14.2) over the
first differing path, with the check as its first segment. That function's `check` parameter
admits `HqChangePlanCheck` beside `AcceptanceCheck`, and `signature.test.ts` there holds that
every signature begins with a member of one list or the other.

`B` and `T` are the documents of the base reading and the reading now. In order:

1. `readings.now.kind` is `account`: the plan is `account` with its findings. Nothing is compared:
   a partial app that publishes back deletes what it did not hold.
2. Acceptance failed on the reading now: `differs`, with acceptance's own check and signature
   (part 09, section 14).
3. Both readings are put under the app's declaration (5.3, "The declaration and the split").
4. `readBackDifferences(B, { doc: T, choices: null })` (part 09, section 9.1) is empty: `nothing`,
   with step 13's list.
5. `H = diffDocsToMutations(B, T, HQ_READING_DELTA)`. A thrown
   `LocalizationEndpointNotRepresentableError` is `held` with `languages-reordered` (5.3). Any
   other throw is `differs` with check `apply`.
6. **The document the changes are applied to.** Nova holds nothing unpublished exactly where
   `documentDifferences(canonK(D_ref), canonK(D_now))` is empty (5.1, P0). Then the changes are
   applied to `D_now`, and `appliedTo` is `head`. Otherwise they are applied to `D_ref`, and
   `appliedTo` is `published`.
7. **`H` is narrowed to what CommCare HQ's app can say**, by three rules (5.2 gives the reason
   for each). The result is `H'`.
   - *Worker properties and location properties.* The reading mints one per slug the app reads,
     with the slug as its label (part 11, section 11.5), and holds no definition. So no
     `removeUserProperty`, `removeLocationProperty`, `updateUserProperty` or
     `updateLocationProperty` is taken, and an add whose UUID the document of step 6 holds is left
     out. An add of a slug Nova does not hold is taken: the question that reads it needs it.
   - *A translation whose source was reworded.* A `setTranslation` whose entries in `B` and `T`
     hold deep-equal `value` differs only because the fingerprint of its source moved. Where the
     document of step 6 holds an entry for that unit, the entry written is that document's own
     with `sourceFingerprint` set to `T`'s and `review` set to `"needs-review"`. Its `value`,
     `origin` and `translatedFrom` stay. Every other `setTranslation` is taken as read.
   - *The case catalog.* No `removeCaseProperty` is taken. A declaration is the definition saved
     case values are held to, and a reading's catalog holds only what the reader derives, so its
     silence about a property is no statement that the property is gone. A `setCaseProperty`,
     which carries a declaration whole, is taken as the document's own declaration with only the
     keys the two readings differ in replaced, so a label Nova holds stays under a type CommCare
     HQ's change moved. A `retireCaseType` is taken: Nova retires a case type nothing uses in its
     own edits too (`lib/doc/caseTypeRetirement.ts`), and a retired type's rows are kept.
8. `target = applyMutations(<that document>, H')`. Where `appliedTo` is `published`, the target
   then takes each case property the head declares and the target does not, on a case type the
   target holds, by one `addCaseProperty` each, placed after the nearest property before it in
   the head's order that the target holds, and first where there is none. Step 11's batch then
   removes no declaration, which is the third rule again for a property Nova declared after the
   publish.
9. **The take check** (5.2) over the document of step 6 and `target`. Where it holds, `respelled`
   is empty. Where it fails, or where step 8's reducers threw or `mutationTargetsInvalid` refused
   the result, the menus and forms CommCare HQ changed take the reader's spelling and steps 8 and
   9 are run once more:
   - `touched = touchedBy(<that document>, H')`: every menu a mutation of `H'` names or orders a
     form of, every form a mutation names or holds a named question of, and every form whose
     place in its menu a mutation moves. A menu brings its lists with it and a form its
     questions. Nothing at the app's level is touched: translations, the case catalog and worker
     setup have their own rules above.
   - in the document of step 6, each touched menu, form and question entity, and each array
     that orders a touched menu's forms or a touched form's questions, is replaced by the same
     entity or array of that document under every `one-wire` row of part 09's canon list (its
     section 9), applied until none changes it. No `not-carried` row is applied, so a purpose
     note stays. Each `one-wire` pair prints the same bytes (part 09's `canon.test.ts`), so the
     app Nova publishes is the same app.
   - `respelled` is `touched`.

   A second failure is `differs`: check `commutes` for the take check, check `apply` for the
   reducers. It is a defect of Nova's (9.5, U6), and W2 holds that no generated change reaches
   it.
10. `renamedInNova` is `reference.renamesSince` where `appliedTo` is `published`, and empty
    otherwise. Where it is not empty, step 11 is not run: the plan holds the lists of step 12 and
    an empty `batch`, and the bring-in refuses it (6.3).
11. `batch = diffDocsToMutations(D_now, target, HQ_READING_DELTA)`, and its replay over `D_now`
    must give `target` exactly (`toPersistableDoc` deep equality, as `lib/db/apps.ts` proves a
    synthetic batch). A throw or a mismatch is `differs` with check `replay`. An empty batch is no
    failure: the app already holds what changed (4.4).
12. The two lists (6.2), `removedCaseProperties` and `removedCaseTypes`: the properties
    `effectiveCaseTypes(D_now)` holds that `effectiveCaseTypes(target)` does not, on a case type
    the target keeps, and the case types `D_now` holds that `target` does not.
13. `publishChanges`: what the next publish would change in CommCare HQ that it would not have
    changed before CommCare HQ's edit. It is the ids of `firstPublishChangesFor` over the reading
    now (acceptance's `AcceptedDeclaration.firstPublish` for the app's declaration, part 09,
    section 12.1), less the ids of the same function over the base reading's facts, built by the
    same builder; less the two ids whose `scope` is `declaration`, which the publish's own Web App
    question asks; less `forms-and-settings-rewritten`, which is spelling alone. The media input
    of the register (`assignMediaPaths`, part 10, section 4.2) is, for the reading now, the files
    CommCare HQ added or replaced (7.6), and for the base none. Two readings of one app differ by
    this list where a person in CommCare HQ set something the reader reads as what Nova writes
    (`location-list-setting-reset`: `location_fixture_restore` is inside
    `hqSourceBaseline.ts::project`'s settings, so it stops a publish, and both readings give one
    document), and where a replaced file takes a path of its own (`media-files-renamed`, 7.6).

**Acceptance runs on the reading now, as on a bring-in.** `acceptReading` (part 09, section 2)
with the app's own declaration as its one choice, the Project's tables as they stand, and the
media of section 7.6. It is what makes "comes in whole" true of a changed app exactly as of a new
one: the changed app is re-emitted and read back, and its identities and CommCare HQ's question
summary are checked.

### 2.6 What CommCare HQ rewrites by itself, and why none of it reads as an edit

| What moves without a person editing the app | Read at | Why it is no change |
|---|---|---|
| Every declared property serialized, `modules` replaced whole, ids written as sent | `_merge_source_into_app`; `hqSourceBaseline.ts` | the baseline is CommCare HQ's answer after it did this |
| A fresh id for every form and report config on every read | `Application.scrub_source`, `util.py::update_form_unique_ids` | normalized to positions in the baseline; a document holds no form id |
| `_id`, `_rev`, `version`, `copy_of`, the short URLs | `ApplicationBase._meta_fields`, deleted by `export_json` | never in a source, so a build or a release moves nothing a source read returns |
| A form's validation result | `models/forms.py`, `validation_cache`, popped from the form's data | not in the document CommCare HQ stores |
| `multimedia_map` after Nova's own media upload | `service.ts::publishAppToHq` ("Before the media upload") | a path Nova publishes resolves by section 7's record, never by the baseline's map |
| `build_profiles` and `comment` kept through an update, and `logo_refs` | `_update_excluded_fields` for the first two. `logo_refs` is not on that list: it stays because `_merge_source_into_app` keeps a key the body leaves out, and Nova's body names the key only to take out an entry whose only key is `path` (`lib/deployment/CLAUDE.md`, "One publish lifecycle") | in both of CommCare HQ's answers alike |
| A save in a CommCare HQ editor that changes no value (re-spelled XML, keys a page writes) | `lib/deployment/CLAUDE.md`, "Baselines" | the two readings are one document: the plan is `nothing` |
| The form builder filling a language's text from the default language's | `Vellum/src/javaRosa/itextWidget.js`, the `defaultLanguage-itext-changed` listener, which rewrites another language only where it equals the default's previous value | a translation equal to its source is no entry in either reading (part 06, section 12.5) |

### 2.7 Where it runs, and what it costs

The comparison is made only where today's check already found a difference. The `target-app` edge
and `diffHqAppSource` stay the trigger: a publish over an unchanged app whose files are all on
record reads nothing new and runs no reader. On a difference, the review (9.2) makes two reader
runs and acceptance's one re-read. Part 05 measured Nova's own parsers over CommCare HQ's starter
apps and allows ten times that for a read (its section 3.3), which puts three passes over an app
of that size well under a second of processing. That figure is carried from that measurement and
is not measured for this path; every answered review logs `checkMs`, `longestPieceMs` and
`sourceBytes` as a read does (part 12, section 10).

**The cap is the bring-in's own, on both sources.** `HQ_BRING_IN_APP_MAX_BYTES` (part 05,
section 3.3) bounds each, before either is parsed:

- *CommCare HQ's app now.* The review reads it as a bring-in does (`readHqAppForReading`), so a
  body over the cap is never parsed and the review answers an account of the one finding
  `too-large` (part 12, section 3.6), drawn as S4 with its own lead (9.3).
- *The baseline's source.* A publish's own read admits a source up to `HQ_APP_SOURCE_MAX_BYTES`,
  four times the cap, so a stored baseline can be larger than a review reads. `AppBaseline`
  gains `sourceBytes`, the row's `source_bytes`, on each arm that holds a source, and the review
  answers `unavailable` with the reason `base-too-large` (9.5, U4) where it is over the cap,
  before `sourceFromBaseline` runs. It is no part of `usablePair`: a later publish does not
  shrink an app, so U1's promise would be false of it.

A review runs pieces no read runs: `sourceFromBaseline` and the second reader pass, `canonK` over
two documents, two diffs, the take check, the replay and the two lists. So it has its own test at
the cap, `lib/deployment/hqChanges/__tests__/cap.test.ts` ("Tests"), which holds each synchronous
piece of a review and of a bring-in under five seconds as part 12's `cap.test.ts` holds a read's.
A failure is cut in the piece that is long, and the cap stands.

Because the trigger is the comparison of what Nova publishes, a change in CommCare HQ to something
Nova's publish never sends and that comparison does not read (the logo, a build profile) stops no
publish and is not looked for. Section 5.3 says what follows.

---

## 3. The pair every comparison stands on

A baseline's source is only useful with the Nova document it corresponds to. A bring-in of
changes has to move the two without a push, so the pair is stored as one fact.

**The one thing stored.** `app_deployment_baselines.nova_revision`, a nullable `bigint` of 0 or
more (part 10, section 11, statement 10, holds its DDL): the revision of the Nova app whose
document this source describes. Null where the source describes no Nova document. Every writer
of this step writes 1 or more, since an app is born at sequence 1 and each commit adds one. The
floor is 0 because the fill below copies `pushed_revision`, whose own floor is 0, the value an
app's sequence starts at (`apps.mutation_seq`, `DEFAULT 0`). Test 4 below says how a 0 is read.

| Baseline origin | `nova_revision` |
|---|---|
| `push` | the sequence the publish emitted and sent (the value `publishAppToHq` passes as `pushedRevision`) |
| `read` (a bring-in of the app; part 10, section 6.3) | the birth's sequence |
| `changes` (new, 4.4: a bring-in of changes) | the sequence of the `hq-changes` commit, or the reviewed head where the app already held the changes |
| `create`, `unread`, `cutover` | null |

`app_deployment_resources.pushed_revision` keeps its meaning (the last push) and no reader of it
changes. The column is on the baseline row, and is no overloading of `pushed_revision`, because a
bring-in of changes is not a push, and one row write then moves the source and the revision
together. `AppBaseline` and `AppBaselineWrite` gain `novaRevision: number | null`, and both admit
the origin `changes` (and `storedOrigin` admits it), in the statement that admits `read`.

**Rows written before this step.** Statement 10b of part 10's migration (its section 11, which
holds the SQL) fills the column for every row whose origin is `push` from the live app mapping of
the same deployment and the same `remote_app_id`, where that mapping's `pushed_revision` is not
null. The pairing holds for those rows because one transaction wrote both. Rows of any other
origin stay null. It replays over its own result and migrates no document. The column's CHECK
admits every value that copy can produce, a `pushed_revision` of 0 included (part 10, section
11, the table of what each statement reads).

**When there is a usable pair.** A bring-in of changes is offered only where all hold:

1. the baseline holds a source (origin `push`, `read` or `changes`) that still verifies
   (`store.ts::readAppBaseline`);
2. its `nova_revision` is not null;
3. for a `push` baseline, `nova_revision` equals the live app mapping's `pushed_revision`;
4. the app has a fold baseline, and `nova_revision` is at or after the greatest one
   (`greatestFoldBaselineSeq`, which answers null for an app with none).

Test 4 is the whole rule for a `nova_revision` of 0, and no test asks for 1 or more. Every fold
baseline sits at sequence 1 or later: a birth writes its app's at sequence 1, and a cutover's is
admitted only beside the `fold-baseline` change that cutover appended in the same transaction,
at the app's new head (`nova_admit_app_change_fold_baseline_insert`, as
`20261110020000_hq_round_trip_case_writes_fold_horizon` leaves it). So a revision of 0 is behind
every baseline, `loadCanonicalBlueprintAtSequence` could not rebuild the document it names, and
the pair is unusable until the deployment's next publish writes both. `usablePair` compares the
two numbers and holds no special case for 0. A null `foldSeq` is unusable for the same reason:
with no baseline at or before a revision, that loader throws.

`reference.ts::usablePair(baseline, mapping, foldSeq)` is the one function that answers it, for
the publish's `canBringIn` (9.4), the review and section 8's check. `foldSeq` is `number | null`,
`greatestFoldBaselineSeq`'s answer as it stands. Test 3 is what keeps the pair
honest across the deploy: the migration runs while the previous revision serves, and that
revision's publish upserts a baseline's source and the mapping's `pushed_revision` and leaves
`nova_revision` as the fill left it. The two then disagree, the pair reads as unusable, and the
deployment's next publish writes both.

Otherwise the review answers `unavailable` (9.5) and the person has the two choices they have
today. Every such deployment gains a usable pair at its next publish. The tail this bounds: a
deployment whose baseline is `unread` or `cutover`, a shell (`create`), a deployment the previous
revision published during the deploy, and one last published before the app's greatest fold
baseline. Step 6 writes no fold baseline over an app that already exists (a birth writes its
app's first, at sequence one), so the last is only a deployment not published since step 5's
cutover. Three more stops are found only while the review runs: a later `blueprint-migration`
row that does not apply to the reference document (6.1, `nova-updated`), a Project move that
followed a person's change (6.1, `app-moved`), and a stored source over the review's cap (2.7,
`base-too-large`).

**"Refresh from CommCare HQ"** (part 01, section 6.5) keeps `nova_revision` as it is: it rewrites
a source only where nothing Nova writes changed, so the document the source describes is the same
one.

---

## 4. Applying the changes

### 4.1 One batch, through the commit gate

`plan.batch`, where it is not empty, commits through
`lib/db/applyBlueprintChange.ts::applyBlueprintChange`, as an autosave and an MCP call do. It
puts the batch through the canonical kernel, so the whole gate runs over the candidate and an
invalid result cannot exist, and it is the function that keeps what is derived from the document
current with a commit: a retired case type's schema is marked inactive in the commit's
transaction, every changed case type's schema is synced after it, and so is each changed
worker's row ("Executed during planning"). A batch read from CommCare HQ can add a case type, a
property or a worker property, so it needs all three, and Preview would otherwise meet a case
type with no schema.

Two things widen for it:

```ts
// lib/db/canonicalCommitKernel.ts::CanonicalCommitRequest, a third arm shaped as the publish's own
| (CanonicalCommitBase & {
		readonly kind: "hq-changes";
		/** The head the plan was computed at. */
		readonly expectedHeadSeq: number;
  })

// lib/db/applyBlueprintChange.ts::ApplyBlueprintChangeArgs
readonly kind: EditorAppChangeKind | "hq-changes";
/** Required with `hq-changes`, refused with any other kind. */
readonly expectedHeadSeq?: number;
/**
 * Server-owned callers only, and only with `hq-changes`. Runs at the end of this function's own
 * `beforeWrite` hook, in the commit's transaction, with the sequence the commit takes. It must
 * be deterministic and free of network effects, as that hook requires.
 */
readonly inTransaction?: (context: {
	readonly tx: Transaction<AppDatabase>; readonly seq: number;
}) => Promise<void>;
```

The kernel's head test (`AppHeadMovedError`) covers both server kinds: a plan is a function of the
head it read, and at any other head it is not the plan the person reviewed. A gate refusal writes
nothing and is answered with its findings (9.5, G1): the reading passed acceptance, so a finding
here comes from what CommCare HQ's app never carries, most often an automation that reads a
property CommCare HQ's change removed. No batch of this part holds a `removeCaseProperty` (2.5,
step 7), so the kernel's refusal of a removed property that holds saved values is never met.

`batchId` is UUIDv5 over the deployment's id, the review's digest and the acting member's id.
Two requests of one member that carry one digest (a double press, two tabs) and reach the kernel
together converge on its `(app_id, batch_id)` latch, and the second answers the first's commit.
The member's id is in the name because the latch compares the actor: without it a second
member's press would meet `MutationBatchIdCollisionError`. With it, that press meets the head
test, and the bring-in answers `AppHeadMovedError` as `changed` with the review as it now stands.
A request that arrives after the commit, a retry of a lost response included, computes the
review again before it reaches the kernel (9.2), finds the digest moved and answers `changed`
too, with a review that says nothing is left to bring in.

### 4.2 What it is recorded as

A new member of `lib/db/types.ts::APP_CHANGE_KINDS`: `hq-changes`. It joins
`BlueprintMutationAppChangeKind` beside `blueprint-migration`, so `AppChangeDoc`'s
mutation-bearing arm and `PLACEMENT_RECORDING_KINDS` (which `satisfies` that type) admit it, and
it stays out of `EDITOR_APP_CHANGE_KINDS` and `COLLABORATION_FRAME_KINDS`. It carries a nonempty
admitted batch, no run, and the acting member as `actor_id` (a person chose it; it is no system
task). A take whose batch is empty writes no row (4.4).

The admit routine is replaced by one migration,
`lib/case-store/migrations/20261201010000_hq_changes_app_change_kind.ts`, registered in
`migrations/index.ts` after part 10's. Its body is the routine of
`20261110000000_hq_round_trip_case_writes_publish_placement` whole, with `'hq-changes'` added to
the closed set of kinds and one arm for it after the empty-batch refusal:

```sql
IF NEW.kind = 'hq-changes' AND NEW.run_id IS NOT NULL THEN
	RAISE EXCEPTION 'hq-changes app changes carry no run';
END IF;
```

It is `CREATE OR REPLACE`, so it replays over its own result, and it is additive in effect: every
row the revision before writes still passes, and that revision writes no row of the kind. It is
one statement, and replacing a routine takes no lock on `app_changes` or on any other table the
serving revision reads or writes: the trigger that calls the routine is left as it is. So it has
no lock wait to bound, unlike the step's three other migrations (the top-level file, "Migrations
and the deploy"). `down` throws, as that migration's does.

`lib/db/placementAuthority.ts::PLACEMENT_RECORDING_KINDS` gains the kind: where CommCare HQ keeps a
case change is a fact about CommCare HQ, the reader holds each placement as it read it (part 07,
`07-the-reader-cases-menus-lists.md`), and so a batch read from CommCare HQ may change any hold
and its `holdPlacements` entries are recordings (`lib/db/placementRecords.ts::
readRecordedPlacementHolds` reads the kind beside the two it reads today).

It is replayable history like any mutation-bearing row, so `loadCanonicalBlueprintAtSequence`
folds through it and a later comparison's reference can be the revision it wrote.

### 4.3 What open tabs see, and undo

`hq-changes` is not a member of `COLLABORATION_FRAME_KINDS`. The stream route already treats every
other kind as a change that reauthorizes and reloads, and the reconciler's reload already does the
right three things: it fetches the committed document, folds any edit of this tab that has no
receipt yet onto it, and clears the undo history.

Clearing undo is the reason for a reload over a frame. An undo step is a recorded command with its
inverse. After a person chose CommCare HQ's version, a step recorded before the choice would put
an older value back over CommCare HQ's, silently, in the tab of someone who may not have made the
choice.

**The window that stays open.** A tab's history clears when its reload completes, not when the
commit lands. An undo pressed in another tab in between is an ordinary edit made after the
bring-in: an autosave carries no base sequence and lands on the new head
(`app/api/apps/[id]/route.ts`). It is not silent for good: it is a change in Nova, the next publish
sends it, and the next review lists it under Nova. Closing the window would take a lock on the app
while a bring-in runs, which no edit in Nova takes today and this part does not add.

Two small additions make the reload explain itself:

- The stream's `reload` event carries `reason: "hq-changes"`, the row's `batchId` and its
  `actorId` where the suffix that forced it holds a row of that kind (it carries `"app-changed"`
  today).
- `lib/collab/ReconcilerProvider.tsx`'s `reload` listener reads the reason and, for that one,
  shows the toast T1 after the reload (9.6), with the actor named from the presence roster the tab
  already holds.

The tab that made the request reads its own answer and shows the result there (9.3); it knows the
batch id it sent, and shows no toast for that one.

**Private work in a chat or an MCP workspace.** An open workspace's save requires the exact
canonical base sequence and refuses any intervening commit (`lib/agent/change-set/CLAUDE.md`). An
`hq-changes` commit is one more such commit: the save answers its existing conflict and nothing is
lost. No rebase is added for it.

**Undo of the bring-in itself: none.** It is on no tab's history, since a server wrote it. Section
6.4 decides recoverability.

### 4.4 The ledger and the baseline afterwards

One function, `lib/deployment/store.ts::recordHqChangesTaken(tx, input)`, moves the pair. It runs
in one of two transactions:

- where the batch is not empty, the commit's own: the bring-in passes it as
  `applyBlueprintChange`'s `inTransaction` (4.1), so it runs in the kernel's `beforeWrite` hook,
  after the gate has passed and before the batch is written, with the sequence the commit takes.
  A write that fails after it rolls it back with the rest, and a dedup hit never reaches it,
  because the first commit already ran it;
- where the batch is empty (the app already holds what changed), a short transaction of its own
  with no app change, under `store.ts::withDeploymentRow` as every deployment write is. The pair
  it writes names the head the plan read, and the document at a sequence is permanent, so the
  pair stays true whatever is committed after, and the app's head is not fenced.

It is no kernel sidecar. Those are closed arms of SQL that live in `lib/db`, which imports none
of `lib/deployment`'s code ("Executed during planning"), and this record is the deployment
store's own writers (`writeAppBaseline`, part 10's identity and media path writers) over rows the
bring-in built. As a sidecar its SQL would be a second copy of each. The `beforeWrite` hook is
the kernel's seam for a server-owned caller's own writes in the commit's transaction, and it
hands over the same sequence.

It takes the deployment row `FOR UPDATE`, after the app's row, which is the order
`store.ts::withDeploymentRow` takes them in (the kernel holds the app's row by then), carries
`expectedEndings` as every baseline writer does (part 10, section 8.5), and:

1. **Fences.** The baseline row's `source_digest` and `nova_revision` are the ones the plan read,
   and the live app mapping's `remote_id` is the app that was read. Otherwise it throws
   `store.ts::HqChangesBaselineMovedError`, the transaction rolls back, and the request answers
   `changed` with the review as it now stands: a publish landed in between.
2. **Moves the pair.** Upserts the baseline: `source` the normalized source CommCare HQ served for
   this request, `origin: "changes"`, `nova_revision` the commit's sequence (or the reviewed
   head), `observed_by` the actor, no discard, `media_files` as section 7.8 gives it, and
   `ownership` the descriptor the next publish's body would give over that source and the target
   document: `importApplication.ts::hqImportApplication({ prepared, target, compatibility: {
   advisories: [] }, update: { appId, source }, identity, languageNames, seeds }).ownership`,
   with `prepared` the target document's export boundary and `languageNames` and `seeds` what a
   publish over this mapping passes (`"target"` for an adopted mapping, `"nova"` otherwise; part
   01, sections 7.2 and 7.3). It is computed before the commit, as part 10 computes a `read`
   baseline's (its section 6.3). The row's own descriptor would be wrong: `diffHqAppSource`
   compares only what the ownership names (`AppOwnership`: the add-ons, the profile properties,
   `autoGpsCapture`), so a change that brings in something whose emission needs an add-on the
   old descriptor lacks would leave that add-on uncompared, and a later change to it in CommCare
   HQ would be published over unseen.
3. **Records what CommCare HQ added.** For each menu and form of the reading now whose CommCare HQ
   id is not the one its UUID derives (`lib/commcare/wireIdentity.ts`), an identity row, by part
   10's writer and rule (its section 3). Without it the next publish would send a derived id for a
   form a person made in CommCare HQ, and CommCare HQ would hold it as another form with another
   `xmlns`. For each file CommCare HQ added or replaced that Nova now holds, a media path row,
   by 7.6.
4. **Keeps the next publish's list honest.** `first_publish_changes` (part 09, section 12.3)
   takes a list by one rule. Where the row holds a list of kind `first-publish` (an app brought in
   and not yet published), it takes the list acceptance gave this request's reading for the app's
   declaration, kind `first-publish`: the first publish will make every one of those changes over
   the app as it now is. Otherwise, where the plan's `publishChanges` is not empty, it takes those
   ids with the Web App setting the source now holds, kind `next-publish`. Otherwise it is set
   null. Part 09 holds the stored value, whose `of` member says which kind a list is, the writer,
   which takes an explicit `keep` or `set`, and the reader, which answers the list wherever the
   live app mapping names the app it was stored for (its sections 11.1 and 12.3). The publish
   dialog shows the list at the next publish (9.4), and the push ends it, as today.

**A source that reads the same** (the review is `nothing` with the reason `reads-the-same`) is
recorded by part 01's own writer for a read that compared equal,
`store.ts::recordRefreshedAppBaseline`, under its own fence (`comparedDigest`): the source is
replaced, and origin, `nova_revision`, ownership and any stored discard stay, because the
document the source describes is the same one. Its input gains two optional members:
`firstPublish`, item 4's list where `publishChanges` is not empty, and `mediaFiles`, the record
of 7.8 where the review learned an id. That is no new writer. A review that is `nothing` with the
reason `already-here` is the empty batch above: CommCare HQ's source changed and the app already
holds the change, so `recordHqChangesTaken` moves the pair to the reviewed head in its short
transaction.

`app_deployment_resources.pushed_revision`, `pushed_at`, `remote_revision`, the deployment's state
and its phase outcomes do not change in any of the three: nothing was sent, and what a build or a
release holds is observed, never inferred.

**Why the next publish neither stops nor re-sends CommCare HQ's change as Nova's.** The baseline
is now CommCare HQ's source as it stands, so `diffHqAppSource` finds no difference and the
`hq-changes` edge passes. Nova's document holds what CommCare HQ holds, so its emission over that
app reads back as the same app (acceptance proved it for this very source). And the next
comparison's reference is the revision this commit wrote, so what Nova changed "since then" starts
empty.

**A publish already past its preflight.** The publish holds no lock a bring-in can see: its
preflight is folded onto the deployment and its read-back writes the baseline later. A person who
ticked "Publish over this" in another tab can therefore send the earlier document after a bring-in
commits. Followed through: CommCare HQ then holds the earlier document, the publish's read-back
writes a `push` baseline whose `nova_revision` is that earlier sequence, and the pair is
consistent. Nova's document still holds CommCare HQ's change one revision later, so the next
publish sends it back. Nothing is lost on either side. A review made before that publish lists the
change under Nova, which is where it now lives. No fence is added: the deployment row holds no
mark of a publish in flight to fence on.

---

## 5. The round trip loses nothing

### 5.1 The property

Notation. `K` is the entity kinds no reading holds
(`lib/commcare/reader/identity.ts::KINDS_WITH_NO_EXTERNAL_KEY`, part 10, section 2.2: user types,
personas, automations and their parts) with the arrays that order them. `canonK(D)` is
`canonDocument(D)` (part 09, section 9) less `K` and less `appSettings.runsOnlyOn`, which is what
`readBackDifferences` compares (its section 9.1). `B` and `T` are the documents of the base
reading and the reading now. `H = diff(B, T)`, and `H'` is `H` narrowed by 2.5, step 7.

**P0, what "no change in Nova" means.** `canonK(D_ref) = canonK(D_now)`: what Nova would publish
reads the same as what it published. It is deliberately wider than "the two documents are equal".
A purpose note written, a translation reviewed, a persona added, a case property labelled or a
worker property relabelled after the publish changes nothing CommCare HQ ever receives, so it is
no change the round trip could lose, and it must not turn a round trip into a choice.

**P1, nothing changed.** If CommCare HQ's source now equals the baseline's after normalization,
`T = B`, `H` is empty and nothing is committed. True by the reader's purity (part 06, section 2.2,
`readerPurity.test.ts`): equal inputs, equal output.

**P2, exactly the edit.** Every mutation of `H` names an entity or a slot whose value differs
between `B` and `T`. True by `diffDocsToMutations`' contract (patches of only the changed keys),
which its fuzz test holds. `H'` holds no mutation `H` does not, and rewrites only the translation
entries of 2.5's second rule and the declarations of its third.

**P3, lossless.** Under P0, after the commit the app is `D' = D_now` with `H'` applied, and:

- every path of `documentDifferences(D_now, D')` lies in a slot some mutation of `H'` writes, in
  a slot the reducer derives from one (a removed question's place in its parent's order, a
  catalog property a new writer declares), or, inside a menu or form of the plan's `respelled`,
  in a slot a `one-wire` canon row rewrites;
- no mutation of `H'` writes any of these, so each is byte for byte what it was: every entity of
  `K`; `appSettings.runsOnlyOn`; every worker property, location property and level the app
  holds; `Module.purpose` and `Form.purpose` of every menu and form CommCare HQ kept; the `origin`
  and `translatedFrom` of every translation whose text CommCare HQ kept; in the case catalog,
  every declared property of every case type CommCare HQ's app still uses, label included; every
  slot of every menu, form and question CommCare HQ did not change;
- and `canonK(D')` reads as CommCare HQ's app does wherever CommCare HQ changed it (5.2).

**P4, the round trip.** Publishing `D'` back and reading CommCare HQ again gives `T`: Nova to
CommCare HQ, a change there, no change in Nova, back to Nova, back to CommCare HQ, and the app in
CommCare HQ reads as it did after the person's edit.

**Where P3 bends, exactly.** A mutation writes its slot whole, with the reader's value. So Nova's
own content that sits inside a slot CommCare HQ changed is replaced with it. There are five such
cases, 5.3 names each with what the person reads, and none can be closed without publishing a
Nova value over CommCare HQ's edit, which would not be CommCare HQ's version:

1. a translation whose source text CommCare HQ reworded keeps its text and loses its `reviewed`
   mark (it becomes `needs-review`), because nobody reviewed it against the new source;
2. a translation whose own text CommCare HQ changed reads as a person's, reviewed, which is true
   of text a person saved in CommCare HQ, and replaces what Nova held for it, an out-of-date
   entry's older text included;
3. a thing CommCare HQ removed goes with everything Nova held on it (a removed form's purpose
   note, a removed question's review marks). A case property is no such thing: its declaration
   stays, label included (2.5, step 7);
4. a `required` condition Nova holds on a question that names a new case, which Nova's emission
   writes as always required (`create-name-required-is-absent`), is replaced by "always required"
   where CommCare HQ moves the case name to another question, because that is what CommCare HQ's
   app now says of the first one;
5. Nova's own spelling of a menu or a form CommCare HQ changed, where that spelling no longer
   fits the change, is replaced by the reader's spelling of it, which prints the same bytes
   (2.5, step 9): a root of one-screen groups becomes sections, a tile cell kept on a list that
   was no tile goes, a formatting flag kept under a form whose formatting was off goes, a
   registration form's place among its menu's forms becomes last. Each was dormant: it reached
   no export, and CommCare HQ's change is what would have woken it.

### 5.2 The take check, and why `H` is narrowed

The mutations are computed between two documents in the reader's image and applied to a document
that is not in it. For nearly every slot the two agree, because a canon row rewrites a slot only
where both members print the same bytes. The check holds the rest at run time. With `D` the
document the changes are applied to:

```
canonK(apply(D, H'))  equals  canonK(apply(canonK(D), H'))
```

Taking the change and then reading Nova's document as the reader would gives the same document as
reading it first and then taking the change. It is free of the differences that exist by CommCare
HQ's own rules (a logo never sent, a build profile Nova never writes), because both sides start
from `D`.

**Where it fails, the thing CommCare HQ changed takes the reader's spelling.** A failure means
Nova's document and its reading are shaped differently at the very spot CommCare HQ edited: a
`one-wire` pair whose two members printed alike until the change moved what they depend on. Both
members print the same bytes today, so swapping Nova's member for the reader's in the touched
menu or form changes nothing Nova publishes, and after the swap the document is in the reader's
image exactly where `H'` writes. Step 9 of 2.5 does that and checks again. So with nothing
unpublished in Nova the change still comes in with no warning, and what the swap replaced is
dormant content Nova held there (P3, case 5). The swap is made only on a failure: a change that
fits Nova's spelling leaves that spelling alone. A failure after the swap is `differs` with
check `commutes`, a defect of Nova's (9.5, U6) and never a wrong document.

**Why the three narrowing rules exist.** The first two close a case where `H` would write a slot
CommCare HQ's app cannot speak for, and where the take check passes, because both sides agree
under canon. The third closes a case the kernel would refuse.

- *Worker and location properties.* A reading's property is `{ uuid, slug, label: slug }` for a
  slug the app reads. So removing the one question that reads `village` in CommCare HQ would give
  `removeUserProperty`, and Nova's label, its `required`, its choices and every persona's value
  for it (`lib/domain/users.ts::userDataValuesSchema`, keyed by the property's UUID) would go. No
  edit in CommCare HQ's app deletes a worker property: its app holds none. An unread property is
  valid in Nova, so nothing is removed or relabelled.
- *A reworded source.* The reader gives every translation the fingerprint of the current source,
  as a person's and reviewed (part 06, section 12.5), and `diffDocsToMutations.ts::
  diffLocalization` writes an entry whole wherever two entries are not deep-equal. So rewording an
  English label in the form builder, which leaves the French as it is (2.6, last row), would
  rewrite Nova's French entry as reviewed by a person against a sentence nobody showed them.
  Dropping the mutation instead would leave the entry out of date, Nova prints the source for an
  out-of-date entry (`out-of-date-translation-is-absent`), and the next publish would replace
  CommCare HQ's French with English, which breaks P4. Keeping the text, moving the fingerprint and
  marking it for review is the one entry that prints what CommCare HQ holds and says what is true.
- *The case catalog.* A reading's catalog is what the reader derives from one app, and Nova's is
  fuller: it holds labels and properties nothing in the app reads. So a property the changed app
  no longer names would give `removeCaseProperty`, and the kernel refuses that mutation wherever
  a saved case or a set-aside value holds the property ("Executed during planning"): a person
  who had run the app in Preview could bring nothing in, and nothing they could do in the
  builder would clear it. Nova's own rule for such a property is that its definition is kept, so
  the change set keeps it. The catalog is compared as the reader derives it
  (`case-catalog-is-as-read`), so the kept declaration reaches no export and breaks neither the
  take check nor P4.

### 5.3 Every case where the property bends, and what happens

| Case | What happens |
|---|---|
| **A canon row where CommCare HQ did not edit** (any row of part 09's canon list) | Nothing. The slot differs between Nova's document and `B`, but not between `B` and `T`, so no mutation names it and Nova's spelling stays. |
| **A canon row whose pair depends on something CommCare HQ's change moved**: `root-question-lists-are-sections` (a condition added to a group Nova holds as a `fieldList` group and the reader as a section); `dormant-tile-cells` (a list switched to a tile, or a hidden column shown, where Nova holds a tile cell the reader never saw); `plain-flag-under-plain-text-is-absent` (text formatting turned back on in a form whose questions hold flags in Nova); `registration-form-last` (a menu's forms reordered); and any other `one-wire` row whose two members stop printing alike when their menu or form changes | Taken. Where both sides still read alike the change is taken over Nova's spelling. Where they do not, the touched menu or form takes the reader's spelling first and the change is taken over that (2.5, step 9; P3, case 5). The lists show it under that menu or form, which CommCare HQ's change already names. |
| **A column whose content CommCare HQ changed** | Its content is written whole with the reader's spelling (`lib/doc/caseListColumnMutations.ts::columnSnapshotMutations`). Its visibility, its sort and its tile cell are separate writes there, made only where the two readings differ, so a tile cell Nova holds on that column stays. |
| `case-catalog-is-as-read` | A property CommCare HQ's change starts writing is added after its predecessor, which Nova's fuller catalog also holds. A property the changed app no longer names keeps its declaration and its label (2.5, step 7), so cases saved in Nova keep its value under a definition. Every other label and unread property stays. |
| **A case property that only a question's save gave** (no declaration in Nova's catalog), whose question CommCare HQ removed or renamed | There is no declaration to keep. The property leaves the app, each saved case keeps its value until that case is next saved, and the first case data line says so (9.3). It is what removing that question in Nova does. |
| **A case type CommCare HQ's app no longer uses** (a menu's case type changed, or its last menu and form removed) | `retireCaseType` is taken with the change. Nova's saved cases of that type stay in the case store with their values, the type's schema is marked inactive in the commit's transaction (4.1), and no list of the app shows them. The second case data line says so (9.3). Where an automation still names the type, the gate refuses and names it (G1). |
| **A translation whose source CommCare HQ reworded** | P3, case 1. The list counts it under translations to review. |
| **A translation CommCare HQ changed** | P3, case 2. The list counts it under translations changed. |
| Translation rows where CommCare HQ changed neither the text nor its source | Untouched. |
| `unheld-placements-are-held` | A published document holds every placement (`placements.ts::recordPublishPlacements`), so none differs. A hold recorded after the publish is part of the reference (6.1). |
| **An entity CommCare HQ deleted** | `H` removes it, and the reducer's cascade removes what hangs from it (P3, case 3). Where something in `K` still reads it (an automation's criterion on a removed property), the gate refuses the batch and the answer names the finding (9.5, G1); the person edits that in Nova, which is no unpublished change (P0), and checks again. |
| **An entity CommCare HQ added** | It is minted UUIDv5 over the app's id and its key (part 10, section 2.1), added by `H`, and its CommCare HQ ids are recorded (4.4). It arrives with no purpose note and with its texts read as reviewed. |
| **Reordering** | An order is a slot: `H` carries predecessor-based moves and nothing else. For the three kinds keyed by content and an ordinal (a column, a case operation, a link; part 10, section 2.2), swapping two that are equal in content swaps their keys, and reads as each taking the other's values. |
| **A key that changes in CommCare HQ**: a question renamed or moved | One removed and one added, which is what happened to its data in CommCare HQ too. Nova's question is removed with its translation review state; the new one reads as reviewed. A case property it saved to stops being written and another starts (2.4), and no saved rows move. The old property keeps its declaration where Nova's catalog holds one, and where it holds none the first case data line names it. The list says "renamed" nowhere: it says one question was removed and one added. |
| **A question that names a new case, moved in CommCare HQ** | P3, case 4. The question counts as changed in its form's line. |
| **A change inside something Nova generates or folds** (a node Nova's emission adds; an expression part 08 folds back to a typed form) | The reader reads what is there now. Where it still folds, nothing changed. Where it no longer does and Nova can hold what is there, `H` replaces the typed slot with the reader's value, which is CommCare HQ's edit. Where Nova cannot hold it, the reading is an account. |
| **Something Nova cannot hold** | The reading now is an account. Nothing is taken (2.5, step 1; 9.3, S4). |
| **Something the reader reads as what Nova writes** (the register of part 09, section 11: the location list setting, a search filter on today's date, a registration label) | The document does not change for it, so there is nothing to take, and the next publish writes Nova's spelling over it. The person is told before that publish: `publishChanges` (2.5, step 13) is shown in the panel and again in the publish dialog (9.3, 9.4). |
| **Something Nova's publish never sends and the publish's comparison does not read** (the logo, a build profile) | It stops no publish, so no review is made for it. It comes in only in a review some other change caused, and only if no publish and no Refresh re-read the baseline since. Otherwise CommCare HQ keeps its value and Nova its own, and neither writes over the other, as with a logo today. |
| **The app's name** | Changed in CommCare HQ: the publish's comparison reads it (`diffHqAppSource`, the `name` part), so it stops a publish and is taken. Changed in Nova: an unpublished change like any other, since every publish sends the name ("Executed during planning"); it is on Nova's list as "The app's name". |
| **The declaration and the split** | A reading holds no `runsOnlyOn` and offers choices (part 06, section 16.3). Both readings are taken under the app's own declaration. Where `D_ref` holds the questions a date and time split made (the split's first minted UUID is in the document, `lib/domain/datetimeSplitIdentity.ts`), both readings are put under the split choice's mutations before they are compared, so an app brought in with the split and not yet published compares like with like. Where the reading now offers the app's declaration only with a split (CommCare HQ added a date and time question to an app that runs in Web Apps), the reading is taken under it, and `publishChanges` carries the register's own line for the split (part 09, section 11.2), because the next publish makes that change in CommCare HQ. Where it offers the app's declaration not at all, `held` with `runs-elsewhere` (9.5, H2). |
| **The languages reordered, a new first language included** | A reading's source language is its first language (part 06, section 6.3), so a new first language is a new source language, and `diffLocalization` throws `LocalizationEndpointNotRepresentableError` for that in an app with more than one language and for any other reorder: the mutation dialect has no such change (`relabelSourceLanguage`, `addLanguage`, `removeLanguage` and `setDefaultLanguage` exist, and nothing orders languages). `held` with `languages-reordered` (9.5, H1). A language added last, or one removed, is an ordinary change. One added at any other place is held too, because `diffLocalization` appends each added language and then finds the order differs. An order of languages a person can set is model Nova does not hold, and the step 7 outline names it (`../7-rest-of-model.md`, "Settings Nova comes to own"). |
| **A case property renamed in Nova since the reference** | "Use CommCare HQ's version" is not offered until it is renamed back (6.3). Publishing over and stopping stay. |
| **Changes brought in from another project space** | The app is one document and its deployments are several. Changes brought in from project space A are, for project space B, changes made in Nova since B's last publish: B's review lists them under Nova, with the member who brought them in named (6.2), and B's "Use CommCare HQ's version" removes them. That is what the words say, and no line is marked by its source. |
| **Lookup tables managed in CommCare HQ** | No part of the app's change set. At a publish, rows are refreshed and a change to what the app reads stops, under part 11's own rule (its section 8.1), before any of this runs (2.3). |
| **A table the changed app reads that the Project does not hold** | Read from CommCare HQ and created as a copy managed in CommCare HQ, by part 11's create arm (its section 6.4), in a short transaction of its own before the commit. The kernel has no seam between its app lock and its gate, and the gate needs the table's definition. A bring-in that is then turned back leaves a true copy of one of CommCare HQ's tables in Project data, and the next try binds to it by its origin. A tag that meets a Project table of another origin asks the bring-in's own question (part 11, section 7.2; part 13, section 8.5), with the same component and the same field. |
| **A table Nova manages, and places** | Outside this part. Their drift keeps part 11's choices (publish over; "Let CommCare HQ manage it again" on the table's page). |
| **A picture or sound CommCare HQ added under a new path, or replaced under an unchanged one** | A change to the question, menu or list that shows it. Section 7 owns both. |

---

## 6. When Nova has unpublished changes

### 6.1 The reference document, and what counts as a change in Nova

```ts
// lib/deployment/hqChanges/reference.ts (new, server-only)
export type ReferenceDocument =
	| { readonly kind: "ok";
	    /** `D_ref`. */
	    readonly doc: BlueprintDoc;
	    /** The net of the `renameCaseProperties` commands people made after the reference. */
	    readonly renamesSince: readonly CasePropertyRename[];
	    /** The members who changed the app after the reference, by user id. */
	    readonly actors: readonly string[] }
	/** A later `blueprint-migration` row does not apply to the document at the reference. */
	| { readonly kind: "nova-updated" }
	/** The app moved to another Project after a person changed it and before a publish (step 2). */
	| { readonly kind: "app-moved" };

export async function loadReferenceDocument(input: {
	readonly appId: string; readonly novaRevision: number;
	readonly head: { readonly doc: BlueprintDoc; readonly seq: number };
}): Promise<ReferenceDocument>;
```

Where the head's sequence is `novaRevision`, `D_ref` is the head's document and nothing is folded.
Otherwise it is built in three steps.

1. **The published document.** `loadCanonicalBlueprintAtSequence(db, { appId, seq: novaRevision,
   expectedDigest: null })`.
2. **What a server wrote after it.** The rows of `app_changes` in `(novaRevision, head]` are read
   once, with their kind, actor and mutations. Three kinds change the document without being a
   person's edit of the app's content, and each is applied to the document, in sequence order,
   as a fact of the reference. Every other row that carries a batch is one of
   `EDITOR_APP_CHANGE_KINDS` or `hq-changes`, a person's change. A `fold-baseline` row carries no
   batch and cannot lie in the range (section 3, test 4).
   - `publish-placement`: a publish records the holds it carries before it sends, and a stop after
     that keeps the holds (`lib/deployment/CLAUDE.md`, "Placements"); a move a person accepted is
     recorded before preflight runs. Its `holdPlacements` are applied through the reducer, which
     leaves an entry alone where its target is missing (`lib/doc/mutations/placements.ts`), so a
     hold on something made after the publish is not carried onto a document that lacks it.
   - `blueprint-migration`: a repair or a transform a deploy ran over saved apps
     (`lib/db/apps.ts::appendSyntheticBatchInTransaction`). Its batch must apply whole:
     `mutationTargetsInvalid` or a reducer that throws answers `nova-updated`, and the review is
     `unavailable` (9.5, U5). Applying part of a migration could leave a document no version of
     Nova ever held.
   - `project-move`: a move of the app to another Project, which carries `[]` or the batch that
     rewrites every media reference to the destination Project's asset ids ("Executed during
     planning"). The deployment moved with the app, so the range can hold one. Where every row
     of the range before it is one of these three kinds, the reference built so far is the
     document the move was written over, so its batch applies exactly and the reference is then
     in the head's Project: it names the assets the head names. Where a person's row comes
     before it, the batch was written over a document the reference is not: a picture changed
     between the publish and the move would enter the reference as if it had been published,
     and one removed in between was never copied to the new Project. The answer is then
     `app-moved`, and the review is `unavailable` (9.5, U7) until the next publish there.

   Without this step a person who changed nothing would read a list of changes they never made
   (every picture and sound, after a move), "Use CommCare HQ's version" would undo a repair on
   their app, and after a move it would write another Project's asset ids into the app.
3. **What a publish to this app never sends, from the head.**
   - every entity of `K` with its ordering arrays;
   - worker properties, location properties and organization levels: the head's, in the head's
     order, followed by any the published document held that the head no longer does. No reading
     says anything about a definition (2.5, step 7), levels are part 11's and both readings are
     handed CommCare HQ's (2.3), and `K` reads all three by UUID. The ones the head dropped stay
     because the published document's content may still read them. One key is the published
     document's and not the head's: a property's `slug`, where the published document holds the
     property. The slug is what the app's logic reads, so it is sent, and a slug renamed in Nova
     since the publish is an unpublished change like any other. *One slug, two properties:*
     where a property was renamed in Nova since the publish and a property made since then took
     its old slug, `D_ref` holds both under that slug. The slug binds to the one the published
     document held (2.2), which is the one CommCare HQ's app means by it, and the other keeps
     its head slug. A slug renamed in Nova is an unpublished change, so the changes are applied
     to `D_ref`, the target holds both, and the gate refuses the bring-in with that property's
     own finding (`USER_PROPERTY_SLUG_DUPLICATE` or `LOCATION_PROPERTY_SLUG_DUPLICATE`; 9.5,
     G1). Renaming the newer property in Nova clears it;
   - `appSettings.runsOnlyOn`: the declaration keeps its own question at publish (the `web-apps`
     edge), and it makes the way out of `runs-elsewhere` real;
   - `logo`: a publish never sends the logo, so it can be no unpublished change to this app. The
     app's name is not on this list: every publish sends it, so the reference holds the published
     name.

`renamesSince` folds the `renameCaseProperties` commands of the editor rows in order (a rename and
its rename back cancel), and keeps the pairs whose two names differ.

**Nova holds nothing unpublished** exactly where `documentDifferences(canonK(D_ref),
canonK(D_now))` is empty (5.1, P0). Then the changes are applied to the app as it stands, so
nothing a person did in Nova since the publish is discarded, whatever it was. This is the round
trip, and it is why step 3 above is short: it only has to cover what `canonK` would otherwise see.

**Otherwise** the changes are applied to `D_ref`. What goes is everything `D_now` holds beyond it,
the notes and review marks made since the publish included. They are changes to the app in Nova
that taking CommCare HQ's version removes, so they are on the list (6.2). Carrying them across
would need a rule per kind of content for a case where the person is already reading a list and
choosing, and the worker setup, the one thing a discard would leave nothing to fix an app with, is
already carried.

### 6.2 How both lists are worded

Wording each of some hundred mutation kinds would be the largest thing in this part and would read
as a log. The smallest honest wording is by place, from two documents. CommCare HQ's list counts
the questions of a form that changed. Nova's list names each one, because it is the list of
what a choice removes, and a count does not tell a person which of their edits go:

```ts
// lib/doc/documentChanges.ts (new, pure, client-safe)
export type MenuPart = "name" | "case-list" | "case-details" | "search" | "settings" | "note";
export type FormPart = "name" | "settings" | "case-changes" | "after-submit" | "note";
export type AppPart =
	| "name" | "languages" | "settings" | "logo"
	| "case-types" | "worker-properties" | "organization";

/** One question, named as Nova names a question for a person: by its id (see below). */
export interface QuestionRef { readonly uuid: Uuid; readonly name: string }
export interface FormChange {
	readonly uuid: Uuid; readonly name: string; readonly menuName: string;
	readonly state: "added" | "removed" | "changed";
	readonly parts: readonly FormPart[];
	/** Each question once, in the form's order. A count is a list's length. */
	readonly questions: { readonly added: readonly QuestionRef[];
	                      readonly removed: readonly QuestionRef[];
	                      readonly changed: readonly QuestionRef[];
	                      readonly moved: readonly QuestionRef[] };
}
export interface MenuChange {
	readonly uuid: Uuid; readonly name: string;
	readonly state: "added" | "removed" | "changed";
	readonly parts: readonly MenuPart[];
	readonly formsReordered: boolean;
}
export interface DocumentChanges {
	readonly app: readonly AppPart[];
	readonly translations: {
		/** Entries added, removed, or holding another text. */
		readonly text: number;
		/** Entries holding the same text whose review state, origin or source fingerprint differs. */
		readonly review: number;
	};
	/** Differences at a slot that holds a picture or a sound. */
	readonly mediaFiles: number;
	readonly menusReordered: boolean;
	readonly menus: readonly MenuChange[];
	readonly forms: readonly FormChange[];
	/** The number of lines `documentChangeLines` gives for this value. */
	readonly count: number;
}
export function documentChanges(
	before: BlueprintDoc, after: BlueprintDoc,
	/** The differences to word. Default: every difference of the two. */
	differences?: readonly DocumentDifference[],
): DocumentChanges;
```

`documentDifferences` and `DocumentDifference` are part 09's (its section 14.2), declared in
`lib/doc/documentDifferences.ts`: the walk is of two Nova documents and nothing more, this file
words its output, and `lib/doc` may not import `lib/deployment`. Part 09's `signature.ts` imports
them from there.

`documentChanges` files each difference under the entity it lies in: a question under its form
(through either document's parent index), a form under its menu. Each schema key of a menu and of
a form maps to a part through one `satisfies Record<keyof Module, MenuPart | null>` table and its
twin for forms, so a key the schema gains fails to compile until it is placed. `null` is allowed
for one key only, an entity's own `uuid`. Every other key has a part, a held placement included
(an operation's `placement` and a form's `ownClosePlacement` are "what it saves to cases", a
menu's `heldKind` its "settings", a query repeat's `placement` its question changed): the
reference already holds every hold a server recorded (6.1), so a hold never shows as a change in
Nova, and one CommCare HQ's change moved must have a line. At the app's level, `connectType` and
every key of `appSettings` are "settings", and `locationProperties` and the levels are
"organization". A difference whose path ends in a media slot (the slots
`lib/domain/mediaRefs.ts::walkAssetRefs` visits) is filed under its entity as any other and also
counted in `mediaFiles`. Names come from `after`, and from `before` for a removed thing. A
question is listed once, as added, removed, changed or moved. Its `name` is its id, which is how
Nova already names a question for a person (`lib/domain/mediaRefs.ts::describeCarrier`: `field
"{fieldId}"`): it is never blank, it is what both builders show, and a label can hold
references, be long, or be the very thing that changed. A question inside a group or a repeat
is named with the ids above it, joined by "/" (`household/head_name`), since an id is unique
only among its siblings.

**The one definition.** A list has something on it exactly where its `count` is above zero.
`documentChanges.test.ts` holds, over the diff fuzz corpora, that `count` is zero exactly where the
differences given are none. So no path can be discarded without a line.

**The two lists.**

- `hqChanges` is `documentChanges(D, target)`, `D` being the document the changes were applied to.
  It is what bringing them in changes in the app.
- `novaChanges` is what taking CommCare HQ's version removes of what changed in Nova. With
  `changed = documentDifferences(D_ref, D_now)` and `taken = documentDifferences(D_now, target)`,
  it is `documentChanges(D_ref, D_now, lost)`, where `lost` is every difference of `changed` whose
  path is, contains or lies under the path of some difference of `taken`. A change both sides
  made alike is in `changed` and not in `taken`, so it is not listed: it is not lost. Where the
  changes were applied to the head, `novaChanges` is empty by construction.

The sentences are in `lib/publish/documentChangeCopy.ts` (new, client-safe), one function
`documentChangeLines(changes, side: "hq" | "nova"): readonly string[]`. It returns every line. The
lines are one for each menu and form that changed plus a handful for the app, so their number is
bounded by the size of the app and not by the number of edits. No line is cut on the server: a
person must be able to read every place a discard touches, and so must an MCP client.

| Change | Line |
|---|---|
| a menu added / removed | The menu “{name}” was added / The menu “{name}” was removed |
| a menu's parts | The menu “{name}”: {parts} changed, with parts joined by commas and "and": "its name", "its case list", "its case details", "its search", "its settings", "its note" |
| forms reordered in a menu | The menu “{name}”: its forms are in a new order |
| a form added / removed | The form “{name}” in the menu “{menuName}” was added / The form “{name}” in the menu “{menuName}” was removed |
| a form changed, on the CommCare HQ side | The form “{name}” in the menu “{menuName}”: {clauses}, where a clause is "{n} questions added", "{n} removed", "{n} changed", "{n} moved" (singular: "1 question added"), "its name", "its settings", "what it saves to cases", "where it goes after submit", "its note", joined by commas |
| a form changed, on the Nova side | the same line, with each question clause naming its questions: "questions added: {names}", "removed: {names}", "changed: {names}", "moved: {names}" (singular: "question added: {name}"), each name in quotation marks and joined by commas and "and". No name is left out: "The form “Visit” in the menu “Mothers”: questions changed: “edd” and “household/head_name”, its settings" |
| menus reordered | The menus are in a new order |
| app parts | The app's name / The app's languages / The app's settings / The app's logo / The case types / Worker properties / The organization |
| translations, text | {n} translations changed (singular: 1 translation changed) |
| translations, review, on the CommCare HQ side | {n} translations to review, because their source text changed in CommCare HQ (singular: 1 translation to review, because its source text changed in CommCare HQ) |
| translations, review, on the Nova side | Review marks on {n} translations (singular: The review mark on 1 translation) |
| pictures and sounds | {n} pictures or sounds changed (singular: 1 picture or sound changed) |

A menu and a form are named as today's drift list names them (`describeAppChange`: "The form
“{name}” in the menu “{menuName}”"), since these lists take that list's place in the same dialog.

**Who made them.** Under Nova's heading, where `reference.actors` holds anyone but the member
reading: "Some of these were made by {names}." The names are resolved by user id as part 10
resolves `adoptedByName` (through `confirmerNames`); three at most, then "and {n} others". It is
the one fact a person needs before removing a colleague's work, and it costs the actor column of
rows already read.

### 6.3 What "Use CommCare HQ's version" does

Exactly 2.5 with the changes applied to `D_ref`: the app becomes the reference with CommCare HQ's
changes applied, in one commit. Everything Nova's list named is gone from the app, the worker
setup and the declaration stay as they are now, and CommCare HQ's changes are in. There is no
second code path: the no-warning path is the same plan with the changes applied to the head.

**A case property renamed in Nova since the reference.** A rename in Nova moves every saved
case's value to the new name, in the rename's own transaction
(`lib/db/classifyCaseTypeChanges.ts`'s header). Going back to the reference would leave every
saved case holding its value under the new name while the app's questions save and read the old
one again. So where `renamesSince` is not empty, "Use CommCare HQ's version" is not offered. The
panel says which property, and that renaming it back in Nova moves the data back (9.3, R1);
after that the reference's catalog and the app's agree and the choice is offered. Publishing
over and stopping stay as they are.

### 6.4 Why nothing puts the changes back

- **Undoable from the builder: no.** The commit is a server change and every tab's undo history
  clears at the reload (4.3).
- **Recoverable: not from any Nova surface.** The discarded changes stay in `app_changes`, which
  is never pruned, and the document before the commit can be rebuilt from it. But Nova has no
  surface that restores an app to an earlier revision (`scripts/recover-app.ts` repairs a stuck
  status and restores nothing), and this part adds none.
- **Why not here.** Restoring a revision has to decide what the ledger pair becomes (after a
  restore the baseline says CommCare HQ's version is in Nova, and it no longer is), what saved
  case rows do, and what placements do, and those answers are the same for a restore after any
  change, not only this one. A one-off "put my changes back" for this screen would answer them
  badly for one case. The second rule this part is built on is met by the list: the person reads
  every place that goes before choosing, the list can be copied whole (9.3), and the sentence
  under the button says plainly that Nova can't put the changes back. `design/readme.md` asks a
  destructive flow to state what happens and how to undo; this one states what happens and that
  there is no undo, and names the other choice that keeps the changes.

---

## 7. The media file

A picture or sound is the one thing a person can change in CommCare HQ without changing a byte of
what the publish's comparison reads: the app's content names a path, and the file behind the path
is a row of `multimedia_map`, which no update writes and `ownedProjection` does not read. Today
the next publish uploads Nova's file to that path and the person's file is gone from the app, with
no word. This section closes that: the change is seen, it is listed, bringing it in takes the
file, and only a person's choice writes Nova's file back.

### 7.1 What identifies a file in CommCare HQ

`multimedia_map[path].multimedia_id`, by the facts "Executed during planning" reads at source:

- one id is one file's bytes for good, so **the same id at a path means the same file**;
- a person's replace under a path gives the path the id of the new file's document, so **another
  id at a path means another file, with one exception**: CommCare HQ can hold two documents of one
  hash, so two ids can be the same bytes;
- Nova's own upload reports, for every path it matched, the id it mapped there (`m_id`).

So an id is exact for "nothing changed here" and a candidate for "something changed here", and
content settles a candidate. Nova holds each of its files' content hash
(`media_assets.content_hash`, SHA-256, the hash a derived path spells), and a path always carries
the same Nova bytes: a derived path is its file's hash (`assetWirePath.ts::wirePathFor`), and a
held path is one immutable asset's (part 10, sections 4.2 and 4.5: "New bytes never take an old
path"). That is why a record of path to id is the whole record, with no hash beside it.

### 7.2 What Nova stores

`app_deployment_baselines.media_files`, a nullable `jsonb` held to a JSON object (part 10,
section 11, statement 10, holds its DDL): for each path this app publishes to the deployment,
CommCare HQ's id of the document Nova knows to hold this app's file there.

```ts
// lib/deployment/hqMedia.ts (new, pure, client-safe)
/** Wire path (CommCare HQ's path without `jr://file/`) to CommCare HQ's id of the file there. */
export type HqMediaRecord = Readonly<Record<string, string>>;
/** Keys pass part 10's `isHoldableWirePath`; values match `^[\w-]+$`, part 05's rule for an id. */
export const hqMediaRecordSchema: z.ZodType<HqMediaRecord>;
```

`lib/db/pg.ts::AppDeploymentBaselinesTable` types it `JSONColumnType<Readonly<Record<string,
string>>> | null`. `AppBaseline` gains `mediaFiles: HqMediaRecord | null` on every arm
(`readAppBaseline` parses the column with `hqMediaRecordSchema`; a value that fails the parse is
logged at error with the deployment's id and read as null, since Nova wrote it). Null means Nova
holds no record for this deployment. An entry that is absent means Nova holds no record for that
path. An app publishes at most `MAX_MEDIA_EXPORT_ASSETS` files (500), so the value is at most a
few tens of kilobytes.

It is on the baseline row because it is the same kind of fact as the source beside it: what Nova
last knew CommCare HQ to hold. It is a column of its own, and no reading of the stored source's
`multimedia_map`, because the read-back that writes the source precedes the upload ("Executed
during planning").

`AppBaselineWrite` gains `readonly mediaFiles: { readonly kind: "keep" } | { readonly kind: "set";
readonly files: HqMediaRecord | null }`. `writeAppBaseline`'s insert writes the files of a `set`
and null for a `keep`. Its conflict arm writes a `set` as given, and for a `keep` keeps the row's
value where the HQ app is the same and writes null where it is another app. Section 7.8 says which
maker passes which.

### 7.3 A path's standing, and settling it by content

```ts
// lib/deployment/hqMedia.ts
/** One file this app publishes to a deployment. */
export interface PublishedMediaFile {
	readonly wirePath: string; readonly assetId: MediaAssetId;
	readonly contentHash: string; readonly kind: AssetKind;
}
export type HqMediaStanding =
	/** CommCare HQ maps no file at the path, or maps an entry with no id. */
	| "absent"
	/** The id there is the one the record holds: this app's file. */
	| "recorded"
	/** The record holds another id for the path. A candidate. */
	| "moved"
	/** Nova holds no record for the path. A candidate. */
	| "unrecorded"
	/** Settled by content: the file there is not this app's. */
	| "replaced";
export interface HqMediaPath extends PublishedMediaFile {
	/** CommCare HQ's entry at the path now, where it names a file Nova can ask for. */
	readonly hq: { readonly mediaType: HqMediaType; readonly multimediaId: string } | null;
	readonly standing: HqMediaStanding;
}
/** How many paths of `record` hold another id in `now`. Pure, and needs no document (7.5). */
export function movedRecordedPaths(
	record: HqMediaRecord | null, now: readonly HqMediaMapItem[],
): number;
/** Whether any of `paths` holds another id, or an entry on one side only, in the two maps (7.4). */
export function mediaMovedBetween(
	first: readonly HqMediaMapItem[], second: readonly HqMediaMapItem[],
	paths: readonly string[],
): boolean;
/** The standing of every published file against one source read. Pure: no fetch. */
export function hqMediaStandings(input: {
	readonly published: readonly PublishedMediaFile[];
	readonly record: HqMediaRecord | null;
	/** `HqAppSource.multimediaMap` of the read being judged (part 05, section 7). */
	readonly now: readonly HqMediaMapItem[];
}): readonly HqMediaPath[];
```

`published` is each asset `bulkUploadAssets(doc, assets)` returns, at the wire path the resolved
manifest gives it (`heldPaths.get(id) ?? wirePathFor(contentHash, extension)`, part 10, section
4.3). The logo is not among them: a publish never sends it. An entry part 05 reads as `unreadable`
at a published path (an id or a type Nova cannot ask for) is `replaced` at once: Nova's own upload
never writes such an entry.

```ts
// lib/deployment/hqMediaSettle.ts (new, server-only)
export type SettledHqMedia =
	| { readonly kind: "settled";
	    /** Every path, with no `moved` and no `unrecorded` among those asked for. */
	    readonly paths: readonly HqMediaPath[];
	    /** Candidates found to hold this app's bytes: path to the id that holds them. */
	    readonly learned: HqMediaRecord }
	| { readonly kind: "failed"; readonly failure: CommCareApiError };
export function settleHqMedia(
	creds: CommCareCredentials, paths: readonly HqMediaPath[],
	options: { readonly cancel?: AbortSignal },
): Promise<SettledHqMedia>;
```

It asks CommCare HQ for the file of each `moved` and each `unrecorded` path through part 05's
`readHqMediaFile(creds, mediaType, multimediaId, { maxBytes: ASSET_SIZE_CAPS_BYTES[kind], cancel
})` (its section 9), inside that section's window (four at once, 64 MiB in flight), once per id,
and hashes the bytes with SHA-256:

| The answer | The path becomes |
|---|---|
| bytes whose hash is the asset's `contentHash` | `recorded`, and `learned` gains the path with that id |
| bytes of another hash | `replaced` |
| `too-large` | `replaced`: a file over Nova's limit for the kind is not this app's |
| `missing` | `absent`: the map names a document CommCare HQ no longer serves, and an upload puts the file back |
| a failure after part 05's one resend | the whole answer is `failed` |

Nothing of a fetched file is kept: it is hashed and dropped. `failed` is never read as "nothing
changed": `lib/deployment/CLAUDE.md` names treating "could not ask" as "there are none" as the one
reading that turns a permissions problem into somebody's data being overwritten.

### 7.4 A publish

`preflight.ts`'s `target-app` edge, after its source read, its normalization and the floor, and
only where the publish updates an app that holds content (a shell holds no file):

1. `hqMediaStandings` over the prepared files, the stored baseline's `mediaFiles` and the read's
   `multimediaMap`. A read whose `multimediaMap` is null, for an app that publishes a file, blocks
   as an unreadable `profile` does (`hq_app_state_unknown`): CommCare HQ serializes the map on
   every app (part 05, section 7), so a missing one is an answer Nova cannot read.
2. Where any path is `moved` or `unrecorded`, `settleHqMedia`. `failed` blocks the edge with
   `hq_app_state_unknown` and a sentence of its own, `preflight.ts::hqMediaReadFailure(failure,
   domain)`: nothing was sent. `hqAppSourceReadFailure` is not reused, because its sentences
   are about the app ("Check that the app still opens in CommCare HQ") and its input is a source
   read's failure. For a 401 or a 403: "Nova couldn't read a picture or sound this app publishes
   on “{domain}”, so it left that app unchanged. Reading it needs permission to edit apps in
   CommCare HQ. You can check the connected account, then publish again." For any other
   failure: "Nova couldn't read a picture or sound this app publishes on “{domain}”, so it left
   that app unchanged. Nova checks each one before it sends this app's own over it. You can
   publish again in a moment."
3. `appRemoteChange` hands the count of `replaced` paths to `diffHqAppSource`, whose input gains
   `readonly mediaChanged?: number` and whose `AppChangePart` gains `{ readonly kind: "media";
   readonly count: number }`: one part where the count is above zero. It is compared like every
   other part: not for a shell, and not where the baseline is unknown (that change already stops
   with no parts).
4. The settled paths and `learned` ride to the publish as a new member, `media`, of the `ready`
   arm of `preflight.ts::PreflightResult`, for 7.8.

So a replaced file stops the publish with `hq_changed` before anything is sent, as an edited form
does. The publish that proceeds uploads what it uploads today: every stop a person could decide
differently is before the upload, and the upload is the one write that can put Nova's file over
another.

`publishAppToHq`'s second read (after a table or a place was pushed) compares the two reads' ids
at the published paths, `hqMedia.ts::mediaMovedBetween(first, second, paths)`, beside its
`diffHqAppSource`: a path whose id moved while the Project data went stops at `upload` with
`HQ_CHANGED_DURING_PUSH_MESSAGE`, as a moved form does.

**What it costs.** A publish over an app whose files are all on record makes no new request: the
map is in the source it already reads. A `moved` path costs one file. A deployment with no record
costs one request per file, once (7.10).

### 7.5 Refresh, and the check when the builder opens

Part 01's `refreshKeptValues` (its step 6) and section 8's check hold no document and fetch no
file. They pass `diffHqAppSource` the count `hqMedia.ts::movedRecordedPaths(record, now)` gives:
the paths of the baseline's record whose id in the read's map is another id. So a file whose id
moved is a part, Refresh answers `changed-in-hq` and the check answers that the deployment
changed; a path with no record is none. Where the review that follows settles a `moved` path as
this app's own bytes (two documents of one hash), it answers `nothing` with the reason
`reads-the-same` and records the id (9.2; 9.3, S3), so the same path never asks twice.

### 7.6 A review and a bring-in

The review computes the standings over the files `D_ref` publishes, the baseline's record and the
source now, and settles `moved` and `unrecorded` as a publish does. The two readings then take
their media index (`ReaderMediaIndex`, part 11, section 14.2) by these rules, per path a source
references:

| The path | Base reading | Reading now |
|---|---|---|
| one this app publishes, standing `recorded` or `absent` | that asset | that asset |
| one this app publishes, standing `replaced` | that asset | CommCare HQ's file there now |
| any other path with an entry in the source's `multimedia_map` | the file the baseline source's own map names there, fetched by that id. `missing` reads as `no-entry`: CommCare HQ no longer serves the file the baseline named | the file the current map names there |
| a path with no entry | `no-entry` | `no-entry` |

"CommCare HQ's file" is fetched and judged as a bring-in judges a file (part 11, section 2.2,
`judgeReadingMedia`), and named by its provisional id until it is published (part 12, section
2.3). The first row is what keeps Nova's own upload from reading as CommCare HQ's edit: a
baseline's map lags Nova's own files, and an upload that failed leaves CommCare HQ without a file
Nova holds, and neither is a change a person made. The second row is the closed gap: the slot that
shows the file differs between the two readings, so `H` holds a mutation for it, the lists show it
(7.7), and the round trip carries it.

A file Nova cannot hold (over its limit, bytes `lib/media` refuses, a kind no platform the app
runs on plays) makes the reading now an account, by part 11's own findings (its section 2.4), and
nothing is taken.

A bring-in publishes each added and replaced file to the Project's library once its digest has
passed and before the commit, as a create does (part 12, section 6.1; a file whose bytes the
Project already holds is that asset). Then, in `recordHqChangesTaken` (4.4, item 3):

- `assignMediaPaths` (part 10, section 4.2) runs over those files, each under the path CommCare
  HQ holds it at. A kept path becomes a media path row of the deployment. Where another asset of
  the deployment holds that path, which is the replaced file's own asset at a held path, that row
  is deleted first: a row is never updated (part 10, section 3.2), and the document no longer
  shows that asset at that path.
- A path the assignment does not keep takes its file's derived path. The one such case this flow
  makes ordinary is a file replaced under a path in Nova's own derived shape: the path spells the
  old file's hash, so it "names another file" (part 10, section 4.2, step 3). The new file takes
  the path of its own hash, the next publish moves the reference there, and CommCare HQ drops the
  old path once nothing names it. That is the register's entry `media-files-renamed`, and
  `publishChanges` carries it (2.5, step 13), so the person reads it before that publish.

### 7.7 What the person is shown

- **In the panel** (9.3), a replaced or added file is a change of the place that shows it, by
  6.2's wording ("The form “Visit” in the menu “Mothers”: 1 question changed"), and the list's
  last line counts the files: "1 picture or sound changed". Nova's own list counts its own the
  same way.
- **At a drift stop that lists parts** (where the review is not offered, 9.4),
  `remoteChanges.ts::describeAppChange` words the new part: "A picture or sound this app
  publishes" for one, "{n} pictures or sounds this app publishes" for several.
- **On the Publishing card**, Refresh's sentence for a change is C1 (9.6), whatever changed.

### 7.8 The record after each write

```ts
// lib/deployment/hqMedia.ts
/** For each published path: the id CommCare HQ reported, else one learned by content, else the
 *  previous record's. A path with none of the three has no entry. */
export function nextHqMediaRecord(input: {
	readonly published: readonly PublishedMediaFile[];
	readonly previous: HqMediaRecord | null;
	readonly learned: HqMediaRecord;
	readonly reported: HqMediaRecord;
}): HqMediaRecord;
/** Each kept path's id in the source a bring-in read its files from. */
export function hqMediaRecordFromSource(
	wirePaths: readonly string[], map: readonly HqMediaMapItem[],
): HqMediaRecord;
```

| Write | `mediaFiles` |
|---|---|
| a publish's read-back (`push`), before the upload | `keep`: what Nova knew of each path is still true |
| after the upload settles | `store.ts::recordDeploymentMediaFiles` (below), with `reported` from the upload's own report |
| the empty app a first publish makes (`create`) | `set`, null: a new HQ app holds no file |
| a read-back that failed (`unread`) | `keep` |
| a bring-in of the app (`read`; part 10, section 6.3) | `set`, `hqMediaRecordFromSource` over the media path rows the birth writes and the source the create accepted: each kept file was fetched by that entry's id |
| a bring-in of changes (`changes`; 4.4) | `set`, `nextHqMediaRecord` with `learned` the review's, plus each added and replaced file's kept path under the id it was fetched by, and nothing reported |
| a read that compared equal (Refresh; a `nothing` review) | `keep`, or for a review that learned an id, `set` with `nextHqMediaRecord` over the previous record and `learned` |

`lib/commcare/client.ts::MediaBundleUploadResult` gains `matchedFiles: readonly { readonly path:
string; readonly multimediaId: string }[] | null`: every entry of `matched_files`, across its
classes, whose `path` and `m_id` are strings, with `multimediaId` held to `^[\w-]+$`. Where
`matched_files` is not the shape read at the pin it is null, logged at warn, and the upload's
outcome stands as today: a report Nova cannot read for ids is no failed upload.

```ts
/** `lib/deployment/store.ts`. Writes the record a publish's upload earned. `edit`. */
export async function recordDeploymentMediaFiles(
	scope: DeploymentScope, target: DeploymentTargetKey,
	input: { readonly remoteAppId: string;
	         /** The digest of the baseline this publish wrote. */
	         readonly sourceDigest: string;
	         readonly files: HqMediaRecord; readonly expectedEndings: number },
): Promise<void>;
```

`publishAppToHq` calls it after `uploadMediaBytes`, with `nextHqMediaRecord` over the files it
published, the baseline's previous record, preflight's `learned`, and `reported`: the matched
files' ids by path where the upload completed with no error and `matchedFiles` is not null, and
nothing otherwise (an upload that failed, timed out or reported errors earns no entry). An app
that publishes no file writes `{}`. Inside `withDeploymentRow` it writes only where the baseline
row still names that app and that digest; a later publish's baseline is left alone, and that
publish writes its own. A failed read-back writes an `unread` baseline with a null digest, and the
record is then written against the row's `remote_app_id` alone.

### 7.9 What "publish over" does to such a file

The app's change in the `hq_changed` refusal is one item with one "Publish over this", and a
replaced file is one of its parts. The discard names the app back with `observedDigest`, the
digest of the whole normalized read, which holds `multimedia_map`: a file replaced again after the
person was shown the stop moves the digest, and the publish asks again.

A publish that proceeds over the discard uploads every file as today, Nova's file at the replaced
path among them. CommCare HQ's `create_mapping` assigns the path to Nova's file's document. It
deletes no document: the file a person uploaded stays in CommCare HQ's media library, and the app
no longer points at it. The upload's report then gives the path Nova's id, and 7.8 records it. The
panel's sentence under that choice says what it does to CommCare HQ's version whole (9.3), files
included.

**Part 10's fallback for held paths, if it is ever written.** Part 10 plans a function,
`service.ts::withoutHeldMedia`, only where its lane control on held paths fails (its section
4.7): it leaves out of the bulk upload each file that holds a path row, because CommCare HQ
already holds that file there. Left as that, it would undo this choice for a held path: Nova's
file would not be sent over the replaced one, the report would name no id, the record would keep
the replaced file's, and the next review would list the same file again. So where it is written
it takes the settled standings and leaves out a held file only where its path's standing is
`recorded`, which is exactly where CommCare HQ holds this app's file by id. A held path that is
`absent`, and one that is `replaced` under a person's "publish over", is uploaded, and its
reported id is recorded. Part 10's test for that function holds all three.

### 7.10 A deployment with no record

Every deployment published before this step holds none, and so does one whose last upload could
not be confirmed, for the paths that upload first sent.

- **Until its next publish**, Refresh and the check when the builder opens compare no file for a
  path with no record: they fetch nothing, and an id with nothing to compare it to says nothing.
  A review, which does fetch, settles such a path by content and so sees a replaced file.
- **Its next publish** settles every unrecorded path by content before it sends anything (7.4): one
  request per file CommCare HQ maps at a path this app publishes, bounded by the export ceiling
  the same publish already holds in memory (`MAX_MEDIA_EXPORT_ASSETS`, `MAX_MEDIA_EXPORT_BYTES`),
  and for an ordinary app a dozen icons. A file found replaced stops that publish like any change.
  Then the upload's report writes the record, and later publishes read ids alone.

No row is backfilled: nothing Nova stored before says which file a path held.

### 7.11 What stays open

- **Between the `target-app` read and the upload**, a file replaced in CommCare HQ is written
  over, and the record then holds Nova's id. It is the window `lib/deployment/CLAUDE.md` ("What
  the check cannot close") already names for the import, one round trip wide, and CommCare HQ's
  upload takes no expected id that could close it.
- **A file replaced with the same bytes** is no change: CommCare HQ finds the same document.
- **The logo** is in no record: a publish never sends it (5.3).

---

## 8. The check when the builder opens

Without it the round trip is reachable only by a person who thinks to press Refresh before their
first edit: anyone who edits first has an unpublished change by the time they publish, and is
asked to choose a side. So Nova looks once, unasked, each time the builder opens an app. The rule
it is built to is that the builder never waits on it: no render, no control and no edit.

### 8.1 What it reads

```ts
// lib/deployment/service.ts
/** Part 01's `refreshKeptValues`, steps 1 to 6, with no write. */
export function peekHqAppChanged(
	scope: DeploymentScope, target: DeploymentTargetKey,
	options: { readonly cancel?: AbortSignal },
): Promise<"changed" | "unchanged" | "unknown">;

// lib/deployment/hqChanges/check.ts (new, server-only)
/** The project spaces whose copy of this app changed, among those Nova could ask. */
export function checkHqChangesForApp(
	scope: DeploymentScope, options: { readonly cancel?: AbortSignal },
): Promise<readonly DeploymentTargetKey[]>;
```

`checkHqChangesForApp` reads the app's deployments and, for each that has a usable pair (section
3) and that the member's own key reaches (part 05's `getHqCredentials`, its section 11, on the
deployment's server), calls `peekHqAppChanged`: one read of the app's source, normalized and
compared with the baseline by `diffHqAppSource` with the count of recorded paths that moved (7.5). The
reads run together, each under its own deadline (the source read's 30 seconds). A deployment is
listed only for `changed`. Everything else is `unknown` and is not listed: no key, a key on
another server, a project space the key does not reach, a failed or unreadable read, an app gone.
A failure is logged at warn with the app's id and nothing of the app. It writes nothing: no
baseline, no fold, no notification.

`POST /api/commcare/changes/check`, body `{ appId }`. It authorizes `edit` on the app, as Refresh
does, because it reads CommCare HQ with the member's own key, and answers 200 with `{ changed:
readonly { server, domain }[] }` for every outcome past authorization, an empty list included. It
hands `req.signal` to the check as `cancel`.

### 8.2 Why it cannot block the builder

Each property below is a fact of how the check is built, and "Tests" holds each.

1. **It is a Route Handler's `fetch`, never a Server Action.** Next.js sends a tab's Server
   Actions one at a time ("Executed during planning"), and the builder's deployment reads are
   Server Actions (`lib/deployment/actions.ts`). A check made as one would hold the Publish
   dialog's records, Check status and every other action of the tab behind CommCare HQ's answer.
   No function that reaches `peekHqAppChanged` is exported from a `"use server"` module.
2. **It starts after the builder is drawn.** `components/builder/HqChangesCheck.tsx` renders
   nothing and is mounted in `BuilderProvider` beside `LocationRecoveryEffect`. Its one
   `useEffect` starts the request once per mount for an app, and only once the builder's phase is
   `Ready` or `Completed` (`lib/session/hooks.tsx::useBuilderIsReady`) and the member can edit
   (`useCanEdit`). An effect runs after the commit it belongs to, so the builder it follows is on
   screen.
3. **No render waits on it.** The component returns null, reads no promise and sits under no
   Suspense boundary. Its one output is a write to one session field, `hqChangedTargets`, whose
   starting value is the empty list. The field has no "checking" value, so no component can draw
   a spinner or disable a control for it.
4. **No edit waits on it.** The route takes no row lock and writes nothing, so no commit, autosave
   or publish can queue behind it. It reads the deployment and its baseline in short reads of
   their own and holds no pooled connection while CommCare HQ answers
   (`lib/deployment/CLAUDE.md`, "No lock spans the CommCare HQ round trips").
5. **It is cancelled when the builder goes.** The effect's cleanup aborts the request's
   `AbortController`: leaving the builder or opening another app (the provider remounts on a new
   build id) ends it, and the route's `req.signal` stops the read at its next call.
6. **Where it fails it says nothing.** A rejected or aborted `fetch`, a status other than 200 and
   a body that does not parse are all dropped in the effect: no toast, no state, no log in the
   browser. The server's warn is the only trace.

### 8.3 What it shows, and what clears it

Where `hqChangedTargets` is not empty, the builder's header shows C3 (9.6) beside the notice chip,
for a member who can edit. Nothing else changes.

A target leaves the field when the panel answers `nothing`, `brought-in` or `recorded` for it,
when a publish lands there, and when publishing there is stopped. A reload whose reason is
`hq-changes` clears the field whole: someone brought the changes in. The field is per tab and is
gone with the builder session; the next open asks again.

---

## 9. The experience

Every string a person reads is written out in this section, once. "Copy" says which export of
which file holds each.

### 9.1 Where a person meets it

1. **The publish stop**, which exists. A publish that stops on `hq_changed` with the app's own
   change shows the panel (9.3) inside `PublishDialogBody.tsx::RemoteChangeChoice`, in place of
   the app item's list of parts (9.4).
2. **The Publishing card**, when the person asks. Part 01's "Refresh from CommCare HQ" already
   reads the app's source and compares it with the baseline, and answers `changed-in-hq` where
   something Nova publishes differs (its section 6.5). That outcome's sentence becomes C1 and
   gains the button C2 (9.6), which opens the same panel in a dialog.
3. **Before they edit, unasked**: section 8's check, which shows C3 in the builder's header.

Deliberately not the Solutions Architect, as every deployment surface is
(`lib/deployment/CLAUDE.md`, "Surfaces").

### 9.2 The two requests

```ts
// lib/deployment/hqChanges/types.ts (new, client-safe)
export interface HqChangesKey {
	readonly appId: string; readonly server: CommCareServer; readonly domain: string;
}
export type HqChangesReview =
	/** Nothing to bring in. */
	| { readonly kind: "nothing";
	    /** `unchanged`: CommCare HQ's app is the baseline's. `reads-the-same`: it was saved and
	     *  reads as the same app. `already-here`: it changed, and this app already holds that. */
	    readonly reason: "unchanged" | "reads-the-same" | "already-here";
	    readonly since: DriftReference;                 // part 10, section 9.1
	    /** What the next publish changes in CommCare HQ (2.5, step 13), as sentences. */
	    readonly publishChanges: readonly string[];
	    /** Null for `unchanged`: there is nothing to record. */
	    readonly readingId: string | null;
	    readonly reviewDigest: string | null }
	| { readonly kind: "changes";
	    readonly since: DriftReference;
	    readonly hqChanges: readonly string[];          // every line
	    readonly novaChanges: readonly string[];        // every line; empty: the no-warning path
	    readonly madeBy: readonly string[];             // names, 6.2; empty where none or only the reader
	    /** The case data lines (9.3): none, one, or one for properties and one for case types. */
	    readonly caseData: readonly string[];
	    readonly publishChanges: readonly string[];
	    /** The digest of CommCare HQ's whole normalized source as read: what a publish over this
	     *  change names in its discard (`RemoteChangeDiscard.observedDigest`; 9.3, S2). */
	    readonly observedDigest: string;
	    /** Not empty: using CommCare HQ's version is not offered (6.3). */
	    readonly renamedInNova: readonly CasePropertyRename[];
	    /** Part 12's review entries for the tables the changed app newly reads
	     *  (`ReadingReview["tables"]`). One whose tag meets a Project table asks its choice
	     *  (part 11, 7.2), answered in `tableChoices`. */
	    readonly tables: ReadingReview["tables"];
	    /** Sent back at the bring-in: the ids of a newly read table derive from it (part 11, 5.5). */
	    readonly readingId: string;
	    readonly reviewDigest: string }
	| { readonly kind: "account"; readonly findings: readonly Finding[]; readonly more: number;
	    readonly counts: { readonly notYet: number; readonly never: number;
	                       readonly fixInHq: number } }
	| { readonly kind: "held"; readonly reason: HqChangeHeld;
	    /** For `runs-elsewhere`: where the app runs, and where CommCare HQ's version runs. */
	    readonly runs: { readonly app: readonly Platform[]; readonly hq: readonly Platform[] } | null }
	| { readonly kind: "unavailable"; readonly reason: HqChangesUnavailable }
	/** CommCare HQ could not be read (part 05's `classifyHqFailure`), or the read is not Nova's to make. */
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding };

// lib/publish/hqChangesKinds.ts (new, client-safe; "Copy"), re-exported here
export const HQ_CHANGES_UNAVAILABLE = [
	"no-reference", "baseline-unread", "base-needs-project-data", "base-unreadable",
	"base-too-large", "nova-updated", "app-moved", "nova-defect",
] as const;
export type HqChangesUnavailable = (typeof HQ_CHANGES_UNAVAILABLE)[number];

export type HqChangesOutcome =
	| { readonly kind: "brought-in"; readonly seq: number; readonly discarded: boolean;
	    readonly deployment: DeploymentView }
	/** Nothing in the app changed: Nova recorded what CommCare HQ holds (4.4). */
	| { readonly kind: "recorded"; readonly deployment: DeploymentView }
	/** The app, the baseline or CommCare HQ is not what was reviewed. `now` is where it stands. */
	| { readonly kind: "changed"; readonly now: HqChangesReview;
	    /** The member whose edit moved the head, where that is what changed. */
	    readonly editedBy: string | null }
	| { readonly kind: "gate"; readonly findings: readonly string[] }
	| { readonly kind: "refused"; readonly message: string };
```

A plan's `differs` is `unavailable` with `nova-defect`, whatever its check. A `changes` plan
whose `batch` and `renamedInNova` are both empty is the review `nothing` with the reason
`already-here`: the app already is the target. A reference of kind `nova-updated` or `app-moved`
is `unavailable` with that reason. A stop's finding is one of part 01's circumstances, made by
part 05's `hqReadCircumstance` (its section 4.3); this part adds no finding code.

- **Review.** `POST /api/commcare/changes/review`, body `HqChangesKey`.
  `lib/deployment/hqChanges/review.ts::reviewHqChanges(scope, target, { onEvent, cancel })`. It
  authorizes `edit`, as Refresh does: it reads CommCare HQ with the member's own key. In order:
  the deployment, its baseline and the pair test of section 3; the baseline's size against the
  cap (2.7); the head; part 05's bracketed read of the app; the media standings, settled (7.6);
  `diffHqAppSource` (no part and no id learned: `nothing`, `unchanged`; no part and an id
  learned: `nothing`, `reads-the-same`, with a digest, so the bring-in records the id);
  `loadReferenceDocument`; the project data and the files, through the functions part 12's
  `gatherFromHq` calls for its steps 5 to 8 (its section 3.3) with no bytes kept; both readings;
  acceptance; `planHqChanges`. It mints a `readingId` as a read does (part 12, section 2.3) and
  writes nothing.
- **Bring in.** `POST /api/commcare/changes/bring-in`, body `HqChangesKey & { readingId,
  reviewDigest, tableChoices }`. `bringIn.ts::bringInHqChanges`. It runs the review's whole
  computation again, with the `readingId` it was sent and the bytes of each added and replaced
  file kept, and goes on only where its digest is the one sent. Then, by what the review is:

  | The review | What the bring-in does | Answer |
  |---|---|---|
  | `changes`, `renamedInNova` empty | the tables of 5.3's row, the kept files published, the ownership of 4.4 computed, then the commit of 4.1 with `recordHqChangesTaken` in its transaction | `brought-in` |
  | `changes`, `renamedInNova` not empty | nothing | `refused`, with R1's sentence |
  | `nothing`, `already-here` | `recordHqChangesTaken` in its short transaction (4.4) | `recorded` |
  | `nothing`, `reads-the-same` | `recordRefreshedAppBaseline` (4.4) | `recorded` |
  | `nothing`, `unchanged` | nothing: there is no digest to send | not reached |
  | any other kind, or another digest | nothing | `changed`, with the review as it now stands |

  On `changed` the person reads the new lists before anything is taken, as a create that finds
  the app changed answers its review (part 12, section 5.3). The kernel's `AppHeadMovedError`
  and the record's `HqChangesBaselineMovedError` are answered the same way, after the review is
  computed once more.
- **The digest.** `reviewDigest` is `canonicalJsonDigest` of the baseline's `source_digest`, the
  normalized digest of CommCare HQ's source now, the head's sequence, the settled media standings,
  and for `changes` the target document with each media file named by its content (part 12's rule
  for its own digest, its section 5.2). Two requests that agree on it computed the same lists, so
  the route asks for no second statement that the person saw them: a Nova list that grew between
  the review and the press moved the head, and the digest with it.

Both routes answer 200 for every outcome above, as a refused publish does, and stream their
stages as a bring-in's routes do (part 12, section 4.3): the review its four, and the bring-in
those four and two more (9.3, "Loading" and "While it is brought in"). They are routes and not
Server Actions for part 12's reason (its section 4.2) and section 8.2's.

`service.ts::publishAppToHq` changes in one field for this section: an `hq_changed` refusal's app
change carries `canBringIn: boolean`, `usablePair`'s answer (section 3), so the dialog and MCP know
whether to offer the review. `DeploymentRemoteChange.canBringIn` is false for a table and a place.

### 9.3 The panel, state by state

One component, `components/builder/HqChangesPanel.tsx`, drawn in the publish dialog and in the
card's dialog, over a state model (`hqChangesPanelModel.ts`). `{since}` is one of three phrases,
by part 10's `DriftReference`, which gains the kind `changes-brought-in`:

| `since.kind` | `{since}` |
|---|---|
| `published` | Nova last published this app to “{domain}” |
| `brought-in` | Nova brought this app in on {date} |
| `changes-brought-in` | Nova last brought in changes from “{domain}” |

A list longer than ten lines shows its first ten and a ghost button, "Show all {n}", which opens
the rest in place.

**Loading.** The bring-in's stage row (part 13, section 5), with these stage names: "Reading the
app in CommCare HQ", "Reading its lookup tables", "Checking what changed", "Checking pictures and
sounds ({done} of {total})". After ten seconds, beside it: "Still reading. A large app can take a
little while."

**While it is brought in.** After "Bring in these changes" or "Use CommCare HQ's version" is
pressed, the panel keeps its headings and lists as they are and draws the stage row in place of
its buttons, so nothing can be pressed twice and the person still sees what they chose. The row
runs the four stage names above, since the bring-in reads everything again, and then two more:
"Adding pictures and sounds to this Project" (shown only where a file is added) and "Bringing
the changes in". The ten-second line is the same. It ends in "After it is brought in", or in one
of the stops of 9.5 with the buttons back.

**S1. Changes, and nothing in Nova would be removed (no warning).** Shown wherever `novaChanges`
is empty.

- Heading: What changed in CommCare HQ
- Lead: These changed in CommCare HQ since {since}. You can bring them in to Nova. Everything
  else in this app stays as it is.
- The list (`hqChanges`).
- The case data lines, where there are any (below).
- The next-publish block, where `publishChanges` is not empty (below).
- Primary button: Bring in these changes
- Under it, in the publish dialog only: Or you can publish over them, which replaces them with
  this app's version. A ghost button beside it: Publish over CommCare HQ's changes

No tick, no confirmation, no dialog on top.

**S2. Changes, and changes in Nova that would be removed.**

- Heading: What changed in CommCare HQ
- Lead: These changed in CommCare HQ since {since}.
- The list (`hqChanges`), the case data lines and the next-publish block.
- Heading: What changed in Nova since then
- Lead: Nova doesn't combine the two, so this is a choice between them.
- Where `madeBy` is not empty: Some of these were made by {names}.
- The list (`novaChanges`).
- A ghost button: Copy both lists. It copies every line of both, shown or not, under their two
  headings. On success, a `role="status"` line beside it for four seconds: Both lists copied.
  Where the browser refuses the clipboard: Nova couldn't copy the lists here. You can select
  them above and copy them yourself.
- The choices, each a button with one sentence under it:

| Button | Under it |
|---|---|
| Use CommCare HQ's version | This app takes CommCare HQ's changes. The changes listed under Nova are removed, and Nova can't put them back. |
| Publish over CommCare HQ's changes | CommCare HQ takes this app's version. What changed there is replaced. |
| Stop publishing here | part 10's `STOP_PUBLISHING_HELPER`, unchanged; an editor reads part 13's line D8b in place of the button |

"Publish over CommCare HQ's changes" sets the app item's "Publish over this" and moves focus to
the dialog's footer button, which already reads "Publish over these changes". In the card's
dialog it closes the panel and opens the publish dialog on that project space with that choice
already made: `lib/session/store.ts::requestPublishDialog` gains an optional `discard`, the
`RemoteChangeDiscard` of the app's change under the review's `observedDigest`, which the dialog
puts in the discards it sends. So the person does not read the same panel and press the same
button a second time. The dialog opens on its destination step, with one line under the project
space's plan line, "This publish replaces what changed in CommCare HQ with this app's version.",
and its footer button reads "Publish over these changes". Where CommCare HQ changed again in
between, the digest no longer matches, the publish stops and the panel shows what is there now.
No choice is preselected, and pressing "Use CommCare HQ's version" acts at once: the list above
it is the one honest warning, and a second question would only repeat it.

**R1. In S2, where a case property was renamed in Nova.** In place of the first button and its
sentence: Since then, the case property “{from}” was renamed to “{to}” in Nova, which moved saved
case data to the new name. To use CommCare HQ's version, you can rename it back in Nova, so the
data moves back with it, and then check again. (Several: "Since then, these case properties were
renamed in Nova: “{from}” to “{to}”, and “{from}” to “{to}”, which moved saved case data to the
new names. To use CommCare HQ's version, you can rename them back in Nova, so the data moves back
with them, and then check again.") A button: Check again

**The case data lines** (S1 and S2, under the CommCare HQ list). Two, each shown where it has
something to say:

- where `removedCaseProperties` is not empty: The app no longer has the case property “{name}”,
  so cases saved in Nova lose that value the next time each one is saved. (Several: "The app no
  longer has the case properties {names}, so cases saved in Nova lose those values the next time
  each one is saved.", each name in quotation marks, five at most, then "and {n} more".) Only a
  property with no declaration in Nova's catalog is ever named here (5.3): a declared one stays.
- where `removedCaseTypes` is not empty: The app no longer has the case type “{type}”. Its cases
  saved in Nova are kept, and no list in this app shows them. (Several: "The app no longer has
  the case types {types}. Their cases saved in Nova are kept, and no list in this app shows
  them.", named and cut the same way.)

**The next-publish block** (S1, S2 and S3, where `publishChanges` is not empty): Nova writes a few
things its own way, so your next publish changes these in CommCare HQ: followed by the register's
own sentence for each id (`lib/publish/firstPublishCopy.ts::FIRST_PUBLISH_SENTENCES`, part 09).

**S3. Nothing to bring in (`nothing`).** One line, `role="status"`, by reason:

- `unchanged`: Nothing in this app has changed in CommCare HQ since {since}.
- `reads-the-same`: CommCare HQ saved this app since {since}, and Nova reads it as the same app.
  There's nothing to bring in.
- `already-here`: What changed in CommCare HQ since {since} is already in this app. There's
  nothing to bring in.

Where the review holds a digest the panel sends the bring-in at once, which records what CommCare
HQ holds and changes nothing in the app (4.4). It is the one thing done unasked, and it only
records a read. Then: in the publish dialog, where `publishChanges` is empty, the publish is sent
again by itself and goes ahead with no tick and no discard; where it is not empty, the dialog
returns to its review step, which shows the list (9.4), and the person presses Publish. On the
card, the line is followed by: Your next publish here goes ahead as usual.

**S4. CommCare HQ's version holds something Nova can't hold (`account`).**

- Heading: Nova can't bring in CommCare HQ's version
- Lead: Nova read what changed and found {n} things it can't hold, so it brought nothing in.
  Taking part of an app would lose the rest at the next publish. Here is each one, with what you
  can do about it. (One: "Nova read what changed and found 1 thing it can't hold, so it brought
  nothing in.", then the same two sentences.) Where the account's one finding is `too-large`
  (2.7), Nova read nothing, so the lead is instead: CommCare HQ's version of this app is larger
  than Nova brings in, so Nova brought nothing in. Part 01's block for that finding follows, and
  no "Check again" button is drawn: checking again reads the same size.
- The account, drawn by the bring-in's own component with its groups, labels, next steps and
  links to CommCare HQ (part 13, section 7), and part 01's `ACCOUNT_CHECK_AGAIN_LINE` (its
  section 9.1).
- A button: Check again
- Under the account: You can also publish over CommCare HQ's version, which removes these from
  CommCare HQ, or stop publishing here.

The two existing choices stay exactly as they are, below.

**After it is brought in.** In the panel, `role="status"`:

- nothing was removed: CommCare HQ's changes are in this app now.
- `discarded`: This app now holds CommCare HQ's version. The changes listed under Nova were
  removed.

In the publish dialog the refusal clears, the destination step returns, and under the project
space's plan line: There's nothing new to publish to “{domain}” yet. The Publish button stays
live: publishing an app that holds the same thing is allowed and harmless. The builder reloads the
app under the dialog (4.3), and the session's `deploymentRecordsRevision` is bumped, so the card
redraws.

### 9.4 What the publish dialog does around it

**The stop's headline.** Part 10's `hqChangedMessage` ends "You can publish over what's listed
below", which above S1 would read as a warning with one way on. Where the app's change has
`canBringIn` true it reads instead, by `since.kind`:

| `since.kind` | Headline |
|---|---|
| `published` | Something in this app changed in CommCare HQ since Nova last published it, so Nova stopped before sending anything. Here's what changed. |
| `brought-in` | Something in this app changed in CommCare HQ since Nova brought it in on {date}, so Nova stopped before sending anything. Here's what changed. |
| `changes-brought-in` | Something in this app changed in CommCare HQ since Nova last brought in changes from it, so Nova stopped before sending anything. Here's what changed. |

The headline names no way on. It is chosen from `canBringIn` before the review answers and stays
above whatever the panel then shows, S3, S4 and every stop of 9.5 included, where the change
cannot be brought in. The panel's state says what the person can do.

Where the refusal also lists a lookup table or a place, one sentence follows: The lookup tables
and places listed below keep their own choice. The sentence "A save in CommCare HQ can show up
here even when it changed no value" is in none of these arms, because such a save now goes ahead
by itself (S3).

**One set of controls.** On an `hq_changed` refusal whose app change has `canBringIn` true, the
dialog starts the review at once. While it runs, and in S1, S2 and S3, the app's item shows the
loading row or the panel and nothing else: its own list of parts, its "Publish over this" tick
and part 13's "Stop publishing here" block are not drawn, because the panel's choices are those
controls (its "Publish over" sets the tick; its "Stop publishing here" is part 13's button, with
its confirmation). So a person cannot tick and publish over a change before Nova has said they
could have brought it in with nothing lost. The item is drawn as part 13 has it (its section
11.3), with its list, its tick and the stop block, under S4, under every stop of 9.5, and where
`canBringIn` is false, which adds one line under its parts: U1. Changes to lookup tables and
places in the same refusal keep their items and their ticks (part 11).

**The next publish's list.** Part 13's section over the confirmations (its 11.2) shows wherever
`DeploymentView.firstPublish` is not null. For a list of kind `first-publish` it reads as that
part has it. For a list of kind `next-publish` (4.4, item 4) it takes the heading "What this
publish changes in CommCare HQ" and the lead "CommCare HQ's version holds a few things Nova writes
its own way. This publish changes them there."

### 9.5 Stops, each with its words

| Outcome | Words |
|---|---|
| U1. `unavailable`, `no-reference` | Nova can't tell CommCare HQ's changes from this app's here, because its record of the last publish to “{domain}” doesn't hold what that takes. Nova can bring in changes made in CommCare HQ after your next publish here. |
| U2. `unavailable`, `baseline-unread` | part 10's `baselineUnknownSentence(since)`, then: Nova can bring in changes made in CommCare HQ after your next publish here. |
| U3a. `unavailable`, `base-needs-project-data` | This Project's lookup tables or organization changed since {since}, so Nova can't read its own record of what it left in “{domain}”, and can't tell what changed there. Nova can bring in changes made in CommCare HQ after your next publish here. |
| U3b. `unavailable`, `base-unreadable` | Nova couldn't read its own record of what it left in “{domain}”, so it can't tell what changed there. That's Nova's to fix, and Nova has reported it. Nova can bring in changes made in CommCare HQ after your next publish here. |
| U4. `unavailable`, `base-too-large` | Nova's record of what it left in “{domain}” is larger than Nova compares, so it can't tell what changed there. That limit is Nova's, not the app's. You can publish over the change, or stop publishing here. |
| U5. `unavailable`, `nova-updated` | Nova updated how this app is stored since {since}, so it can't tell this app's changes from CommCare HQ's here. Nova can bring in changes made in CommCare HQ after your next publish here. |
| U6. `unavailable`, `nova-defect` | Nova read what changed in CommCare HQ and couldn't fit it to this app, so it changed nothing. That's Nova's to fix, and Nova has reported it. You can check again later, publish over the change, or stop publishing here. |
| U7. `unavailable`, `app-moved` | This app moved to another Project after it was changed in Nova and before it was published to “{domain}” again, so Nova can't tell this app's changes from CommCare HQ's here. Nova can bring in changes made in CommCare HQ after your next publish here. |
| H1. `held`, `languages-reordered` | The order of this app's languages changed in CommCare HQ, and Nova can't bring that in. You can put the languages back in their earlier order in CommCare HQ, with any new language last, and check again, or publish over the change. |
| H2. `held`, `runs-elsewhere` | CommCare HQ's version doesn't run everywhere this app does. This app runs {where}, and what changed in CommCare HQ runs only {platforms}. You can change where this app runs in App settings and check again, or publish over the change. ({where} and {platforms} are the platform names as App settings words them, joined by "and".) |
| G1. `gate` | Bringing these changes in would leave something in this app that no longer works, so Nova changed nothing. Then each finding's own sentence (`ValidationError.message`). Then: You can change that in Nova and check again, or publish over the change. |
| R2. `changed` | CommCare HQ's copy or this app changed while you were reading, so here is the list as it stands now. Then, where `editedBy` is another member: {name} is editing this app. You can bring the changes in when they pause. Then the panel in its new state. |
| A failed read of CommCare HQ (`stop`) | the bring-in's stop block for the same code (part 13, section 6; part 01, section 9.3), with "Check again" |
| `refused` (no edit access, the app is mid build, a rename that holds the choice back) | the kernel's own sentence, as the publish shows `app_not_ready`; for the rename, R1's sentence |

U3b and U6 log at error with the app's id and, for U6, the plan's `check` and `signature`, as part
12 logs `read-back-differs` (its section 10): one Sentry group per defect, and no word of any app
in it. U6 covers every `differs` plan, a failed take check included: none is a limit a person is
asked to accept, so none is logged below error. U4 and U7 log at warn with the app's id.

**After G1.** A finding there comes from content CommCare HQ's app never carries meeting what
CommCare HQ changed (4.1). Changing that content in Nova is no unpublished change (P0), so the
next check is the no-warning path again. `ValidationError` names a scope and not a kind, so the
panel cannot tell such a finding from one in ordinary content. If the person's fix is to ordinary
content, the next check shows it under Nova, and they can see that using CommCare HQ's version
would remove it. That is why G1 names publishing over as the other way on.

### 9.6 The other strings

- **C1** (Publishing card, the kept list's line after Refresh answers `changed-in-hq`; it replaces
  part 01's sentence, which ends "The next publish here will show you what changed"): CommCare HQ
  saved this app since Nova last read it, so these stay as of {date}.
- **C2** (button beside it): See what changed
- **C3** (builder header, beside the notice chip, where section 8's check found a change): a ghost
  button, See what changed in CommCare HQ. It opens the card's dialog on that project space, or
  the Publishing section where more than one changed.
- **T1** (toast in every other open tab, after the reload): {name} brought in changes from
  CommCare HQ, so this app now shows the latest. Edits you hadn't saved yet are kept where they
  still fit. ({name} falls back to "Someone in this Project" where the tab does not hold the
  member. The `reload` event carries who and which batch, and not whether anything was removed,
  so the toast says nothing of that.)
- **The card's publish-over line** (publish dialog, under the project space's plan line, where
  it was opened with the discard of 9.3, S2): This publish replaces what changed in CommCare HQ
  with this app's version.
- Dialog title on the card: Changes in CommCare HQ
- The drift list's new part (7.7): A picture or sound this app publishes; {n} pictures or sounds
  this app publishes.

Part 10's five sentence functions (its section 9.2) each gain an arm for `changes-brought-in`,
for the places that still show them (a change that cannot be brought in, the check's details, the
Web App question):

| Function | `changes-brought-in` |
|---|---|
| `hqChangedMessage`, the app listed alone | Something in this app isn't the same in CommCare HQ as when Nova last brought in changes from it, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version. |
| `baselineUnknownSentence` | Nova couldn't confirm what CommCare HQ held when it last brought in changes from it, so it can't tell whether anything changed. |
| `hqChangesConfirmedDetail` | You chose to publish over what changed in CommCare HQ since Nova last brought in changes from it. |
| `hqChangesNoneDetail` | Nothing in this app has changed in CommCare HQ since Nova last brought in changes from it. |
| `webAppsChangeMessage`, to on | Someone turned this app's Web App setting off in CommCare HQ since Nova last brought in changes from “{space}”. Then the `published` arm's remaining sentences, unchanged. |
| `webAppsChangeMessage`, to off | Someone turned this app's Web App setting on in CommCare HQ since Nova last brought in changes from “{space}”. Then the `published` arm's remaining sentences, unchanged. |

`hqChangedMessage`'s arm for both kinds listed ("as when Nova last read it there") already covers
a refusal that lists a `changes-brought-in` app beside a table. Part 10 owns `DriftReference` and
`driftReferenceOf`, and says when the third kind is answered (its section 9.1).

---

## 10. MCP

Two tools, registered in `lib/mcp/server.ts::registerNovaTools` beside the bring-in's (part 13,
section 14.1), each declaring its scope challenge and calling `assertScope` first. Neither is
given to the Solutions Architect and neither enters `SHARED_TOOL_REGISTRY`, so neither needs an
entry in `scripts/test-schema.ts`. Neither takes a server: it is the member's connection's, as
`upload_app_to_hq` resolves it, and `domain` may be omitted by that tool's own rule (a key that
reaches exactly one project space).

| Tool | Scope | Input | Answer |
|---|---|---|---|
| `read_hq_changes` | `nova.hq.read` | `app_id`, `domain` | `HqChangesReview`, in snake case: `kind`, `reason`, `since`, `hq_changes`, `nova_changes`, `made_by`, `case_data`, `publish_changes`, `observed_digest`, `renamed_in_nova`, `tables`, `reading_id`, `review_digest`, `runs`; an account as `read_hq_app` returns one (part 13, section 14.3). Every line of both lists is returned. |
| `bring_in_hq_changes` | `nova.hq.write` | `app_id`, `domain`, `reading_id`, `review_digest`, `discard_nova_changes` (boolean), `table_choices` (the shape of `bring_in_hq_app`'s field of that name; part 13, section 14.4) | `HqChangesOutcome`; `changed` carries the review as it now stands |

Each calls the function its route calls, after the same authorization, and is handed what part 12
gives a tool call (its section 4.4): no deadline of Nova's own, the call's own cancellation signal
for the read and none for the bring-in, and progress for each stage.

`discard_nova_changes` exists on this tool and not on the HTTP route. A person presses a button
under the list they read; a model sends a call. So the field is the model's statement that the
person said yes to the list: `true` is refused where the review holds no Nova change, and `false`
where it holds some. A `nothing` review's digest may be sent to record it, after which an upload
goes ahead; left unsent, the upload still stops and can be sent with `discard_hq_changes`, as
today.

**Descriptions.**

- `read_hq_changes`: "Read what changed in CommCare HQ since Nova last published this app to a
  project space, or brought it in or last brought in changes from it. Changes nothing. Call it
  when `upload_app_to_hq` answers `hq_changed` with `can_bring_in` true on the app's change, or
  when the user asks what changed there. `hq_changes` lists what bringing the changes in changes
  in this app. `nova_changes` lists what that would remove of changes made in Nova since then: it
  is empty when nothing would be removed. Show the user every line of both lists and `made_by`
  before calling `bring_in_hq_changes`. A `kind` of `account`, `held`, `unavailable` or `stop`
  means Nova can't bring the changes in: relay its sentences, and the user can still publish over
  the change or stop publishing there."
- `bring_in_hq_changes`: "Bring the changes `read_hq_changes` listed in to this Nova app. Send
  back its `reading_id` and `review_digest`. Set `discard_nova_changes` to false when
  `nova_changes` was empty. When it was not empty, bringing the changes in removes every change
  listed there and Nova can't put them back: set it to true only after the user has read that
  list and said yes. An answer of `changed` means CommCare HQ or the app moved since the read:
  show the user `now` and ask again. `gate` lists what would stop working; the user can change
  that in Nova and you can read again."

**Three tools that change.** `upload_app_to_hq`'s `hq_changed` answer gains, on the app's change,
`can_bring_in`, and its description gains: " When the app's change has `can_bring_in` true, you
can read what changed with `read_hq_changes` and bring it in with `bring_in_hq_changes`, or
publish over it by naming it in `discard_hq_changes`. Ask the user which." Each change's `since`
admits `{ kind: "changes-brought-in" }` beside part 13's two (its section 14.7). `get_deployment`
and `refresh_deployment`'s projection (`lib/mcp/tools/deploymentProjection.ts`) gains
`nova_revision` beside `pushed_revision`: the revision of this app that CommCare HQ's copy was
last known to match, so a client that compares the app's head with it does not read a brought-in
change as one waiting to be published. `refresh_deployment` with `kept_values: true` relays C1
for `changed-in-hq`, followed by: " `read_hq_changes` lists what changed."

---

## Copy

Every string above is in Nova's voice, sentence case, with no em dash and no ellipsis in a
button. Each lives once, in one of two new client-safe files that import nothing of
`lib/deployment` or `lib/commcare`, so the builder, MCP and the docs read one text. The three
kinds their sentences take as input are declared beside them, in a third file, for that reason.

**`lib/publish/hqChangesKinds.ts`** (new, client-safe, types and two lists): `HQ_CHANGES_UNAVAILABLE`
and `HqChangesUnavailable` (9.2), `HQ_CHANGE_HELD` and `HqChangeHeld`, and `CasePropertyRename`
(2.5). `lib/deployment/hqChanges/types.ts` and `plan.ts` import them from here.

**`lib/publish/documentChangeCopy.ts`**: `documentChangeLines(changes, side)`, the twelve rows of
6.2's table, and `madeByLine(names)` ("Some of these were made by {names}.", with "and {n} others"
past three).

**`lib/publish/hqChangesCopy.ts`**:

| Export | Holds |
|---|---|
| `sincePhrase(since, domain, options?)` | 9.3's three phrases; `options` is part 10's `DriftDateOptions` |
| `HQ_CHANGES_STAGE_LABELS`, `HQ_CHANGES_STILL_READING` | the review's four stage names, the bring-in's two more, and the ten-second line |
| `HQ_CHANGES_HEADING`, `NOVA_CHANGES_HEADING`, `hqChangesLead(since, removes)`, `NOVA_CHANGES_LEAD` | S1's and S2's headings and leads |
| `BRING_IN_CHANGES_ACTION`, `USE_HQ_VERSION_ACTION`, `USE_HQ_VERSION_HELPER`, `PUBLISH_OVER_HQ_ACTION`, `PUBLISH_OVER_HQ_HELPER`, `PUBLISH_OVER_INSTEAD_LINE`, `PUBLISH_OVER_CHOSEN_LINE`, `COPY_BOTH_LISTS_ACTION`, `LISTS_COPIED_LINE`, `LISTS_NOT_COPIED_LINE`, `showAllAction(n)`, `CHECK_AGAIN_ACTION` | every button, the sentence under each, the two answers to a copy, and the card's publish-over line (9.6) |
| `renamedInNovaLine(renames)` | R1 |
| `caseDataLine(properties)`, `caseTypesLine(caseTypes)` | the two case data lines |
| `NEXT_PUBLISH_LEAD`, `NEXT_PUBLISH_HEADING`, `NEXT_PUBLISH_DIALOG_LEAD` | the next-publish block's lead, and 9.4's heading and lead |
| `nothingToBringInLine(reason, since)`, `NEXT_PUBLISH_GOES_AHEAD` | S3 |
| `CANNOT_BRING_IN_HEADING`, `cannotBringInLead(n)`, `CANNOT_BRING_IN_TOO_LARGE_LEAD`, `CANNOT_BRING_IN_OTHER_WAYS` | S4 |
| `broughtInLine(discarded)`, `nothingNewToPublishLine(domain)` | after it is brought in |
| `hqChangedBringInMessage(since, hasOtherChanges, options?)` | 9.4's three headlines and the sentence for tables and places |
| `hqChangesUnavailableLine(reason, context)`, `hqChangesHeldLine(reason, runs)`, `HQ_CHANGES_GATE_LEAD`, `HQ_CHANGES_GATE_NEXT`, `hqChangesMovedLine(editedBy)` | U1 to U7, H1, H2, G1, R2 |
| `KEPT_CHANGED_IN_HQ` (used by part 01's `keptRefreshSentence`), `SEE_WHAT_CHANGED_ACTION`, `SEE_WHAT_CHANGED_IN_HQ_ACTION`, `HQ_CHANGES_DIALOG_TITLE`, `hqChangesBroughtInToast(name)` | C1, C2, C3, the title, T1 |

`remoteChanges.ts::describeAppChange` holds the drift list's media part, part 10's five
functions hold their own third arms (9.6), and `preflight.ts::hqMediaReadFailure` holds the two
sentences of 7.4, beside `hqAppSourceReadFailure`, whose shape it answers in.

**For a developer** (thrown, never shown to a person):

| Where | Message |
|---|---|
| `planHqChanges`, handed a reference of kind `nova-updated` or `app-moved` (its type refuses one; a cast reached it) | "Nova was asked to plan CommCare HQ's changes with no reference document. `loadReferenceDocument` answers `{kind}` when it cannot build one, and the caller answers `unavailable` for it instead of planning." |
| `store.ts::HqChangesBaselineMovedError`, thrown by `recordHqChangesTaken` where a fence fails | "The deployment's baseline is not the one this plan read (expected source digest {expected}, found {found}), so nothing was recorded. A publish landed in between; the caller answers the review as it now stands." |
| `applyBlueprintChange`, handed `expectedHeadSeq` or `inTransaction` with a kind other than `hq-changes`, or `hq-changes` with no `expectedHeadSeq` | "Only a bring-in of changes made in CommCare HQ commits at an expected head with its own transaction work. This call asked for that under the kind {kind}; an editor's batch takes neither." |
| `sourceFromBaseline`, a value that is no normalized source | "Nova tried to read a stored baseline as an app source and it is not one (missing {key}). `readAppBaseline` verifies a baseline before it is read; this value did not come from it." |

---

## Tests

Each at the smallest boundary that can fail for the right reason. No test is a DOM test under
jsdom: the panel's states are a model, tested as a model, and drawn under Playwright.

| Test | Boundary | Holds |
|---|---|---|
| `lib/doc/__tests__/documentChanges.test.ts` | pure | the grain of 6.2; each changed question listed once, under one of the four lists, by its id with its groups' ids before it; names from the right side; every schema key placed; a media slot counted in `mediaFiles`; `count` is zero exactly where there are no differences, over the diff fuzz corpora |
| `lib/publish/__tests__/hqChangesCopy.test.ts`, `documentChangeCopy.test.ts` | pure | every sentence of sections 6.2 and 9 exactly, singular and plural, each `since` kind; the Nova side's form line names every question and the CommCare HQ side's counts them; no em dash, no ellipsis in a button |
| `lib/deployment/hqChanges/__tests__/plan.fuzz.test.ts` | pure, production reducers and the production reader | below, "The round trip over generated documents" |
| `lib/deployment/hqChanges/__tests__/plan.test.ts` | pure | each arm of `HqChangePlan`; each row of 5.3 that has a decided outcome, built from production builders: a removed read of a worker property keeps the property and every persona's value; a newly read slug Nova holds binds to it and adds nothing; a reworded source keeps the translation as `needs-review` (two readings built by hand, since Nova's own emission of a reworded text prints the source for its translations); a change both sides made alike is off Nova's list and gives an empty batch; a rename since the reference gives the lists and no batch; a rename of the app in Nova is on Nova's list; a gate refusal caused by an automation clears after an edit to the automation, and the next plan is applied to the head; a property the changed app stops naming keeps its declaration and its label, and one only a save gave is in `removedCaseProperties`; a `setCaseProperty` moves the type and keeps the label; a case type the changed app drops is retired and is in `removedCaseTypes`; with the changes applied to the published document, a property the head declared since stays in the target and the batch holds no `removeCaseProperty`; for each of the four rows 5.3 names (a condition added to a one-screen group, a list switched to a tile over a dormant cell, formatting turned on over dormant flags, a menu's forms reordered around a registration form) the first take check fails, the touched form or menu takes the reader's spelling, the change is taken, `respelled` names it and nothing outside it moved; `touchedBy` over each mutation family |
| `lib/deployment/hqChanges/__tests__/reference.postgres.test.ts` | real Postgres | a recorded hold after the publish and an accepted move are in the reference, and the plan is applied to the head; a `blueprint-migration` row that applies is in the reference; one that does not answers `nova-updated`; a rename and its rename back give no `renamesSince`; the worker setup and the logo are the head's, the name is the published document's, and a worker property's slug renamed since is the published one; a Project move after the publish with no person's change before it is in the reference, the plan is applied to the head and Nova's list is empty; a Project move that follows a person's change answers `app-moved`; two properties left holding one slug bind the slug to the published one, and the bring-in answers `gate` with the duplicate-slug finding; `usablePair` over every origin, a null revision, a `push` row whose revision is not the mapping's, a revision behind a fold baseline, a revision of 0 beside a mapping whose `pushed_revision` is 0 (unusable, by test 4 alone), and a null `foldSeq` |
| `lib/deployment/hqChanges/__tests__/baselineSource.test.ts` | pure, the reader | W1's property over every retained read |
| `lib/doc/__tests__/diffDocsToMutations.provenance.test.ts` | pure | the third arm emits a removed and an added property and never a rename; a source guard holds its callers to `plan.ts` |
| `lib/deployment/__tests__/hqChanges.postgres.test.ts` | real Postgres, HQ answered by the controlled client the publish tests use | one `hq-changes` row at the expected head; the baseline, its `nova_revision`, its `media_files`, identity rows and media paths in that transaction, and all of them gone where the batch's write is made to fail after the record; a change that adds a case type leaves that type's schema synced, and one that drops a case type leaves its schema inactive and its rows in place; a change that stops naming a declared property commits over cases that hold a value for it; a bring-in that takes something whose emission needs an add-on writes an ownership that holds it, and a later change to that add-on in CommCare HQ stops the next publish; two requests of one member with one digest answer one commit; a second member's request that races the first answers `changed`, and so does a retry sent after the commit; a replaced file at a held path deletes the old asset's path row and inserts the new one's; a moved head and a moved baseline each write nothing and answer `changed`; a repeat answers the same commit; the gate's refusal writes nothing; a second review is `nothing`; an empty batch writes no app change and moves the pair to the reviewed head; a `nothing` review's record keeps origin and `nova_revision`; the stored list is written, kept and cleared exactly where 4.4's item 4 says; `D_ref` rebuilt across an `hq-changes` row |
| `lib/deployment/__tests__/hqMedia.test.ts` | pure | `hqMediaStandings` over every combination of record and map entry (absent, a null id, an unreadable entry, the recorded id, another id, no record); `nextHqMediaRecord`'s order of preference and that an unpublished path leaves the record; `hqMediaRecordFromSource`; `mediaMovedBetween`; `movedRecordedPaths` counts a recorded path whose id moved and no path without a record; `diffHqAppSource` gives one `media` part for a count above zero and none for zero, for a shell or for no count |
| `lib/deployment/__tests__/hqMediaSettle.test.ts` | the HQ adapter over retained answers (undici's `MockAgent`, as part 05's readers are held) | the same bytes are `recorded` and learned; other bytes, `too-large` and an unreadable entry are `replaced`; a 404 is `absent`; a failure after the resend is `failed`; one request per id; nothing kept |
| `lib/commcare/__tests__/mediaBundleStatus.test.ts` | the client over retained status answers | `matchedFiles` holds each entry's path and id across classes; a status with no `matched_files`, or an entry with no `m_id`, gives null and the same counts as today |
| `lib/deployment/__tests__/publishMedia.postgres.test.ts` | real Postgres, the controlled HQ client | a replaced file stops the publish with `hq_changed` and one `media` part, and nothing is uploaded; the discard uploads and the record takes the reported id; a file replaced again after the stop is asked about again; an unrecorded path with the app's own bytes proceeds and is recorded, with one file request; a later publish over the same app makes no file request; a failed file read blocks with nothing sent; a null map blocks an app that publishes a file and passes one that publishes none; a failed, timed-out or errored upload keeps the previous record; a publish the previous revision's upsert followed leaves `media_files` as it was; an id moved during a resource push stops at `upload`; a failed file read answers `hqMediaReadFailure`'s sentence, the permission one for a 403 |
| `lib/db/__tests__/placementAuthority.test.ts` (new case) | pure | a batch of the kind may change any hold |
| `lib/db/__tests__/placementRecords.postgres.test.ts` (new case) | real Postgres | `readRecordedPlacementHolds` reads an `hq-changes` row's holds as recordings, and an editor's restore after one is held to it |
| `lib/db/__tests__/applyBlueprintChange` (new cases, beside that function's own) | real Postgres | `hq-changes` commits only at `expectedHeadSeq`; `inTransaction` runs once with the commit's sequence and rolls back with it; an editor's kind handed either is refused before any write |
| `lib/deployment/hqChanges/__tests__/cap.test.ts` | the controlled HQ client, its own timeout of 60 seconds | a baseline and a changed source each just under `HQ_BRING_IN_APP_MAX_BYTES`, built as part 12's `cap.test.ts` builds one, reviewed and then brought in: the longest synchronous piece of each is under 5,000 ms; a baseline one byte over the cap answers `base-too-large` with `sourceFromBaseline` never called; a current source over it answers the one `too-large` account |
| the two migrations' own tests | real Postgres, the historical prefix | the fill pairs only `push` rows with their live mapping, and replays; other origins stay null; `media_files` refuses a JSON value that is no object; the routine admits `hq-changes` with a batch and no run, and refuses it empty or with a run; every row the previous revision writes still passes |
| `lib/db/__tests__/persistedJson.test.ts` (new cases) | pure | an `hq-changes` envelope with a nonempty batch and no run parses, and one with a run or an empty batch is refused, so the server's own reader never admits a row the database refuses |
| `app/api/apps/[id]/stream/__tests__/stream.postgres.test.ts` (new case) | real Postgres | an `hq-changes` row gives `reload` with the reason `hq-changes`, its batch id and its actor |
| `lib/collab/__tests__/reconciler` (new case) | headless state machine | a reload re-folds an unacknowledged edit and clears history |
| `lib/deployment/hqChanges/__tests__/check.postgres.test.ts` | real Postgres, the controlled HQ client | `checkHqChangesForApp` lists a changed deployment and no other; a deployment with no usable pair, no key, a key on another server and a failed read are each not listed; a `moved` file id lists and an `unrecorded` path does not; every table the app's deployments touch is byte for byte unchanged after it |
| `app/api/commcare/changes/__tests__/routes.test.ts` | routes with no database | the three routes refuse a caller with no `edit` before any read; `check` answers 200 with an empty list when its service throws; `review` and `bring-in` answer 200 for every outcome |
| `lib/deployment/hqChanges/__tests__/checkIsNoServerAction.test.ts` | source guard | no module that carries `"use server"` imports `check.ts` or names `peekHqAppChanged`; `HqChangesCheck.tsx` imports no such module and calls `fetch` |
| `components/builder/__tests__/hqChangesPanelModel.test.ts` | the state model | every transition of 9.3 and 9.5; S3 sends the bring-in once; no state between loading and an answer draws a tick; while a bring-in runs no choice can be pressed; the card's publish-over hands the publish dialog the discard under the review's digest |
| `e2e/tests/browser/hq-changes.spec.ts` | Playwright, browser peers with Nova's own routes answered from `page.route` (part 13, section 12.4) | S1 with no warning and one press; S2's two lists, "Show all", and three choices with no tick drawn beside them; R1 in place of the first choice; S3 publishes by itself; S3 with a next-publish list waits for the press; S4 keeps both existing choices; a second tab's toast |
| `e2e/tests/browser/hq-changes-check.spec.ts` | Playwright, the builder mounted with `**/api/commcare/changes/check` held unanswered | while the request is pending the header's controls are enabled, a label edit commits and the save indicator settles, and the Publish dialog opens and lists its records; aborting the request, a 500 and an unparseable body each leave no toast, no button and no console error; an answer with one target shows C3, which opens the card's dialog; leaving the builder aborts the pending request |
| `lib/mcp/__tests__/` for the two tools, and `servedSchemas.test.ts` | MCP | the shapes; every line returned; `discard_nova_changes` refused where it does not match the review |

**The round trip over generated documents** (`plan.fuzz.test.ts`, W2). The two readings are made
by the reader over Nova's own emission, the way acceptance's check 3 re-reads one (part 09,
sections 5.1 and 5.2), which ordinary CI already runs with no CommCare HQ. So the test trusts no
list to be the reader's image. Over the fuzz corpora `diffDocsToMutations.fuzz.test.ts` already
draws, a document `D` is given every kind of content CommCare HQ never carries: a persona with a
value for a worker property, a user type, an automation, both purpose notes, a labelled and an
unread case property, a worker property with a label, `required` and choices that a question
reads and one nothing reads, and a machine translation awaiting review on every text. An edit `M`
from the fuzz's own generators stands in for a person's change in CommCare HQ. `B` is the reading
of `emit(D)` and `T` the reading of `emit(apply(D, M))`, both through the identity map of `D`.

- *The round trip* (P1 to P4): `planFromDocuments({ ref: D, now: D, base: B, theirs: T })` gives
  `changes` applied to the head whose `target` (a) holds every planted thing unchanged, apart from
  what sat on a thing `M` changed or removed (P3's cases 2 to 5); (b) differs from `D` only in
  slots `M` named or the reducer derives, or inside a menu or form of `respelled`; (c)
  satisfies `canonK(target) = canonK(apply(D, M))`; and (d) reads back, through emission and the
  reader, as `T`. With `M` empty the plan is `nothing`.
- *P0*: with `now` set to `D` plus an edit of the planted content alone (a note, a review mark, a
  persona, a worker property's label), the plan is still applied to the head, its Nova list is
  empty, and that content is in `target` as edited.
- *The discard*: with `now` set to `D` plus a second generated edit `N`, the plan is applied to
  the published document, every leaf `N` changed that `target` does not hold is under a line of
  the Nova list, and no line names a leaf `target` does hold (6.2). The worker setup is in
  `target` as `now` holds it.
- *The reader's spelling*: `D` is also given each dormant spelling 5.3's second row names (a
  root of one-screen groups, a tile cell on a list that is no tile, formatting flags under a
  form whose formatting is off, a registration form that is not last). Wherever `respelled` is
  not empty, (c) and (d) still hold, and every difference between `D` and `target` outside the
  slots `M` named lies inside a menu or form of `respelled`.
- A sample where the plan is `differs` fails the test, whatever its check, and so does any throw
  that escapes. W2 says what the session does for each.

**The lane** (W3). `proof/corpus/documents.ts::HqSideSaveKinds` gains the saves a person makes to
an app's content, each through the view a person's save reaches, as every save of
`proof/observe/hqside.py` is made today. A form's content is edited in the form builder itself,
through the lane's own driver of it (`proof/editors/vellum.py::open_and_save`, which opens the
real builder and presses its Save), because what the builder rewrites on a save is exactly what
decides the reworded-source case and the save that changes nothing. The driver gains one step
between open and save: change one label in the default language.

| Document | The save | How |
|---|---|---|
| `targeted-hq-changes-label` | a label reworded in the default language, in an app with a second language | the form builder |
| `targeted-hq-changes-resave` | a form opened and saved with no change | the form builder |
| `targeted-hq-changes-questions` | a question added, and one removed | `views/forms.py::patch_xform` |
| `targeted-hq-changes-form-setting` | a form's own setting | `views/forms.py::edit_form_attr` |
| `targeted-hq-changes-case-management` | a form's case management | `views/forms.py::edit_form_actions` |
| `targeted-hq-changes-menu` | a menu's setting, and its case list columns | `views/modules.py::edit_module_attr`, `views/modules.py::edit_module_detail_screens` |
| `targeted-hq-changes-forms` | a form added and a form removed | `views/forms.py::new_form`, `views/forms.py::delete_form` |
| `targeted-hq-changes-order` | menus and forms reordered | `views/apps.py::rearrange` |
| `targeted-hq-changes-location-list` | the location list setting set to both lists | `appAttributes`, the save the corpus already has (`views/apps.py::edit_app_attr`) |
| `targeted-hq-changes-media` | a picture replaced under its path | `hqmedia/views.py::ProcessImageFileUploadView`, posted with the path the app already holds |

`HqSideSaves.republish` gains a fourth outcome, `brings-in`, with the document the bring-in must
give. For each such document the unit publishes D; makes the saves; reads the source; runs the
review and the bring-in through the production functions; then holds, in this order:

1. the app is the stated document, and every not-carried thing the corpus document holds is
   unchanged in it (P3; for the reworded label, the second language's entry keeps its text and
   origin and is `needs-review`; for the replaced picture, the question shows the file CommCare HQ
   holds, by content);
2. a second review answers `nothing`, with the reason `unchanged` (the pair moved);
3. Nova publishes, with no stop and no discard;
4. `readBackDifferences` of the reading of CommCare HQ after that publish against the reading
   before it is empty in both directions (P4, the round trip; for the reworded label, CommCare
   HQ's second language reads as it did; for the replaced picture, the app's map points to a
   document of the person's bytes);
5. proof 6 over the new document, as over any (the fixed point).

The form saved with no change states `proceeds`: the review answers `nothing`, with the reason
`reads-the-same` and no `publishChanges`. The location list setting states `proceeds` too, with
`publishChanges` holding `location-list-setting-reset` and the document unchanged. The media
document also runs the other branch: with the same save and "publish over", the publish stops
first, the discard proceeds, and the app's map points to a document of Nova's bytes afterwards.
W4's assertion is in `proof/observe/publish.py::upload_media`, so the media document's own
publishes hold it.

---

## Contracts and docs these changes make false

- **`lib/deployment/CLAUDE.md`.** "Baselines" gains the pair (`nova_revision`), the origin
  `changes` and the media record: "A baseline also holds the revision of the Nova app its source
  describes, and which CommCare HQ file stands at each path the app publishes there, written from
  CommCare HQ's own report of the upload." "Preflight is a graph" gains, in the sentence on
  `target-app`: "It also compares the file at each path the app publishes with the one Nova
  recorded, by id, and settles a path it holds no record for by the file's content." A new
  section, "Bringing in what changed in CommCare HQ", states section 2.1's principle, P0, the two
  requests, what each of 4.4's three writes does, the three narrowing rules, the five places
  Nova's own content gives way (5.1), and the rows of 5.3 that are held or unavailable. It states
  no rate: no change is left unfitted by design. "What the check cannot close" loses nothing and
  gains 7.11's first row in its own
  words. "Surfaces" gains the panel, the check when the builder opens and the two MCP tools. "One
  publish lifecycle" gains: "After the media upload settles, the publish records the id CommCare
  HQ reported for each path."
- **Root `CLAUDE.md`.** In the `lib/deployment` paragraph, the sentence part 10 rewrites to end
  "or since it brought the app in, without the person confirming the discard" (its "Contracts and
  docs these changes make false") gains ", and it offers to bring that change in to Nova instead".
  In the `lib/db` paragraph, "`blueprint-migration` / `fold-baseline` / `project-move` are
  server-only reload boundaries" becomes "`blueprint-migration` / `hq-changes` / `fold-baseline` /
  `project-move` are server-only reload boundaries".
- **`lib/db/CLAUDE.md`.** The kind `hq-changes` in the kind set, who writes it, that it is
  replayable and reloads tabs; that a fold horizon hides a deployment's reference document until
  its next publish; one sentence that a `blueprint-migration` batch is granular, so the
  reference applies it to an earlier document of the same app and stops where it does not apply;
  under "Guarded commit", that `applyBlueprintChange` also commits a bring-in of changes, at an
  expected head, with the deployment's record written in its `beforeWrite` hook; and in the
  sentence on who may change a held placement, the kind beside a publish and a migration.
- **`lib/doc/CLAUDE.md`.** The third provenance arm and its one caller; `documentDifferences` and
  `documentChanges`.
- **`lib/collab/CLAUDE.md`.** The `reload` event's reason, batch id and actor.
- **`components/builder/CLAUDE.md`.** `HqChangesPanel` and its two homes; and the rule of section
  8.2 in one paragraph: the check is a route's `fetch` started from an effect, never a Server
  Action, and no state of the builder waits on it.
- **`docs/architecture/contracts.md`**, "HQ deployment safety": "A bring-in of changes never
  rebuilds Nova's document from CommCare HQ's app: it applies the difference of two readings of
  CommCare HQ's own answers." and "No publish writes a file over one a person replaced in CommCare
  HQ without that person's choice." In the paragraph on `app_changes`' envelope, the closed kind
  set gains `hq-changes`, which carries a nonempty admitted batch and null Project-move columns
  and is written only by a bring-in of changes, at the head it was reviewed at. In the paragraph
  on the browser's frame, the kind joins the ones that reload.
- **`docs/architecture/complex-apps.md`**, "Export, publishing, and the deployment record": the
  media facts of "Executed during planning" (what `multimedia_id` identifies, what a replace
  changes, what the upload reports), each with its symbol at the pin, and that an update writes
  the app's name from `app_name`. "The permanent app-change log" gains the kind.
- **`proof/README.md` and `proof/CLAUDE.md`.** The new save kinds and the outcome `brings-in`.
- **Public docs.** `content/docs/publishing.mdx`, "Changes made in CommCare HQ" (the section is
  there today, about publishing over a change). Its opening paragraph and the list that begins
  "Some changes read a little differently" stand. The rest changes as follows, each sentence held
  to sections 5.1, 6.3, 7.7, 8 and 9.3 before it lands. After the opening paragraph, these
  paragraphs are added, in this order:

  > **When the app itself changed, you can bring the change in.** Nova lists what changed by menu
  > and form. If nothing in this app has changed in Nova since then, choose **Bring in these
  > changes**: they come in to this app, and everything else in it stays as it is, including what
  > CommCare HQ never holds, such as notes, personas and review marks on translations. Your next
  > publish then goes ahead as usual.
  >
  > **When the app changed in both places, you choose one.** Nova shows a second list, **What
  > changed in Nova since then**, and doesn't combine the two. **Use CommCare HQ's version** takes
  > CommCare HQ's changes and removes the ones listed under Nova, and Nova can't put those back, so
  > **Copy both lists** is there if you'd like a record first. If you renamed a case property in
  > Nova since then, Nova asks you to rename it back before it offers CommCare HQ's version, so
  > saved cases keep their values. **Publish over CommCare HQ's changes** sends this app's version
  > and replaces what changed there. An admin or owner of the Project can also choose **Stop
  > publishing here**, which leaves the app in CommCare HQ as it is; a later publish there makes a
  > new app. You can also close the dialog and decide later.
  >
  > **A picture or sound replaced in CommCare HQ is a change like any other.** It's listed with
  > the rest. Bringing the changes in takes CommCare HQ's file, and Nova sends its own file back
  > only when you choose to publish over the change.
  >
  > **Nova also looks when you open an app.** Once the builder is up, Nova checks in the
  > background whether the app changed in CommCare HQ, using your own CommCare HQ connection.
  > Nothing waits on it. If something changed, **See what changed in CommCare HQ** appears in the
  > builder's header. If Nova can't reach CommCare HQ, it says nothing, and your next publish
  > checks again.
  >
  > **When Nova can't bring a change in**, it says why and what you can do about it, and you can
  > still publish over the change or stop publishing there.

  The paragraph that begins "**You decide what happens to each change.**" keeps its sentences and
  takes a new lead: "**You can also publish over a change.**", and gains at its end: "A change to a
  lookup table or a place is decided this way." The paragraph "**A save in CommCare HQ can show up
  here even when it changed no value.**" is replaced by:

  > **A save in CommCare HQ that changed nothing doesn't hold you up.** CommCare HQ's settings
  > pages and its form builder write things Nova doesn't, so opening a form there and saving it
  > can look like a change. Nova reads the app again, sees that it's the same app, and lets your
  > publish go ahead.

  `content/docs/mcp/tools.mdx`, "Bringing in an app from CommCare HQ" (part 13, section 17.3),
  gains two rows:

  > | `read_hq_changes` | Read what changed in CommCare HQ since Nova last published an app to a project space, brought it in, or last brought in changes from it. Changes nothing. Returns `kind`, and for `changes` the lists `hq_changes` and `nova_changes`, with the `reading_id` and `review_digest` to bring them in. Requires `nova.hq.read`. |
  > | `bring_in_hq_changes` | Bring the changes `read_hq_changes` listed in to the Nova app. `discard_nova_changes` is true only when `nova_changes` was not empty and the user agreed to lose every change listed there. Answers `brought-in`, `recorded`, `changed`, `gate` or `refused`. Nothing is sent to CommCare HQ. Requires `nova.hq.write`. |

  `content/docs/claude-code/commands.mdx`, `/nova:upload_to_hq`, "Changes made in CommCare HQ",
  gains the third way.
- **`design/readme.md`, "Publishing".** "A change made in CommCare HQ is shown as one list by
  place. Where bringing it in removes nothing, one button brings it in with no warning. Where it
  would remove work, a second list names exactly what, and three choices stand side by side with
  none chosen. The list is the warning: no second question follows it."
- **`../nova-plugin`.** The `upload_to_hq` skill's `hq_changed` step says the three ways on and
  asks before discarding either side; it rides the step's one plugin bump (part 13, section 16).

---

## Departures

**From the outline and the research.**

1. **No merge, where the outline's item 4 and the research say "with conflicts shown".** The
   outline: "Nova also offers to bring HQ's changes in as ordinary mutations on the current
   document, matching entities by external identity, with conflicts shown." The research
   (`docs/research/2026-09-26-hq-round-trip/README.md`) says the same and adds that a rename in
   HQ "arrives as a remove and an add". This part keeps the mutations, the external identity and
   the remove and add. It does not show conflicts: where both sides changed, the person chooses
   one side whole. A conflict view needs a rule for every pair of mutation kinds that can touch
   one slot, and the two rules this part is built on ask for none of them: a round trip with no
   loss, and an honest list where there would be loss.
2. **The diff is of two readings, not of a reading against Nova's document.** The research:
   "read HQ's current app, diff it against the reading of what Nova last pushed there (or, after
   an import, read)". That is this part's base (2.1). What the research did not say is which
   document the difference is applied to: the head where Nova holds nothing unpublished, and the
   reference otherwise.
3. **The research's "if HQ's current app no longer reads ... the person chooses between
   discarding HQ's change and ending that deployment"** is S4, with a third way it did not have:
   fix the thing in CommCare HQ and check again, with the account that says where.
4. **Where the change is offered.** The outline offers it "where step 2's drift check stops a
   publish". This part offers it there, on the Publishing card, and from a check when the builder
   opens (section 8), because a person who meets it only at a publish has usually edited first,
   and then the round trip is a choice.

**Alternatives weighed and not taken.**

5. **Rebuilding Nova's document from CommCare HQ's app.** It loses everything CommCare HQ never
   carries even when Nova changed nothing, which the first rule forbids.
6. **`canonDocument(D_ref)` or a re-read of Nova's emission as the base.** Not exact (2.1).
7. **A stored identity map.** It serves no deployment the document does not already serve
   (part 10, section 10, which holds the reasoning).
8. **Overloading `pushed_revision`.** A bring-in of changes is not a push (section 3).
9. **Carrying notes and review marks across a discard.** A rule per kind of content, for the case
   where the person is already reading a list of them (6.1). P0 keeps them wherever nothing else
   changed.
10. **A list of "what only Nova held" beside every change.** Weighed for content inside a slot
    CommCare HQ changed. The five cases are named (5.1) and each already shows as a line of the
    place it is in; a second list would warn on the round trip, and its fifth case is a
    respelling that prints the same bytes.
11. **Nova undoing its own case property rename as part of the take.** `renameCaseProperties` is
    an explicit command that owns its batch and its transaction, so it would be a second commit
    ahead of the `hq-changes` one, with a review at a head in between and a state to explain if
    the second commit is refused. The person already has the rename in Nova's own builder, where
    its effect on case data is explained (6.3).
12. **A second toast, a notice or a stored flag for a colleague whose work was removed.** The
    history row holds no place for it, migration notices are written by cutovers alone
    (`lib/notices/store.ts`), and one toast that names who to ask says what is true in both
    cases.
13. **Running the readings inside preflight.** A publish over an unchanged app must stay as cheap
    as it is, and the publish lifecycle stays one thing with one job.
14. **Bringing changes in as a side effect of pressing Publish.** Changing a person's app because
    they pressed Publish is a surprise even when nothing is lost. It is one press of its own. The
    one thing done unasked is recording a read that changes nothing in the app (S3).
15. **Wording every mutation.** A log, not an account (6.2).
16. **An "are you sure" on Use CommCare HQ's version.** The list is the question.
17. **"Put my changes back".** A restore of a revision is its own feature (6.4).
18. **A third reading of the normalized current source**, to make the cancellation airtight
    against the normalization. W1 holds the same thing.
19. **A frame the tabs fold.** It keeps undo steps that would write over CommCare HQ's version
    (4.3).
20. **A fence against a publish in flight.** Nothing is lost without it (4.4), and the deployment
    row holds nothing to fence on.
21. **Two finding codes for the held changes.** `languages-reordered` and `runs-elsewhere` are
    two values of this part's own type (2.5): a reading of an app meets neither, so part 01's
    circumstance list, its standings and its copy model gain nothing.
22. **The media record read from the baseline's own `multimedia_map`.** It is read before the
    upload, so it never holds what that publish uploaded ("Executed during planning"), and for a
    path it does hold it cannot say whether Nova or a person put the file there.
23. **One more source read after every upload, as the record's source.** CommCare HQ's own report
    of the upload names the same ids with no request and no window between the write and the
    read. The source read is W4's fallback and nothing else.
24. **Treating a path with no record as unchanged, or as changed.** Unchanged is today's silent
    overwrite for one more publish of every deployment. Changed would stop every existing
    deployment's next publish to ask about pictures nobody touched. Content settles it exactly,
    once, with no question (7.10).
25. **Uploading only the files CommCare HQ lacks.** It would make an overwrite impossible by
    construction, and it would change what every publish sends for a reason the stop already
    meets: every stop a person could decide differently is before the upload (7.4). Part 10's
    control on held paths (its section 4.7) stands, and 7.9 says what its fallback leaves out.
26. **A per-file choice at the stop.** A replaced file is a part of the app's one change, under
    its one "Publish over this", as an edited form is.
27. **The check as a Server Action, or awaited by the builder's first render.** Section 8.2.
28. **A cheaper signal for the check than a source read** (CommCare HQ's app version from Check
    status's read). Nova's own media upload saves the app (`process_bulk_upload_zip` ends in
    `app.save()`), so the version moves after every publish that sends a file, with no person's
    edit. A button that says "changed" after Nova's own publish teaches people to ignore it.
29. **The check on a timer, or on the stream.** Once per open is what makes the round trip
    reachable. A person who keeps a builder open for a day meets the stop at their next publish,
    as today.
30. **A stop where Nova's spelling of a changed menu or form does not fit the change.** It would
    make the round trip fail for a person who changed nothing, for a difference that reaches no
    export. The menu or form takes the reader's spelling and the change comes in (2.5, step 9).
31. **Applying the reader's spelling to every touched menu and form, fitting or not.** Simpler,
    and it would drop dormant content Nova holds (a tile cell kept for later, formatting flags
    under a form whose formatting is off) on every edit made near it in CommCare HQ. It is done
    only where the take check fails.
32. **Removing a case property CommCare HQ's app stops naming.** The kernel refuses that removal
    wherever saved case data holds the property, and a reading's silence is no statement that
    the property is gone (5.2). The declaration stays.
33. **Committing through `commitGuardedBatch` directly, as a publish records its placements.** A
    batch of holds changes no schema; a batch read from CommCare HQ can add or retire a case
    type, so it goes through the function that keeps the case schema current (4.1).
34. **The ledger record as a kernel sidecar.** A sidecar is SQL inside `lib/db`, so the record's
    writers would exist twice (4.4).
35. **Naming a question by its label in Nova's list.** A label can be blank, long, a reference to
    another answer, or the very thing that changed. The id is what `describeCarrier` already
    shows a person and what both builders show (6.2).
36. **Replaying a Project move's batch whatever came before it.** Over a document a person had
    changed since the publish, it would carry that change into the reference as if it had been
    published (6.1). The move is applied only where nothing of a person's precedes it.

---

## Files

New:

- `lib/deployment/hqChanges/types.ts` (9.2), `baselineSource.ts` (2.2), `readings.ts` (2.2, 2.3,
  7.6), `reference.ts` (3, 6.1), `plan.ts` (2.5, 5.2), `digest.ts` (9.2), `review.ts` and
  `bringIn.ts` (9.2), `check.ts` (8.1), `index.ts` (`import "server-only"`; the server surface the
  routes and the MCP tools import), and the tests "Tests" names under `__tests__/`.
- `lib/deployment/hqMedia.ts` (7.2, 7.3, 7.8), `lib/deployment/hqMediaSettle.ts` (7.3), and their
  tests.
- `lib/doc/documentChanges.ts` (6.2) and its test. It reads `lib/doc/documentDifferences.ts`,
  which is part 09's file (its section 14.2) and is listed there.
- `lib/publish/hqChangesKinds.ts`, `lib/publish/documentChangeCopy.ts`,
  `lib/publish/hqChangesCopy.ts` ("Copy"), and the two copy files' tests.
- `app/api/commcare/changes/review/route.ts`, `bring-in/route.ts`, `check/route.ts`, and
  `__tests__/routes.test.ts`.
- `components/builder/HqChangesPanel.tsx`, `hqChangesPanelModel.ts`, `HqChangesDialog.tsx` (the
  card's dialog), `HqChangesCheck.tsx` (8.2), and the model's test.
- `lib/mcp/tools/readHqChanges.ts`, `lib/mcp/tools/bringInHqChanges.ts`, and their tests.
- `lib/case-store/migrations/20261201010000_hq_changes_app_change_kind.ts` (4.2), registered in
  `migrations/index.ts`.
- `e2e/tests/browser/hq-changes.spec.ts`, `e2e/tests/browser/hq-changes-check.spec.ts`.
- `proof/targeted/` builders for the ten documents of "The lane", with their `hq-side.json`.

Changed:

- `lib/doc/diffDocsToMutations.ts`: the third provenance arm (2.4).
- `lib/db/types.ts` (`APP_CHANGE_KINDS`, `BlueprintMutationAppChangeKind`);
  `lib/db/canonicalCommitKernel.ts` (the request arm; the head test for both server kinds);
  `lib/db/applyBlueprintChange.ts` (the kind, `expectedHeadSeq`, `inTransaction`; 4.1);
  `lib/db/placementAuthority.ts` and `lib/db/placementRecords.ts` (the recording kind);
  `lib/db/pg.ts` (`nova_revision`, `media_files`); `lib/db/persistedJson.ts`
  (`parsePersistedAppChangeEnvelope`: eight durable kinds in its comment, and an `hq-changes` row
  that carries a run is refused, as a `publish-placement` row's is).
- `lib/deployment/types.ts` (`AppBaseline` and `AppBaselineWrite`: the origin `changes`,
  `novaRevision`, `mediaFiles`; `AppBaseline.sourceBytes`; `DeploymentRemoteChange.canBringIn`).
- `lib/deployment/store.ts` (`writeAppBaseline` and `readAppBaseline` for the three columns and
  `sourceBytes`; `recordRemoteResource` and part 10's adoption writer pass `novaRevision`;
  `recordRefreshedAppBaseline` keeps it and takes 4.4's two optional members;
  `recordHqChangesTaken` and `HqChangesBaselineMovedError`; `recordDeploymentMediaFiles`).
- `lib/deployment/hqSourceBaseline.ts` (`diffHqAppSource`'s `media` input and part);
  `lib/deployment/remoteChanges.ts` (the `media` part's words; the third `DriftReference` arm of
  each function; `driftReferenceOf`); `lib/publish/driftReference.ts` (the third kind);
  `lib/publish/webApps.ts` (its third arm); `lib/publish/keptValues.ts` (C1).
- `lib/deployment/preflight.ts` (7.4: the standings, `hqMediaReadFailure`, `media` on the
  `ready` arm; `canBringIn`); `lib/deployment/service.ts` (the record
  write after the upload; `mediaMovedBetween` at the second read; `peekHqAppChanged`;
  `refreshKeptValues`' count of moved paths); `lib/commcare/client.ts`
  (`MediaBundleUploadResult.matchedFiles`).
- `lib/deployment/reading/signature.ts` (`differenceSignature`'s `check` admits
  `HqChangePlanCheck`; 2.5);
  `lib/deployment/reading/firstPublishChanges.ts` (exports the builder of its facts, so the base
  reading's list is built by the code acceptance uses); `lib/publish/firstPublishChangeIds.ts`
  and `lib/publish/firstPublishCopy.ts` (the stored value's `of`; the `next-publish` heading and
  lead); `lib/deployment/resources.ts::firstPublishOf`.
- `lib/deployment/adoption.ts::adoptedAppBaselineWrite` (`novaRevision`, `mediaFiles`).
- `app/api/apps/[id]/stream/route.ts` and `lib/collab/ReconcilerProvider.tsx` (the reload's
  reason, batch id and actor; T1).
- `lib/session/store.ts` and `lib/session/hooks.tsx` (`hqChangedTargets`;
  `requestPublishDialog`'s optional `discard`, 9.3).
- `components/builder/BuilderProvider.tsx` (mounts `HqChangesCheck`), `BuilderHeader.tsx` (C3),
  `PublishDialogBody.tsx` (9.4), `DeploymentStatus.tsx` (C1, C2), `publishOutcome.ts`
  (`canBringIn`; the third `since` kind).
- `lib/mcp/server.ts`, `lib/mcp/tools/uploadAppToHq.ts`, `lib/mcp/tools/deploymentProjection.ts`,
  `lib/mcp/tools/deploymentTools.ts`.
- `proof/corpus/documents.ts`, `proof/observe/hqside.py`, `proof/editors/vellum.py` (the edit
  step), `proof/corpus/publish.ts`, `proof/observe/publish.py` (W4's hold in `upload_media`).
- The contracts and docs of "Contracts and docs these changes make false".
