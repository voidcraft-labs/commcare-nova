# Step 6, part 12: The reading and the birth

This part plans the job that carries one CommCare HQ app from "a person picked it" to "a Nova app
exists": the durable `hq_app_readings` row; the service in `lib/deployment/reading/` that advances it
by bounded, idempotent, request-scoped steps; the routes that carry each step from the browser and
the budgets an MCP call keeps; the review digest; the `hq-adoption` birth, which is one transaction
through the transaction-taking writers of part 10 (`10-identity-and-the-ledger.md`, B8) and part 11
(`11-project-data.md`, B9); the activation receipt's adoption arm; the census that orders step 7; and
what every other surface does with an app that was brought in. It plans pull request B10 in full.
Pull requests are named by the ids the top-level file gives them (`../6-bring-in.md`, "The stacks":
A1 to A11, B1 to B15), parts by the numbers of their files.

Citations are `path::symbol`: Nova at `main` `15a00a97`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. This
part reads CommCare HQ through part 05's readers only and couples to no HQ field of its own; the two
HQ facts it leans on (the save counter's bracket and the real form ids) are cited where they are used
(3.3) and were read at `d6c6e16d8ae1`.

Versions at `15a00a97`: `lib/models.ts::MODEL_CONTEXT_VERSION` is `"v6-hq-round-trip-case-writes.14"`
and `lib/db/appTests.ts::RUNTIME_VERSION` is `18`. B10 sits above B7, B8 and B9 (stack B's order is
B1 to B6, B8, B9, B7, B10). B9 leaves the first at `"v7-hq-round-trip-bring-in.b9"` (part 11,
`11-project-data.md`, its opening), B7 moves nothing, and A9 leaves the second at `19` (part 04,
`04-names.md`, section 3.4). B10 moves neither: it changes no tool the Solutions Architect holds, no tool
description and no guide sentence (B12 registers the MCP tools: part 13, `13-the-experience.md`,
section 14.1), and no document an App Test pins. It adds no `scripts/test-schema.ts` entry and asks
for no billed run.

| Section | Owns | Pull request |
|---|---|---|
| 2 | `hq_app_readings`: DDL, privilege class, what is and is never stored, states and transitions, who sees a row, retention, Project moves | B10 |
| 3 | the service in `lib/deployment/reading/`: every step function, its idempotency key, bounds and resumption; concurrency; what each circumstance does to a reading | B10 |
| 4 | transport: the six routes, their durations, the allowlist, progress by polling, the MCP budgets | B10 (B12 registers the tools) |
| 5 | the review and its digest; the re-read at creation and the mismatch path | B10 |
| 6 | the `hq-adoption` birth: media first, the candidate, the one transaction and its lock order, refusals, retry | B10 |
| 7 | the receipt's adoption arm: key set, parser, installer | B10 (B11 mounts the flow) |
| 8 | the census and its inspector | B10 |
| 9 | App Tests, app copy, delete and restore, Project move, `search_blueprint` and `get_app`, the first edit turn, the deploy probe, each traced | B10 (no work but the two named tests) |
| 10 | observability: log events and Sentry grouping | B10 |

---

## Decisions in brief

1. **A reading is one row of `hq_app_readings`, and its id is the app's id** (2.1). The id is a
   UUIDv7 Postgres mints when the reading starts; `apps.id` is its text.
2. **The table is runtime read-write**, registered in
   `lib/db/privilegeConvergence.ts::RUNTIME_READ_WRITE_TABLES`, because the birth locks its row `FOR
   UPDATE` (2.2).
3. **Seven states**: `reading`, `media`, `account`, `stopped`, `ready`, `created`, `removed` (2.4).
   `stopped` holds part 01's `stop` circumstances apart from an account, as its section 8.3 requires.
4. **The row holds Nova's words about the app and never CommCare HQ's source** (2.3): the account or
   the review, the manifest revision, the finding codes, the census, the lookup ids predeclared for
   it, part 11's media plan (each file's verdict and published asset), and the save counter the
   bracket held. No form XML, no source JSON, no table row, no document.
5. **A reading belongs to the person who started it, in the Project they chose** (2.5). Only that
   person sees or drives it, and only while they can still edit in that Project. One person holds at
   most one open reading of one HQ app in one Project, so two tabs converge on one row.
6. **Rows are never deleted** (2.6). "Remove" clears everything that names the app, replaces the
   project space and the HQ app's id with a one-way key, keeps the content-free census, and then
   asks part 11 to delete the reading's staged bytes; a created row stays as the birth's
   idempotency record. No reaper, no expiry.
7. **A Project move does not touch the table** (2.7): a created row records where the app was brought
   in, and nothing reads it for authority afterwards.
8. **One function makes every verdict: the read step** (3.3). It reads the app under part 05's
   bracket, reads the Project data, runs the reader and acceptance, and writes one outcome. It runs
   first with no media (acceptance already judging everything but the files), again once the media
   is in, and a third time inside creation. Nothing else decides whether an app can come in. The
   Project data and the files are read, judged and planned through part 11's one surface (its
   section 14); this part composes none of it a second time.
9. **Steps never hold a lock or a lease across CommCare HQ's answers** (3.2). A step reads the row at
   a revision, works, and writes `WHERE revision = $r`; a step that loses the write discards its
   outcome. Two tabs cost a second set of reads and can never corrupt a row. A running step marks
   the row every ten seconds (`step_beat_at`), and a page drives a reading only where that mark is
   absent or more than thirty seconds old; the mark says a step is alive and guards nothing.
10. **A step is bounded at 270 seconds by construction, for every caller** (3.6): 120 for the app,
    60 for Project data, 60 for the reader and acceptance, which run in a worker thread the step
    stops at that bound, and 30 for the step's own reads, its outcome write and, at creation, the
    birth. A fetching media step asks CommCare HQ for at most twelve files, and a publishing step
    starts no file after 120 seconds. An app whose reader and acceptance take more than their own
    60 seconds, or more memory than their worker is given, is `too-large`, with its log line;
    CommCare HQ's slowness never is. One read step at a time holds CommCare HQ's two bodies and
    runs a check on an instance.
11. **The browser drives a reading through six routes under `/api/commcare/readings`** (4), which
    `lib/hostnames.ts::HOSTNAME_ALLOWLIST` already admits through `/api/commcare`. The two long ones
    export `maxDuration = 300`: a step's 270 seconds and 30 for the route. Server Actions are not
    used: Next dispatches a client's actions one at a time, so a four minute step would hold every
    other action of the page.
12. **Progress reaches the page by polling the row every two seconds while its own step is in
    flight** (4.4). No realtime channel is added.
13. **A call runs whole steps and starts another only where its ceiling still fits 270 seconds**
    (4.5): a read step, and creation's final step, run only as a call's first step; a media step
    follows another only in a call's first minute. The browser's routes and the MCP tools keep one
    rule and one budget.
14. **The review digest is the SHA-256 of everything the person was shown and everything the birth
    would write that they were not** (5.2): the review, the document with each media file named by its
    content, the identity rows, the media paths, and the manifest revision. The date of the read is
    left out. No choice the review offers changes the document, so the digest of the review is the
    digest of what is created under any answer.
15. **Creation re-reads CommCare HQ, runs the reader and acceptance again, and creates only where the
    digest is the one the person sent** (5.3). A difference writes the new review and answers
    `review-changed`; nothing is created from a state CommCare HQ has left. A table choice left
    unanswered is part 01's `table-differs-in-project`, answered `held` with the review standing.
16. **Media is published before the candidate is prepared** (6.1), as ordinary ready rows found by
    Project and content hash, in creation steps of their own that record each published file on the
    row, so the document names final asset ids and the final step never publishes. A birth that then
    fails leaves files in the Project's library and nothing else.
17. **The birth is one transaction in one stated lock order** (6.3): the reading row, the HQ app's
    claim, the genesis tail (membership, the app row, then inside a new seam the lookup tables and the
    places, then the gate, export readiness, media edges, entities, the baseline, the case schemas),
    the adopted deployment, and the reading's `created`.
18. **`writePreparedGenesisInTransaction` gains one optional seam, `afterAppInsert`** (6.2), which
    runs after the app row is inserted and before the lookup context is read. It is what lets export
    readiness see the tables the same transaction created, and what lets the tail's organization
    integrity judge the places the birth copies before anything commits.
19. **An adopted app is born `complete`, with no holder, no reservation, no credits, no design
    session, no authoring session and no thread** (6.4).
20. **A gate or export-readiness refusal at birth is Nova's defect, worded as Nova's** (6.5): the
    circumstance `could-not-create`, which part 01 (`01-the-bar-and-the-manifest.md`, sections 8.3
    and 9.3) holds as landing in B10, logged at error. The reading stays and nothing exists.
21. **A retried creation returns the same app** (6.6): a reading in state `created` answers with a
    receipt read back from the saved app, whatever its sequence is by then.
22. **The receipt's adoption arm is a second exact key set** (7): the twelve keys every birth sends
    plus `adoption`. The three existing births send what they send today, so a tab from before the
    deploy still lands a build that finishes after it.
23. **The census is the row's `census` column and one read-only inspector,
    `scripts/inspect-hq-readings.ts`** (8). It prints counts by entry id, standing and step 7 group,
    and nothing that names an app, a project space or a person.
24. **Nothing else in Nova needs to know an app was brought in** (9): App Tests, delete and restore,
    a Project move, `search_blueprint`, `get_app` and the first edit turn each meet an ordinary
    `complete` app. Nova has no app copy.
25. **An app brought in to a Project the tab is not looking at lands by a full load of `/build/{id}`**
    (7.3). The in-tab installer keeps its strict Project check; where the receipt's Project is
    another, the tab holds nothing worth keeping, and the build page opens the app in its own
    Project as any link to it does.

---

## Executed during planning

Read, not run. Nothing here was executed against a database, CommCare HQ or the proof lane.

- **The genesis writer.** `lib/db/appGenesis.ts`, end to end: `prepareGenesisCandidate`,
  `writePreparedGenesisInTransaction`, `GenesisGateRejectedError`, `genesisBatchId`,
  `admitGenesisRuntimeSchemas`, `createExplicitBlankApp`, `AppMaterializationReceipt`;
  `lib/agent/change-set/materializeGenesis.ts::materializeSessionGenesis` (the born-`complete`
  composition this part copies); `app/(app)/build/actions.ts::createStarterApp` and
  `CreatedAppReceiptPayload`; `e2e/lib/smokeSeedFactory.ts` (a held document born through
  `diffDocsToMutations` and the write tail).
- **The kernel and its locks.** `lib/db/CLAUDE.md` (lock ordering, the membership gate, "creation is
  the only shared-gate-first exception", privilege classes, the Project move);
  `lib/db/canonicalCommitKernel.ts::assertProjectCapabilityInTransaction`,
  `lookupContextForAuthoritativeWrite`, `admitExactMediaReferences`;
  `lib/db/projectMembership.ts::projectRoleForInTransaction`; `lib/db/projectMembershipGate.ts`;
  `lib/db/placementAuthority.ts::PLACEMENT_RECORDING_KINDS`, `PLACEMENT_CHANGE_REFUSAL`;
  `lib/db/placementRecords.ts` (the greatest fold baseline's snapshot counts as a recording);
  `lib/db/pg.ts::withAppTx` (retry, `deadlineAt`).
- **Lookup and organization writers.** `lib/lookup/CLAUDE.md`, "Valid writes";
  `lib/lookup/authoringBatch.ts::applyLookupAuthoringBatchInTransaction` and `mintIds`;
  `lib/lookup/agentService.ts` (membership before Project state);
  `lib/organization/commitIntegrity.ts::extractLocationReferenceTargets` and
  `applyOrganizationCommitIntegrity` with the six checks it runs; the DDL of `app_locations` and
  `app_location_references` (`lib/case-store/migrations/20260802010000_organization_model.ts`, both
  `REFERENCES apps(id)`); `lib/export/boundaryValidation.ts::organizationExportFindings` (a
  fixed-place owner is refused by export readiness, `LOCATION_OWNER_EXPORT_NOT_ACTIVE`).
- **Media.** `lib/media/CLAUDE.md` (two statuses, the `pending/` prefix, two concurrent key-lock
  bodies against a three-slot pool); `lib/db/mediaAssets.ts`'s exports (`loadAssetsByIds`,
  `getAssetsInTransaction` and its `FOR SHARE` in id order);
  `lib/domain/mediaRefs.ts::remapAssetRefs`; `lib/domain/multimedia.ts::ASSET_SIZE_CAPS_BYTES`.
- **Access.** `lib/db/appAccess.ts::resolveProjectAccess`, `userInProject`,
  `resolveAuthorizedAppSnapshot`; `lib/auth/projectRoles.ts::roleAllowsApp`;
  `lib/auth-utils.ts::requireSession`, `resolveActiveProjectId`.
- **The home list.** `lib/db/designInProgress.ts::listDesignsInProgress`, called by
  `app/(app)/(site)/app-list.tsx`, and `userHasDesignsInProgress`, called by
  `app/(app)/(site)/page.tsx` for the empty state.
- **Work off the event loop.** `lib/preview/engine/evaluateForm.ts` (a bundled worker under
  `public/form-evaluation/`, built by `scripts/build-xpath-worker.mjs`, started with
  `node:worker_threads` under `resourceLimits: { maxOldGenerationSizeMb: 128 }`, stopped by a timer
  and `worker.terminate()` in `finally`).
- **Memory, and one at a time.** `lib/agent/officeProcess.ts::OfficeParser` (one permit a process,
  waiters woken in turn, the permit released in `finally`) and `lib/agent/officeLimits.ts::
  OFFICE_LIMITS` (a 256 MiB heap and a 768 MiB data limit for its child); `cloudbuild.yaml`'s
  `deploy` step, which passes `gcloud run deploy` no `--memory`;
  `scripts/rollout/deploy-cloud-run.py::_forbid_deploy_policy_overrides` (the flags the deploy
  policy owns, memory not among them) and its `JobTemplateContract`, which holds memory for the
  Jobs of `config/deployment-jobs.json` alone; `scripts/infra/__tests__/cloudBuild.test.ts`, which
  holds the `deploy` step's arguments one by one; `lib/commcare/hq/readJson.ts::readHqJson` and
  `readBoundedBody` (a body is read to its bound as bytes, decoded and parsed, and only the parsed
  value is returned).
- **Transport and limits.** `config/runtime-capabilities.json`;
  `scripts/rollout/render-build-config.mjs::requireStaticRouteTimeout` and its two callers;
  `lib/hostnames.ts::HOSTNAME_ALLOWLIST`, `isPathAllowedOnHost`; `app/api/commcare/upload/route.ts`;
  `app/api/mcp/dispatch.ts::MCP_MAX_DURATION_SECONDS`; `app/api/mcp/route.ts::maxDuration`;
  `app/api/chat/route.ts::maxDuration` and its comment; `lib/deployment/actions.ts`'s exports;
  `lib/deployment/index.ts`'s header and its client importers; `lib/apiError.ts::handleApiError`,
  `readJsonBody` and the request budgets beside them;
  `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, "Sequential dispatch on the
  client".
- **The client.** `components/chat/chatLifecycle.ts::parseAppMaterializationReceipt`,
  `AppMaterializationActivation`; `components/chat/ChatContainer.tsx::installCreatedApp`,
  `verifyActivationDigest`, the `data-app-materialized` handler and `handleCreateStarterApp` (both
  refuse a receipt whose Project is not the session's); `app/(app)/build/[id]/[[...path]]/page.tsx`
  (an existing app's page takes the Project of `resolveAuthorizedAppSnapshot`, never the active
  one); `components/builder/CLAUDE.md`, "Creation never navigates"; `lib/collab/CLAUDE.md`.
- **Registries.** `lib/db/privilegeConvergence.ts` (the five capability sets and
  `RUNTIME_TABLES_WITHOUT_ROW_LOCKS`); `lib/case-store/migrations/index.ts` and
  `20260809000000_design_sessions.ts` (the DDL idiom of a pre-app row); `biome.json`'s
  `noRestrictedImports` (`lib/deployment/**` may import `lib/commcare`).
- **Planning.** `lib/doc/platformDeclaration.ts::planContentDeclaration`, `declaredForContent`;
  `lib/doc/diffDocsToMutations.ts`'s header; `lib/db/apps.ts::appendSyntheticBatchInTransaction`'s
  equality check, `softDeleteApp`, `commitAppProjectMoveInTransaction`.
- **Other surfaces.** `lib/logger.ts::log`, `captureToSentry` (an error passed to `log.error` is
  captured with its message; a message alone is a message event), `SENTRY_TAG_KEYS`;
  `scripts/inspect-usage.ts` (the inspector idiom); `lib/commcare/validator/rules/app.ts`
  (`NO_MODULES`); `docs/architecture/contracts.md` (app birth; "HQ deployment safety").
- **The other parts of this plan**, where this part meets them: 01 (sections 8 and 9), 05 (sections
  3, 4.3, 7, 8, 9, 11, 13), 06 (sections 2.2, 2.3, 4.4, 16.3, 17.3, 17.4 and its hand-offs), 09
  (sections 2.2, 2.4, 12.1, 12.3, 14 and 15), 10 (sections 3, 4.2, 4.6, 5, 6, 8.4 and its
  hand-offs), 11 (sections 2, 3.2, 4, 5.1, 5.5, 6.4, 7, 11.4, 13 and 14, its hand-offs and its
  needs of this part), 13 (sections 8, 9 and 14.1), 14 (section 5.2), the hand-offs of 07 and 08
  to this part, and the openings and hand-offs of 02, 03 and 04.

**Claims corrected, and facts verified.**

- **Verified: a row lock held for a step would hold a pooled connection for minutes.** A row lock
  is held by an open transaction, a step is up to 270 seconds of CommCare HQ's answers, and an
  instance has three pooled connections (`lib/case-store/postgres/connection.ts`, "these 3 pooled
  connections now carry the WHOLE app-state"; `lib/media/CLAUDE.md`, "the current three-slot
  pool"). A step that took its row `FOR UPDATE SKIP LOCKED` for its whole length would hold a third
  of an instance for minutes. Steps compare a revision instead (3.2).
- **Verified: a publish is a route's `fetch`, not a Server Action.** A publish is
  `fetch("/api/commcare/upload")` (`components/builder/PublishDialogBody.tsx::handleUpload`);
  `lib/deployment/actions.ts` says so itself ("Publishing itself stays on `/api/commcare/upload`")
  and carries the card's short actions. A reading follows the publish (4.2).
- **Verified: a bring-in needs the client installer.** `components/builder/CLAUDE.md` ("Creation
  never navigates") forbids a creation that navigates, so a bring-in cannot go to `/build/{id}` in
  place of installing its receipt. The app lands through the one activation receipt, section 7
  gives the receipt its arm, and the one landing that does load a page is Departure 15.
- **Verified: Project state taken before the membership gate can close a lock cycle.** Lookup
  tables made by `applyLookupAuthoringBatchInTransaction` in the order "Project state, then
  tables, then insert the app" would take Project state before the membership gate. Every
  app-bound lookup writer proves membership first (`lib/lookup/agentService.ts` calls
  `projectRoleForInTransaction`, which takes the shared gate, before `lockLookupProjectState`), and a
  shared gate request queues behind a waiting exclusive one, so gate-after-state can close a cycle
  with a lookup writer and a membership write (6.3). The tables are written inside the tail, after
  its membership assertion.
- **Claim corrected (the outline, item 2): "the third owner of the one genesis
  writer".** The writer has three production callers today (`createExplicitBlankApp`,
  `materializeAppFromGenesis`, `materializeSessionGenesis`) and `docs/architecture/contracts.md`
  already lists three births. `hq-adoption` is the fourth.
- **Verified: no document slot holds a lookup row's id.**
  `lib/doc/lookupReferences.ts::LookupReferenceTargetSet` is `tableIds` and `columnTargets`, and
  `rg -n "rowId" lib/domain` finds nothing. Table and column ids are minted with the reading; row ids
  stay the lookup writer's (Departure 2).
- **Read while this plan was settled: the service's memory.** No checked-in file states it. The
  `deploy` step names no `--memory`, so every deploy keeps what the service already holds, and no
  test or script reads it. The service's own description, read once through Cloud Run's API with
  the person's read access, answers 2 GiB of memory, one CPU and 80 concurrent requests an
  instance, and no `NODE_OPTIONS`. Section 3.6 divides that 2 GiB, so B10 writes `--memory=2Gi`
  into the `deploy` step: the figure the division rests on is then checked in, and a deploy holds
  the service to it.
- **Run while this plan was settled: the worker bundle and a CommonJS package.** One three-line
  entry that imports `adm-zip` and adds a file to an archive, bundled with the form evaluation
  worker's own options (`bundle`, `format: "esm"`, `platform: "node"`, `target: "node24"`) under
  the repository's esbuild 0.28.2 and run under Node 24: it throws `Dynamic require of "fs" is not
  supported` as it loads. The same entry with the `createRequire` banner of 3.6 runs and prints its
  one entry. The built form evaluation bundle on disk holds no such stub and no line of Sentry's
  (`rg` over `public/form-evaluation/worker.mjs`), so it is no precedent for a bundle that reaches
  `lib/commcare/compiler.ts`. This is why 3.6 gives the third bundle `require`.
- **Verified: `compiler.ts`'s archive library loads in the worker bundle only with the banner.**
  That the bundle is Node's does not make `adm-zip` load there as it does on the server: the
  server loads it through Node's own `require`, and an ESM bundle has none until it is given one.
  Part 09 (its 15.1) holds the same.
- **Claim corrected (`docs/architecture/contracts.md`): "a persisted empty app, optional seed path,
  independently reconstructed starter, or pre-app placeholder row is forbidden".** The sentence means
  a placeholder `apps` row; `design_sessions` is already a pre-app row. A reading is one too, and the
  sentence is reworded so it stays true ("Contracts").

---

## Written and not yet run

This part writes one gated run, M1. Every other fact it rests on is Nova's own code, read above, or
a reader of part 05's whose runs are part 05's.

**M1. The check fits its memory (B10; by hand on a hosted runner,
`lib/deployment/reading/__tests__/checkMemory.scale.test.ts`).** Section 3.6 gives the check's
worker 736 MiB of old generation and 32 of young, and gives CommCare HQ's two bodies 512 MiB of
the server's own process. Both are a division of the instance, not a measurement, and only a run
says whether an app at Nova's own ceiling fits them. The file is in the `scale` Vitest project and
runs only from `.github/workflows/reader-scale.yml` (part 06, B3), started by hand on B10's branch
on the person's yes, as part 06's R2 and part 09's K4 are. It is never run on a person's machine.

What it runs. The source is the one part 06's run R2 builds, at the ceiling K4 left (150 forms of
200 questions in three languages, or the smaller size K4's outcome C wrote), with the aligned
modules, the three offered declarations and the complete media plan K4's test builds for it. It
takes two measures and prints both:

- **The worker's heap.** `checkReadingInWorker` over that input through the real bundle, under
  `READING_CHECK_RESOURCE_LIMITS`, twice: as a read step (`chosen: null`) and as a creation whose
  chosen declaration takes the split. Each is given a budget of 600,000 ms in place of the
  step's 60,000, because time is K4's question and a check near its limit collects slowly. Each
  must answer `checked`. Then, for the record, the same two under each smaller old generation of
  640, 544, 448, 352 and 256 MiB (young unchanged), stopping at the first that answers
  `over-memory`: the smallest limit that still answered is the heap the check needs, to the
  nearest step, and the test prints it with the limit that failed.
- **The server's share.** A child process (`__tests__/fixtures/readStepMemoryChild.ts`, started
  with `process.execPath --conditions=react-server --import tsx`, as the repository's TypeScript
  scripts start) holds what the server's own process holds of a read step and nothing else. The
  test writes the application resource and the source as two files of JSON; the child sets
  `globalThis.fetch` to one that answers the three addresses of the bracket (the resource, the
  source, the save counter) with each file as a stream, so no body is held by the stand-in. It
  notes `process.memoryUsage().rss`, calls part 05's `readHqAppForReading`, builds the
  `ReadingCheckInput` 3.3 builds (with the project data K4's test gives that source), calls
  `v8.serialize` on it, which is the serialization `workerData` is cloned with, and holds the
  result as a worker's start would. It then prints `process.resourceUsage().maxRSS` (kilobytes)
  less the first note (bytes), in MiB: the peak this process reached for the two bodies, as
  `lib/agent/office.worker.ts` reports its own peak. The test requires it to be at most 512 MiB.

The test asserts both, since memory, unlike time, does not move with a shared runner's load. The
two printed numbers go into B10's description.

- *A: both checks answer `checked` under the production limits, and the child's peak is at or
  under 512 MiB.* Nothing lands beyond the file, its child and the run.
- *B: a check ends on its limit at the ceiling (`over-memory` under the production limits).* The
  heap is not raised, and neither is the service's memory: that is a billed change, and this plan
  makes none. The run is made again over R2's source cut to the sizes of K4's ladder that are
  below the ceiling K4 left (125, then 100, then 75 forms, 200 questions and three languages
  each), and the largest at which both checks answer and the child's peak holds becomes, in B10,
  the size `readerScale.scale.test.ts` builds and the ceiling part 06's run R2 states. K4's
  outcome C and this one write the same number in the same two places, B7 first and B10 after it,
  so the smaller of the two is the ceiling, and the size at which a reading is too large stays
  one number in the plan. K4 is not made again: `acceptance.scale.test.ts` reads R2's source, and
  an app that fit its time at the larger size fits it at the smaller. Past that size a reading's
  check ends `over-memory` and the person is told the app is too large for Nova yet (3.3, step
  8). Where 75 forms does not fit, stack B does not merge and the person is told, with the
  printed peaks of each size.
- *C: both checks answer, and the child's peak is over 512 MiB.* The step stops holding the
  application resource once its menus are typed. In B10, `HqAppReading`'s `read` arm (part 05,
  8.1; `lib/commcare/hq/appReading.ts`, B1's file) loses its `application` member, and
  `readHqAppForReading` keeps the resource's `version` and the typed modules of its step 1 and no
  reference to the `HqApplication`, so `rawModules`, the menus as CommCare HQ sent them, is
  unreachable before the source is asked for. Nothing reads the member: the app's name is the
  source's (5.1), the save counter is `version`, and the question summaries the check needs are
  in the aligned `modules`. `hqAppReading.test.ts` no longer reads the member, the child's
  requirement stands at 512 MiB, and the run is made again. Where the peak is still over
  after that release, the run is made again at the smaller sizes exactly as B does, and B's rule
  gives the ceiling.

B is read before C: where a check ends on its limit and the child is over too, the size comes
down first, and C is asked of the size that then fits.

Three of part 05's runs change this part's tables when they come in, and nothing else of it:

| Part 05's run | Outcome | What changes here, in B10 |
|---|---|---|
| G2 (a remote app) | C: the list holds no remote app | the `remote-app` row leaves the table of 3.8, with the code |
| G3 (a menu HQ cannot summarize) | B: the resource answers 500 | section 3.3 step 3 gains the row `not-summarized`: an account of one `app-unreadable-in-hq` finding at the app, as step 4 gives for `notSummarizedMenus`' `app` answer; 3.8's row stands |
| G7 (a table row with an empty field) | B: 200 with the row | the `table-rows-unreadable` row leaves the table of 3.8, with the code |

The birth's own behavior (atomicity, rollback, the claim race, the idempotent retry, the lock order
under a held lock) is settled by the real-Postgres tests of "Tests", which run in ordinary CI.

---

## 1. What Nova does today

- **Every app is born through one writer.** `lib/db/appGenesis.ts::prepareGenesisCandidate` reduces a
  construction batch from `lib/doc/scaffolds.ts::emptyBlueprintDoc` and
  `writePreparedGenesisInTransaction` writes it: it asserts `edit` in the Project
  (`assertProjectCapabilityInTransaction`), inserts the `apps` row at sequence 1, reads the lookup
  context under `FOR KEY SHARE`, runs the absolute gate, loads the referenced media rows and runs
  `lib/doc/commitVerdicts.ts::exportReadinessFindings`, applies
  `lib/organization/commitIntegrity.ts::applyOrganizationCommitIntegrity`, admits the exact media
  references, replaces the lookup edges, inserts the entity rows, the sequence-one `fold-baseline`
  change and the immutable baseline, and admits the runtime case schemas. A failure of the gate or of
  export readiness throws `GenesisGateRejectedError` and nothing exists.
- **It has three callers, and a birth's provenance is stored nowhere.** `createExplicitBlankApp`
  (the builder's blank app), `materializeAppFromGenesis` (a reviewed build) and
  `materializeSessionGenesis` (an ordinary session's first save, which is how MCP `begin_work` makes
  an app). The database knows one thing about a birth: the sequence-one batch id
  `genesis:<app_id>` (`genesisBatchId`).
- **The tail writes no lookup table, no place and no deployment.** A reviewed build makes its tables
  before the birth; every `lib/deployment/store.ts` writer opens its own transaction.
- **A birth with no run costs nothing and holds nothing.** `createStarterApp` and
  `materializeSessionGenesis` pass `status: "complete"`, no `runHolderNonce` and no `holderTransfer`;
  `lib/db/CLAUDE.md`: "Complete creation does not use holder identity because it creates no holder."
  Only `/api/chat` charges.
- **A birth carries holds.** The tail never calls
  `lib/db/placementAuthority.ts::placementChangeRefusal`, and
  `lib/db/placementRecords.ts::readRecordedPlacementHolds` falls back to the greatest fold baseline's
  snapshot, so the holds a construction batch carries are recorded holds.
  `e2e/lib/smokeSeedFactory.ts` births a held document this way today.
- **Every birth hands the client one receipt.** `AppMaterializationReceipt` is twelve keys;
  `components/chat/chatLifecycle.ts::parseAppMaterializationReceipt` admits exactly that key set and
  `components/chat/ChatContainer.tsx::installCreatedApp` lands it without a route change.
- **Work that exists before its app is a `design_sessions` row**, listed for its owner alone by
  `lib/db/designInProgress.ts::listDesignsInProgress` in the Project they are looking at. It is shaped
  around a model run: a holder, a lease and a credit reservation.
- **Long work in the browser is one request.** A publish is one `POST /api/commcare/upload`; the
  route exports no `maxDuration`. The service's real request ceiling is Cloud Run's
  (`config/runtime-capabilities.json::cloudRunRequestSeconds`, 3600); a route's `maxDuration` is
  advisory on the standalone server (`app/api/chat/route.ts`'s comment), and
  `scripts/rollout/render-build-config.mjs::requireStaticRouteTimeout` holds only the two stream
  routes to the manifest. An MCP request is capped at 300 seconds by contract
  (`app/api/mcp/dispatch.ts::MCP_MAX_DURATION_SECONDS`), measured over the whole request, the
  caller's authentication and the tool's dispatch included.
- **`/api/commcare` is on the main host's allowlist** (`lib/hostnames.ts::HOSTNAME_ALLOWLIST`), and
  matching is by path segment, so every path under it is reachable in production.
- **Nothing reads an app from CommCare HQ.** `rg -i "hq_app_readings|hq-adoption"` over `lib`, `app`,
  `components` and `scripts` finds nothing.

---

## 2. `hq_app_readings`

### 2.1 The DDL

`lib/case-store/migrations/20261203000000_hq_app_readings.ts`, registered in
`lib/case-store/migrations/index.ts` after part 10's `20261201000000_hq_bring_in_ledger` and part
11's `20261202000000_hq_bring_in_project_data` (it references neither). Every statement replays over
its own result (`IF NOT EXISTS`), as `lib/case-store/CLAUDE.md` requires. `down` drops the table and
exists for local teardown only. The module holds the server list once, as `const SERVERS =
"'production', 'india', 'eu'"`, and writes `CHECK (server IN (${sql.raw(SERVERS)}))`, the idiom of
`20260806000000_deployments.ts` and `20261015020000_hq_round_trip_deployment_ledger.ts`; the
statement below is shown as rendered.

```sql
CREATE TABLE IF NOT EXISTS hq_app_readings (
	-- The reading's id, and the id of the app it creates (apps.id is its text).
	id uuid PRIMARY KEY DEFAULT uuidv7(),
	project_id text NOT NULL CHECK (btrim(project_id) <> ''),
	actor_user_id text NOT NULL CHECK (btrim(actor_user_id) <> ''),
	server text NOT NULL CHECK (server IN ('production', 'india', 'eu')),
	-- The project space and CommCare HQ's app id. After Remove, both hold one one-way key (2.6).
	domain text NOT NULL CHECK (btrim(domain) <> '' AND char_length(domain) <= 255),
	remote_app_id text NOT NULL
		CHECK (btrim(remote_app_id) <> '' AND char_length(remote_app_id) <= 255),
	-- CommCare HQ's name for the app, for the home row. Null until the first read and after Remove.
	remote_app_name text CHECK (remote_app_name IS NULL OR char_length(remote_app_name) <= 255),

	state text NOT NULL CHECK (state IN
		('reading', 'media', 'account', 'stopped', 'ready', 'created', 'removed')),
	-- Every outcome a step writes raises it by one; a step writes WHERE revision = what it read.
	revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
	-- What a step in flight is doing, for the page. Not covered by the revision.
	phase text CHECK (phase IN ('connecting', 'waiting', 'reading-app', 'reading-project-data',
		'checking', 'fetching-media', 'publishing-media', 'reading-again', 'creating')),
	-- When a running step last said it was alive (section 3.2): written as the step starts and
	-- every ten seconds while it runs, null once an outcome is written. A liveness mark and no
	-- lock: nothing is refused for it. Not covered by the revision.
	step_beat_at timestamptz(3),
	-- 1 after one read that CommCare HQ's save counter moved under; the next such read stops.
	-- Every other outcome of a read writes 0.
	changed_count smallint NOT NULL DEFAULT 0 CHECK (changed_count IN (0, 1)),
	-- The save counter both ends of the last bracketed read held. Null until one held.
	hq_version integer CHECK (hq_version IS NULL OR hq_version >= 0),
	-- When that read ended: the date the review's kept list carries.
	read_at timestamptz(3),

	-- The surface manifest's revision the last outcome was made under (section 3.9).
	manifest_revision text CHECK (manifest_revision IS NULL OR manifest_revision ~ '^[0-9a-f]{16}$'),
	-- The stop, the account or the review (section 2.3). Null in reading, media, created, removed.
	outcome jsonb,
	review_digest text CHECK (review_digest IS NULL OR review_digest ~ '^[0-9a-f]{64}$'),
	-- Every distinct finding code of the last outcome, sorted.
	finding_codes text[] NOT NULL DEFAULT '{}',
	-- Counts by code (section 8). Content-free. Kept through Remove.
	census jsonb NOT NULL DEFAULT '{"codes":{}}'::jsonb,
	-- The lookup table and column ids predeclared for this reading, by tag and field name
	-- (part 11's predeclaredLookupIdsSchema).
	minted jsonb NOT NULL DEFAULT '{}'::jsonb,
	-- Part 11's media plan (section 2.3): each referenced file, its verdict and, once published,
	-- its asset. Null until a read plans the app's files.
	media jsonb,
	media_total integer NOT NULL DEFAULT 0 CHECK (media_total >= 0),
	media_done integer NOT NULL DEFAULT 0 CHECK (media_done >= 0 AND media_done <= media_total),

	app_id text REFERENCES apps(id) ON DELETE CASCADE,
	created_at timestamptz(3) NOT NULL DEFAULT now(),
	updated_at timestamptz(3) NOT NULL DEFAULT now(),

	CONSTRAINT hq_app_readings_created_names_its_app
		CHECK ((state = 'created') = (app_id IS NOT NULL)),
	CONSTRAINT hq_app_readings_app_is_the_reading
		CHECK (app_id IS NULL OR app_id = id::text),
	CONSTRAINT hq_app_readings_ready_holds_a_digest
		CHECK ((state = 'ready') = (review_digest IS NOT NULL)),
	CONSTRAINT hq_app_readings_outcome_by_state
		CHECK ((state IN ('account', 'stopped', 'ready')) = (outcome IS NOT NULL)),
	CONSTRAINT hq_app_readings_removed_names_nothing
		CHECK (state <> 'removed' OR (remote_app_name IS NULL AND media IS NULL
			AND minted = '{}'::jsonb AND remote_app_id LIKE 'removed:%' AND domain = remote_app_id))
);

-- One open reading of one HQ app per person per Project: two tabs converge on one row.
CREATE UNIQUE INDEX IF NOT EXISTS hq_app_readings_open
	ON hq_app_readings (actor_user_id, project_id, server, domain, remote_app_id)
	WHERE state NOT IN ('created', 'removed');

-- The home list: a person's open readings in the Project they are looking at.
CREATE INDEX IF NOT EXISTS hq_app_readings_home
	ON hq_app_readings (actor_user_id, project_id, updated_at DESC)
	WHERE state NOT IN ('created', 'removed');
```

`project_id` has no foreign key: Better Auth creates `auth_organization` after the case-store ledger
runs (`lib/db/CLAUDE.md`, "Every app belongs to exactly one Project"), which is why `design_sessions`
and `app_deployments` carry a bare `project_id` too. `app_id` references `apps(id)` and nothing
references `apps.project_id`, so the auth-app tenancy migration's catalog of Project references is
untouched. `lib/db/pg.ts::AppDatabase` gains the table's type in the same commit ("lock-stepped with
the DDL").

The migration is additive and the previous revision never reads the table, so it is safe while that
revision serves.

### 2.2 Privilege class

`lib/db/privilegeConvergence.ts::RUNTIME_READ_WRITE_TABLES` gains `"hq_app_readings"`
(classification `application`, capability `read-write`). Registering the table is not optional:
`auditPublicTableInventory` refuses, on every migration run in CI and at deploy, a public table no
policy lists ("The database has a table the inventory doesn't list"). The class is forced by one
statement: the birth takes the row `FOR UPDATE` (6.3), PostgreSQL asks `UPDATE` privilege of a
row-lock clause, and `lib/db/__tests__/runtimeRowLockPrivileges.test.ts` refuses a row lock on any
table of `RUNTIME_TABLES_WITHOUT_ROW_LOCKS`, which is every runtime table that is not read-write.
Serving code never issues `DELETE` against the table (2.6); the class's `DELETE` grant is unused, as
it is for `app_deployments`. Grants converge on the next deploy; the migration grants nothing.
`lib/db/__tests__/privilegeConvergence.postgres.test.ts` derives its expectations from the policy
and needs no per-table edit; it gains one probe, a `SELECT … FOR UPDATE` on `hq_app_readings` under
`SET LOCAL ROLE` to the runtime role, beside its existing lock probes.

### 2.3 What is stored, and what never is

**`outcome`**, by state, parsed by `lib/deployment/reading/types.ts::readingOutcomeSchema`:

```ts
import type { CircumstanceFinding, Finding } from "@/lib/publish/hqFindings";

export type ReadingOutcome =
	/** State `stopped`: the read ended at something that is no fact about the app's content. */
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding }
	/** State `account`: what Nova could not hold, in the app's own order. */
	| {
			readonly kind: "account";
			/** At most `READING_MAX_STORED_FINDINGS`, sorted by place in the app's order. */
			readonly findings: readonly Finding[];
			/** How many findings beyond those the read met. The census counts every one. */
			readonly more: number;
			/** False where the read stopped short of media (the account says so, part 13). */
			readonly mediaChecked: boolean;
	  }
	/** State `ready`: what creating will make (section 5.1). */
	| { readonly kind: "review"; readonly review: ReadingReview };

export const READING_MAX_STORED_FINDINGS = 2000;
```

Each finding is part 01's `Finding` and is parsed by its `findingSchema` (its section 8.1). An
account's findings are sorted by `place` (app, app settings, languages, then menus by index, each
menu's case list, details, search and forms by index, questions by path, then lookup tables by tag,
media by path, organization), then by `code`. An app whose every question holds one unsupported
appearance could give tens of thousands of findings; the row stores the first two thousand and the
count of the rest, and the account says how many more there are (part 13's sentence over `more`).

**`minted`**: part 11's predeclared ids, parsed by its `predeclaredLookupIdsSchema` (its section
5.5), which is `Record<tag, { tableId: LookupTableId; columns: Record<fieldName, LookupColumnId> }>`.
Part 11's `readReadingProjectData` (its 14.1; 3.3, step 5) mints, through the
`lib/lookup/managed.ts::mintLookupIds` this part passes it (one statement over the pool), one table
id for each candidate table and one column id for each of its fields, wherever the row's `minted`
holds none yet, and answers the union, which the step writes back. An id, once minted for a tag or
a field name, is never replaced on that row, so every read of one reading, and a creation retried
after a lost answer, binds the same ids. Which ids a table is bound to (these, or a Project table's
own) is decided inside that same function (part 11, 7.4; 5.2 here). Row ids are not minted here
(Departure 2).

**`media`**: part 11's `ReadingMediaPlan`, parsed by its `readingMediaPlanSchema`
(`lib/deployment/reading/projectData/media.ts`, its section 14.2, B9). This part declares no media
type of its own. The plan holds three things, each by `HqMediaFile.key` (part 11, 2.1): `files`, one
per file the document references, with the paths that name it and the asset id reserved for it
when it was first planned (`reservedId`); `verdicts`, part 11's `HqMediaVerdict` for every file
judged; and `published`, part 11's `PublishedReadingFile` for every held file a creation step has
published into the Project (6.1).

A file's reserved id is `mediaIds.ts::provisionalReadingMediaId(row.id, mediaType, multimediaId)`
(5.2). Wherever a function of part 11's takes `reserve` (its `ReserveMediaId`), this part passes
`(mediaType, multimediaId) => provisionalReadingMediaId(row.id, mediaType, multimediaId)`, so part
11's module imports nothing of B10.

A `held` verdict carries part 11's `StagedMediaFile` (its 2.5): the staged bytes' key, hash, format
and size, and no asset row, since staging writes none. A verdict is kept for as long as the reading
is open, with no expiry of its own (2.6); the staged bytes live one day, by
the bucket's own rule (part 11, Departure 1), and creation fetches again a file whose bytes have
lapsed (6.1). A read step whose reader gave a draft writes the plan part 11's `planReadingMedia`
answers (3.3, step 7.3): a file the row's plan already held keeps its reserved id, its verdict and
its `published` entry, a new file takes a reserved id, and a file the app stopped referencing
leaves with all three, so the row never holds a verdict for a file the app no longer names.
`media_total` is `plan.files.length` and `media_done` the number of those with a verdict.

**The columns that make "Nova has learned more" answerable with no read of CommCare HQ**:
`manifest_revision`, `finding_codes` and `census` (3.9, 8).

**Never stored**: CommCare HQ's app source or any part of it (no form XML, no module JSON, no
`multimedia_map`, no translation), the application resource, a lookup table's rows, a place, the
reader's document or its construction batch, an identity map, a media file's bytes, the person's
key. What the row does hold of the app is what Nova says to the person about it: names of menus,
forms and questions inside findings' places, table tags and field names, file paths and the name
each staged file will take in Files, and the review's counts and names. Every step that needs the
source reads it again (Decision 8); the media step needs none, since the row names the files it is
to fetch. A Postgres test plants a sentinel in a controlled source's form XML and in a table row
and asserts no column of the row holds it after any step ("Tests").

### 2.4 States and transitions

```ts
// lib/deployment/reading/types.ts
export const READING_STATES =
	["reading", "media", "account", "stopped", "ready", "created", "removed"] as const;
export type ReadingState = (typeof READING_STATES)[number];
export const OPEN_READING_STATES =
	["reading", "media", "account", "stopped", "ready"] as const satisfies readonly ReadingState[];
```

| State | Means | The home row offers (part 13 draws it) |
|---|---|---|
| `reading` | the next step is a read step | Continue, Remove |
| `media` | the read was clean and files are still to fetch | Continue, Remove |
| `account` | the read met findings | See the list, Check again, Remove |
| `stopped` | the read ended at a `stop` circumstance | See why, Check again, Remove |
| `ready` | a review waits for the person | Review, Check again, Remove |
| `created` | the app exists | nothing: the row is off the list |
| `removed` | the person removed it | nothing: the row is off the list |

In `reading` and `media` the row says Continue where no step is running and names the running
step where one is (3.1's `stepRunning`; part 13, section 10.2).

The home row and the flow offer "Check again" in the three states the table names. From `media`,
`checkReadingAgain` is reached by MCP's `read_hq_app` with `action: "check_again"` (part 13, section
14.3, B12) and by nothing a person presses.

| From | Event | To | Also written |
|---|---|---|---|
| (none) | `startReading` | `reading` | the key; `revision` 0 |
| `reading` | read step: CommCare HQ's counter moved, first time | `reading` | `changed_count` 1 |
| `reading` | read step: counter moved, second time in a row | `stopped` | `changed-while-reading`; `changed_count` 0 |
| `reading` | read step: a circumstance whose standing is `stop` | `stopped` | the stop; `changed_count` 0 |
| `reading` | read step: any finding, or a circumstance of another standing | `account` | findings, `finding_codes`, `census`, `manifest_revision`, `minted`, `media`, and `remote_app_name`, `hq_version`, `read_at` where the app's own read completed; `changed_count` 0 |
| `reading` | read step: clean but for the files, and a referenced file has no verdict | `media` | `media` (this read's plan, 2.3), `media_total`, `media_done`, `minted`, `remote_app_name`, `hq_version`, `read_at`; `changed_count` 0 |
| `reading` | read step: clean, every referenced file held (or none referenced) | `ready` | the review, `review_digest`, `census`, `manifest_revision`, `minted`, `media` (this read's plan), `media_total`, `media_done`, `remote_app_name`, `hq_version`, `read_at`; `changed_count` 0 |
| `media` | media step: files remain | `media` | `media` (the plan with the verdicts reached), `media_done` |
| `media` | media step: every planned file has a verdict | `reading` | `media`, `media_done`; the next read step makes the verdict with the files' facts |
| `media` | media step: CommCare HQ failed a file after its resend | `stopped` | the stop of `hqReadCircumstance`; every verdict reached is kept |
| `account`, `stopped`, `ready`, `media` | `checkReadingAgain` | `reading` | `outcome`, `review_digest` null; `changed_count` 0; `media` and `minted` kept |
| `ready` | creation, a media step: files published, or files whose bytes had lapsed fetched again (6.1) | `ready` | `media` (the plan each answer of part 11's carries); the review and its digest stand |
| `ready` | creation: the re-read gives another digest, a finding, an ending stop (3.8), or a referenced file with no verdict | `ready`, `account`, `stopped` or `media` | as the read step writes |
| `ready` | creation: CommCare HQ's counter moved, first time | `ready` | `changed_count` 1; the second time writes 0 and answers `held` |
| `ready` | creation: the birth's own checks refuse | `account` | `could-not-create` |
| `ready` | creation: the birth ran past its time | `account` | `too-large` (3.6) |
| `ready` | creation: the HQ app is claimed | `stopped` | `already-in-nova` |
| `ready` | creation: a Project table changed under the birth (6.5) | `reading` | as `checkReadingAgain` writes |
| `ready` | creation: a published file left the Project's library before the birth (6.5) | `ready` | `media` less that file's entries |
| `ready` | creation commits | `created` | `app_id`; `outcome`, `review_digest`, `media`, `phase`, `step_beat_at` null; `minted` emptied |
| any open state | `removeReading` | `removed` | 2.6 |

`created` and `removed` are terminal. Every transition but those two is one `UPDATE … WHERE id = $1
AND revision = $2` that sets `revision = revision + 1`, `phase = NULL`, `step_beat_at = NULL` and
`updated_at = now()` (3.2). The two terminal writes clear both columns too, so no write that raises
the revision leaves a step marked as running. `created` is written inside the birth's transaction
under the row's lock (6.3), and `removed` under a row lock of its own (2.6). `changed_count` is 1
only between a read the counter moved under and the next read's outcome: every outcome of a read
step and of creation's re-read other than that first `changed` writes 0, so a counter that moves
once before a clean review and once more at creation, days later, is two first times and never a
stop.

### 2.5 Who may see and act on a row

The reading was made with one person's CommCare HQ key and says things about an app that key can
read; a co-member of the Project may have no access to that project space at all. So a row is its
actor's alone, as a design in progress is its owner's (`lib/db/designInProgress.ts`).

| Act | Requires |
|---|---|
| list (`listOpenReadings`) | the session user is `actor_user_id`, and holds `view` in `project_id`; a caller without it gets an empty list |
| read one (`readReading`) | the same; anything else is not found |
| start, advance, check again, create | the session user is `actor_user_id` (for start: becomes it) and holds `edit` in `project_id`, checked at the start of every call through `lib/db/appAccess.ts::resolveProjectAccess` |
| remove | the session user is `actor_user_id` |

A row another person holds, a row that does not exist and a removed row are one answer, not found
(`reading_not_found`), so an id says nothing to someone it does not belong to. The Project is the one
the person chose at the first screen (part 13, `13-the-experience.md`, section 4.1, B11);
`startReading` takes it as an argument
and never reads the session's active Project, as
`app/(app)/build/actions.ts::createStarterApp` does not. A person who lost `edit` after starting
still sees the row and can remove it; advancing answers `project_access_lost` ("Copy"). The birth
asserts `edit` again inside its transaction, through the tail.

Project admins and owners get no view of another member's reading. The one thing they need from it,
that an HQ app is already in Nova and who holds it, they get from part 10's claim
(`readHqAppClaims`), which exists only once an app does.

### 2.6 Retention and removal

- **No expiry.** An open row stays until its person removes it or creates from it. An abandoned
  open row is a row and, for a day, staged bytes under the media contract's `pending/` prefix,
  which the bucket's own rule deletes (part 11, 2.5); nothing else is held for it. There is no
  reaper and no scheduled work.
- **Remove** (`removeReading`) is one transaction that takes the row `FOR UPDATE`, requires an open
  state, and sets `state = 'removed'`, `outcome`, `review_digest`, `remote_app_name`, `media`,
  `phase`, `step_beat_at`, `hq_version` and `read_at` null, `media_total`, `media_done` and
  `changed_count` 0, `minted` empty, `domain` and `remote_app_id` both to
  `store.ts::removedAppKey(server, domain, remoteAppId)`, and raises `revision`. The transaction
  touches no storage. After it commits, `removeReading` calls part 11's `discardReadingMedia({
  projectId, plan })` (its 14.2) with the plan the row held, read under the lock before it was
  cleared: a best-effort delete of each held file's pending bytes, and what it misses the bucket's
  one-day rule deletes. It deletes nothing a ready row names: a file a creation step already
  published is an ordinary file of the Project that the person asked for when they pressed Bring
  it in (6.1). `finding_codes`, `census`, `manifest_revision`, `server`, `project_id`,
  `actor_user_id`, `created_at` and `updated_at` stay. The person can start a new reading of the
  same app at once (the `hq_app_readings_open` index leaves removed rows out).
- **What a removed row still says.** `removedAppKey` is `"removed:"` followed by the SHA-256, in
  hex, of `canonicalJsonText([server, domain, remoteAppId])`. The census needs one thing of a
  removed row, to count an app a person checked five times once (8.2), and a one-way key gives it:
  the inspector computes the same key for every row it reads. So a removed row holds entry ids,
  counts, the server, a Nova user id and a Project id, and no longer says which project space or
  which app that person read.
- **A created row** keeps its key, `app_id`, `finding_codes`, `census` and `manifest_revision`. It is
  what makes a retried creation return the same app (6.6) and what the census counts as an app that
  came in. It cascades with its app's row, which no runtime path deletes.
- **Rows are never deleted by serving code.** The write-verb source guard needs no entry: the table
  is read-write.

### 2.7 Project moves

`lib/db/apps.ts::commitAppProjectMoveInTransaction` does not name `hq_app_readings`, and B10 does not
add it. An open reading has no app, so no move meets it. A created row's `project_id` is where the
app was brought in, a fact about the past; after creation nothing reads it for authority: a retried
creation authorizes against the app's own current Project (`resolveAuthorizedAppSnapshot`, 6.6). The
row is absent from the move's re-tenanting list on purpose, and a real-Postgres test holds that a
move leaves it byte-equal and that the retry still answers ("Tests"). An adopted app that reads a
lookup table cannot move at all (`lib/db/apps.ts`: the structural and stored lookup targets must both
be empty), which part 13's first screen says beside the Project choice.

---

## 3. The service: `lib/deployment/reading/`

`lib/deployment/**` is an allowed consumer of `lib/commcare` (`biome.json`), so the service may call
the reader in `lib/commcare/reader/` and part 05's readers. No file of `lib/db` imports
`lib/deployment` at runtime today (`lib/db/pg.ts` imports two types of
`lib/deployment/entryPointTypes` and nothing else) and none does after B10: the table's SQL lives in
`lib/deployment/reading/store.ts`, as the deployment tables' SQL lives in `lib/deployment/store.ts`.

| File | Exports |
|---|---|
| `types.ts` | `READING_STATES`, `ReadingState`, `OPEN_READING_STATES`, `READING_PHASES`, `ReadingPhase`, `ReadingKey`, `ReadingOutcome`, `readingOutcomeSchema`, `READING_MAX_STORED_FINDINGS`, `ReadingReview`, `readingReviewSchema`, `ReadingDeclarationChoice`, `ReadingLearned`, `ReadingView`, `ReadingSummary`, `ReadingRefusal`, `READING_REFUSALS`, `READING_REFUSAL_STATUS`, `BringInInput`, `bringInInputSchema`, `CreateResult`; and, re-exported from part 11's `lib/deployment/reading/projectData/reviewTypes.ts` (B9), `ReviewTable` and `ReviewPlaces`. Client-safe: its run-time imports are `zod`, `PLATFORMS` (`@/lib/domain`), part 01's `findingSchema` (`lib/publish/hqFindings.ts`), part 09's `firstPublishViewSchema` (`lib/publish/firstPublishChangeIds.ts`) and part 11's `reviewTypes.ts` (`LOOKUP_TABLE_CHOICES`, `reviewTableSchema`, `reviewPlacesSchema`), none of which imports a server module; everything else it imports is a type |
| `budget.ts` | `HQ_READING_STEP_SECONDS`, `HQ_READING_STEP_MS`, `HQ_READING_ROUTE_MARGIN_SECONDS`, `HQ_READING_CHECK_BUDGET_MS`, `HQ_READING_WRITE_RESERVE_MS`, `HQ_READING_OUTCOME_WRITE_MS`, `HQ_READING_CHECK_HEAP_MB`, `HQ_READING_CHECK_YOUNG_MB`, `HQ_READING_SLOT_WAIT_MS`, `HQ_READING_STEP_BEAT_MS`, `HQ_READING_STEP_QUIET_SECONDS`, `HQ_MEDIA_STEP_WORK_MS`, `HQ_MEDIA_STEP_CEILING_MS`, `HQ_MEDIA_PUBLISH_DEADLINE_MS`, `stepFits` (3.6) |
| `store.ts` | `insertOrFindOpenReading`, `loadReading`, `listOpenReadingRows`, `hasOpenReadingRow`, `writeReadingOutcome`, `ReadingOutcomePatch`, `writeReadingPhase`, `beatReadingStep`, `lockReadingInTransaction`, `markReadingCreatedInTransaction`, `markReadingRemoved`, `removedAppKey`, `ReadingRow` |
| `beat.ts` | `withStepBeat`: the one timer that marks a running step (3.2) |
| `slot.ts` | `ReadingSlot`, `ReadingSlots`, `createReadingSlots`, `processReadingSlots`: the instance's one reading slot (3.6) |
| `service.ts` | `startReading`, `readReading`, `listOpenReadings`, `userHasOpenReadings`, `advanceReading`, `advanceReadingWithin`, `checkReadingAgain`, `removeReading` |
| `gather.ts` | `gatherReading`, `GatherInput`, `Gathered`, `GatherResult`, `GatheredFacts`, `unrecognizedLogKey` |
| `check.ts` | `runReadingCheck`, `ReadingCheckInput`, `ReadingCheck` (3.6): the reader, part 11's verdicts and acceptance as one pure function of plain data |
| `checkWorker.ts`, `checkInWorker.ts` | the worker's entry, and `checkReadingInWorker` with `ReadingCheckAnswer`, which starts it, bounds it and stops it (3.6) |
| `mediaIds.ts` | `READING_MEDIA_NAMESPACE`, `provisionalReadingMediaId`, `reviewMediaId` |
| `digest.ts` | `reviewDigestOf`, `ReviewDigestInput` |
| `create.ts` | `createFromReading`, `createFromReadingWithin` |
| `birth.ts` | `adoptHqAppInTransaction`, `AdoptionBirth`, `AdoptionOutcome`, `adoptedDeploymentWrite`, `adoptedAppReceipt`, `readBackAdoptedAppReceipt` |
| `census.ts` | `censusOf`, `ReadingCensus`, `readingCensusSchema`, `mergeCensuses` |
| `learned.ts` | `whatNovaLearned` |
| `index.ts` | `import "server-only"`; the server surface: the `service.ts` and `create.ts` functions and the types above. Routes and MCP tools import it; no client module does |

There is no `mediaState.ts`: the media plan, its index and its merge are part 11's
(`lib/deployment/reading/projectData/media.ts`, its section 14.2), its staging and publishing are
in `mediaStore.ts` beside that file, and this part calls them. `check.ts` and `checkWorker.ts`
import part 11's pure files alone (`projectData/index.ts`, `media.ts`, `lookupTables.ts`,
`places.ts`, `review.ts`, `settlements.ts`); the service, `gather.ts`, `create.ts` and `birth.ts`
import its store files too (`read.ts`, `mediaStore.ts`, `lookupTableStore.ts`, `placeStore.ts`).

`lib/commcare/surface/revision.ts` exists from B2, which carries `surfaceStandingsRevision()` as 3.9
writes it (part 06, `06-the-reader-forms.md`, section 2.1); B10 adds `currentStandingOf(code)` (3.9)
and `isDeclaredSurfaceKey(key)` (10).

### 3.1 The views

```ts
// lib/deployment/reading/types.ts
import type { CommCareServer } from "@/lib/commcare/servers";

export interface ReadingKey {
	readonly projectId: string;
	readonly server: CommCareServer;
	readonly domain: string;
	readonly remoteAppId: string;
}

export const READING_PHASES = ["connecting", "waiting", "reading-app", "reading-project-data",
	"checking", "fetching-media", "publishing-media", "reading-again", "creating"] as const;
export type ReadingPhase = (typeof READING_PHASES)[number];

/** One reading as its person sees it. What every route and MCP tool returns. */
export interface ReadingView {
	readonly id: string;
	readonly projectId: string;
	readonly server: CommCareServer;
	readonly domain: string;
	readonly remoteAppId: string;
	readonly remoteAppName: string | null;
	readonly state: ReadingState;
	readonly revision: number;
	/** True where a step marked the row within the last `HQ_READING_STEP_QUIET_SECONDS` (3.2). */
	readonly stepRunning: boolean;
	/** What the running step last reported. Null where `stepRunning` is false. */
	readonly phase: ReadingPhase | null;
	readonly media: { readonly done: number; readonly total: number } | null;
	readonly outcome: ReadingOutcome | null;
	readonly reviewDigest: string | null;
	/** ISO 8601, when the last bracketed read ended. */
	readonly readAt: string | null;
	readonly updatedAt: string;
	/** For an account: what the manifest holds now of what the list named (3.9). */
	readonly learned: ReadingLearned | null;
	/** The app's id once `state` is `created`. Equal to `id`. */
	readonly appId: string | null;
}

/** One home-list row: the view without its outcome. */
export type ReadingSummary = Omit<ReadingView, "outcome" | "reviewDigest"> & {
	/** For an account: how many findings it holds, by label. */
	readonly counts: { readonly notYet: number; readonly never: number;
		readonly fixInHq: number } | null;
	/** For a stop: its code, so the row can word it. */
	readonly stopCode: ReadCircumstance | null;
};
```

`counts` is read from `census` (8.1). `stepRunning` is the row's `step_running` (3.2): the database
compares `step_beat_at` with its own clock, so no server's clock and no browser's enters it.
`phase` is reported only where `stepRunning` is true, so a step that died with its instance stops
showing as in flight thirty seconds later, without any write, and the page never names a step
nothing is running.

### 3.2 How a step writes: one compare of a revision

Every step has the same three moves, and none of them holds a transaction across a read of CommCare
HQ:

1. `loadReading(id)`: the row, with its `revision` r. Authorize (2.5).
2. The work: reads of CommCare HQ, the reader, staging, inside `beat.ts::withStepBeat(id, r, run)`
   (below). `writeReadingPhase(id, r, phase)` as it goes (`UPDATE … SET phase = $3, step_beat_at =
   now()` over the row at `id = $1 AND revision = $2`, taken `FOR UPDATE SKIP LOCKED` as the beat
   below takes it; it touches neither `revision` nor `updated_at`, and its losing is harmless).
3. `writeReadingOutcome(id, r, fromState, patch)`: `UPDATE … SET …, revision = revision + 1, phase =
   NULL, step_beat_at = NULL, updated_at = now() WHERE id = $1 AND revision = $2 AND state = $3
   RETURNING *`. One row: the step's outcome stands. No row: another step or act won; the step
   discards its outcome, loads the row again and returns it as the winner wrote it, with
   `log.info("[reading] step lost its write")`.

**Whether a step is running is its own fact.** `phase` cannot say it: a step writes its first
phase only once it has work to name, and a step that dies leaves its last phase behind. So a
running step marks the row, and everything that asks "is a step running" reads the mark:

```ts
// lib/deployment/reading/beat.ts
/**
 * Runs one step's work with the row marked as running. It awaits `beatReadingStep(id, revision)`
 * once before `run` starts, then again every `HQ_READING_STEP_BEAT_MS` from one `setInterval` it
 * owns, and in `finally` clears the interval and awaits the beat still in flight, if one is, so no
 * write of the step outlives it. A beat that fails is logged at warn and never fails the step.
 */
export function withStepBeat<T>(
	id: string, revision: number, run: () => Promise<T>,
	/** `beatReadingStep` unless a test passes its own ("Tests"). */
	beat: (id: string, revision: number) => Promise<void> = beatReadingStep,
): Promise<T>;

// lib/deployment/reading/store.ts
/**
 * `UPDATE hq_app_readings SET step_beat_at = now() WHERE id IN (SELECT id FROM hq_app_readings
 * WHERE id = $1 AND revision = $2 FOR UPDATE SKIP LOCKED)`. A beat never waits for the row: where
 * the birth or a Remove holds its lock (6.3, 2.6), the beat finds no row and returns, so it
 * cannot hold one of an instance's three pooled connections behind a transaction.
 */
export async function beatReadingStep(id: string, revision: number): Promise<void>;
```

- **Who writes it.** Every step: a read step, a media step, and each step of a creation (5.3),
  from the moment it has loaded and authorized the row until it has written its outcome or ended
  without one. The wait for the reading slot (3.6) is inside it, so a step that is waiting its
  turn is a running step. The timer fires because the step's long work is never on the event loop:
  its reads of CommCare HQ are awaited, and the reader and acceptance run in a worker (3.6).
- **What clears it.** Every write that raises the revision: an outcome (move 3), `checkReadingAgain`,
  `removeReading` and the birth's `created`. A step that ends without one (it lost its write, it
  found the slot busy, it threw) stops its timer and writes nothing more, and its last mark ages
  out. A beat is bound to the revision the step loaded, so once any write has raised the revision,
  the beats of a step still working at the old one find no row.
- **Who reads it.** Every read of a row answers `step_running`, computed by the database in the
  same statement: `step_beat_at IS NOT NULL AND step_beat_at > now() - make_interval(secs =>
  $quiet)`, `$quiet` being `HQ_READING_STEP_QUIET_SECONDS` (30, three missed beats).
  `ReadingRow` carries it, and `ReadingView.stepRunning` is it (3.1). A write's `RETURNING`
  answers it as false, since every such write has just cleared the mark. A page drives a reading
  whose state is `reading` or `media` once two rows in a row have said `stepRunning` is false,
  and only polls otherwise (4.4). So a step that takes a minute to reach its first phase gets no
  second driver, and a step whose instance was killed is taken over thirty seconds after its last
  beat, by whichever tab has the reading open, with `phase` already reported null.
- **What it is not.** It is a liveness mark and no lock. The service starts a step for whoever
  asks, whatever the mark says, and nothing is refused or delayed for it: an MCP call, or a tab
  whose own request was lost, may start a second step beside a running one. Correctness rests
  where it did, on the revision compare of move 3 and on the media merge (3.4). The mark only
  keeps a page that did not start a step from starting a second one for no reason.

```ts
// lib/deployment/reading/store.ts
/** The stored row, and `step_running` as the statement that read it computed it (above). */
export type ReadingRow = Selectable<AppDatabase["hq_app_readings"]> & {
	readonly step_running: boolean;
};
export async function insertOrFindOpenReading(
	key: ReadingKey, actorUserId: string,
): Promise<ReadingRow>;
export async function loadReading(id: string): Promise<ReadingRow | null>;
export async function listOpenReadingRows(
	actorUserId: string, projectId: string, limit: number,
): Promise<readonly ReadingRow[]>;
/** Whether the person holds an open reading in the Project: one indexed `LIMIT 1` read. */
export async function hasOpenReadingRow(actorUserId: string, projectId: string): Promise<boolean>;
export async function writeReadingPhase(
	id: string, revision: number, phase: ReadingPhase,
): Promise<void>;
/**
 * What one outcome writes. `state` is always written. Every other member that is present
 * replaces its column, and one that is absent leaves the column as it is. `media_total` and
 * `media_done` are written from `media` whenever it is present (2.3). `revision`, `phase`,
 * `step_beat_at` and `updated_at` are the function's own.
 */
export interface ReadingOutcomePatch {
	readonly state: (typeof OPEN_READING_STATES)[number];
	readonly outcome?: ReadingOutcome | null;
	readonly reviewDigest?: string | null;
	readonly changedCount?: 0 | 1;
	readonly remoteAppName?: string | null;
	readonly hqVersion?: number | null;
	readonly readAt?: string | null;
	readonly manifestRevision?: string;
	/** Written together: `findingCodes` is the sorted keys of `census.codes` (8.1). */
	readonly findingCodes?: readonly string[];
	readonly census?: ReadingCensus;
	readonly minted?: PredeclaredLookupIds;
	readonly media?: ReadingMediaPlan | null;
}
/** Null where the row is no longer at `revision` in `fromState`. */
export async function writeReadingOutcome(
	id: string, revision: number, fromState: ReadingState, patch: ReadingOutcomePatch,
): Promise<ReadingRow | null>;
export async function lockReadingInTransaction(
	tx: Transaction<AppDatabase>, id: string,
): Promise<ReadingRow | null>;
export async function markReadingCreatedInTransaction(
	tx: Transaction<AppDatabase>, id: string,
): Promise<void>;
/**
 * Null where the actor holds no such row. Otherwise the Project and the media plan the row held
 * before this call cleared it, for `discardReadingMedia` (2.6); `media` is null where the row
 * held none or was removed already.
 */
export async function markReadingRemoved(
	id: string, actorUserId: string,
): Promise<{ readonly projectId: string; readonly media: ReadingMediaPlan | null } | null>;
/** The one-way key a removed row holds in place of its project space and HQ app id (2.6). */
export function removedAppKey(server: CommCareServer, domain: string, remoteAppId: string): string;
```

`insertOrFindOpenReading` is `INSERT … ON CONFLICT (actor_user_id, project_id, server, domain,
remote_app_id) WHERE state NOT IN ('created', 'removed') DO NOTHING RETURNING *`, then a select of
the open row where the insert returned none. JSON columns are written with `JSON.stringify` and read
through the schemas of `types.ts` and `census.ts` and part 11's `predeclaredLookupIdsSchema` and
`readingMediaPlanSchema`; a row whose JSON fails its schema is an invariant failure, thrown and logged
at error, never shown. The DDL's defaults (`{"codes":{}}`, `{}`) are values those schemas admit, so
the row `startReading` inserts parses.

**Why no lease.** A reading holds none (Decision 9), and going without one costs little: two
drivers of one reading are one person with two tabs or an agent and a tab, they double the reads of
one step, and CommCare HQ's limiter answers the second with a wait or a `rate-limited` the loser's
write never lands. The mark above makes two drivers rare; it does not make them impossible, and
nothing needs it to. The media step is the one place where discarded work would be real work, so it
merges instead (3.4).

### 3.3 The read step

```ts
// lib/deployment/reading/gather.ts
export interface GatherInput {
	readonly row: ReadingRow;
	readonly actorUserId: string;
	/**
	 * The answer for each table that asks one, by tag, as part 11's `resolveTableChoices` accepted
	 * them (5.3, step 3). Null in a read step.
	 */
	readonly tableChoices: Readonly<Record<string, LookupTableChoice>> | null;
	/** The declaration the person chose (`BringInInput`'s two members). Null in a read step. */
	readonly chosen: { readonly runsOnlyOn: Platform | null;
	                   readonly splitDatetime: boolean } | null;
	/** `Date.now` in production; a test's own clock. */
	readonly now: () => number;
	readonly onPhase: (phase: ReadingPhase) => Promise<void>;
	/**
	 * Takes the instance's one reading slot (3.6), waiting at most `HQ_READING_SLOT_WAIT_MS`.
	 * False where another step still holds it. The step that passed this releases the slot.
	 */
	readonly takeSlot: () => Promise<boolean>;
}

export type GatherResult =
	/** Another step holds the instance's reading slot. Nothing of CommCare HQ's app was read. */
	| { readonly kind: "busy" }
	/** CommCare HQ's save counter moved under the read. */
	| { readonly kind: "changed" }
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding }
	| { readonly kind: "account"; readonly findings: readonly Finding[];
	    readonly mediaChecked: boolean; readonly facts: GatheredFacts }
	/** Clean but for the files, and a referenced file has no verdict yet. */
	| { readonly kind: "needs-media"; readonly facts: GatheredFacts }
	| { readonly kind: "clean"; readonly gathered: Gathered };

/** What every non-stop result carries for the row. */
export interface GatheredFacts {
	/** The three facts of the app's own read. Null where that read did not complete. */
	readonly remoteAppName: string | null;
	readonly hqVersion: number | null;
	readonly readAt: string | null;
	/** The row's predeclared ids with any minted in this step added (part 11, 5.5). */
	readonly minted: PredeclaredLookupIds;
	readonly manifestRevision: string;
	/** This read's plan where the reader gave a draft, else the row's own, unchanged (2.3). */
	readonly media: ReadingMediaPlan | null;
	/** `media.files.length`, and how many of them hold a verdict; 0 where `media` is null. */
	readonly mediaTotal: number;
	readonly mediaDone: number;
}

/** A clean read, held in memory for the length of one request and never stored. */
export interface Gathered {
	readonly facts: GatheredFacts;
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
	/** Part 06's draft: the document, its construction batch, its identities, its declarations. */
	readonly draft: ReadDraft;
	readonly accepted: Extract<AcceptedReading, { ok: true }>;
	/** Part 11's `readingProjectDataWrite`: the tables and the places the birth writes (6.3). */
	readonly projectData: ReadingProjectDataWrite;
	/** Part 11's `readingLookupSnapshot`: the tables the document reads, as the birth will hold
	 *  them. Acceptance's `lookup`, and what `adoptionExportBoundary` names its tables from (6.2). */
	readonly lookup: LookupFixtureDataSnapshot;
	/** Part 11's `adoptedMediaFiles(files)`: one entry per referenced path of every held file. */
	readonly mediaFiles: readonly AdoptedMediaFile[];
	readonly review: ReadingReview;
	readonly reviewDigest: string;
}

export function gatherReading(input: GatherInput): Promise<GatherResult>;
```

`gatherReading`, in order. Every numbered move that can end the step says how.

1. **Connection** (`connecting`). `lib/db/settings.ts::getHqCredentials(actorUserId, row.domain)`
   (today's `getCredentialsForUpload`, renamed by part 05, section 11). `not_configured`, or
   credentials whose `server` is not the row's (a person stores one connection, on one server):
   `stop`, `not-connected`. `not_authorized` (the project space is not among the stored
   `approved_domains`): `stop`, `not-a-member`. `ambiguous` cannot be answered where a project space
   is named, and is thrown as an invariant failure.
2. **The claim, as advice.** `lib/deployment/store.ts::readHqAppClaims({ viewerUserId, server, domain,
   remoteAppIds: [remoteAppId] })` (part 10, 5.5). A view: `stop`, `already-in-nova`, with the view
   less `remoteAppId` as `detail.claim`. This read decides nothing; the claim inside the birth does.

   **Then the slot**, before anything of the app is read: `await input.takeSlot()`. False ends the
   step with `{ kind: "busy" }` and nothing read; true lets it on, holding the instance's one
   reading slot until the step ends (3.6). The two stops above are answered without it, so a
   reading with no connection never waits behind another reading's check.
3. **The app** (`reading-app`). `lib/commcare/hq/appReading.ts::readHqAppForReading(creds, domain,
   remoteAppId)`, one bracketed attempt under `HQ_APP_READING_DEADLINE_MS` (part 05, 8.2).

   | Answer | Result |
   |---|---|
   | `read` | continue |
   | `changed` | `{ kind: "changed" }` |
   | `linked`, `remote`, `deleted`, `gone` | `stop`: `linked-app`, `remote-app`, `app-deleted`, `app-gone` |
   | `failed` | `hqReadCircumstance(failure)`: `stop` where `CIRCUMSTANCE_STANDINGS` says `stop`, else an account of that one finding (`too-large`) |

   The bracket rests on CommCare HQ's save counter, read at `d6c6e16d8ae1` for this part:
   `app_manager/models/applications.py::ApplicationBase.save` raises `version` on every save of a
   working app unless the caller passes `increment_version=False`;
   `app_manager/dbaccessors.py::get_current_app_version` reads it from the `applications_brief` view;
   `app_manager/views/releases.py::current_app_version` serves it. The real form ids come from
   `api/resources/v0_4.py::ApplicationResource.dehydrate_module` (`form.unique_id`). All four are
   alive: none sits behind a flag and none is marked deprecated. Part 05 (8.2) holds the two saves
   that do not raise the counter and why neither opens the bracket.
4. **Menus CommCare HQ could not summarize.** `notSummarizedMenus(modules)`: `app` is an account of
   one `app-unreadable-in-hq`; `menus` adds one `menu-unreadable-in-hq` finding at each index (place
   `{ kind: "menu", menu, name }`, the name from the source) to the findings of step 7 and makes the
   result an account whatever the reader says. HQ's message goes to the log with the menu's position
   and to no person (part 01, 8.3).
5. **Project data** (`reading-project-data`). One `withHqRequestDeadline(run,
   HQ_PROJECT_DATA_READING_DEADLINE_MS)` (part 05, 3.3) around one call of part 11's (its 14.1):

   ```ts
   readReadingProjectData({ creds, server, domain, projectId, actorUserId, readingId: row.id, source,
   	minted: row.minted, mintIds: mintLookupIds, choices, places: "when-source-reads", within })
   ```

   `within` is the `HqReadDeadline` that deadline hands, `mintLookupIds` is
   `lib/lookup/managed.ts`'s, and `choices` is `input.tableChoices`: null at a read step, and at
   creation the answers `resolveTableChoices` accepted. Everything of project data is inside that
   call, and this part makes none of its reads itself: the table list and the rows of each table
   the source's text may name, the ids minted for them, the Project's side (its tables of those
   tags, the apps that read them, the sibling mappings, the person's role), each table's standing
   and binding, the reader's lookup catalog, and, where the source may read places, CommCare HQ's
   levels and places. Part 06 plans no scan of the forms' reads (its 17.4), and the reading adds
   none: part 11's source test is the one way candidate tables are named (Departure 17).

   A `failed` answer is `hqReadCircumstance(failure)`, as in step 3. A `read` answer carries
   `data`, part 11's `ReadingProjectData`: `data.lookups` and `data.organization` are the reader's
   two inputs, `data.minted` is what the step writes back to `minted`, `data.placesRead` says
   whether the levels and places were read, and `data.gathered` is what the check judges. A table
   whose rows CommCare HQ could not send is no failure of this step: it is that table's finding,
   raised in step 7.2 where the app reads the table.
6. **The media index.** Part 11's `readingMediaIndex({ source, plan: row.media, reserve: (t, id) =>
   provisionalReadingMediaId(row.id, t, id) })` (its 14.2) builds part 06's `ReaderMediaIndex` (its
   2.2) by the rows of part 11's table there: a path resolves `no-entry`, `unreadable` (a file
   whose verdict is `missing` among them) or `asset`, with the kind its media type gives and, as
   its id, the published file's where the plan holds a `published` entry for the file, else the
   file's `reservedId`, else what `reserve` answers. `reserve` is a function of the reading's id
   and CommCare HQ's two ids for the file, so a file is named by one id whether or not it has a
   verdict, and the document is the same before the media step and after it (part 06's rule, its
   17.4). A plan holds a `published` entry only once a creation step wrote one (6.1): a read step
   of a reading no creation has touched names every file by its reserved id, and creation's final
   step, which runs only once every held file is published, names every held file by its ready
   asset. The digest sees neither kind of id (5.2), so `GatherInput` carries no mode for it. The
   index is function-valued, so it is built on the worker's side of step 7 (3.6).
7. **The check** (`checking`). `checkInWorker.ts::checkReadingInWorker(input,
   HQ_READING_CHECK_BUDGET_MS)` runs `check.ts::runReadingCheck` in a worker thread (3.6) and
   answers its result, `over-budget`, `over-memory`, or the reader's contract error.
   `runReadingCheck` is pure and reads no clock. Its input, `ReadingCheckInput` (3.6), is plain
   data: the source, the aligned modules, `data.gathered`, `data.minted` and `data.placesRead`, the
   row's media plan, the reading's id and target, the person's declaration at creation, and the
   claims mode. On its own side the check builds the function-valued values again:
   `mintingResolver(row.id)`, `data.lookups` with part 11's `readerLookupCatalog` over the bindings
   of `gathered.tables`, `data.organization` from `gathered.hqLevels`, the media index of step 6,
   and `appStrings`. In order:
   1. **The reader.** `lib/commcare/reader/index.ts::readHqApp({ appId: row.id, target, source,
      modules, resolver: mintingResolver(row.id), lookup: data.lookups, organization:
      data.organization, media, appStrings, recordDialect: recordDialectRoundTrip }, { claims:
      input.claims })` (part 06, 2.2; part 10's resolver). `target` is the server's origin
      (`lib/commcare/servers.ts::COMMCARE_SERVERS[row.server].baseUrl`) and the project space;
      `media` is step 6's index; `appStrings` is part 09's
      `lib/commcare/appStrings.ts::localAppStringTable` (its 15.1); `recordDialect` is part 08's
      `lib/agent/authoring/recordRoundTrip.ts::recordDialectRoundTrip`
      (`08-the-reader-expressions.md`, sections 2.5 and 8.4, B6); `input.claims` is `"counts"` in every
      step of a reading (3.6). The reader answering `account` ends the check after the next move,
      with its findings and that move's.
   2. **The project data, judged.** `reads = projectDataReadsOf(data, outcome)`, then
      `readingProjectDataFindingsFor(data, reads, draft?.doc ?? null, mintingResolver(row.id))`
      (part 11, 14.1): every finding of project data for this read, raised in this one place. A
      table matters only where the app reads it, and levels and places only where the app reads
      places, which is why the findings wait for the reader. Where `reads.readsPlaces` is true and
      `data.placesRead` is false, the source test of step 5 missed a spelling. The check stops
      here and answers `placesMissed`; `gatherReading` runs step 5 once more with `places:
      "always"` and then the check again (part 11, 11.1's backstop), and logs the miss at error
      (10). It is one extra pass and never a loop, since the second call always reads places. The
      two passes share one budget each: the second call of step 5 runs under what the first left
      of `HQ_PROJECT_DATA_READING_DEADLINE_MS`, and the second check under what the first left of
      `HQ_READING_CHECK_BUDGET_MS`, so the sum of 3.6 stands.
   3. **The files**, where the reader gave a draft. `planReadingMedia({ source, references:
      hqMediaReferencesOf(draft.facts), runsOn, previous: row.media, reserve })` (part 11, 14.2)
      answers `{ plan, media }`: `plan` is the `ReadingMediaPlan` the step writes (2.3), and
      `media` the `HqMediaPlan` of this read. `runsOn` is the platforms of the declaration the
      draft proposes (part 06, 16.3), `reserve` is step 6's, and `hqMediaReferencesOf` is part
      11's bridge from the reader's two lists of references (its 2.1). Then
      `readingMediaFindings({ media, plan, runsOn: offered })`, `offered` being every platform
      some declaration choice of the draft declares, answers the files' findings, `playsOn` and
      `complete`: the plan is complete where every file of it has a verdict. Once it is,
      `narrowDeclarationsByMedia(draft.declaration, playsOn)` leaves the choices every held file
      plays on. Where it leaves none, `readingMediaFindings` has already given
      `media-not-played-where-app-runs` (part 11, 2.4), so the read is an account and acceptance
      is not called.
   4. **Acceptance.** `lib/deployment/reading/acceptance.ts::acceptReading(input)` (part 09,
      `09-acceptance-and-the-first-publish.md`, section 2.2, B7): its five checks, in the order of
      its `ACCEPTANCE_CHECKS`. It is called where the reader read clean and moves 2 and 3 gave no
      finding. A draft that part 11 holds a finding against is no document Nova would return
      (part 06, section 10.1), so judging it would word part 11's finding a second time as Nova's
      own defect. Step 4's menu findings do not hold acceptance back: its check 5 skips the forms
      of a menu CommCare HQ could not summarize (part 09, 7.6). `input` is part 09's
      `AcceptReadingInput`, and no value of this part's own is handed to it:

      | Member | Value |
      |---|---|
      | `appId`, `source`, `modules` | the reader's own |
      | `target` | `{ server: row.server, domain: row.domain }` |
      | `outcome` | the reader's `read` outcome |
      | `reader` | the reader input's `target`, `lookup`, `organization`, `media`, `appStrings` and `recordDialect` |
      | `choices` | under `media: "pending"`, the draft's own `outcome.draft.declaration`; once every file has a verdict, `narrowDeclarationsByMedia(outcome.draft.declaration, playsOn)` |
      | `settlements` | `handOffSettlements(outcome.claims.handOffs, media, findings)` (part 11, `projectData/settlements.ts`, its 14.3), `media` being move 3's `HqMediaPlan` and `findings` those of moves 2 and 3 |
      | `lookup` | `readingLookupSnapshot(data, reads)` (part 11, `projectData/lookupTables.ts`, its 14.3) |
      | `mediaLeftOut` | `HqMediaPlan.inert.length` |
      | `media` | `"pending"` where the plan is not complete. Otherwise `{ files: adoptedMediaFiles(files), rows: readingMediaRows(plan) }`: `files` is, for each held file of `plan`, its `published` entry where the plan holds one and its entry of part 11's `stagedReadingFiles(plan)` otherwise, which is the plan's staged files at a read step and the published ones at creation; `plan` is move 3's, the row's own plan cut to the files this document references |
      | `chosen` | absent in a read step; at creation `{ runsOnlyOn, splitDatetime }`, `input.chosen` |

      Under `media: "pending"` every check runs, and check 2 drops only the four validator codes
      that read a file's own facts (part 09, 2.4, `MEDIA_FACT_CODES`).
   5. **A clean read's values.** Where there is no finding and the plan is complete, the check
      also answers what the review and the birth need, from the same `data`, `reads` and
      document: `projectDataReview(data, reads, doc, mintingResolver(row.id))` (the review's
      `tables` and `places`, 5.1), `readingProjectDataWrite(data, reads, doc,
      mintingResolver(row.id))` (what the birth writes, 6.3), the `lookup` snapshot and the `files`
      of move 4, and `adoptedMediaFiles(files)`. Each call takes a resolver of its own, as move 2's
      does: a resolver answers a key once (part 10, 2.3), each of part 11's three functions claims
      the levels' keys, and every `mintingResolver(row.id)` mints the same UUIDs.
8. **The verdict**, by the check's answer:

   | The check answered | Result |
   |---|---|
   | `over-budget` | an account of one `too-large` at the app, `detail.name` `checking`, with `log.error("[reading] step over budget")` (3.6) |
   | `over-memory` | the same account, one `too-large` at the app with `detail.name` `checking`, with `log.error("[reading] step over memory")` (3.6) |
   | the reader's contract error (part 06, C3) | an account of one `read-back-differs` at the app, `detail.name` `reader`; the error is logged at error |
   | any finding, from step 4 or the check | `account`. `mediaChecked` is true exactly where the reader gave a draft and its plan is complete. Each `unrecognized`, each reader defect and each `read-back-differs` is logged (10) |
   | no finding, and the plan is not complete | `needs-media` |
   | no finding, and the plan is complete | the review and its digest (5); `clean` |

   The first check's `placesMissed` never reaches this table: step 7.2 runs the second pass, and
   the table reads that pass's answer. Every result but `stop` and `changed` carries the facts
   the row keeps (`GatheredFacts`): `data.minted`, the manifest revision, and the plan of move 3
   where the reader gave a draft.

**Everything but the files is judged before a file is fetched.** The first step of a reading is to
read and check everything but media (Departure 3). So the first read step runs acceptance too, in
its `pending` mode: a
`read-back-differs`, a gate refusal or an app no declaration runs is an account at once, and never
after twenty-five requests of media for a three hundred file app. `needs-media` therefore means the
reader read clean, acceptance passed but for the files, and part 11 has no finding yet. The read
step after the media step runs acceptance whole.

The document acceptance judges under each choice is the reduction of `[...draft.batch,
...choice.mutations]` from `emptyBlueprintDoc(row.id)`, through
`lib/doc/commitVerdicts.ts::mutationCommitVerdict` (part 09, section 4). That is the batch the
birth itself reduces for the choice the person makes (6.2), so what acceptance judged is what
`prepareGenesisCandidate` will reduce, but for the name.

**`advanceReading` in state `reading`** calls `gatherReading` with `tableChoices: null` and
`chosen: null`, and writes by its result, as 2.4's table says: `changed` raises `changed_count` or
stops; `stop`, `account`, `needs-media` and `clean` write their state. On `clean` the `Gathered`
value is dropped: only the review, its digest and the facts reach the row. `busy` writes nothing:
the step answers the row as it stands, in state `reading`, so `again` is true (3.5) and the caller
advances again. The step passes `takeSlot` as a closure over `slots.acquire(() =>
onPhase("waiting"))` that keeps the slot it was given, and releases it in a `finally` that follows
its outcome write, so the slot covers the whole of a step that holds CommCare HQ's bodies. `slots`
is `slot.ts::processReadingSlots` unless a test passed its own to `advanceReadingWithin` (3.5).

### 3.4 The media step

**`advanceReading` in state `media`** reads no document and no source: the files it is to fetch are
the files of `row.media` that hold no verdict (2.3). After the connection (as 3.3's step 1) it
makes one call of part 11's (its 14.2):

```ts
stageReadingMedia({ readingId, projectId, actorUserId, creds, plan: row.media,
	maxFiles: HQ_MEDIA_FILES_PER_STEP, signal })
```

For at most `HQ_MEDIA_FILES_PER_STEP` (12) files with no verdict, `HQ_MEDIA_READ_CONCURRENCY` (4) at
a time, that function calls its `fetchAndStageHqMediaFile` (its 2.2) with the file's `reservedId`
as the staging id: the read under `HQ_MEDIA_FILE_DEADLINE_MS` and the kind's byte limit (part 05,
section 9), the sniff, the one media gate, and the bytes staged under the media contract's
`pending/` key with no row written. Each file read gets a verdict (`held`, `missing`, `over-limit`,
`refused`, `wrong-kind`). The answer is `staged` with the plan and its new verdicts, or `failed`
with the plan as far as the step reached and part 05's `HqFailure`. `signal` is the step's own,
`AbortSignal.timeout(HQ_MEDIA_STEP_WORK_MS)`, and never the request's (4.3). So one step asks for
at most 12 files, holds at most four in memory (at most 4 × 50 MiB,
`lib/domain/multimedia.ts::ASSET_SIZE_CAPS_BYTES`), and its work with the files ends within 180
seconds (`HQ_MEDIA_STEP_WORK_MS`). With the 30 second reserve for its reads of Postgres and its
write, merges included, the whole step ends within 210 (`HQ_MEDIA_STEP_CEILING_MS`, 3.6).

The step then writes `media` (the answer's plan) and `media_done` at its revision. **A lost write is
merged, not discarded**: the step loads the row again and, where the state is still `media`, writes
part 11's `mergeReadingMediaPlans(theirs, mine)` again, at most three times, `theirs` being the plan
the row now holds. The merge is per file key: `theirs`, with each verdict of `mine` for a key
`theirs` lacks (two verdicts of one key are equal, since one multimedia id is one file's bytes
judged by one function, part 11's fact), and a `published` entry is kept from either side. Per-file
facts commute, so two drivers lose no fetch.

When every file of the plan has a verdict, the write sets `state = 'reading'`: the next read step
makes the verdict with the files' facts in hand, findings among them. A `failed` answer writes the
plan it carries, with the verdicts the step reached, and `state = 'stopped'` with
`hqReadCircumstance(failure)`'s code (a file CommCare HQ could not send this minute is no fact about
the app, so it writes no verdict for it); "Check again" resumes from the verdicts the row holds, and
asks CommCare HQ only for the rest.

### 3.5 The other acts

```ts
// lib/deployment/reading/service.ts
export interface ReadingActor { readonly userId: string }
export type ReadingResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly refusal: ReadingRefusal };

export function startReading(actor: ReadingActor, key: ReadingKey): Promise<ReadingResult<ReadingView>>;
export function readReading(actor: ReadingActor, readingId: string): Promise<ReadingView | null>;
export function listOpenReadings(
	actor: ReadingActor, projectId: string,
): Promise<readonly ReadingSummary[]>;
/** Whether the home page has a reading to show: the empty state's question. */
export function userHasOpenReadings(actor: ReadingActor, projectId: string): Promise<boolean>;
/** Exactly one step. `again` is true where the caller should advance again now. */
export function advanceReading(
	actor: ReadingActor, readingId: string,
): Promise<ReadingResult<{ readonly reading: ReadingView; readonly again: boolean }>>;
/**
 * Whole steps while their ceilings fit `budgetMs` (4.5). `now` is `Date.now` and `slots` is
 * `processReadingSlots` (3.6) unless a test passes its own.
 */
export function advanceReadingWithin(
	actor: ReadingActor, readingId: string, budgetMs: number, now?: () => number,
	slots?: ReadingSlots,
): Promise<ReadingResult<{ readonly reading: ReadingView; readonly again: boolean }>>;
export function checkReadingAgain(
	actor: ReadingActor, readingId: string,
): Promise<ReadingResult<ReadingView>>;
export function removeReading(
	actor: ReadingActor, readingId: string,
): Promise<ReadingResult<{ readonly removed: true }>>;
```

| Function | Idempotency key | What a repeat does |
|---|---|---|
| `startReading` | the open-row index: actor, Project, server, project space, HQ app id | returns the open row as it stands; reads nothing of CommCare HQ |
| `advanceReading`, state `reading` | reading id and revision | reads again and writes the same outcome for the same CommCare HQ state; a concurrent repeat loses its write |
| `advanceReading`, state `media` | reading id, and per file HQ's media type and multimedia id | fetches only files with no verdict; merges |
| `advanceReading`, any other state | none needed | returns the row with `again: false` and does nothing |
| `checkReadingAgain` | reading id and revision | a row already in `reading` is returned as it is |
| `removeReading` | reading id | a removed row answers `removed: true` |
| `createFromReading` | reading id; the HQ app's claim | 6.6 |

`startReading` validates the key (`server` a `CommCareServer`, `domain` through
`lib/commcare/client.ts::isValidDomainSlug`, `remoteAppId` matching `^[\w-]{1,255}$`, `projectId` a
non-blank string of at most 255 characters), resolves `edit` in the Project, and calls
`insertOrFindOpenReading`. It makes no request to CommCare HQ: the first `advanceReading` does.

`again` is true exactly where the state the step left is `reading` or `media`.

`removeReading` is 2.6's: `markReadingRemoved`, and then, where it answered a media plan, part 11's
`discardReadingMedia({ projectId, plan })`. The discard is best effort by part 11's own rule (its
14.2): what it misses the bucket's one-day rule deletes, so the answer is `removed: true` whatever
it reached.

`listOpenReadings` returns at most twenty rows, most recently updated first, and an empty list for a
caller without `view` in the Project, as `listDesignsInProgress` does. `userHasOpenReadings` is
`hasOpenReadingRow` behind the same `view` check and answers false without it, as
`userHasDesignsInProgress` does: `app/(app)/(site)/page.tsx` chooses its empty state by both, so a
home whose only content is a reading in progress does not read as "no apps yet".

### 3.6 Bounds

```ts
// lib/deployment/reading/budget.ts
/**
 * The one budget of a step, for every caller: the browser's two long routes and the MCP tools.
 * Its clock starts when the service function is called. Every part of a step is inside it, the
 * outcome write included.
 */
export const HQ_READING_STEP_SECONDS = 270;
export const HQ_READING_STEP_MS = HQ_READING_STEP_SECONDS * 1000;
/**
 * What a step leaves the request that carries it: the session or the token's check, the body's
 * parse and the tool's dispatch before the step, and the answer's way out after it. With the
 * step it is the 300 seconds both long routes export and an MCP request is capped at.
 */
export const HQ_READING_ROUTE_MARGIN_SECONDS = 30;
/** What the reader and acceptance may take together, measured from the moment the check starts. */
export const HQ_READING_CHECK_BUDGET_MS = 60_000;
/** The rest of part 05's 90 second remainder: the step's own reads and writes of Postgres, its
 *  outcome write among them, and, at creation, the birth's transaction. */
export const HQ_READING_WRITE_RESERVE_MS = HQ_READING_STEP_REMAINDER_MS - HQ_READING_CHECK_BUDGET_MS;
/** The end of that reserve a birth may not use: what the write after a birth that ran out takes. */
export const HQ_READING_OUTCOME_WRITE_MS = 5_000;
/** The check worker's two heap limits, in MiB ("The check's memory", below). */
export const HQ_READING_CHECK_HEAP_MB = 736;
export const HQ_READING_CHECK_YOUNG_MB = 32;
/** How long a step waits for the instance's reading slot before it answers `busy`. */
export const HQ_READING_SLOT_WAIT_MS = 20_000;
/** How often a running step marks its row, and how old a mark may be and still say "running". */
export const HQ_READING_STEP_BEAT_MS = 10_000;
export const HQ_READING_STEP_QUIET_SECONDS = 30;
/** A media step's work with its files: 12 files, 4 at a time, 60 seconds each (part 05,
 *  section 9). The timeout of the step's own signal. */
export const HQ_MEDIA_STEP_WORK_MS = 180_000;
/** A whole media step, its reads of Postgres and its write included: what `stepFits` is asked. */
export const HQ_MEDIA_STEP_CEILING_MS = HQ_MEDIA_STEP_WORK_MS + HQ_READING_WRITE_RESERVE_MS;
/** How far into a creation media step part 11's `publishReadingMedia` may start a file (6.1):
 *  the step's work less one file's own deadline (part 05's `HQ_MEDIA_FILE_DEADLINE_MS`, 60 s). */
export const HQ_MEDIA_PUBLISH_DEADLINE_MS = 120_000;
/** Whether a step with `ceilingMs` may start `elapsedMs` into a call of `budgetMs`. */
export function stepFits(elapsedMs: number, ceilingMs: number, budgetMs: number): boolean;
```

| Step | Time | Bytes | Files |
|---|---|---|---|
| read step | 270 s: `HQ_APP_READING_DEADLINE_MS` 120 s, `HQ_PROJECT_DATA_READING_DEADLINE_MS` 60 s, `HQ_READING_CHECK_BUDGET_MS` 60 s for the reader and acceptance, `HQ_READING_WRITE_RESERVE_MS` 30 s for the step's Postgres reads and its outcome write (part 05, 3.3, gives the first two and their 90 second remainder) | 64 MiB for the application resource and 64 MiB for the source (`HQ_APPLICATION_MAX_BYTES`, `HQ_APP_SOURCE_MAX_BYTES`); project data by part 11's caps; the check's heap by `HQ_READING_CHECK_HEAP_MB` | none |
| media step | 210 s: `HQ_MEDIA_STEP_WORK_MS` 180 s for the files, and the 30 s reserve for its Postgres reads and its write | each file by its kind's limit: 5, 10 or 50 MiB; four in memory at once | 12 asked of CommCare HQ |
| creation, a media step (6.1) | 210 s: a publishing step starts no file after `HQ_MEDIA_PUBLISH_DEADLINE_MS`, 120 s, the last in flight has its own 60, and the reserve holds its write; a fetching step is a media step | each file by its kind's limit; two in memory while publishing, four while fetching | as many as are published before the 120 s, or 12 asked of CommCare HQ |
| creation, the final step | 270 s, as a read step, the 30 s reserve holding the birth's transaction too, which carries `deadlineAt`, and the write that follows it | as a read step | none |

**One budget, for every caller.** A step has `HQ_READING_STEP_MS`, 270 seconds, whether a browser
route or an MCP tool called it, and every row above sums to it or to less with its outcome write
inside the sum. The request that carries a step has 300: `HQ_READING_ROUTE_MARGIN_SECONDS`, 30
seconds, is the route's, for what comes before the service function is called and after it
answers. An MCP request is capped at 300 seconds from its start
(`app/api/mcp/dispatch.ts::MCP_MAX_DURATION_SECONDS`), so a step given the whole 300 would be
measured against a cap that had already spent some of them on the token's check and the tool's
dispatch. A test holds `HQ_READING_STEP_SECONDS + HQ_READING_ROUTE_MARGIN_SECONDS` equal to that
constant and to the literal both long routes export (4.3; "Tests").

**The reads of CommCare HQ keep their own deadlines** (part 05), so what CommCare HQ's speed can
cost a step is bounded and is never judged as the app's size.

**The reader and acceptance run off the event loop, under their own clock.** They are synchronous
CPU over up to 64 MiB of source. Run in the request, they would hold the instance's one event loop
for their whole length: every other request on it, the builder's SSE relays, the chat route's lease
heartbeats and this reading's own two second polls (4.4) would wait. Nova already runs server CPU of
this kind in a worker it can stop (`lib/preview/engine/evaluateForm.ts`), and the check takes that
idiom whole:

- `scripts/build-xpath-worker.mjs` gains a third bundle, `public/reading-check/worker.mjs`, from
  `lib/deployment/reading/checkWorker.ts`, built as the form evaluation worker is (Node platform,
  `server-only` aliased to its empty module) with the two additions below; `.gitignore` gains
  `/public/reading-check/`. The bundle resolves everything the check imports,
  `lib/commcare/compiler.ts` (through part 09's `localAppStringTable`) and
  `lib/export/boundaryFindings.ts` (through its check 2) among them.
- **The bundle is given `require`.** `compiler.ts` imports `adm-zip`, a CommonJS package that calls
  `require("fs")`, and esbuild's ESM output answers such a call with a stub that throws, so a
  bundle built with the form evaluation worker's options alone dies as it loads ("Executed during
  planning"). The third `build` call therefore passes `banner: { js: 'import { createRequire as
  novaCreateRequire } from "node:module"; const require = novaCreateRequire(import.meta.url);' }`,
  which gives every chunk Node's own `require`, as part 14's reader bundle does (its 5.2). The
  form evaluation bundle holds no CommonJS package and keeps its options.
- **The bundle holds only what computes.** The check is pure, and so is every module it imports at
  run time: the reader, acceptance, and the pure files of part 11's project data. The bundle holds
  no module that reaches a store, CommCare HQ or the logger: nothing under `lib/db/`,
  `lib/case-store/`, `lib/storage/` or `lib/auth/`, not `lib/logger.ts`, and nothing of `pg`,
  `@google-cloud/*`, `@sentry/*` or `next`. A thread that only computes has no use for a pool, a
  bucket client or Sentry's Next.js SDK, which `lib/logger.ts` imports; each would be loaded again
  in every check, inside the check's own budget, and the form evaluation bundle holds none today.
  The build holds the rule: the third `build` call passes `metafile: true`, and the script throws
  where `metafile.inputs` holds a path under one of those, naming the path and the file that
  imports it (C8). Part 11 keeps its pure functions and its store functions in separate files for
  this, and a pure file takes a store file's types with `import type` alone (its section 14).
- `checkReadingInWorker(input, budgetMs)` starts `new Worker(workerPath, { workerData: input,
  resourceLimits })`, `workerPath` being `resolve(process.cwd(), "public/reading-check/worker.mjs")`
  in production and `resourceLimits` the two heap limits of "The check's memory" below, races its
  one message against a timer of `budgetMs`, and calls `worker.terminate()` in `finally`, as
  `evaluateForm.ts` does.
- The check's input and its answer are plain data, because both are cloned across the thread:

  ```ts
  // lib/deployment/reading/check.ts
  export interface ReadingCheckInput {
  	/** The reading's id, which is the app's. */
  	readonly appId: string;
  	readonly server: CommCareServer;
  	readonly domain: string;
  	readonly source: HqAppSource;
  	readonly modules: readonly HqAlignedModule[];
  	/** Part 11's `ReadingProjectData`, less its two function-valued members (3.3, step 5). */
  	readonly gathered: ReadingProjectData["gathered"];
  	readonly minted: PredeclaredLookupIds;
  	readonly placesRead: boolean;
  	/** `row.media`: the plan the last step wrote, or null. */
  	readonly media: ReadingMediaPlan | null;
  	/** The declaration the person chose. Null in a read step. */
  	readonly chosen: { readonly runsOnlyOn: Platform | null;
  	                   readonly splitDatetime: boolean } | null;
  	/** Part 06's `ReaderOptions.claims`. A reading's step passes `"counts"`. */
  	readonly claims: "counts" | "full";
  }

  export interface ReadingCheck {
  	/** Every finding of the reader, of part 11's verdicts and of a failing acceptance, in part
  	 *  06's `placeOrder`. */
  	readonly findings: readonly Finding[];
  	/** The reader's draft; null where the reader answered `account`. */
  	readonly draft: ReadDraft | null;
  	/** `ReadOutcome.defects`, for the log (10). Never stored. */
  	readonly defects: readonly ReaderDefect[];
  	/** True where the document reads places and the project data read none (3.3, step 7.2). The
  	 *  check stopped there: `media`, `accepted` and `clean` are null. */
  	readonly placesMissed: boolean;
  	/** Move 3's answers; null where there is no draft. */
  	readonly media: {
  		readonly plan: ReadingMediaPlan;
  		readonly complete: boolean;
  		readonly playsOn: readonly Platform[];
  		/** `HqMediaPlan.inert.length`. */
  		readonly leftOut: number;
  	} | null;
  	/** Acceptance's answer; null where it was not called. A failing arm's findings are in
  	 *  `findings`, and its `differences` never leave the worker: they hold the app's words. */
  	readonly accepted:
  		| Extract<AcceptedReading, { readonly ok: true }>
  		| { readonly ok: false; readonly check: AcceptanceCheck; readonly signature: string;
  		    /** How many differences it found (at most 20) and their distinct signatures (at most 5). */
  		    readonly differenceCount: number; readonly signatures: readonly string[] }
  		| null;
  	/** Move 5's values; null unless there is no finding and the plan is complete. */
  	readonly clean: {
  		readonly tables: readonly ReviewTable[];
  		readonly places: ReviewPlaces | null;
  		readonly write: ReadingProjectDataWrite;
  		readonly lookup: LookupFixtureDataSnapshot;
  		/** Move 4's `files`, and `adoptedMediaFiles(files)`. */
  		readonly files: readonly PublishedReadingFile[];
  		readonly mediaFiles: readonly AdoptedMediaFile[];
  	} | null;
  	/** The tags of `choice` tables whose binding under the answers is not their binding under
  	 *  no answer (5.2). Empty in a read step, and at creation unless Nova is at fault. */
  	readonly bindingsMoved: readonly string[];
  	/** What the reader claimed. `log` is part 06's `serializeClaimLog(outcome.claims)` under
  	 *  `"full"` and null under `"counts"`: a string, so that it clones. */
  	readonly claims: {
  		readonly counts: Readonly<Record<string, number>>;
  		readonly handOffs: readonly HandOffRecord[];
  		readonly log: string | null;
  	};
  }
  /** 3.3, step 7. Pure; reads no clock. Throws only the reader's contract error (part 06, C3). */
  export function runReadingCheck(input: ReadingCheckInput): ReadingCheck;

  // lib/deployment/reading/checkInWorker.ts
  export type ReadingCheckAnswer =
  	| { readonly kind: "checked"; readonly check: ReadingCheck }
  	| { readonly kind: "over-budget"; readonly elapsedMs: number }
  	/** The worker ended on a heap limit: its `error` carried `ERR_WORKER_OUT_OF_MEMORY`. */
  	| { readonly kind: "over-memory" }
  	/** `runReadingCheck` threw the reader's contract error; `message` is its own sentence. */
  	| { readonly kind: "reader-contract"; readonly message: string };
  /** The limits production runs a check under; a test passes smaller ones ("Tests"). */
  export const READING_CHECK_RESOURCE_LIMITS = {
  	maxOldGenerationSizeMb: HQ_READING_CHECK_HEAP_MB,
  	maxYoungGenerationSizeMb: HQ_READING_CHECK_YOUNG_MB,
  } as const;
  /** `workerPath` is the built bundle unless a test passes its own entry ("Tests"). */
  export function checkReadingInWorker(
  	input: ReadingCheckInput, budgetMs: number,
  	workerPath: string = resolve(process.cwd(), "public/reading-check/worker.mjs"),
  	resourceLimits: { readonly maxOldGenerationSizeMb: number;
  	                  readonly maxYoungGenerationSizeMb: number } = READING_CHECK_RESOURCE_LIMITS,
  ): Promise<ReadingCheckAnswer>;
  ```

  The reading's step passes `claims: "counts"`, so production holds no claim log in memory; part
  14's lane (`14-proof.md`, section 5.2, B13) calls `runReadingCheck` in process with `"full"` and
  reads `claims.log`. The worker builds the function-valued inputs of the reader on its own side
  (3.3, step 7): `mintingResolver(appId)`, the lookup catalog, the organization, the media index,
  `appStrings` and `recordDialect`.
- The timer firing is `over-budget`: the worker is stopped mid-computation, so the bound is real and
  not a check made after the fact. The worker ending on a heap limit is `over-memory` ("The check's
  memory", below). The worker's other failures stay failures: an error it posts for the reader's
  contract breach is 3.3's `read-back-differs`, and any other error or an early exit is thrown as
  infrastructure (a 500, logged at error, nothing written).

`over-budget` writes an account of one `too-large` finding at the app with `detail.name`
`checking`, and `log.error("[reading] step over budget")` with the elapsed time. The clock it is
judged by starts when the check starts, so it measures the app and Nova's code and nothing of
CommCare HQ: the same source takes the same work on a quick day and a slow one, which is what makes
it a finding and never a retry. An app Nova cannot read and check inside its own budget is one Nova
cannot hold yet, which is what `too-large`'s block says (part 01, 9.3: "That limit is Nova's, not
the app's"); part 01's row for the code (its 8.3) holds the two time causes and the check's
memory cause from B10 on (C7).

**The check's memory.** Time and bytes do not bound memory. A source inside its byte bound can
still take a check more heap than an instance has, and a worker with no limit of its own takes
the whole server down with it, every other request on the instance included. So the worker is
started with both of V8's heap limits:

```ts
new Worker(workerPath, {
	workerData: input,
	resourceLimits: {
		maxOldGenerationSizeMb: HQ_READING_CHECK_HEAP_MB,    // 736
		maxYoungGenerationSizeMb: HQ_READING_CHECK_YOUNG_MB,  // 32
	},
});
```

The numbers divide the instance. The service runs at 2 GiB an instance, which B10 writes into
`cloudbuild.yaml`'s `deploy` step as `--memory=2Gi` ("Executed during planning"), with the
argument added to the list `scripts/infra/__tests__/cloudBuild.test.ts` holds. Of those 2,048 MiB:

| Share | MiB | What holds it to that |
|---|---|---|
| the check's worker | 768 | `resourceLimits`: 736 of old generation and 32 of young |
| CommCare HQ's two bodies, in the server's own process | 512 | part 05's two byte bounds, and one step at a time ("One reading slot an instance", below) |
| everything else the server holds and runs | 768 | not this plan's to bound: its own heap, with a read step's project data in it (rows and places inside part 11's caps) and a publish's own read of a source; a media step's four files (200 MiB at most, 3.4); each form evaluation worker (128 MiB, `evaluateForm.ts`); and the Office parser's child (`OFFICE_LIMITS`) |

- **A worker that ends on its limit is `too-large`.** Node ends such a worker with an `error`
  whose `code` is `ERR_WORKER_OUT_OF_MEMORY`. `checkReadingInWorker` answers `{ kind:
  "over-memory" }` for that code and for no other, and the step writes what `over-budget` writes:
  an account of one `too-large` at the app with `detail.name` `checking`, and
  `log.error("[reading] step over memory")` with the two limits. It is a fact about the app and
  Nova's code, as the time bound is: the same source meets the same limit on every try. A 500
  would be a failure every retry repeats; an account is written to the row like every other
  `too-large`, and tells the person the limit is Nova's.
- **What the limit does not hold.** It holds V8's heap and nothing outside it. The check's one
  allocation outside it is the archive the compile inside `localAppStringTable` packs (part 09,
  15.1): a Buffer no larger than the files Nova emits for the app, held for the length of one
  compile. It is counted in the table's last row.

**What the server's own process holds of a read step**, which no worker limit covers:

- **Each body is read to its bound and no further.** `readBoundedBody` (part 05, 2.3) reads the
  response as a stream, and one byte past 64 MiB cancels the read and is `too-large` (part 05,
  3.3), so no body is ever buffered whole before it is measured.
- **One body's bytes and text at a time.** `readHqJson` decodes and parses a body and returns the
  parsed value alone, so the bytes (64 MiB at most) and the decoded text (128 MiB at most, where
  it holds a character outside Latin-1 and is kept at two bytes a character) are unreachable once
  it returns. `readHqAppForReading` reads the application resource and then the source (part 05,
  8.2), never the two together, so the most that exists at once of this kind is one body's 192
  MiB.
- **Both parsed values, until the step ends.** `HqAppReading`'s `read` answer carries the
  resource's question summaries (inside `modules`) and the source; the check's input is made of
  both, and at creation the birth reads the gathered values. Neither can be released for the
  other. The share allows each parsed value twice its body's bytes: what the two bodies hold is
  strings of form XML and of question text, which a parsed value keeps at one or two bytes a
  character.
- **The copy handed to the worker.** `workerData` is cloned once, into a buffer the worker reads
  as it starts. It is no larger than the two parsed values together.

The worst moment is the check's start: 128 and 128 MiB of parsed values and at most 256 of the
copy, 512 MiB. The moment before it, with the resource parsed and the source arriving, is 128,
192 and 128: 448. Both byte bounds therefore stay at 64 MiB. The division holds with them, and
the source's is the bound a publish already reads under
(`lib/commcare/hq/appSource.ts::HQ_APP_SOURCE_MAX_BYTES`).

The two shares are a division and not a measurement. Whether an app at Nova's ceiling fits
them, the worker's 736 MiB and the two bodies' 512 with the allowance of twice a body's bytes
inside it, is run M1's to say, with what changes for each answer ("Written and not yet run").

What the division does not promise is said here, once. Its last row is no sum of caps. The child
that extracts a document (`lib/agent/officeProcess.ts`) may take 768 MiB at its own limit, for
the fifteen seconds its deadline gives it, and a read step at its worst beside it passes the
instance's 2 GiB. Cloud Run then ends the instance: the server's process, the check's worker in
it and the child, with every request that instance was serving. The person bringing an app in
sees their step's request fail with no answer; the page says "Trying again" and posts the step
again three seconds later (part 13, section 5), on an instance that is starting or on another,
and nothing was written, so the step runs whole and succeeds, the coincidence having passed with
the child's fifteen seconds. A page that was only watching takes the reading on once the dead
step's mark is thirty seconds old (3.2). The person whose document was being read sees that
request fail and sends it again, as for any instance that ends today. This plan bounds the
reading's own share and does not make the coincidence impossible. Giving the service more
memory would, and that is the person's decision, a billed change this plan does not make.

**One reading slot an instance.** The 512 MiB row is one step's. An instance serves 80 requests
at once, and with no rule each of them could be a read step holding two bodies and starting a
worker. So a process holds one slot:

```ts
// lib/deployment/reading/slot.ts
export interface ReadingSlot {
	/** Gives the slot back and wakes every step waiting for it. Idempotent. */
	readonly release: () => void;
}
export interface ReadingSlots {
	/**
	 * Free: the caller holds the slot at once. Taken: `onWait` is awaited once, then the caller
	 * waits until the slot is released or `waitMs` has passed, whichever comes first, and is then
	 * answered null, without the slot, in both cases.
	 */
	readonly acquire: (
		onWait: () => Promise<void>, waitMs?: number, // HQ_READING_SLOT_WAIT_MS
	) => Promise<ReadingSlot | null>;
}
/** One slot. Production makes one; a test makes its own to stand for a second instance. */
export function createReadingSlots(): ReadingSlots;
/** This process's one reading slot: what every step takes unless a test hands it another. */
export const processReadingSlots: ReadingSlots;
```

- **Who takes it.** A read step and creation's final step, between steps 2 and 3 of
  `gatherReading` (3.3), through the `takeSlot` each passes, a closure over
  `processReadingSlots.acquire`. A media step of either kind takes
  none: it holds files, by 3.4's own bound, and no body.
- **For how long.** From before the app's read until the step ends: the step releases it in a
  `finally` that follows its outcome write and, at creation, the birth. So one instance never
  holds two steps' bodies and never runs two checks.
- **A second caller answers `again`. It does not wait its turn inside its step.** The parts of a
  read step already sum to the whole budget, so a step that waited and then ran would outlive it,
  and a wait charged to the check's share or the birth's would judge another reading's load as
  this app's size. A caller that finds the slot taken waits, `HQ_READING_SLOT_WAIT_MS` (20
  seconds) at most, for one reason: so that the call it answers is not repeated at once. It is
  then answered `busy`, whether or not the slot came free meanwhile. `advanceReading` answers the
  row unchanged with `again: true` (3.3); creation answers `again` with `publishing: null` (5.3);
  and the caller's next call starts with its whole budget and takes the slot where it is free.
  That is what the step contract already allows: `again` is true exactly where the state a step
  left is `reading` or `media` (3.5), and a step that started nothing left the state as it was.
- **It is a permit and no queue.** Waiters are not ordered and a release wakes them all;
  whichever caller asks next holds the slot. It is one process's: another instance has its own,
  and nothing about it is stored.
- **With the mark of 3.2.** A step waiting for the slot is inside `withStepBeat`, so it marks its
  row while it waits and no other page starts a step for that reading. Its `onWait` writes the
  phase `waiting`, which the page words as "Waiting while Nova finishes another app" (C4), so the
  step never reads as a slow CommCare HQ. A step answered `busy` stops marking; the page
  that is driving calls again inside the mark's thirty seconds, and the new step's first beat
  keeps the row marked, so a reading that is waiting its turn reads as running throughout. Where
  that page has gone, the last mark ages out and the home row offers Continue.

**The step adds up.** 120 + 60 + 60 leaves `HQ_READING_WRITE_RESERVE_MS`, 30 seconds, of the 270 for
everything of a step that is neither a read of CommCare HQ nor the check: the credentials and claim
reads, the statements part 11's project data call runs against Postgres (its id mint and its reads
of the Project's own tables), the beats of 3.2, the write of the outcome, and at creation the birth.
The wait for the reading slot is in no step's sum: a step that waited runs nothing. The backstop
pass of 3.3's step 7.2 adds nothing to the sum: it spends what the first pass left of the same two
budgets. A test holds `HQ_APP_READING_DEADLINE_MS + HQ_PROJECT_DATA_READING_DEADLINE_MS +
HQ_READING_STEP_REMAINDER_MS` equal to `HQ_READING_STEP_MS`, `HQ_READING_CHECK_BUDGET_MS +
HQ_READING_WRITE_RESERVE_MS` equal to `HQ_READING_STEP_REMAINDER_MS`, and `HQ_MEDIA_STEP_CEILING_MS`
no more than `HQ_READING_STEP_MS`.

**The birth's share.** Creation's final step sets `stepDeadlineAt` to the instant its call began
plus `HQ_READING_STEP_MS` less `HQ_READING_OUTCOME_WRITE_MS` (the final step is always a call's
first, 4.5), and runs the birth in `withAppTx(body, { deadlineAt: stepDeadlineAt })`, which
PostgreSQL enforces as `transaction_timeout` (`lib/db/pg.ts::withAppTx`). The five seconds held
back are the outcome write's: a birth that runs to its deadline is still followed by the write
of its account inside the step's 270. By the sum above the transaction has what the reads and the
check left, which is never less than the reserve less those five seconds and the prelude's few
reads. A
birth PostgreSQL ends for that timeout (SQLSTATE `25P04`), or one whose deadline has passed before
it opens, has rolled back whole: creation writes an account of one `too-large` at the app with
`detail.name` `saving`, and `log.error("[reading] birth over budget")` with the elapsed time and
the counts of what it was writing. It is an account and never a bare failure. The cause can be the
app's size or a wait on another writer's lock, and the log line's counts tell the team which; for
the person both have one next step that works, which is to check again, where a 500 on every retry
would have none.

### 3.7 Concurrency

| Who | What happens |
|---|---|
| one person, two tabs, one HQ app, one Project | `startReading` returns one row to both. Both may advance: each step reads at a revision and one write lands (3.2); media merges (3.4). Both pages show the same row. Both may press Bring it in: one birth commits, and the other answers `created` with the same app, whether it was waiting on the row's lock inside the birth or met the committed row at any write of its own (5.3, 6.6) |
| one person, the same HQ app into two Projects | two rows. The first creation takes the claim; the second's read step then stops at `already-in-nova` with the `open` view, and a creation already past its read is refused by the claim (6.5) |
| two people, one HQ app | a row each; neither sees the other's. The first creation takes the claim (part 10, 5.2: the advisory lock serializes them before either writes). The second's creation rolls back whole and its reading is written `stopped` with `already-in-nova` |
| a reading, and a Nova app that already publishes to that HQ app | the first read step stops at `already-in-nova` |
| a reading, and the holder moved to recently deleted | the claim passes over a deleted holder (part 10, 5.3); the birth releases it |
| a step, and a deploy or an instance that died | the request dies with its instance and wrote nothing, or wrote its outcome; the next advance repeats or carries on. The row's last mark is thirty seconds old soon after, `stepRunning` and `phase` then read false and null (3.2), and a page that has the reading open takes it on; with no page open the home row offers Continue |
| a step that is slow to name its first phase | it has marked the row since it started, so a second tab only polls |
| two read steps on one instance, of one reading or of two | the first holds the reading slot; the second waits at most 20 seconds and answers `again` with nothing read (3.6). Two steps on two instances each hold their own instance's slot, and one write lands |
| a step, and "Check again" or "Remove" from another tab | the act raises the revision; the step's write finds no row and is discarded |

### 3.8 What each circumstance does to a reading

The rule is one line: a circumstance a read or media step raises writes `stopped` where its
`CIRCUMSTANCE_STANDINGS` entry is `stop`, and `account` otherwise. At creation a stop that is a fact
about the HQ app ends the review; any other stop leaves the review standing and is answered `held`,
because the person can clear it and create again. One stop is raised at creation alone,
`table-differs-in-project`: it is about an answer the person has not given, which only a creation
can find missing.

| Code | Raised by | A read or media step writes | At creation (5.3) |
|---|---|---|---|
| `not-connected` | `getHqCredentials` | `stopped` | answers `held`; the row stays `ready` |
| `key-not-accepted` | any read, through `hqReadCircumstance` | `stopped` | `held` |
| `plan-lacks-api-access` | the application resource | `stopped` | `held` |
| `not-a-member` | `getHqCredentials`; a 403 the list confirms | `stopped` | `held` |
| `cannot-edit-apps` | the source read; a table's rows | `stopped` | `held` |
| `cannot-access-apis` | the application resource; the table list | `stopped` | `held` |
| `app-gone` | `readHqAppForReading`: `gone` | `stopped` | `stopped` |
| `app-deleted` | `deleted` | `stopped` | `stopped` |
| `linked-app` | `linked` | `stopped` | `stopped` |
| `remote-app` | `remote` | `stopped` | `stopped` |
| `rate-limited` | any read, after its waits | `stopped` | `held` |
| `hq-unavailable` | any read: no answer in time, or one Nova cannot read | `stopped` | `held` |
| `changed-while-reading` | this part: the second `changed` in a row | `stopped`; the first only raises `changed_count` | the first answers `again`; the second answers `held` and resets the count |
| `already-in-nova` | `readHqAppClaims`; `HqAppAlreadyClaimedError` | `stopped` | `stopped` |
| `hq-gateway-refused`, `api-cut-off`, `browser-only` | any read | `stopped` | `held` |
| `cannot-read-organization` | the level or the place read | `stopped` | `held` |
| `too-large` | a body over its bound (part 05); the check over its budget or over its worker's memory, `detail.name` `checking`; the birth past its time, `detail.name` `saving` (3.6) | `account` | `account` |
| `menu-unreadable-in-hq`, `app-unreadable-in-hq` | `notSummarizedMenus` | `account` | `account` |
| `shadow-disagrees`, `unrecognized`, `no-platform-runs-everything` (part 06's, B2) | the reader | `account` (`unrecognized` logged at error) | `account` |
| `read-back-differs` | acceptance; the reader's contract error | `account`, logged at error | `account` |
| `media-file-unreadable` | part 11's `readingMediaFindings`: its rule for a drawn slot whose file is missing (its 3.2, row 3) | `account` | `account` |
| `media-not-played-where-app-runs` (part 11's, B9) | part 11's `readingMediaFindings` | `account` | `account` |
| `places-over-nova-limit`, `place-not-holdable` (part 11's, B9) | part 11's `readingProjectDataFindingsFor` | `account` | `account` |
| `table-rows-unreadable` | part 11's `readingProjectDataFindingsFor`, from a rows read | `account` | `account` |
| `table-cell-unrepresentable`, `table-choices-unusable` | part 11's `readingProjectDataFindingsFor` | `account` | `account` |
| `owner-rule-needs-one-place` | part 11's `readingProjectDataFindingsFor` | `account` | `account` |
| `table-differs-in-project` | this part, at creation: a table whose review entry asks a choice has no answer (5.3, step 3) | not raised: a read asks no answer, and the review holds the choice open | answers `held`, `detail.name` the tag; the row stays `ready` |
| `could-not-create` (B10, 6.5) | the birth | not raised | `account`, logged at error |

Together the rows hold every code of part 01's `READ_CIRCUMSTANCES`, each written by the standing
its `CIRCUMSTANCE_STANDINGS` gives it (part 01, section 8.3: 35 codes after B10).

`held` is a creation answer, not a state: it carries the circumstance for the page to show where the
person stands, and the row is unchanged, so the review is there when they come back.

`table-differs-in-project` is part 01's code with part 01's standing, raised where part 01's "When"
puts it (its 8.3: "creation was asked for with that choice unanswered"). Part 11 (7.2) says the
same: a `choice` ends no read, the review holds the question open, and creation does not start
until every choice has an offered answer. It is not raised for a table that changed in the Project
under a birth: there the review the person answered is stale, so the reading is read again and the
fresh review holds the choice (6.5, Departure 12).

### 3.9 What Nova has learned since

```ts
// lib/commcare/surface/revision.ts. The file exists from B2, which carries this first function
// exactly as written here (part 06, section 2.1); B10 adds the two below it.
/** The first 16 hex characters of the SHA-256 of every inventory entry id with its standing. */
export function surfaceStandingsRevision(): string;
/** The standing an entry id has today, or null where no entry holds that id any more. */
export function currentStandingOf(code: string): ReadStanding | null;
/** True where some inventory entry's `surfaceKeys` holds the key: a key of CommCare's own schema. */
export function isDeclaredSurfaceKey(key: string): boolean;

// lib/deployment/reading/types.ts (client-safe: `ReadingView.learned` and the copy table read it)
export type ReadingLearned = "everything" | "something";

// lib/deployment/reading/learned.ts
/** What the manifest holds today of what an account named. Reads no HQ and no document. */
export function whatNovaLearned(row: Pick<ReadingRow,
	"state" | "manifest_revision" | "finding_codes">): ReadingLearned | null;
```

`surfaceStandingsRevision` is computed once per process over the entries
`lib/commcare/surface/entries/*.json` hold, each as `[id, standingOf(entry)]` (part 01's
`lib/commcare/surface/standing.ts::standingOf`), sorted by id.

`whatNovaLearned` answers null unless the state is `account` and `manifest_revision` differs from
today's. Then, over the row's `finding_codes` that are manifest entry ids (a code that is a member
of `READ_CIRCUMSTANCES` is skipped): `everything` where the list holds at least one entry id and
every one now has the standing `held`, `kept` or `inert`, or no entry by that id exists; `something`
where at least one does and not all; null otherwise. A row that also holds a circumstance finding
can answer at most `something`: what a circumstance was about is not in the manifest, and Nova does
not claim to hold what it cannot check. The home row's two lines are in "Copy".

---

## 4. Transport

### 4.1 The routes

All six are under `app/api/commcare/readings/`. `lib/hostnames.ts::HOSTNAME_ALLOWLIST` holds
`"/api/commcare"` for the main host and `isPathAllowedOnHost` matches by path segment, so no
allowlist entry is added and none of the six is reachable on the MCP or the docs host. A test holds
both ("Tests"), because a route that works on localhost and 404s in production is this repo's most
common deploy surprise.

| Route | File | Calls | `maxDuration` |
|---|---|---|---|
| `POST /api/commcare/readings` | `route.ts` | `startReading` | none |
| `GET /api/commcare/readings/[id]` | `[id]/route.ts` | `readReading` | none |
| `DELETE /api/commcare/readings/[id]` | `[id]/route.ts` | `removeReading` | none |
| `POST /api/commcare/readings/[id]/advance` | `[id]/advance/route.ts` | `advanceReading` | `export const maxDuration = 300;` |
| `POST /api/commcare/readings/[id]/check-again` | `[id]/check-again/route.ts` | `checkReadingAgain` | none |
| `POST /api/commcare/readings/[id]/create` | `[id]/create/route.ts` | `createFromReading` | `export const maxDuration = 300;` |

Each route is a thin shell, as `app/api/commcare/upload/route.ts` is:
`lib/auth-utils.ts::requireSession(req)`, a strict Zod parse of the JSON body through
`lib/apiError.ts::readJsonBody(req, HQ_READING_REQUEST_MAX_BYTES)`, the service call, and
`handleApiError` for whatever is thrown. `HQ_READING_REQUEST_MAX_BYTES = 16 * 1024` is a new
constant of `lib/apiError.ts`, beside `PRESENCE_REQUEST_MAX_BYTES` and with its line in that file's
list of budgets: the largest body is `BringInInput`, a digest, a name and a few answers. Bodies:

| Route | Request body | 200 body |
|---|---|---|
| start | `{ projectId, server, domain, remoteAppId }` | `{ reading: ReadingView }` |
| read | none | `{ reading: ReadingView }` |
| remove | none | `{ removed: true }` |
| advance | `{}` | `{ reading: ReadingView, again: boolean }` |
| check again | `{}` | `{ reading: ReadingView }` |
| create | `BringInInput` (5.3) | `CreateResult` (6.6) |

A stop, an account and a creation that did not create (`review-changed`, `held`, and a refusal
about what the person sent or about the app) are answers, not failures: they are 200 with the row,
as a refused publish is 200 with its deployment. Statuses are for the request itself: 401 with no
session; 413 for a body over the bound; 499 where the client went away while its body was being
read (`handleApiError`'s client-abort arm); 400 `invalid_input`; 403 `no_project_access` (start) and
`project_access_lost` (every later act); 404 `reading_not_found`; 500 for anything thrown that is
none of these.

One table gives a refusal its status, whichever route and whichever function raised it:

```ts
// lib/deployment/reading/types.ts
export const READING_REFUSAL_STATUS = {
	reading_not_found: 404, no_project_access: 403, project_access_lost: 403, invalid_input: 400,
	not_ready: 200, name_missing: 200, choice_not_offered: 200, project_changed: 200,
	app_unavailable: 200,
} as const satisfies Record<ReadingRefusal, 200 | 400 | 403 | 404>;
```

A route that is handed a refusal, as a `ReadingResult` or as a `CreateResult` of kind `refused`,
looks it up. A status other than 200 is answered with that status and the body `{ error, code }`. A
200 is the create route's alone, and its body is the `CreateResult` itself. So a creation that
finds its reading gone answers 404 and one that finds the person's access gone answers 403, as
every other act on that reading does, and an MCP tool, which calls the functions and no route,
reads the same refusal from the `CreateResult`.

Two body shapes, by who made the answer. A refusal answered as a status (400, 403, 404) is built by
the route with `NextResponse.json({ error, code }, { status })`: `error` is the sentence of "Copy"
and `code` the `ReadingRefusal`, so the page branches on the code and shows the sentence. 401, 413,
499 and 500 are `handleApiError`'s, in its one shape `{ error, details? }` with no `code`
(`lib/apiError.ts`: an `ApiError`'s status and message, a client abort, or "Internal server
error"); the page treats any body without a `code` as the request failing and offers the same act
again. A 400's Zod issue is logged with `log.warn("[reading] request refused")` and is not in the
body (C1).

The picker's reads (`listHqApps`, `probeHqApiAccess`, `readHqAppClaims` over a list) are part 13's
transport, as part 05 hands them (its section 5).

### 4.2 Why routes, and not Server Actions

Next dispatches a client's Server Actions one at a time: "If a user triggers three actions in quick
succession, the second waits for the first to finish"
(`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, "Sequential dispatch on the
client"). A step is up to four and a half minutes. As an action it would hold every other action of
the page behind it, the poll of 4.4 among them. A route is a plain `fetch`: it runs beside the
polls, its arguments are JSON by construction (the WAF rule that refuses a multipart action body
never sees it), and it is the shape a publish already has.

### 4.3 Durations against the platform's limits

- The service's request ceiling is 3,600 seconds
  (`config/runtime-capabilities.json::cloudRunRequestSeconds`), twelve times a step.
- `maxDuration = 300` on the two long routes is the numeric literal Next requires and is advisory on
  the standalone server, as `app/api/chat/route.ts` says of its own. It equals
  `HQ_READING_STEP_SECONDS + HQ_READING_ROUTE_MARGIN_SECONDS`, 270 and 30, held by a source test
  that reads both route files and `budget.ts`: the step has 270 seconds and the route keeps 30
  for the session's check, the body's parse and the answer's way out (3.6).
- **What this adds to the runtime manifest: nothing.** `config/runtime-capabilities.json` holds
  three authored fields, and `scripts/rollout/render-build-config.mjs::requireStaticRouteTimeout`
  locks exactly two route files to one of them, `cloudRunRequestSeconds`: the app stream and the
  chat stream, the two long-lived routes, each of which exports 3600. The two reading routes are
  not long-lived streams and are not locked to the manifest: they follow the other bounded routes,
  `app/api/chat/route.ts`, `app/api/mcp/route.ts` and `app/api/media/[assetId]/extract/route.ts`,
  each a static literal of 300 that the renderer does not read. So B10 adds no field to the
  manifest, no call to the renderer and no build argument, and the 300 is far inside the 3,600
  the manifest gives every request. Each of the two files holds exactly one `export const
  maxDuration = 300;`, a numeric literal and never an import of `budget.ts`, because Next reads
  the export statically; the source test above is what keeps the literal and the budget in step.
- What bounds a step is the step (3.6), not the platform.
- **A closed tab does not stop a step.** The two long routes do not pass `req.signal` to the
  service: a step that has read CommCare HQ for two minutes finishes and writes its outcome, so the
  home row shows the result. Where the platform ends the request anyway, nothing was written and
  the next advance repeats the step.

### 4.4 How progress reaches the page

The page that calls `advance` or `create` waits for its answer, which is the row. While that call is
in flight the page polls `GET /api/commcare/readings/[id]` every 2 seconds and renders `phase` and
`media`; when the call answers, the poll stops and the page calls again where `again` is true.

**Who drives.** A page that started the reading or asked for the check drives from that act. Any
other page drives a reading whose state is `reading` or `media` once two rows in a row, its load's
and a poll's or two polls', have said no step is running (`stepRunning` false, 3.2), and only
polls, at the same interval, until then. So a second tab on a running reading watches it and
never starts a second step, however long the step takes to name its first phase; a tab that opens
a reading whose step died with its instance sees `stepRunning` false once the last mark is thirty
seconds old, with `phase` null, and posts `advance` at the poll after; and a tab that opens a
reading nobody is driving posts `advance` two seconds after it loads. Two rows are asked because
one driver's row is unmarked for a moment between two of its steps: an outcome's write clears the
mark and the next call's first beat sets it again, and one row read in between says nothing about
whether the driver is still there. The rule is the page's, read from the row. The service starts
a step for any caller (3.2), which is why an MCP client needs no rule of its own: its call is the
step.

The polled `media` counts the files that hold a verdict (2.3), which is the count the
`fetching-media` label shows. No polled value counts publications: a creation's count is the
`publishing` of its `again` answer (6.1), so while a creation call is in flight the page shows
`publishing-media` with the count of the last answer, and without one before the first (C4).

No realtime channel is added. `lib/db/streamListener.ts` owns one listening client per instance on
five channels, the builder's SSE relay is scoped to an app that does not exist yet, and what a
reading has to say changes a handful of times a minute. A poll is one indexed primary-key read.

### 4.5 One budget rule, for the routes and for MCP

B12 registers six MCP-only tools (part 13, 14.1), three of them over this part's functions;
`read_hq_app` and `bring_in_hq_app` answer part 13's projection of `ReadingView` and `CreateResult`
(its 14.3 and 14.4) with the sentences of "Copy". Those two each call one function of this part
with the step's budget, the one every caller has (3.6), and never with the request's cap:

```ts
advanceReadingWithin(actor, readingId, HQ_READING_STEP_MS);
createFromReadingWithin(actor, readingId, input, HQ_READING_STEP_MS);
```

The cap of an MCP request, `MCP_MAX_DURATION_SECONDS`, is 300 seconds from the request's start,
so the 30 seconds between the two numbers are what the token's check and the tool's dispatch may
take before the function is called and what the answer may take to leave. The browser's routes
call the one-step forms, and `createFromReading(actor, readingId, input)` is
`createFromReadingWithin(actor, readingId, input, HQ_READING_STEP_MS)`: creation has one rule and
one budget, whoever calls it. Both `Within` functions always run one step, and start another only
where `stepFits(elapsed, ceiling, budget)`, which is `elapsed + ceiling <= budget`, `elapsed` being
the time since the function was called. The ceilings are 3.6's, each a whole step with its write:
`HQ_READING_STEP_MS`, 270 seconds, for a read step and for creation's final step, and
`HQ_MEDIA_STEP_CEILING_MS`, 210, for a media step of either kind. So in a 270 second call:

- a read step runs only as the call's first step, and is then the only one;
- a call whose first step is a media step runs media steps while less than 60 seconds have passed,
  and never starts the read step that follows them: it returns `again: true`;
- creation's final step runs only as the call's first step. What decides that is the row, not the
  call: creation's media steps write what they published on the row (6.1), so a later call that
  finds that work done does none of it, and the final step is its first step with the call's whole
  270 seconds. A call that did any media work answers `again`, with its progress.
- a read step or a final step that finds the instance's reading slot busy answers `again` after
  at most 20 seconds, having started nothing (3.6); no second step follows it in that call.

A creation therefore reaches `created` in a bounded number of calls. Every media call that answers
`again` has recorded progress on the row: a publishing step publishes for 120 seconds or until every
held file is published, whichever comes first, and a fetching step gives up to twelve files a
verdict. The one `again` that records none is the busy slot's, which another reading's step ends
within its own 270 seconds. Where storage answers at once and no file's verdict was dropped, that is
two calls: one that publishes every file, and the final step. What a creation call does before its
first step (loading the row, checking the choices, the credentials and the claim's advice) is a few
reads of Postgres, counted from the call's start like everything else and held by the final step's
30 second reserve.

Every answer carries the reading's id and state, so the client resumes by calling the same tool
with the same arguments. `read_hq_app` with no reading id starts one (`startReading`) and then
advances it. The tools' inputs, descriptions and scopes are part 13's (its 14.1 to 14.4, from the
scopes of part 05's section 13).

---

## 5. The review and its digest

### 5.1 The review

```ts
// lib/deployment/reading/types.ts
import type { Platform, PlatformFeatureId } from "@/lib/domain";
import type { DeploymentConfirmationKey } from "@/lib/deployment/types";
import type { FirstPublishView } from "@/lib/publish/firstPublishChangeIds";
import type { KeptLabelId } from "@/lib/publish/keptValues";
// Declared once, by part 11, in a client-safe module of B9, which lands beneath B10 (below).
export type { ReviewPlaces, ReviewTable } from "./projectData/reviewTypes";

/** One way the app may declare where it runs, as the review offers it. */
export interface ReadingDeclarationChoice {
	/** Null is Web Apps and Android. */
	readonly runsOnlyOn: Platform | null;
	/** True where choosing this splits the app's date-and-time questions. */
	readonly splitDatetime: boolean;
	readonly preselected: boolean;
	/** The plan features Nova records as already in use under this choice (part 10, 6.5). */
	readonly recordedFeatures: readonly DeploymentConfirmationKey[];
	/** What a first publish changes where this choice is made (part 09, 12.1). */
	readonly firstPublish: FirstPublishView;
}

/** What creating will make. Everything here is shown to the person or is a count of what is. */
export interface ReadingReview {
	/** CommCare HQ's name for the app: the default of the name choice. */
	readonly appName: string;
	/** ISO 8601: when the read ended. The kept list's date. Not in the digest. */
	readonly readAt: string;
	readonly creates: {
		readonly menus: number;
		readonly forms: number;
		readonly questions: number;
		readonly caseTypes: readonly string[];
		/** The app's languages, as CommCare HQ's codes, default first. */
		readonly languages: readonly string[];
		readonly mediaFiles: number;
	};
	/** At least one, exactly one preselected. */
	readonly runsOn: readonly ReadingDeclarationChoice[];
	/** Why the preselected choice is the one proposed (part 06's `narrowedByHq` and `keepsWebApps`). */
	readonly runsOnWhy: "content" | "web-apps-off-in-hq" | "keeps-web-apps";
	/** `HqAppSource.cloudcareEnabled`. */
	readonly webAppsOnInHq: boolean;
	/** How many date-and-time questions a choice that splits changes; 0 where no choice splits. */
	readonly datetimeQuestions: number;
	/** Each platform no offered choice declares, with what keeps the app off it. */
	readonly platformsOut: readonly {
		readonly platform: Platform;
		/** The distinct features of `platformUses.ts::unavailableUses` for that platform, in table order. */
		readonly features: readonly PlatformFeatureId[];
		/** A referenced file does not play there (part 11's `readingMediaFindings().playsOn`). */
		readonly media: boolean;
	}[];
	/** What stays as it is in CommCare HQ (part 01, 9.4). */
	readonly kept: readonly KeptLabelId[];
	/** The lookup tables the app reads, by tag. */
	readonly tables: readonly ReviewTable[];
	/** The places the app's logic reads, or null where it reads none. */
	readonly places: ReviewPlaces | null;
	/** How many media references point at no file and are left out (part 11, 3.2, row 4). */
	readonly mediaLeftOut: number;
	/** The preselected choice's list (part 09, 12.1): `runsOn`'s preselected entry holds the same. */
	readonly firstPublish: FirstPublishView;
}
```

`ReviewTable` and `ReviewPlaces` are declared once, by part 11, in
`lib/deployment/reading/projectData/reviewTypes.ts` (its 14.1), a module whose only run-time import
is `zod`: B9 lands beneath B10, so a module of part 11's cannot import a file of this part's.
`types.ts` re-exports both, and `lib/deployment/index.ts` re-exports them from there. Their members
are the ones the review needs: for a table, its `tag`, its `standing` (`"new" | "same-managed" |
"same-equal" | "choice"`), `hqDigest` (the digest of CommCare HQ's columns and rows), `projectTable`
(`{ tableId, definitionRevision, rowsRevision }` of the Project table it met, the two revisions as
decimal text, or null for `new`), and for a `choice` its `differs`, the `apps` that read the
Project's table and each answer's offer (`options`); for the places, `count` and `digest`
(`ManagedPlacePlan.digest`).

Where each field comes from, in `gather.ts`, after acceptance:

| Field | From |
|---|---|
| `appName` | `HqAppSource.name` (part 05, section 7), or the empty string where CommCare HQ sent none, in which case the person types one (`name_missing` until they do) |
| `readAt` | the clock when `readHqAppForReading` answered `read` |
| `creates` | the document: `moduleOrder.length`, the count of `forms`, the count of `fields`, `caseTypes`' names sorted, `localization`'s wire codes with the default first, and `plan.files.length`, the number of files in this read's media plan |
| `runsOn` | `AcceptedReading.declarations`, one `ReadingDeclarationChoice` each, in order, each with its `firstPublish`; `gather.ts` filters none. The narrowing by files is done once, before acceptance, as `AcceptReadingInput.choices` (3.3, step 7.4). `runsOnlyOn`, `splitDatetime`, `preselected` and `firstPublish` are the `AcceptedDeclaration`'s at the same position. `recordedFeatures` is `lib/deployment/adoption.ts::adoptionPlanFeatureConfirmations` (part 10, 6.5) over the document under that declaration's `mutations`, the target, `source.cloudcareEnabled` and `AcceptedReading.sourceHoldsSaveToCase`. At least one remains: where the content runs nowhere the reader gave `no-platform-runs-everything`, and where no remaining platform plays a file part 11 gave `media-not-played-where-app-runs`, and either is an account |
| `runsOnWhy` | `web-apps-off-in-hq` where the draft's `narrowedByHq` is true and the proposal stands, `keeps-web-apps` where `keepsWebApps` is true and the proposal stands, and `content` otherwise, including where part 11's files removed the proposal. The proposal stands where the choice at the draft's `proposed` index is the preselected entry of `runsOn` |
| `webAppsOnInHq` | `HqAppSource.cloudcareEnabled` |
| `datetimeQuestions` | the count of date-and-time questions a splitting choice changes: `splits.length` of a choice of `AcceptReadingInput.choices` whose `split` is true (every such choice splits the same questions); 0 where no choice splits |
| `platformsOut` | one entry per platform no offered choice declares, in `PLATFORMS`' order: `features` the distinct features of `platformUses.ts::unavailableUses(doc, [platform])` in table order, and `media` true where `readingMediaFindings().playsOn` leaves the platform out |
| `kept` | `keptListFor(facts)`, `facts` being `targetFactsFromSource` over the source as the adopted baseline will store it, with `observedAt` the read's `readAt`, `adopted: true` and `novaOwnsAutoGpsCapture` the `autoGpsCapture` of the ownership part 10's `adoptedAppBaselineWrite` gives that baseline (its 6.3); the empty list where the answer is null |
| `tables`, `places` | from `projectDataReview(data, reads, doc, mintingResolver(row.id))` (part 11, 14.1), which the check answers (`ReadingCheck.clean`) |
| `mediaLeftOut` | `HqMediaPlan.inert.length` (`ReadingCheck.media.leftOut`) |
| `firstPublish` | `AcceptedReading.firstPublish`, the preselected declaration's |

The review holds no sentence: part 13 words it from these values and the copy tables of parts 01,
09, 10 and 11 (part 11's R1 to R12 are functions of its `lib/publish/managedData.ts`, worded from
`tables`, `places`, `mediaLeftOut` and `creates.mediaFiles`). `readingReviewSchema` is the review's
strict Zod schema. It holds the four fields `runsOnWhy` to `platformsOut` and each choice's
`firstPublish` (part 09's `firstPublishViewSchema`), and it parses `tables` and `places` with part
11's `reviewTableSchema` and `reviewPlacesSchema`, so the digest covers every one of them (5.2).

### 5.2 The digest

```ts
// lib/deployment/reading/digest.ts
export interface ReviewDigestInput {
	readonly v: 1;
	readonly manifestRevision: string;
	/** The review without `readAt`. */
	readonly review: Omit<ReadingReview, "readAt">;
	/** `canonicalJsonDigest` of the persistable document with every media asset id replaced. */
	readonly document: string;
	/** `adoptedIdentityRows(...)`, as written: kind, Nova UUID, HQ id, `xmlns`. */
	readonly identities: readonly DeploymentIdentityOverride[];
	/** `assignMediaPaths(...)` over the files with each `assetId` set to `reviewMediaId(contentHash)`. */
	readonly mediaPaths: MediaPathAssignment;
}
/** `lib/utils/canonicalJson.ts::canonicalJsonDigest(input)`: 64 lower-case hex characters. */
export function reviewDigestOf(input: ReviewDigestInput): string;
```

**What it covers, and why each part is in it.**

| Part | Covers | A change the person must see again |
|---|---|---|
| `review` | every value the review screen shows: the name, the counts, the declaration choices and which is preselected, why it is the one proposed, whether Web Apps is on in CommCare HQ, the date-and-time questions a split changes, the platforms no choice declares and why, the kept list, each table's and the places' entry, the features recorded and the first-publish changes under each choice | a kept setting appearing; a table that now meets a Project table; a new first-publish change; Web Apps turned off in CommCare HQ |
| `review.tables`, `review.places` | each table's canonical digest of CommCare HQ's columns and rows, the met Project table's two revisions, each offered answer with what it does; the places' digest (part 11 asks the digest to cover exactly these) | a row edited in CommCare HQ since the review; a Project table edited in Nova since; an answer that is no longer offered |
| `document` | the reader's whole document, which is what a birth saves but for the name and the chosen declaration's mutations: every menu, form, question, expression, case write, hold and translation | a label edited in CommCare HQ since the review, which no count shows |
| `identities` | the HQ ids and `xmlns` the adopted deployment would record | a form deleted and re-made in CommCare HQ with the same content |
| `mediaPaths` | which path each file keeps | a file moved to another path |
| `manifestRevision` | the rules the reading was made under | a deploy between review and creation that changed what Nova holds |

**What it leaves out.** `readAt`, so the same app read a minute later has the same digest. CommCare
HQ's save counter, so a save that changed nothing Nova reads does not send the person back to the
review. The person's choices, which are made after it and validated against `review.runsOn` and
`review.tables`; what each choice would do is in the digest, as the option it answers.

**No choice changes the digested document.** The digest is made at the review, before any answer,
and compared at creation, after them, so the document it covers must be the same under every answer
the review offers. Three kinds of answer exist, and each is held to that:

- **The name.** `document` is the reader's document, which carries CommCare HQ's name. The name the
  person chose is applied to the candidate after the comparison (6.2).
- **The declaration.** That document is also before any choice's mutations. Each offered choice is
  in `review.runsOn`, and its mutations are a function of the document
  (`lib/doc/platformDeclaration.ts::planDeclarationChoices`, part 06), so an equal document and an
  equal `runsOn` give equal mutations.
- **A table's answer.** A table that asks a choice is read, before and after the answer, under one
  binding: the Project table's id, its columns by field name, and the reading's predeclared ids for
  the fields it lacks. That is the binding part 11 gives a `choice` tag before any answer and the
  one `use-commcare-hq` keeps (its 7.4 and 7.2). `use-project` gives the Project table as it is,
  and is offered only where the app reads no field that table lacks, so for every field the reader
  binds it gives the same column ids. The document is therefore one document under no answer and
  under either, which is part 11's rule too ("No answer moves a binding the reader read", its 7.4;
  Departure 13 here gives the evidence). The check holds it at creation: for every table
  of `gathered.tables` whose standing is `choice`, part 11's `resolveLookupBindings` over the same
  reads and standings with `choices: null` gives the no-answer binding, and the table's own binding
  must hold the same table id and, for each field the reader bound, the same column. The tags that
  fail are `ReadingCheck.bindingsMoved`. Where there is one, `gatherReading` answers an account of
  one `could-not-create` finding with `detail.name` `bindings` (6.5), logged with C8's sentence.

**Media ids.** A file's asset id is not stable across a reading: until a creation step publishes
the file it is the reserved id, a name the reading gives the file before any asset exists (staging
writes no row), and after that it is a ready file's, which may be one the Project already held. So
the digest never sees an asset id:

```ts
// lib/deployment/reading/mediaIds.ts
import type { HqMediaType } from "@/lib/commcare/hq/appSource"; // part 05, section 7

export const READING_MEDIA_NAMESPACE = "4374916f-4ced-42c6-b00d-f7fb7b45aaaf";
/** UUIDv5 under `READING_MEDIA_NAMESPACE` of
 *  `canonicalJsonText([readingId, mediaType, multimediaId])`. */
export function provisionalReadingMediaId(
	readingId: string, mediaType: HqMediaType, multimediaId: string,
): MediaAssetId;
/** UUIDv5 under the same namespace of `canonicalJsonText(["content", contentHash])`: one id per
 *  file content. `contentHash` is the SHA-256 the staged file and the published file both carry. */
export function reviewMediaId(contentHash: string): MediaAssetId;
```

`document` is `canonicalJsonDigest(remapAssetRefs(persistable, map))`, where `map` sends each asset
id the document holds to `reviewMediaId` of that file's content hash (the plan's `published`
entry's where the file has one, else its `held` verdict's `staged.contentHash`; the two are equal,
since publication refuses bytes whose hash is not the staged one, part 11, 4.1). `mediaPaths` is
`assignMediaPaths` (part 10, 4.2) run over the files with each `assetId` already set to
`reviewMediaId(contentHash)`, not a remap of the real assignment: two media documents of CommCare
HQ's that hold the same bytes are two files with two reserved ids at the review and one ready
file at the birth, and the assignment collapses paths per asset, so only an assignment keyed by
content is the same at both moments. It is also the assignment the birth will write, up to the ids'
names, so what B7's register says of collapsed and re-derived paths at the review is what happens.
`lib/domain/mediaRefs.ts::remapAssetRefs` is the production rewrite the Project move uses, which
touches every slot `walkAssetRefs` reads; built-in icon refs fall through unchanged. A digest is
computed only where every referenced file has a `held` verdict (3.3 ends at `needs-media` or an
account otherwise), so every id has a hash. `export const READING_MEDIA_NAMESPACE =
"4374916f-4ced-42c6-b00d-f7fb7b45aaaf";` in `mediaIds.ts`.

**Lookup ids need no such step.** A tag binds to the Project's own table where it meets one and to
the reading's predeclared ids otherwise (part 11's `readReadingProjectData`; 3.3, step 5). Both are
the same at the review and at creation unless the Project's tables changed in between, which is a
change the person must see and which `review.tables` holds; and no answer moves a binding the
reader reads, by the rule above.

### 5.3 The re-read at creation, and the mismatch path

```ts
// lib/deployment/reading/types.ts
export const bringInInputSchema = z.strictObject({
	/** The digest of the review the person is answering. */
	reviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
	appName: z.string(),
	runsOnlyOn: z.enum(PLATFORMS).nullable(),
	splitDatetime: z.boolean(),
	/** The answer for each table whose review entry asks a choice, by tag (part 11, 7.2). */
	tableChoices: z.record(z.string(), z.enum(LOOKUP_TABLE_CHOICES)),
});
export type BringInInput = z.infer<typeof bringInInputSchema>;
```

One call of `createFromReadingWithin` is a prelude that reads Postgres alone, then one step, or
several media steps where they fit (4.5).

**The prelude**, in order:

1. Load the row. A `created` row asks only that the caller is its actor, and answers the receipt,
   read back under the app's own access (6.6), which is what lets a retry answer after a Project
   move (2.7). Otherwise authorize as 2.5 says; any state but `ready` is refused `not_ready`.
2. `input.reviewDigest !== row.review_digest`: answer `review-changed` with the row. The person
   answered a review that is no longer the row's (another tab checked again).
3. The choices, against the stored review. `appName.trim()` is 1 to 255 characters
   (`name_missing`). `(runsOnlyOn, splitDatetime)` is a member of `review.runsOn`
   (`choice_not_offered`). The table answers go through part 11's
   `resolveTableChoices(review.tables, input.tableChoices)` (its 14.1). An answer it lists as
   `unknown` (the tag is no `review.tables` entry that asks a choice) or `notOffered` (the offer is
   `offered: false`) is `choice_not_offered`: a client sent an answer this review never showed.
   Then, where it lists a tag as `missing` (an entry asks a choice and no answer was sent): answer
   `held` with the circumstance `table-differs-in-project`, `detail.name` the first such tag in tag
   order, and write nothing (3.8). The review stands, the page shows the circumstance's block
   above it, and the person answers in the review. Otherwise its `choices` are the answers the
   final step reads with.
4. The connection, `getHqCredentials`, read as 3.3's step 1: a stop here answers `held` and nothing
   is published under a key CommCare HQ would refuse. Then the claim's advice, `readHqAppClaims` as
   3.3's step 2: where another Nova app already holds the HQ app, write `stopped` with
   `already-in-nova` and answer `review-changed`, before any file of this creation reaches the
   Project's library.

**The steps:**

5. **Media**, while creation's media work is not done (6.1). The call answers `again` with its
   progress, or `held` where a read of CommCare HQ failed inside the step.
6. **The final step**, only as a call's first (4.5): `gatherReading` with `tableChoices` the
   answers step 3 accepted and `chosen: { runsOnlyOn: input.runsOnlyOn, splitDatetime:
   input.splitDatetime }` (`reading-again`). Every held file is published by now (6.1), so the
   document names ready assets alone. By its result:

   | Result | Creation does |
   |---|---|
   | `busy` | write nothing and answer `again` with `publishing: null`: another step holds the instance's reading slot (3.6), and the next call runs this step with its whole budget |
   | `changed` | `changed_count` 0: write 1 and answer `again`. Already 1: write 0 and answer `held` with `changed-while-reading` |
   | `stop` | by 3.8's last column: answer `held`, or write `stopped` and answer `review-changed` |
   | `account` | write `account` as a read step does; answer `review-changed` |
   | `needs-media` | a file the document now references has no verdict: write `media`, as a read step does; answer `review-changed` |
   | `clean`, digest differs | write `ready` with the new review and digest; answer `review-changed` |
   | `clean`, digest equal | go on to the birth (6) |

**A write of creation that loses.** Creation writes the row at the revision it loaded, like every
step (3.2), and another tab may have moved it since. Any write of creation that finds the row no
longer at that revision (a media step's, where the row it reloads to merge into is no longer
`ready` under the same digest; the final step's `stopped`, `account`, `media` or `ready`; the write
after a refused birth) writes nothing, loads the row again, and answers by what it finds:
a `created` row answers `created` with `readBackAdoptedAppReceipt` (6.6), because the other tab's
creation of this same reading is this person's app; any other row answers `review-changed` with it.
So two tabs that press Bring it in together both end in the builder, whichever of them the birth
ran in and wherever the other was when it committed.

`review-changed` always carries the row as it now stands, so the page shows the new review, the
account or the stop with one sentence above it ("Copy"). The person's choices are not kept across
it: a changed review may no longer offer them.

The digest is compared after a full reader and acceptance run on the fresh read, never before:
nothing in the row is trusted to say what CommCare HQ holds now. Equal digests mean the document,
the ids, the paths, the project data and the review are the ones the person saw, under the same
rules.

---

## 6. The `hq-adoption` birth

`createFromReading` continues from 5.3 with a clean read whose digest is the person's.

### 6.1 Media is published first

Bytes cannot join a Postgres transaction, and the id a reference ends up naming is only known once
a file is published: publication runs under the Project and content-hash lock and adopts a ready
sibling where the Project already holds the same bytes (`lib/media/CLAUDE.md`). So the files are
published in steps of their own, before the re-read and before any candidate exists, through one
function of part 11's, `publishReadingMedia({ readingId, projectId, actorUserId, creds, plan,
deadlineAt })` (`lib/deployment/reading/projectData/mediaStore.ts`, its 14.2).

Until `deadlineAt` it publishes the held files that `plan.published` does not hold yet, through
its `lib/media/stagedMedia.ts::publishStagedMedia` (its 4.1), two at a time
(`STAGED_MEDIA_PUBLISH_CONCURRENCY`, part 11's constant, which is the media contract's two key-lock
bodies): each staged file's pending bytes are read and judged again, published as an ordinary
`ready` file of the Project (found or made by Project and content hash, as the MCP upload does),
and the pending object is deleted. A file whose pending bytes are gone is read from CommCare HQ
again with `creds` and published from memory where its bytes are still the ones that were judged.
It answers one of four things: `more` (the deadline came first), `published` (every held file is
published; it lists them as `files`), `refetch` (CommCare HQ no longer has a lapsed file, or holds
other bytes for it, so that file's verdict is dropped) or `failed` (a read of CommCare HQ failed).
The first three carry the `plan`, with every publication of the call in its `published` entries.
The function writes nothing to the reading's row: the step that called it does.

**Creation's media work is done** when every file of the row's plan either has a `published` entry
or holds a verdict that is not `held`. Until then each creation media step does one of two things,
never both, so each keeps the 210 second ceiling of 3.6:

- **A publishing step** (`publishing-media`), where some file has a `held` verdict and no
  `published` entry: one call of `publishReadingMedia` with `plan: row.media` and `deadlineAt` the
  step's start plus `HQ_MEDIA_PUBLISH_DEADLINE_MS` (120 seconds), so no file starts after that,
  the last in flight has its own 60 seconds, and the step's reserve holds its write. By its answer:

  | Answer | The step writes | The call answers |
  |---|---|---|
  | `more` | the answer's `plan` | `again`, with the answer's `done` and `total` |
  | `published` | the answer's `plan` | `again`: the media work is done, and the final step is the next call's first |
  | `refetch` | the answer's `plan`, which holds the call's publications and no verdict for the dropped files | `again`: the row stays `ready`, and the next media step is a fetching step |
  | `failed` | nothing | `held`, with `hqReadCircumstance(failure)`'s finding |

- **A fetching step** (`fetching-media`), where no file waits to be published and some file has no
  verdict. It is 3.4's media step run on a `ready` row: one call of `stageReadingMedia`, at most
  twelve files, four at a time. A `held` verdict is published by the next step. Any other verdict
  (the file is gone from CommCare HQ since the review, or is now over a limit) is written as it
  is, and the final step's re-read turns it into the account it is. A `failed` answer writes the
  plan it carries and answers `held` with `hqReadCircumstance(failure)`'s finding.

Either step writes its plan at the row's revision, merged with `mergeReadingMediaPlans` as 3.4
merges where the write loses to another media write, and answers `again` with `publishing: { done,
total }`, `done` being the plan's files with a `published` entry and `total` the plan's files with a
`held` verdict, which are the `done` and `total` part 11's `more` answer carries.
The row stays `ready` and its digest stands: the digest names each file by its content, and a file
fetched again either holds the same content or changes the digest, which the final step's
comparison then finds (5.2). The reading never goes back to `media` for a dropped file (Departure
14).

**Why the row records what was published.** Three things rest on it. The final step must run as a
call's first step (4.5), so a call has to learn that publication is done without doing it; the row
says so. `publishStagedMedia` deletes each pending object it publishes, so a second pass over the
same staged file would find its bytes gone and read the file from CommCare HQ again; the plan's
`published` entry is what makes `publishReadingMedia` skip it. And the final step needs each
file's asset id with no further work.

A step that dies between a publication and its write loses only the record, as a `failed` answer
does: the next publishing step finds the pending bytes gone, reads the file again, and its
publication finds the ready file by its hash. Nothing is published twice.

**What a failed birth leaves.** Ready files in the Project's library that no app references. They
are visible in Files, deletable there, and named by the row's `published` entries when the person
creates again. This is the Project move's bargain, in its words: "Media byte copies are the only
non-destructive pre-transaction work" (`lib/db/CLAUDE.md`). Nothing else exists before the
transaction commits.

`Gathered.mediaFiles` is part 11's `adoptedMediaFiles(files)` (its 4.1): part 10's
`AdoptedMediaFile` for every referenced path of every held file, `hqPath` as the source spells it.
`files` is the list of 3.3's step 7.4. At creation's final step every held file has a `published`
entry, so `files` is what the `published` answer listed and each `assetId` is a ready asset's. In
a read step of a reading no creation has touched it is part 11's `stagedReadingFiles(plan)`, each
file under its reserved id, so the review's path assignment is computed over the same files the
birth's will be.

A creation that ends `review-changed` or `held` after publishing leaves the same files: the person
asked to create, the files are in their Project's library, and the next creation finds them on the
row.

### 6.2 The candidate, and one seam in the tail

**The construction batch** is the reader's batch (`Gathered.draft.batch`), then the mutations of
the declaration the person chose (the `AcceptedDeclaration` of `gathered.accepted.declarations`
whose `runsOnlyOn` and `splitDatetime` are the input's: its `mutations`, which are part 06's for
that choice, a `setAppSettings` where it narrows and then each split's mutations, in the order
`planDeclarationChoices` gives them), then `{ kind: "setAppName", name: input.appName.trim() }`
where that differs from the document's. The birth diffs nothing itself: the reader hands over the
batch with its document (part 06, section 2.2, `ReadDraft.batch`), so this part holds no second
derivation of the
document to prove equal to the first.

```ts
const candidate = prepareGenesisCandidate({
	appId: row.id,            // the reading's id is the app's id
	projectId: row.project_id,
	mutations: batch,
});
```

It is prepared once, outside the retryable transaction, after publication (so the batch names final
asset ids) and with the bindings' lookup ids (the Project's own, or the reading's predeclared ones).
A serialization retry of the transaction reuses it, as `createExplicitBlankApp`'s does.

The declaration's mutations and the name are applied after acceptance judged the reader's document,
and acceptance has already judged them: B7 passes a reading only where the document under each
offered declaration's mutations passes the gate and export readiness (part 09, section 4), and the
one rule the gate holds a name to is that it is not blank (`EMPTY_APP_NAME`,
`lib/commcare/validator/rules/app.ts`), which 5.3's step 3 already required. So the candidate is a
document acceptance passed, under a choice acceptance passed.

**The adopted deployment's write** is assembled once, beside the candidate:

```ts
// lib/deployment/reading/birth.ts
export function adoptedDeploymentWrite(
	gathered: Gathered, row: ReadingRow, input: BringInInput, candidate: PreparedGenesisCandidate,
): Omit<AdoptedDeploymentWrite, "at">;
```

Every field of part 10's type (its 6.2), and where it comes from:

| Field | Value |
|---|---|
| `appId`, `projectId`, `actorUserId` | `row.id`, `row.project_id`, the person |
| `target` | `{ server: row.server, domain: row.domain }` |
| `remoteAppId` | `row.remote_app_id` |
| `remoteRevision` | `gathered.facts.hqVersion`: the save counter this creation's own bracketed read held, never the row's `hq_version` from the review. The digest leaves the counter out (5.2), so a save in CommCare HQ that changed nothing Nova reads lets the review stand; recording the review's counter beside the creation's baseline would then make the first publish's drift check see a change since the baseline and stop for nothing |
| `pushedRevision` | 1, the birth's sequence |
| `identities` | `adoptedIdentityRows(gathered.draft.identities, gathered.modules)`'s `rows` (part 10, 3.1). `ok: false` is 6.5's `could-not-create` and no transaction opens |
| `baseline` | `adoptedAppBaselineWrite({ remoteAppId, source, prepared, target, identity, identityMap, observedAt, firstPublish })` (part 10, 6.3; `firstPublish` is B7's input, part 09, 12.3): `source` is `gathered.source`, `identity` `targetWireIdentity(rows)`, `identityMap` `gathered.draft.identities.entries`, `observedAt` `gathered.facts.readAt`, and `firstPublish` the chosen declaration's `AcceptedDeclaration.firstPublish` from this creation's own acceptance. `prepared` is part 09's `adoptionExportBoundary(doc, lookup.definitions, mediaFiles, target)` (its 15.2): `doc` the candidate's document, `lookup` `gathered.lookup`, `mediaFiles` `gathered.mediaFiles`, and `target` the server's origin and the project space, as the reader takes it |
| `mediaPaths` | `assignMediaPaths(gathered.mediaFiles).rows` (part 10, 4.2): the kept paths, by published asset |
| `confirmations` | `adoptionPlanFeatureConfirmations` over the candidate's document, the target, `source.cloudcareEnabled` and `accepted.sourceHoldsSaveToCase` (part 10, 6.5): the `recordedFeatures` the review showed for the chosen declaration, computed again from the document being born |

**The seam.** `lib/db/appGenesis.ts::WritePreparedGenesisArgs` gains:

```ts
/**
 * Runs once, after the app row is inserted and before the lookup context is read. A birth that
 * brings Project data with it writes that data here, so every verdict below reads it on this
 * transaction. It may lock Project state and the new app's own rows, and no existing app's row.
 */
readonly afterAppInsert?: (tx: Transaction<AppDatabase>) => Promise<void>;
```

`writePreparedGenesisInTransaction` awaits it between the `insertInto("apps")` statement and
`lookupContextForAuthoritativeWrite`. The three existing callers pass nothing and run exactly the
statements they run today. `GenesisGateRejectedError` gains two fields the tail sets where it throws:
`readonly check: "gate" | "export"` and `readonly findingCodes: readonly string[]` (the `code` of each
`ValidationError`), so a caller can log what was refused without logging the app's words.

Why the seam is where it is:

- **After the membership assertion.** The tail's first statement is
  `assertProjectCapabilityInTransaction`, which takes the shared membership gate. Lookup tables are
  written under `lookup_project_state FOR UPDATE`. Taking Project state first and the gate after
  can close a cycle: a lookup writer holds the shared gate and waits for Project state; a membership
  write waits for the exclusive gate behind it; the birth, holding Project state, asks for the
  shared gate and queues behind the exclusive waiter. Gate first is the order every app-bound lookup
  writer already keeps (`lib/lookup/agentService.ts`).
- **After the app row.** `app_locations` and `app_organization_state` reference `apps(id)`, so a
  place cannot be written before its app. And "app row, then Project state, then tables" is the
  app-bound order `lib/lookup/CLAUDE.md` states.
- **Before the lookup context.** `lookupContextForAuthoritativeWrite(tx, …)` locks and reads the
  tables the candidate names. Run on the transaction that just created them, it finds them: this is
  how the gate and `exportReadinessFindings` see same-transaction rows, with no second code path.
- **Before the organization's integrity step.** `applyOrganizationCommitIntegrity` is where Nova
  proves a document and its places agree: every stored place stands at a level that may nest under
  its parent's (`assertLocationPlacementsValid`), every stored value fits the document's location
  properties (`assertLocationValuesValid`), and a reverse owner hop finds one place
  (`assertReverseHopTargetsUnambiguous`). Every later commit of the app runs those checks over its
  places. With the places written in the seam, the birth runs them too, over the copy it is about
  to commit, and a copy that fails them rolls the birth back as Nova's defect (6.5). Written after
  the tail, the same copy would commit unjudged and then fail the person's first unrelated edit.
  The step's edges are not the reason: a brought-in document names no place. It holds no persona
  (part 10, 2.2) and no automation, and a case owner set to one fixed place cannot be in it, since
  export readiness refuses that term (`lib/export/boundaryValidation.ts::organizationExportFindings`,
  `LOCATION_OWNER_EXPORT_NOT_ACTIVE`) and the reader admits only what the gate and export readiness
  admit. So `extractLocationReferenceTargets` is empty at a birth, and part 11 is right that place
  ids need no predeclaring.

### 6.3 The one transaction

```ts
// lib/deployment/reading/birth.ts
export interface AdoptionBirth {
	readonly readingId: string;
	/** The revision and digest the creation read; the row must still hold both. */
	readonly expectedRevision: number;
	readonly reviewDigest: string;
	readonly actorUserId: string;
	/** Attribution only: an adoption holds no run. Minted outside the transaction. */
	readonly runId: string;
	readonly candidate: PreparedGenesisCandidate;
	readonly hqApp: HqAppKey;
	/** Part 11's `ReadingProjectDataWrite`, as the final step gathered it: the origin, the tables
	 *  to create or refresh, and the places to copy (null where the app reads none). */
	readonly projectData: ReadingProjectDataWrite;
	/** Part 10's write, less its time: `adoptedDeploymentWrite`'s answer (6.2). */
	readonly deployment: Omit<AdoptedDeploymentWrite, "at">;
	readonly at: Date;
}
export type AdoptionOutcome =
	| { readonly kind: "born"; readonly role: string }
	/** The reading was already `created`: answer from the saved app. */
	| { readonly kind: "replay" }
	/** The row is no longer the `ready` row this creation read. */
	| { readonly kind: "superseded" };

export function adoptHqAppInTransaction(
	tx: Transaction<AppDatabase>, birth: AdoptionBirth,
): Promise<AdoptionOutcome>;
```

`createFromReading` calls it inside `withAppTx(body, { deadlineAt: stepDeadlineAt })`, so the
transaction cannot commit after the step's budget is spent; 3.6 gives the instant and what a
transaction PostgreSQL ends there becomes. The body is pure of side effects: the candidate, the
deployment's write, `runId` and `at` are made before it, and a retry runs the same statements.

In order, with the lock each statement takes:

| # | Statement | Lock |
|---|---|---|
| 1 | `lockReadingInTransaction(tx, readingId)`. No row, or `removed`: `superseded`. `created`: `replay`. Not `ready`, or another `revision` or `review_digest`: `superseded` | the reading's row, `FOR UPDATE` |
| 2 | `lib/db/hqAppClaims.ts::claimHqAppInTransaction(tx, hqApp)` (part 10, 5.2) | the HQ app's transaction advisory lock; where the holder is in recently deleted, that app's row `FOR UPDATE` |
| 3 | `writePreparedGenesisInTransaction(tx, { candidate, actorUserId, runId, status: "complete", afterAppInsert })`: | |
| 3a | `assertProjectCapabilityInTransaction(…, "edit")` | the shared membership gate; the member row is read |
| 3b | `INSERT apps` at sequence 1, `status` `complete`, no holder and no reservation columns | a new row |
| 3c | `afterAppInsert`, with `write` being `birth.projectData` and `origin` `write.origin`: part 11's `writeBroughtInLookupTablesInTransaction(tx, { projectId, actorUserId }, { origin, tables: write.tables, at })` (its 7.4), which re-derives each standing under the lock and throws `BroughtInTableChangedError` where one is no longer the standing its binding was made for | `lookup_project_state FOR UPDATE`, then each table it creates or refreshes |
| 3d | `afterAppInsert`, after 3c: part 11's `writeBroughtInPlacesInTransaction(tx, { appId, projectId, actorUserId }, { origin, places: write.places, at })` (its 11.4), which takes a null `places` and then writes nothing; otherwise it reaches `lib/organization/managed.ts::writeManagedPlacesInTransaction` | new rows: the new app's `app_organization_state` and its `app_locations` |
| 3e | lookup context; the absolute gate; `getAssetsInTransaction` over the referenced assets; export readiness | the candidate's tables `FOR KEY SHARE` (those 3c wrote are already held); each referenced asset `FOR SHARE`, in id order |
| 3f | organization integrity, which reads the places 3d wrote; `admitExactMediaReferences`; lookup edges | the same assets, already held |
| 3g | entity rows; the sequence-one `fold-baseline` change; the immutable baseline through `nova_insert_app_change_genesis_fold_baseline`; the runtime case schemas | new rows |
| 4 | `lib/deployment/store.ts::recordAdoptedDeploymentInTransaction(tx, { ...deployment, at })` (part 10, 6.2): the deployment at `uploaded`, the `adopted` mapping at `pushed_revision` 1, the `read` baseline with its identity map, the identity rows, the media paths, the confirmations, the deployment poke | new rows; the claim index entry |
| 5 | `markReadingCreatedInTransaction(tx, readingId)`: `state = 'created'`, `app_id = id::text`, `outcome`, `review_digest`, `media`, `phase`, `step_beat_at` null, `minted` empty, `revision + 1` | the row held since 1 |
| 6 | `projectRoleForInTransaction(tx, actorUserId, projectId)` for the receipt | the shared gate, held since 3a |

**The order is free of a cycle**, by five facts:

- **The reading's row is always first, and nothing else waits for one while holding another lock.**
  Two transactions lock a reading's row: this one and `markReadingRemoved`'s, which locks that row
  and nothing more.
- **The claim's locks are part 10's** (its 5.2): an advisory lock is never waited for while an app
  row is held, and a birth waits for at most one existing app's row.
- **The membership gate comes after every app row and before Project state**, the order of every
  existing-app protocol and of every app-bound lookup writer. A membership write takes the gate and
  no row.
- **After Project state the birth asks for no app row.** `lib/lookup/CLAUDE.md`: "No code may hold
  Project state or a lookup table and later request an app lock." Statement 4 reads the new app's row
  without a lock (part 10, 6.2), and that row is this transaction's own insert, which nothing else
  can see or wait on.
- **Media rows are locked after the gate, as media deletion locks them** (gate, then the asset), and
  no lookup writer locks an asset.

`hq-adoption` is creation, so it is gate-first in the sense the contract means: it locks no row of
the app it creates before the gate. The rows it does lock before the gate are its own authority row
and, through the claim, another app's.

**What "atomic" covers.** One commit makes the app, its entities, its baseline and history row, its
case schemas, its lookup tables and their edges, its media edges, its places, its deployment with
the claim, and the reading's `created`. A failure of any statement leaves none of them. The only
things that can exist without the app are the published media files of 6.1.

### 6.4 What an adopted app is born with, and without

| | |
|---|---|
| `apps.status` | `complete` |
| `apps.owner` | the person who brought it in (creation provenance, never an access rule) |
| `apps.run_id` | a fresh UUID, attribution only |
| holder (`run_holder_nonce`, `run_lock`) | none: `lib/db/CLAUDE.md`, "Complete creation does not use holder identity" |
| reservation (`res_*`) and credits | none: only `/api/chat` charges; nothing is reserved, debited, settled or refunded |
| the per-actor generation gate | not taken: no holder is created |
| `design_sessions`, `authoring_sessions`, `design_change_sets` | no row: there was no design and no private candidate |
| threads | none (9.6) |
| held placements | the holds the reader's batch carries (its trailing `holdPlacements`); the genesis baseline's snapshot is their recording, so `readRecordedPlacementHolds` answers them and an editor may restore to them |
| `appSettings.runsOnlyOn` | the declaration the person chose, where it narrows; otherwise absent, as `NEW_APP_SETTINGS` |
| the sequence-one change | `fold-baseline`, batch `genesis:<app_id>`, actor the person, mutations `[]`, as every birth |
| the deployment | part 10, section 6: `uploaded`, `adopted`, `pushed_revision` 1, a `read` baseline |
| notices | none: `app_migration_notices` is written by migrations alone |

The construction batch is not history: sequence 1 carries `[]` and the baseline carries the whole
snapshot, so a large app costs one reduction and one validation and never a replay.

### 6.5 Refusals at the birth

`createFromReading` catches around `withAppTx`:

| Thrown, or returned | Means | The reading | The answer |
|---|---|---|---|
| `superseded` | another tab checked again, removed the reading, or changed its review | as the other act left it | `review-changed` with the row; `refused: reading_not_found` where it is gone |
| `replay` | another call of this reading's creation committed first | `created` | `created`, with the receipt read back (6.6) |
| `HqAppAlreadyClaimedError` | a live Nova app publishes to this HQ app | `stopped`, `already-in-nova`, with `detail.claim` from a fresh `readHqAppClaims` | `review-changed` |
| `GenesisGateRejectedError` | the tail's gate or export readiness refused a document acceptance had just passed | `account`, one `could-not-create` finding at the app, `detail.name` the error's `check` | `review-changed` |
| part 11's `BroughtInTableChangedError`; its `LookupError` with code `tag_taken` or `conflict` | a table the app reads changed in the Project between the final step's snapshot and the birth's lock: a table of that tag was created, edited, or taken over with Manage in Nova | `reading`, written as `checkReadingAgain` writes it (the verdicts, the published files and the ids kept) | `review-changed`. The page advances it, and the fresh review shows the table as it now stands, with its choice where it asks one |
| `BlueprintCommitRejectedError`, and some `published` asset is no longer a ready file of the Project (`lib/db/mediaAssets.ts::loadAssetsByIds` after the rollback) | someone removed a file from the Project's library between its publication and the birth | `ready`; `media` loses that file's `published` entry and its verdict, so the next creation fetches and publishes it again | `refused: project_changed` |
| `BlueprintCommitRejectedError`, and every `published` asset is still a ready file of the Project | the tail's lookup context, organization integrity or media admission refused what acceptance and part 11's plans had passed | `account`, `could-not-create`, `detail.name` `integrity` | `review-changed` |
| `CommitReauthError` | the person no longer edits in the Project | unchanged | `refused: project_access_lost` |
| `adoptedIdentityRows` answers `ok: false` | a form with no real id reached a birth, which part 10 (3.1) shows cannot happen | `account`, `could-not-create`, `detail.name` `identity` | `review-changed` |
| the final step's check answers a tag in `bindingsMoved` (5.2), before any transaction opens | an answer moved a binding the reader read, which part 11's rule (its 7.4) and its offers rule out | `account`, `could-not-create`, `detail.name` `bindings` | `review-changed` |
| PostgreSQL's `transaction_timeout` (SQLSTATE `25P04`), or `stepDeadlineAt` already past | the birth did not fit what the step had left (3.6) | `account`, `too-large`, `detail.name` `saving` | `review-changed` |
| anything else | infrastructure | unchanged | thrown; the route answers 500 and `log.error` |

`BlueprintCommitRejectedError` is thrown by several statements of the tail (the lookup context,
organization integrity, media admission, the lookup edges) and carries nothing that tells them
apart (`lib/db/commitGuard.ts`), so creation asks the one question that does: are the files it
published still there. That read is of at most the ids of the plan's `published` entries, once,
after a rollback.

**A gate refusal at birth is Nova's defect.** Acceptance check 2 ran the same gate and the same
export readiness over the same document moments before; the tail disagreeing means two Nova code
paths disagree. The person is told so, in Nova's voice, through a circumstance part 01 holds for it
(its sections 8.3 and 9.3, both rows landing in B10):

| Code | Standing | Owner | When | `detail` | Lands in |
|---|---|---|---|---|---|
| `could-not-create` | not-yet | | the birth's own checks refused a reading that acceptance had passed | `name`: `gate`, `export`, `integrity`, `identity` or `bindings` | B10 |

| Title | Body | Next |
|---|---|---|
| Nova couldn't create this app | Nova read {app} and every check passed, and then Nova's own last check before saving turned the app down. That is Nova's mistake, not the app's, and it has been reported to the team. Nothing was created. | Nova keeps what it read, and you can check again after Nova's next update. |

It is logged with `log.error("[reading] could not create: " + check, undefined, { appId: readingId,
projectId, userId, operation: "create", phase: check, findingCodes })`: a message and a context, and
no error object. The thrown error must not be passed. `GenesisGateRejectedError`'s message is the
findings' own sentences (`describeCommitFindings`, and each export finding's `message`), which hold
the app's words, and `lib/logger.ts` sends an error it is given to Sentry
(`Sentry.captureException`) and writes its stack to Cloud Logging. A message alone is a message
event, which groups by its text: one issue per check, which is section 10's rule. `findingCodes` is
the validator codes (the `findingCodes` of either error class), never a sentence.
`read-back-differs` is not reused: its block says the check of Nova's own reading did not pass
(part 01, 9.3), and here that check passed and Nova's own saving refused.

### 6.6 The answer, and a retry

```ts
// lib/deployment/reading/types.ts (the type), lib/deployment/reading/create.ts (the functions)
export type CreateResult =
	| { readonly kind: "created"; readonly receipt: AdoptedAppReceipt }
	/** Call again now: a media step ran and the final step is still to come, CommCare HQ's counter
	 *  moved once, or the instance's reading slot was busy (3.6). `publishing` is null for the
	 *  second and the third. */
	| { readonly kind: "again"; readonly reading: ReadingView;
	    readonly publishing: { readonly done: number; readonly total: number } | null }
	/** The review is no longer the one answered. `reading` is what stands now. */
	| { readonly kind: "review-changed"; readonly reading: ReadingView }
	/** A stop the person can clear, an unanswered table choice among them. The review stands. */
	| { readonly kind: "held"; readonly reading: ReadingView;
	    readonly finding: CircumstanceFinding }
	| { readonly kind: "refused"; readonly refusal: ReadingRefusal;
	    readonly reading: ReadingView | null };

/** `createFromReadingWithin` with `HQ_READING_STEP_MS`: what the browser's route calls. */
export function createFromReading(
	actor: ReadingActor, readingId: string, input: BringInInput,
): Promise<CreateResult>;
/**
 * The prelude, then whole steps while they fit (4.5, 5.3). `now` is `Date.now` and `slots` is
 * `processReadingSlots` (3.6) unless a test passes its own.
 */
export function createFromReadingWithin(
	actor: ReadingActor, readingId: string, input: BringInInput, budgetMs: number,
	now?: () => number, slots?: ReadingSlots,
): Promise<CreateResult>;
```

**A retry returns the same app.** The reading's id fixed the app's id when the reading started, so
every creation of one reading prepares the same `apps.id`, and the row's state says whether one
committed:

- A second call after a lost response finds `state = 'created'` at step 1 of 5.3, before any read of
  CommCare HQ, and answers `created` with `readBackAdoptedAppReceipt(row, actorUserId)`.
- Two calls at once (two tabs). Where the second reaches the birth before the first commits, it
  waits at statement 1 of 6.3, then reads `created` and answers `replay`, which becomes the same
  read-back receipt. Where the first commits while the second is still in its prelude or its
  re-read, the second meets the new app as the HQ app's holder (`readHqAppClaims` answers
  `already-in-nova`) or simply finishes its read, and its next write finds the row no longer at its
  revision; 5.3's rule for a losing write reloads the row, finds `created`, and answers `created`
  with the same receipt. No interleaving of the two answers `review-changed` or shows a stop for the
  person's own app. Those are two calls on two instances. On one instance the second call's final
  step finds the reading slot taken and answers `again` (3.6), and its next call finds `created`
  at step 1.
- A call that died before the commit left nothing but published media, recorded on the row or
  found again by hash (6.1); the next call runs the final step again.

`readBackAdoptedAppReceipt` calls `lib/db/appAccess.ts::resolveAuthorizedAppSnapshot(appId, userId,
"view")`, the builder's own hydration read, and builds the receipt from it: the saved app at its
current sequence (it may have been edited since), `batchId` `genesisBatchId(appId)`, `snapshotDigest`
`canonicalJsonDigest(blueprint)`, and the role and Project the snapshot resolved, which is the app's
Project today, not the reading's. `AppAccessError` is answered `refused: app_unavailable` ("Copy"):
the app was brought in and is now in recently deleted, or the person is no longer a member of its
Project.

---

## 7. The receipt's adoption arm

### 7.1 The key set

`lib/db/appGenesis.ts` gains, beside `AppMaterializationReceipt`:

```ts
/** What a brought-in app's receipt says of where it came from. */
export interface AppAdoption {
	readonly readingId: string;
	/** A `CommCareServer`, as text: this file imports nothing of `lib/commcare`. */
	readonly server: string;
	readonly domain: string;
	readonly remoteAppId: string;
}
/** The activation receipt of an `hq-adoption` birth: the twelve keys of every receipt, and one. */
export interface AdoptedAppReceipt extends AppMaterializationReceipt {
	readonly designSessionId: null;
	readonly changeSetId: null;
	readonly starter: null;
	readonly adoption: AppAdoption;
}
```

Exactly thirteen keys: `adoption`, `appId`, `batchId`, `blueprint`, `canEdit`, `changeSetId`,
`designSessionId`, `eventVersion`, `projectId`, `role`, `seq`, `snapshotDigest`, `starter`.
`adoptedAppReceipt` builds it at a birth (`seq` 1, `snapshotDigest` `candidate.candidateDigest`,
`blueprint` `candidate.persistable`, `canEdit` `roleAllowsApp(role, "edit")`), and
`readBackAdoptedAppReceipt` on a retry (6.6):

```ts
// lib/deployment/reading/birth.ts
export function adoptedAppReceipt(
	candidate: PreparedGenesisCandidate, row: ReadingRow, role: string,
): AdoptedAppReceipt;
/** Rejects with `AppAccessError` where the person can no longer open the app (6.6). */
export function readBackAdoptedAppReceipt(
	row: ReadingRow, actorUserId: string,
): Promise<AdoptedAppReceipt>;
```

**Why a second key set, and not a thirteenth key on every receipt.** The parser admits a key set
exactly. A build that began before a deploy can finish after it, and its `data-app-materialized`
frame then reaches a tab running the previous client; an added key would make that tab refuse the
receipt of a build the person watched finish. So the blank app, a reviewed build and a session's
first save send the twelve keys they send today, byte for byte, and only the new route sends
thirteen, to a client that knows them.

### 7.2 The parser

`components/chat/chatLifecycle.ts`:

- `AppMaterializationActivation` gains `readonly adoption: AppAdoption | null` (the type is declared
  again here, client-side, with `server` as `string`; `components/**` imports nothing of
  `lib/commcare`).
- `parseAppMaterializationReceipt` admits two key sets. The twelve-key set parses exactly as today
  and yields `adoption: null`. The thirteen-key set requires, beyond every rule the twelve-key set
  already holds: `designSessionId === null`, `changeSetId === null`, `starter === null`; `adoption`
  a plain object whose keys are exactly `domain,readingId,remoteAppId,server`, each a non-blank
  string; `adoption.readingId === appId`; `adoption.server` one of `production`, `india`, `eu`. Any
  other shape is `null`, as today.
- The rule that a receipt's blueprint holds at least one menu stays for both: the gate refuses an
  app with none (`NO_MODULES`, `lib/commcare/validator/rules/app.ts`), so no birth sends one.

### 7.3 The installer

`components/chat/ChatContainer.tsx::installCreatedApp` does for an adopted app exactly what it does
for every other: identity and capability into the session store, the blueprint under a remote-apply
bracket, the URL promoted to `/build/{id}` through `pushBuilderHistory`, the reconciler activated at
the receipt's `seq`, the app list marked stale. It is unchanged but for its comment ("Contracts").
Since the reading's id is the app's id, the URL the person is promoted to holds the id the flow
already had.

B10 makes the landing reusable. The block inside the blank-app handler that parses a raw receipt,
checks the tab's Project scope against it, installs it and starts the digest check becomes one
function of `ChatContainer`:

```ts
/**
 * Lands one raw creation receipt.
 * `landed`: installed in this tab. `leaving`: the tab is loading the app's own page.
 * `unverified`: neither could be done here, and the toast of C6 says so.
 */
const landCreatedAppReceipt: (
	raw: Record<string, unknown>, origin: "blank" | "brought-in",
) => "landed" | "leaving" | "unverified";
```

The blank-app handler calls it with `"blank"` and behaves as today: `landed`, or `unverified` with
today's toast. Part 13 (B11) calls it with `"brought-in"` from the flow it mounts on `/build/new`,
passing the `receipt` of a `created` answer; the function is handed to that flow as a prop of the
component B11 adds. `verifyActivationDigest` runs wherever a receipt is installed: an adopted
receipt arrives as a route's JSON, and the digest is over the same canonical JSON text.

**A receipt for another Project.** The first screen of the flow offers "Add it to <Project>",
preselected to the Project the person is looking at (part 13, section 4.1), so choosing another
is an ordinary act; and a retried creation answers with the app's Project today, which a move may
have changed (6.6). The tab's session is scoped to one Project (`lib/session`: `projectId`,
`scopeEpoch`), and both existing landings refuse a receipt whose `projectId` is not the session's
(`ChatContainer.tsx`: the `data-app-materialized` handler and `handleCreateStarterApp`), rightly: a
tab's stores, its lookup manifest and its presence belong to its Project. Installing another
Project's app into them is not something to loosen. So `landCreatedAppReceipt`, by what the parsed
receipt says:

| The receipt | Origin | It does | Answers |
|---|---|---|---|
| fails `parseAppMaterializationReceipt`, or the session's scope epoch moved | either | the toast of C6 | `unverified` |
| names the session's Project | either | `installCreatedApp`, then `verifyActivationDigest`, as today | `landed` |
| names another Project | `blank` | the toast of C6, as today: a blank app is created in the session's Project, so this is a fault | `unverified` |
| names another Project | `brought-in` | `window.location.assign("/build/" + activation.appId)` | `leaving` |

The last row is a full page load, and it is the one place a creation navigates. What
`components/builder/CLAUDE.md` protects by forbidding a route change after a creation is a live run
and the document the client already holds. Here there is no run (an adoption holds none, 6.4), and
the tab's stores belong to a Project the new app is not in, so there is nothing of this tab to
keep. The app's page hydrates through `resolveAuthorizedAppSnapshot` and takes the app's own
Project (`app/(app)/build/[id]/[[...path]]/page.tsx`), exactly as opening that app from a link
does today; the person's active Project is not changed for them. The receipt is still parsed first,
so the id the tab loads is one the strict boundary admitted. Part 13's flow keeps its "Creating
your app" state while the answer is `leaving`.

Nothing in the session or the doc store records that an app was brought in: the app's deployment
says it (part 10: the `adopted` mapping, `adoptedByName`), and what the builder shows on landing is
part 13's, read from `activation.adoption`.

---

## 8. The census

### 8.1 What a row counts

```ts
// lib/deployment/reading/census.ts
export interface ReadingCensus {
	/** One entry per finding code the read met: a manifest entry id or a circumstance. */
	readonly codes: Readonly<Record<string, {
		readonly standing: FindingStanding | "stop";
		/** The step 7 group, for a `not-yet` finding that has one. */
		readonly owner: Step7Group | null;
		readonly count: number;
	}>>;
}
export const readingCensusSchema: z.ZodType<ReadingCensus>;
/** Counts every finding, the ones past `READING_MAX_STORED_FINDINGS` too. */
export function censusOf(findings: readonly Finding[]): ReadingCensus;
/** Several apps' censuses as one, one census an app: per code, how many apps met it and how
 *  many findings they hold of it together. The inspector's arithmetic (8.2). */
export function mergeCensuses(censuses: readonly ReadingCensus[]): Readonly<Record<string, {
	readonly standing: FindingStanding | "stop";
	readonly owner: Step7Group | null;
	readonly apps: number;
	readonly findings: number;
}>>;
```

`writeReadingOutcome` writes `census` and `finding_codes` (the sorted keys of `codes`) with every
`account`, with every `stopped` (one code, count 1), and with every `ready` (an empty census: a
readable app is counted by its state). A census holds entry ids, standings, group ids and numbers,
and nothing an app's author typed. It survives Remove (2.6).

### 8.2 The inspector

`scripts/inspect-hq-readings.ts`, read-only, in the idiom of `scripts/inspect-usage.ts`
(`import "./lib/loadEnv"`, `commander`, `--help`, `--prod` through `scripts/lib/prodDb.ts`):

```
npx tsx scripts/inspect-hq-readings.ts [--since <yyyy-mm-dd>] [--prod] [--json]
```

It reads `state`, `census`, `manifest_revision`, `created_at` and the key columns of every row
(since the date where given). One app is one `(actor_user_id, removedAppKey(server, domain,
remote_app_id))`: a removed row already holds that key in `remote_app_id` (2.6) and the script
computes it for every other row, so the reading a person removed and the one they started next
count as one app. It takes the latest row of each (so an app checked five times counts once), and
prints three tables through `mergeCensuses`:

1. **By step 7 group**: for each of the ten group ids of `STEP_7_GROUPS`, the number of apps with at
   least one `not-yet` finding of that group, and the number of apps for which that group is the
   only thing between them and coming in.
2. **By entry id**: code, standing, group, the number of apps that met it, the number of findings.
3. **By outcome**: how many apps are in each state, and for `stopped` by code.

It prints no app id, app name, project space, server, Project or person: grouping keys are used to
dedupe and are never written out. `--json` prints the same three tables as one object.

This is what orders step 7 (`../6-bring-in.md`, "What step 7 is left": "After the first group the
order is the census of readings"): table 1's second column is the order that brings the most apps in
soonest. The script stays after step 6: it runs again whenever a group is planned. Its output is
execution evidence and is not committed.

---

## 9. What every other surface does with an adopted app

An adopted app is an `apps` row at `complete` with entities, a baseline and a deployment. Each
surface below was traced from its entry to what it reads; "none" means no line of it changes.

### 9.1 App Tests

`lib/db/appTests.ts` pins an app's document at a sequence and evaluates it on Preview's engine over
the app's case rows. It reads nothing about how an app was born. An adopted app holds no personas
and no users (CommCare HQ's app holds neither; part 10, 2.2), so a journey starts as it does for any
app without them. `RUNTIME_VERSION` does not move in B10: no evaluator changes. **Work: none.**

### 9.2 App copy

Nova has none: `rg -i "duplicateApp|copyApp|cloneApp|duplicate_app|copy_app"` over `lib`, `app` and
`components` finds nothing, and the home list offers no copy. Bringing the same HQ app in twice is
refused by the claim. **Work: none.**

### 9.3 Delete and restore

`lib/db/apps.ts::softDeleteApp` sets `deleted_at` and writes nothing else; part 10 (5.3, 5.4, 8.4)
decides what the claim does and B8 changes `restoreApp`. The created reading row is untouched by
both: it is not on any list, and it cascades only with a hard delete no runtime path performs. A
retried creation of a deleted app answers `app_unavailable` (6.6). A new reading of the same HQ app
is allowed while the app is in recently deleted, since the open-row index leaves `created` rows out
and the claim passes over a deleted holder. **Work: none in B10.**

### 9.4 Project move

2.7. Part 10 (4.6) re-maps the deployment's media paths in the move. **Work: none in B10** beyond the
test that holds the row unchanged.

### 9.5 `search_blueprint`, `get_app` and the other read tools

They read the saved document through `loadApp` and its projections. An adopted document is made of
the same union every app is; the reader admits exactly what the gate admits (the bar's clause (a):
part 01, "The admission bar"), so no projection meets a shape it has no arm for that a
Nova-authored app could not also hold.
`get_deployment` shows the adopted deployment through part 10's projection, which B12 words.
**Work: none in B10.**

### 9.6 The first edit turn, and the thread an adopted app starts with

An adopted app starts with **no thread**. `threads` rows are written by the chat route as a run
produces units (`lib/db/threads.ts`), and "a FRESH thread admits no assistant messages at all (no run
ever wrote to it)" (`lib/db/CLAUDE.md`): a first message saying what came in would be a transcript no
run wrote. The builder opens `/build/{id}` with an empty conversation, as it does for a blank app,
and what came in is said by the landing part 13 draws and by the Publishing card.

The first message a person sends is an ordinary edit turn: `/api/chat` derives the mode from the
row's status (`complete` is edit, `lib/db/CLAUDE.md`, "Pricing + the charge signal"), claims an edit
lease, charges the edit rate, and creates the thread from the client-minted id. An app with no
design session is not refused: the route refuses a sessionless app only when it is not `complete`
("a sessionless non-complete app is a legacy row"). The canonical commit guard's freeze applies to
"a materialized reviewed build" until its orchestration head is terminal; an adopted app has no
design session, so it is never frozen. The Solutions Architect reads the document through the same
tools as for any app. **Work: none in B10.** What the guide says about an app that came from
CommCare HQ (managed tables, kept settings) is B12's.

### 9.7 The deploy probe

`lib/db/runtimeDatabaseProbe.ts` reruns the whole empty-batch gate over every saved app on every
deploy, and a failing app blocks admission. Every adopted app joins that population at its birth,
having passed that gate inside the tail. No reader-only leniency exists to make one fail later (the
bar's clause (a)). What follows for every later change: a validator rule that tightens ships its
scan over saved apps first, as today, and that scan now meets shapes only CommCare HQ's editors
author. `docs/architecture/deployment.md` gains that sentence ("Contracts"). **Work: none in the
probe.**

---

## 10. Observability

Cloud Logging is the stream and Sentry the grouping (`lib/logger.ts`). A reading has no run, so it
writes nothing to `lib/log`'s per-run event stream. Every line carries `appId` (the reading's id,
which is the app's), `projectId`, `userId` and `operation`, all `SENTRY_TAG_KEYS`; none carries the
project space, the HQ app's id or name, or any finding's `place` or `detail`. No line holds a word
of an app, in its message or in its context: a message titles a Sentry issue, and the context
reaches Sentry as `extra`. `defects` is no exception. A reader defect's `why` is built only by the
constructors of part 06's `reader/defects.ts::readerDefect`, each from closed slots (the defect's
words, the place by position as `placeKey` prints it, a registered claim's name, a manifest
entry's id, a standing, a kind word, an issue code, a position), and never from a name, a label, a
tag, a column, a path, a value, an expression or a parser's message. Part 06's `defects.test.ts`
holds that over every constructor (its section 5.1 and "Tests").

| Message | Level | When | Further context |
|---|---|---|---|
| `[reading] started` | info | `startReading` inserted a row | |
| `[reading] step` | info | every step that wrote its outcome | `operation`: `read`, `media` or `create`; `phase`: the state written; `elapsedMs`; `mediaDone`, `mediaTotal`; where `operation` is `read` and the reader gave a draft, `expressionRounds` (`ReadFacts.expressionRounds`, the count part 08's section 2.5 keeps for this line) |
| `[reading] step lost its write` | info | 3.2's losing step | `operation` |
| `[reading] stopped` | warn | a `stop` was written | `phase`: the circumstance code |
| `[reading] account` | info | an account was written | `findingCount`, `codeCount`, `notYet`, `never`, `fixInHq` |
| `[reading] step over budget` | error | 3.6: the check was stopped at its budget | `phase`: `checking`; `elapsedMs` |
| `[reading] step over memory` | error | 3.6: the check's worker ended on a heap limit | `phase`: `checking`; `heapMb`, `youngMb`, the two limits it ran under |
| `[reading] slot busy` | info | 3.6: a read step or a final step found the instance's reading slot taken and answered `again` | `operation`: `read` or `create`; `waitedMs` |
| `[reading] birth over budget` | error | 3.6: the birth's transaction ran past the step | `elapsedMs`; `tables`, `tableRows`, `places`, `entities`, `mediaFiles` as counts |
| `[reading] places read missed` | error | 3.3, step 7.2: the document reads places and part 11's source test named none, so the step read them in a second pass | |
| `[reading] unrecognized: <log key>` | error | once per distinct log key of the step's `unrecognized` findings | `defects`: the `why` of each `ReaderDefect` whose `name` gives that log key, at most five (below) |
| `[reading] read-back differs: <check>: <signature>` | error | once per distinct signature of the step | `phase`: the check; `differenceCount`; `signatures`, the step's distinct signatures, at most five (part 09, 14.3); for `accounting/defect`, `defects`, the `why` of each defect, at most five |
| `[reading] could not create: <check>` | error | 6.5; a message with no error object | `findingCodes` |
| `[reading] stored row unreadable` | error | a JSON column failed its schema | `phase`: the column |
| `[reading] request refused` | warn | a route body failed its schema (4.1) | `phase`: the route; the first Zod issue as `<top-level key>: <issue code>`, never a deeper path (a key of `tableChoices` is a table's tag) and never a value |
| `[reading] review changed at creation` | info | 5.3's `review-changed` | `phase`: `digest`, `account`, `stopped`, `media` or `reading` |
| `[reading] created` | info | the birth committed | `elapsedMs`; `tables`, `places`, `mediaFiles`, `identityRows` as counts |

**Sentry grouping for `read-back-differs`.** A message-only `log.error` reaches Sentry as a
message event, which groups by its text. So the text is made of exactly what should define an
issue: the check that failed, any of part 09's five `ACCEPTANCE_CHECKS` (`accounting`, `gate`,
`fixed-point`, `identity`, `summary`), or `reader` with the signature `contract` for the reader's
own contract error (3.3), and the signature of the first difference acceptance met. The signature
is part 09's (`lib/deployment/reading/signature.ts::differenceSignature`, its 14.2): the check and
then segments from a closed vocabulary that holds no word of any app, joined with `/` and cut at
the last whole segment within 80 characters, as in `fixed-point/question/relevant`. A failing arm's
`check` is never null and its `signature` is always present, so the line is written for every
check. One defect in the reader is then one issue however many apps meet it, and two defects are
two issues. `ReadingCheck` carries the count and the signatures and no `differences` (3.6), so no
difference's own words can reach a log.

**The log key of an `unrecognized` finding.** The finding's `detail.name` is for the person's
account and is not safe in a message: part 06 (4.4) fills it with a surface key, which is a
declared schema key (`schema:Application.multimedia_map`) or else an undeclared JSON key or an XML
element or attribute name (`xform:<qualified name>`, and an instance's element names are an
author's question ids), and part 11 fills it with a file path or a table's tag. So the message is
built by `gather.ts::unrecognizedLogKey(name: string): string`, which returns the name itself only
where `isDeclaredSurfaceKey(name)` (3.9: a key of CommCare's own schema that the manifest's entries
list, and no content of an app), and otherwise one word of a closed set, by the name's shape:
`undeclared-json-key` (a `<class>.<key>` with no `schema:` prefix), `xform-element` (an `xform:`
name with no `@`), `xform-attribute` (one with an `@`), or `other`. `[reading] unrecognized: <log
key>` then groups by something that is never an app's content. The finding itself, with its full
`detail.name`, is on the reading's row, which the reading's id (the `appId` tag) finds.

**A reader defect.** Where the reader itself is at fault it raises `unrecognized` and returns a
`ReaderDefect` beside it, whose `name` is that finding's surface key and whose `why` is one of
part 06's developer lines (its 5.1 and its Copy, D1 to D12; part 08's C9 and C12 among them), each
built from closed slots and holding no word of the app.
Parts 06 and 08 have this part log each one at error with the reading's id, and it does, on the
finding's own line: the `unrecognized` line of a log key carries, as `defects`, the `why` of each
defect whose `name` gives that key. `why` rides in the context and never in the message, so it
titles no issue, and it is never stored on the row or shown. A defect beside a clean read has no
such finding: acceptance answers it as `accounting/defect` (part 09, section 3), and the
`read-back differs` line of that signature carries `defects` the same way.

The reading's id rides as the `appId` tag on both, so an issue lists the readings that met it, and
each reading stays (in `account`) so the person can check it again after the fix.

`log.warn` stays Cloud-Logging-only, so a stop is searchable and raises no issue: a busy CommCare HQ
is not Nova's defect.

---

## Copy

Every string B10 adds that a person, a developer or a model reads. All of it follows
`design/readme.md`, "Content fundamentals". The strings a person reads live in one new client-safe
file, `lib/publish/hqReadingCopy.ts`, beside part 01's `hqFindingCopy.ts`, because the routes and the
MCP tools return the same sentences. The account's and the review's own layout, headings and buttons
are part 13's; every circumstance's block is part 01's.

```ts
// lib/publish/hqReadingCopy.ts. No run-time import: its key types come from the client barrel.
import type { ReadingLearned, ReadingPhase, ReadingRefusal } from "@/lib/deployment";

export const READING_REFUSAL_COPY: Readonly<Record<ReadingRefusal, string>>;                 // C1
/** By answer, then by the state of the reading the answer carries. */
export const CREATE_RESULT_LEADS: {                                                           // C2
	readonly "review-changed":
		Readonly<Record<"ready" | "account" | "stopped" | "media" | "reading", string>>;
	readonly held: Readonly<Record<"ready", string>>;
};
export const READING_LEARNED_LINES: Readonly<Record<ReadingLearned, string>>;                // C3
type FileCount = { readonly done: number; readonly total: number };
export const READING_PHASE_LABELS: {                                                          // C4
	readonly [P in Exclude<ReadingPhase, "fetching-media" | "publishing-media">]: string;
} & {
	readonly "fetching-media": (count: FileCount) => string;
	readonly "publishing-media": (count: FileCount | null) => string;
};
export function moreFindingsLine(more: number): string;                                      // C5
export const UNVERIFIED_LANDING_TITLE: string;                                                // C6
export const UNVERIFIED_LANDING_BODY: string;                                                 // C6
```

### C1. Refusals (`READING_REFUSAL_COPY`, keyed by `ReadingRefusal`)

```ts
// lib/deployment/reading/types.ts
export const READING_REFUSALS = ["reading_not_found", "no_project_access", "project_access_lost",
	"invalid_input", "not_ready", "name_missing", "choice_not_offered", "project_changed",
	"app_unavailable"] as const;
export type ReadingRefusal = (typeof READING_REFUSALS)[number];
```

"Reading" is the code's word (`../6-bring-in.md`, "What changed from the outline, and why", item
13). No sentence a person reads says it: to them it is the app they are bringing in.

| Code | From | HTTP (`READING_REFUSAL_STATUS`, 4.1) | Sentence |
|---|---|---|---|
| `reading_not_found` | any act on a row that is absent, removed, or another person's | 404 | Nova couldn't find the app you were bringing in. It may have been removed. You can start again from your apps. |
| `no_project_access` | `startReading` | 403 | You don't have edit access to this Project, so Nova can't add an app to it. You can choose another Project, or ask one of its admins for edit access. |
| `project_access_lost` | advance, check again, create; `CommitReauthError` at the birth | 403 | You no longer have edit access to the Project this app is being added to. One of its admins can give it back, and the app you were bringing in will be waiting. |
| `invalid_input` | a body that fails its schema | 400 | Nova couldn't read that request. Reloading the page and trying again usually fixes it. |
| `not_ready` | create on a reading with no review | 200, `refused` | Nova hasn't finished checking this app yet. You can open it from your apps to see where it stands. |
| `name_missing` | create | 200, `refused` | The app needs a name of up to 255 characters. You can keep the one from CommCare HQ or type another. |
| `choice_not_offered` | create | 200, `refused` | One of the choices sent isn't one this review offers. The review may have changed, so you can reload it and choose again. |
| `project_changed` | the birth (6.5) | 200, `refused` | A file this app uses was removed from your Project while Nova was creating the app, so Nova stopped before saving anything. You can create it again, and Nova will bring the file back in. |
| `app_unavailable` | a retried creation (6.6) | 200, `refused` | This app was brought in already, and you can't open it from here. If it's in recently deleted, you can restore it from your apps. If you've left its Project, one of its admins can add you back. |

The Zod issue of an `invalid_input` goes to the log (`[reading] request refused`, section 10) and
not to the person: a path and a parser's message are Nova's own words for its own mistake. An
unanswered table choice is no refusal: it is the circumstance `table-differs-in-project`, answered
`held` (5.3, step 3), so its words are part 01's block. The unauthenticated answer is
`requireSession`'s existing 401.

### C2. What stands after a creation that did not create (`CREATE_RESULT_LEADS`)

One sentence above whatever the answer's `reading` now shows.

| Answer | The reading now | Sentence |
|---|---|---|
| `review-changed` | `ready` | Something changed since you reviewed this app, in CommCare HQ or in your Project, so Nova read it again. Here is the review as it stands now. |
| `review-changed` | `account` | Something changed since you reviewed this app, and Nova can't bring it in as it stands now. Here is what Nova found. Nothing was created. |
| `review-changed` | `stopped` | Nova couldn't finish creating this app. Here is where things stand. Nothing was created. |
| `review-changed` | `media` | This app now uses files Nova hasn't fetched yet. Nova will bring them in and show you the review again. |
| `review-changed` | `reading` | A lookup table this app reads changed in your Project while Nova was creating the app, so Nova is reading it again. Nothing was created. |
| `held` | `ready` | Nova stopped before creating anything. Your review is still here. |

Under a `held` answer the page shows the circumstance's own title, body and next step (part 01,
9.3). The lead says nothing of why, because the circumstances it sits above differ: a key CommCare
HQ refused, a membership that ended, a busy minute, a table choice not yet made. Each block says
its own.

### C3. What Nova has learned (`READING_LEARNED_LINES`, keyed by `ReadingLearned`)

| Value | Sentence |
|---|---|
| `everything` | Nova can now hold everything this list named. You can check again. |
| `something` | Nova has learned more since this check. You can check again. |

### C4. The steps, by name (`READING_PHASE_LABELS`, keyed by `ReadingPhase`)

| Phase | Label |
|---|---|
| `connecting` | Connecting to CommCare HQ |
| `waiting` | Waiting while Nova finishes another app |
| `reading-app` | Reading the app |
| `reading-project-data` | Reading its lookup tables and places |
| `checking` | Checking what Nova read |
| `fetching-media` | Bringing in pictures and sounds, {done} of {total} |
| `publishing-media`, with a count | Adding pictures and sounds to your Project, {done} of {total} |
| `publishing-media`, with none | Adding pictures and sounds to your Project |
| `reading-again` | Reading the app once more |
| `creating` | Creating your app |

`waiting` is the phase of a step that found the server's one reading slot taken (3.6). It says what
is true and asks nothing of the person: the wait is Nova's, and the page calls again by itself.
`fetching-media`'s count is the polled `ReadingView.media`, which a row in that phase always holds.
`publishing-media` takes two forms, and its entry is a function of the count: the count is the
`publishing` of a creation's last `again` answer, and there is none during the first call of a
creation, before any answer (4.4).

### C5. An account longer than the row holds (`moreFindingsLine(more)`)

"Nova found {more} more things to list and counted every one. This list shows the first 2,000."

The rest are not said to be like the ones shown: the list is in the app's order, so what is cut
off is whatever came last, of any kind.

### C6. The landing that could not be verified (`ChatContainer`, the existing persistent toast)

For `blank`, nothing changes: the title "Reload to finish opening this app", the action "Reload
page", and today's body, "Nova created your app, but couldn't verify its Project scope in this tab.
It's waiting in your app list."

For `brought-in`, the toast is reached only where the receipt itself could not be read here (7.3:
a receipt for another Project loads the app's page and shows no toast). The app list the tab would
show on reload is its own Project's, which may not be the one the app went to, so the body does not
promise it: the title is "Your app is in, and this tab couldn't open it", the body "Nova brought
your app in, but couldn't open it in this tab. It's in your apps, in the Project you added it to.",
and the action "Go to your apps", which loads `/`. That title and that body are exports of
`lib/publish/hqReadingCopy.ts`, `UNVERIFIED_LANDING_TITLE` and `UNVERIFIED_LANDING_BODY`, read by
`ChatContainer` for the toast and by part 13's `unopened` screen (its 9.2).

### C7. The two circumstances B10 lands in part 01's files

Both rows are in part 01 (its sections 8.3 and 9.3, each marked B10), and part 01's
`findingLine` answers `named: null` for both, since their `detail.name` is Nova's own word (its 8.4
and 9.2). B10 makes the edits in part 01's two files ("Files by pull request").

`could-not-create`: the row and the block of 6.5.

`too-large`: the code, its standing, its owner, its title and its next step stand. From B10 its
"When" is "the app's source is over the read's byte bound, or reading and checking it takes more
time or more memory than one of Nova's steps allows, or saving it takes longer than one allows",
and its `detail` holds "`name`: `checking` where the check ran out of time or memory, `saving`
where the birth ran out of time; absent where a body was over its byte bound". The body A2 lands
says "{app}'s source is bigger than Nova reads in one go", which is not true of an app that is slow
or heavy to check; from B10 it is "{app} is bigger than Nova can bring in in one go. That limit is
Nova's, not the app's."

### C8. For a developer

Each is logged, so none holds a word of an app or of its project space (10): a slot is the
reading's id, a column or a file of Nova's own, a code, or a count.

| Where | Message |
|---|---|
| `store.ts`, a JSON column that fails its schema | `The reading ${id} holds a ${column} Nova can't read (${key}: ${code}). It was written by an earlier revision or by hand. Checking the reading again writes a fresh one.` `${key}` is the first Zod issue's top-level key and `${code}` its issue code, never a deeper path and never its message: a deeper key of `minted` is a table's tag |
| `gather.ts`, `getHqCredentials` answering `ambiguous` for a named project space | `Nova asked for CommCare HQ credentials for a named project space and was told the choice is ambiguous, which a named project space can't be. Look at lib/db/settings.ts::resolveHqTarget.` |
| `create.ts`, `adoptedIdentityRows` answering `ok: false` | `The reading ${id} reached its birth with a form that has no real CommCare HQ id. A reading with a menu CommCare HQ could not summarize should have ended as an account. Look at gather.ts, step 4.` The answer's `at` is not printed: it names a menu or a form of the app |
| `checkInWorker.ts`, the worker exits before it answers, or ends with an error whose code is not `ERR_WORKER_OUT_OF_MEMORY` | `The reading ${id}'s check stopped before it answered (exit code ${code}). Nothing was written for this step. A check that ran out of its own memory is answered as too large and does not reach here, so look at public/reading-check/worker.mjs and at this instance's memory.` |
| `gather.ts`, the bindings under the answers differ from the bindings read | `The reading ${id} bound ${count} of its lookup tables one way before the person answered and another way after. No answer the review offers may move a binding the reader read. Look at lib/deployment/reading/projectData/lookupTables.ts::resolveLookupBindings.` `${count}` is `bindingsMoved.length`; the tags stay on `ReadingCheck` and reach no log |
| `scripts/build-xpath-worker.mjs`, the reading check's bundle holds a module 3.6 refuses | `The reading check's worker bundle imports ${path} through ${importer}. The check only computes, so its bundle holds no store, no CommCare HQ reader and no logger. Import the pure file beside it, or move the function that needs ${path} into a store file of its own.` |
| the migration's `down` | none: it drops the table. |

---

## Tests

Read `docs/testing.md` first. Each test is named with the boundary it runs at and the failure it
would catch. Transactions run on real Postgres in `*.postgres.test.ts` files; CommCare HQ is
controlled at the HTTP boundary through part 05's retained answers
(`proof/hq-reads/reading/`, served by its `retainedReadingRead`), never by replacing a reader of
`lib/commcare/hq`; pure rules run in plain Vitest; nothing here renders a component. Every Postgres
test owns its pool clients and joins its concurrent work in `try`/`finally`.

### Real Postgres: the table

`lib/case-store/migrations/__tests__/hqAppReadings.postgres.test.ts`

| Test | Catches |
|---|---|
| `up` replays over its own result (run twice) | a statement that is not replay-idempotent |
| each CHECK refuses its bad row: `created` with no `app_id`; an `app_id` that is not the id's text; `ready` with no digest; `account` with no outcome; `removed` that still names the app, or still holds its project space and HQ app id | a constraint dropped or mis-spelled |
| a second open reading of one key by one person is refused by `hq_app_readings_open`, and is admitted once the first is `removed` or `created` | the index's predicate |
| a row inserted with the key alone (every default) passes `readingCensusSchema`, `predeclaredLookupIdsSchema` and the row's own parse | a DDL default the schemas refuse, which would make every fresh reading unreadable |

`lib/db/__tests__/privilegeConvergence.postgres.test.ts` (existing) gains one probe beside its lock
probes: a `SELECT … FOR UPDATE` on `hq_app_readings` succeeds under `SET LOCAL ROLE` to the runtime
role. Catches the table registered under a class with no `UPDATE`, which would make every birth
fail with `42501` in production and nowhere else. A table left out of the registry altogether needs
no test of this part's: `auditPublicTableInventory` fails every migration run, CI's among them.

### Real Postgres: the store and the steps

`lib/deployment/reading/__tests__/readingStore.postgres.test.ts`

| Test | Catches |
|---|---|
| two concurrent `insertOrFindOpenReading` calls of one key return one row | two tabs making two readings, and so two app ids, for one act |
| `writeReadingOutcome` at a stale revision returns null and changes nothing | a step overwriting a newer outcome |
| `writeReadingPhase` changes neither `revision` nor `updated_at` | progress display invalidating the step that shows it |
| `beatReadingStep` at the row's revision sets the mark, changes neither `revision` nor `updated_at`, and the next `loadReading` answers `step_running` true; at a stale revision it changes nothing; while a second connection holds the row `FOR UPDATE` it returns at once with the mark unchanged (asserted by its promise settling before the lock is released); `writeReadingOutcome`, `checkReadingAgain`, `markReadingRemoved` and `markReadingCreatedInTransaction` each leave `step_beat_at` and `phase` null | a step that lost its row still marking it; a finished reading that reads as running |
| a row whose `step_beat_at` the test sets 29 seconds back reads `step_running` true and its view carries its `phase`; set 31 seconds back it reads `step_running` false and its view's `phase` is null though the column still holds one; a row with a `phase` and a null mark reads the same | a killed step shown as in flight; a page waiting on a step nothing is running |
| `markReadingRemoved` clears every column that names the app, leaves `domain` and `remote_app_id` holding `removedAppKey` of what they held, and keeps `census` and `finding_codes`; no column of the row holds the project space or the HQ app's id afterwards | Remove keeping a person's content or which app they read, or dropping the census |

`lib/deployment/reading/__tests__/readStep.postgres.test.ts` (controlled HQ answers)

| Test | Catches |
|---|---|
| a clean app with no media ends `ready`, and a second reading of the same answers has the same digest | a digest that depends on time, order or a minted id |
| a clean app that references files ends `media` with a plan that lists each file under its reserved id, no verdict and no digest | a review offered before its media was checked |
| an app that references files and whose acceptance fails (a controlled source the fixed point rejects) ends `account` with `read-back-differs` after the first read step, with no media request made (the double counts requests) | fetching every file of an app that can never come in |
| `changed` once leaves `reading` with `changed_count` 1; twice in a row writes `stopped`, `changed-while-reading`; `changed`, then a clean read to `ready`, leaves `changed_count` 0, and a later `changed` at creation answers `again`, not `held` | mixing two versions; stopping on the first save; one old save counted against a later one |
| a read that ends `account` after minting ids writes them, and the next read of that row binds the same ids | ids minted and thrown away by an account |
| table-driven over every code 3.8 lists as raised by a read: the controlled answer writes the state the table says | a circumstance written as an account, or the reverse |
| a not-summarized menu gives `menu-unreadable-in-hq` at that menu beside the reader's other findings, in one account | a first finding hiding the rest |
| an account of 2,500 findings stores 2,000, `more` 500, and a census that counts 2,500 | an unbounded row; a census that undercounts |
| a sentinel planted in the source's form XML, in a table row and in a media file appears in no column of the row after any step | CommCare HQ's source at rest |
| two concurrent `advanceReadingWithin` calls of one reading, each handed its own `createReadingSlots()` (two instances), leave one outcome at `revision + 1`, and the loser answers the winner's row | a lost update; a step that throws on losing |
| two readings advanced at once over one `ReadingSlots` (one instance), the first held at its app read by the double: the second answers `again: true` with its row unchanged at its revision once the test's clock passes `HQ_READING_SLOT_WAIT_MS`, its row read `phase` `waiting` and `stepRunning` true while it waited, the double saw no request for the second reading's app, and after the first step ends a third call for the second reading runs and writes its outcome; a reading with no connection advanced while the slot is held writes `stopped`, `not-connected`, with no wait | two read steps holding four bodies and two workers on one instance; a slot never released; a stop made to wait behind another reading |
| a read step held at its first request of CommCare HQ by the double: `readReading` answers `stepRunning` true with `phase` `connecting` or the phase reached, before the step has written anything else; after the step's outcome it answers false | a step that is slow to name its first phase taken for no step at all |
| with the test's `now` moved 175 seconds on by the app's and the project data's reads, a check that answers inside its own budget ends `ready`; with `now` untouched and a check that answers `over-budget`, the row is an account of one `too-large` with `detail.name` `checking` and the step logs once; a check that answers `over-memory` writes the same account and logs `[reading] step over memory` once, and the step's answer is the row, not a throw | CommCare HQ's slowness judged as the app's size; a step that never answers |
| `unrecognizedLogKey`: a declared surface key is returned whole; `xform:<an author's question id>` returns `xform-element`, an undeclared `<class>.<an author's key>` returns `undeclared-json-key`, a file path and a table's tag return `other`, and the logged message holds no character of the planted name | an app's own names in a Sentry issue title |
| a reader defect behind an `unrecognized` finding, over a source whose every menu name, form name, question id, table tag and file path is a marker string: the finding's log line carries the defect's `why` in its context and not in its message, no column of the row holds it, and no line the step logged holds the marker in its message or in its context | a defect a developer cannot find; a defect's text titling an issue or stored at rest; a word of an app in a log line |
| under part 05's run G3 outcome B alone: `readHqAppForReading` answering `not-summarized` ends `account` with one `app-unreadable-in-hq` finding at the app | an app CommCare HQ cannot summarize shown as CommCare HQ being unavailable |
| a source that reads places and tables, read twice: the row's `minted` is the same after both, the review's `tables` and `places` come from `projectDataReview`, and the double shows one table list read, the rows of the candidate tables alone, and the two place reads, all inside one project data deadline | a second composition of project data beside part 11's; ids minted twice |

`lib/deployment/reading/__tests__/checkInWorker.test.ts` (the built worker bundle, no database):
a check over a small source answers the same value `runReadingCheck` answers in process (the
worker's inputs and outputs survive the clone); a worker entry made to spin
(`__tests__/fixtures/spinningCheckWorker.mjs`, a checked-in module that loops and posts nothing,
passed as `checkReadingInWorker`'s third argument) is terminated at a 200 millisecond budget,
`checkReadingInWorker` answers `over-budget` within the budget plus a second, and no thread is left
(`worker.threadId` after `terminate` resolves); an input whose aligned menus are one fewer than its
source's menus, which is the reader's contract error (part 06, C3), answers `reader-contract` from
the real bundle; a worker entry made to allocate (`__tests__/fixtures/allocatingCheckWorker.mjs`,
a checked-in module that appends arrays to a list until it is stopped), run under the limits `{
maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 }` passed as the fourth argument, answers
`over-memory` and not a throw, the test's own process is still running its interval, and no thread
is left; the same entry made to throw an ordinary error is thrown on as infrastructure. Catches a
check that outlives its bound, a blocked event loop (the test's own interval keeps firing while
the worker spins), a worker with no memory limit, and a memory limit answered as a server error.

`lib/deployment/reading/__tests__/checkMemory.scale.test.ts` (run M1; by hand on a hosted runner
through `reader-scale.yml`, in the `scale` project no default run includes; no database), with
its child `__tests__/fixtures/readStepMemoryChild.ts`: the two checks of an app at Nova's ceiling
answer `checked` under `READING_CHECK_RESOURCE_LIMITS`, and the child that holds what the
server's process holds of a read step peaks at or under 512 MiB; it prints the smallest heap
limit the checks still answer under and the child's peak ("Written and not yet run"). Catches a
heap limit that makes Nova's own ceiling too large, and two bodies that take more of the server
than the division gives them.

`lib/deployment/reading/__tests__/slot.test.ts` (no database; the test owns its fake timers and
restores real ones), over one `createReadingSlots()`: a first `acquire` holds the slot at once and
never calls its `onWait`; a second, made while it is held, calls its `onWait` once, is pending, and
answers null when the clock passes its `waitMs`; a third, made while it is held, answers null as
soon as the holder releases, before its `waitMs`; after the release a fourth holds the slot at once;
`release` called twice frees it once, so a fifth made after the fourth is pending; a second
`createReadingSlots()` is free while the first is held; and no timer is left once every promise has
settled. Catches a slot that admits two, a waiter that is handed the slot inside a step that has no
budget for it, a slot lost to a step that threw, and a wait that outlives its caller.

`lib/deployment/reading/__tests__/beat.test.ts` (no database; `withStepBeat` is handed the test's
own beat function as its fourth argument, and the test owns its fake timers): one beat is awaited
before `run` starts; one more lands at each ten seconds of the clock while `run` is pending, so a
`run` that is silent for 25 seconds is beaten three times; no beat lands after `run` settles,
whether it resolved or threw, and the function's promise settles only after a beat that was in
flight has; a beat that rejects is logged at warn and `run`'s answer is unchanged. Catches a step
that stops marking while it works, a timer left running after its step, and a write that escapes
its test.

`lib/deployment/reading/__tests__/mediaStep.postgres.test.ts`: one step asks CommCare HQ for at
most twelve files (the double counts requests); two concurrent media steps leave every file of the
plan with one verdict and `media_done` equal to the verdict count (the merge); the last file returns
the state to `reading`; a file CommCare HQ fails after its resend writes `stopped` and keeps the
verdicts reached; a step writes no `media_assets` row; and Remove on a row with staged files
deletes their pending objects and no ready file. Catches a step that runs unbounded, a merge that
drops a fetch, a staged file showing in the Project's Files, and staged bytes left for a reading
the person removed.

### Real Postgres: the birth

`lib/deployment/reading/__tests__/birth.postgres.test.ts`

The fixture these tests start from is exported for part 13's Playwright seed:
`lib/deployment/reading/__tests__/adoptionFixture.ts::adoptFixtureApp(input: { projectId: string;
actorUserId: string }): Promise<{ appId: string; receipt: AdoptedAppReceipt }>`, which
`e2e/lib/bringInSeed.ts` calls. It starts a reading of the suite's small controlled source for
that person in that Project, advances it to `ready` and creates from it through the production
functions, with CommCare HQ answered from part 05's retained answers, and returns the born app's
id with its receipt.

| Test | Catches |
|---|---|
| one creation commits everything: the app at sequence 1, `complete`, with null holder and reservation columns; its entities; the `fold-baseline` row with batch `genesis:<id>` and its baseline; its case schemas; each lookup table under the reading's predeclared ids with its edges; each media edge; each place; the deployment at `uploaded` with an `adopted` mapping at `pushed_revision` 1, a `read` baseline whose `first_publish_changes` holds the chosen declaration's list, identity rows, media paths and confirmations; the reading `created` with `app_id` its id | any writer left outside the transaction; a first-publish list other than the one the person reviewed |
| `publishedRemoteApp` of the born app's deployment is the adopted mapping, and `nextPublishAction` answers `updates` | an adopted app that reads as an empty shell |
| a document whose select reads a table the same transaction creates passes the tail; with the seam's lookup writer left out it is refused for a missing table | export readiness not seeing same-transaction rows |
| a birth handed a place plan whose place stands at a level that may not nest under its parent's (a plan built by hand, past `planManagedPlaces`' own check) is refused inside the tail, nothing exists afterwards, and creation writes `could-not-create` with `detail.name` `integrity`; the same birth with a sound plan commits and the places exist | places written where the tail's organization integrity never reads them, so a bad copy commits and breaks the app's first edit |
| a born app's document names no place: `extractLocationReferenceTargets` of it is empty and `app_location_references` holds no row for it | a brought-in document that came to name a place without place ids being predeclared |
| the holds the batch carries are what `readRecordedPlacementHolds` answers for the born app | a birth whose holds are not recordings |
| no `design_sessions`, `authoring_sessions`, `threads`, `credit_months` or `usage_months` row is written, and no reservation column is set | a birth that charges or holds |
| rollback, table-driven over each seam (a candidate the gate refuses; one export readiness refuses; a lookup writer that throws; a place writer that throws; a duplicate identity row; a throw after the deployment is recorded): `adoptHqAppInTransaction` is run in a transaction the test owns, and afterwards there is no `apps` row of that id, no table of the predeclared ids, no place, no deployment, no claim index entry, and the reading is still `ready` at its revision (the transaction's own effect; what creation then writes is 6.5's, held by the rows below) | a partial birth |
| a `GenesisGateRejectedError` carries `check` and `findingCodes`, and creation writes `account` with `could-not-create`. The candidate holds a sentinel in a question's label that the gate's finding sentence quotes; a capture of everything `log.error` was called with (message, error argument and context) holds the check and the codes, an `undefined` error argument, and no occurrence of the sentinel | Nova's defect shown as the app's; an app's words reaching Sentry through an error's message |
| a birth whose transaction is made to wait past its `deadlineAt` (a second connection holds `lookup_project_state` until the deadline passes) rolls back whole, writes `account` with `too-large` and `detail.name` `saving`, and answers `review-changed`, not a 500 | a birth over its time answered as a server error on every retry |
| a `published` asset deleted from the Project's library before the birth: the answer is `refused: project_changed`, the row is `ready` without that file's entries, and the next creation fetches and publishes the file and is born | a removed file answered as Nova's defect; a retry that fails forever on a dead asset id |
| a table of a tag the app reads is created in the Project after the final step's snapshot and before the birth's lock (the test's seam between them): the birth rolls back, the row is `reading` with its verdicts, published files and ids kept, the answer is `review-changed`, and the next read's review holds the table's choice | a table that changed under the birth answered with a stale review |
| the three existing births pass no `afterAppInsert` and write exactly what they wrote (the existing genesis tests, unchanged, stay green) | the seam changing an existing birth |

`lib/deployment/reading/__tests__/birthClaimRace.postgres.test.ts`

| Test | Catches |
|---|---|
| two people, two `ready` readings of one HQ app, created at once, each call handed its own `createReadingSlots()` as two instances would have: exactly one app exists; the other reading is `stopped` with `already-in-nova`; the loser left no table, no deployment and no app | two Nova apps publishing over one HQ app |
| a second connection holds the HQ app's advisory lock: the birth is pending (asserted by a statement that returns while it waits), then commits when the lock is released | the claim not serializing births before either writes |
| a second connection holds `lookup_project_state` of the Project, and a third then begins a membership write: the birth, the lookup writer and the membership write all finish, in an order the test joins | the gate-after-Project-state cycle of 6.2 |
| the HQ app's holder is in recently deleted: the birth commits and the holder's mapping is released | a deleted app holding its HQ app against a bring-in |

`lib/deployment/reading/__tests__/createRetry.postgres.test.ts`

| Test | Catches |
|---|---|
| two concurrent creations of one reading over one `ReadingSlots` (one instance): the second's final step answers `again` with `publishing: null` and the row untouched while the first holds the slot, and its next call answers `created` with the first's app | a second final step holding a second pair of bodies on one instance; a busy slot shown as a changed review |
| a second `createFromReading` after a committed one returns the same `appId`, makes no request to CommCare HQ, writes no `app_changes` row, and its receipt passes `parseAppMaterializationReceipt` | a lost response making a second app |
| two concurrent creations of one reading, each call handed its own `createReadingSlots()` as two instances would have, in each of three interleavings the test forces with a held lock or a held HQ answer (the second waits on the row's lock inside the birth; the first commits while the second is in its prelude, so the second's claim read finds the new app; the first commits while the second's re-read is in flight): one birth, both answers `created` with equal `appId`s, and the row `created` | two tabs; the loser shown `review-changed` or a stop for the person's own app |
| after an edit raises the app's sequence, the retried receipt carries that sequence and the edited blueprint, with a digest that matches it | a stale receipt installing over newer work |
| after the app is moved to recently deleted, the retry answers `app_unavailable` | a receipt for an app the person cannot open |
| a creation that fails after publication and is run again makes one app and no second copy of any file | media that is not idempotent by content |

`lib/deployment/reading/__tests__/createDigest.postgres.test.ts`

| Test | Catches |
|---|---|
| between review and creation the controlled source changes one label: the answer is `review-changed`, the row is `ready` with a new digest, no app exists | creating from a state CommCare HQ has left |
| between review and creation a Project table of a tag the app reads is created: `review-changed` | a table meeting a Project table unseen |
| a file's published asset is a ready file the Project already held (another id than the staged one): the digest is equal and the app is born naming that file | a digest that sees asset ids |
| a save in CommCare HQ that changes nothing Nova reads (the counter alone moves): the digest is equal, the app is born, and the deployment's `remote_revision` is the creation's counter, not the review's | sending a person back to a review that did not change; a first publish that stops at drift nobody caused |
| a creation that names a declaration the review does not offer is refused `choice_not_offered` before any request to CommCare HQ | a choice the gate was never asked about |
| a review with a table that asks a choice. With no answer: `held` with `table-differs-in-project` and the tag, the row `ready` at its revision, no request to CommCare HQ. With `use-commcare-hq`, and with `use-project`: the digest is equal to the review's, the app is born, the document names the Project table's id, and the table is refreshed in `adopt` mode or left as it was. With an answer whose offer is `offered: false`: `choice_not_offered` | an answer that changes the document after its digest was taken, so every answering person is sent back to the review; an unanswered choice created past |
| the born deployment row, field by field against `adoptedDeploymentWrite`'s table: target, HQ app id, `pushed_revision` 1, the baseline's origin `read`, one identity row per menu and form, the kept media paths, the confirmations of the chosen declaration | a ledger write assembled from the wrong read |
| a transient stop at creation (`rate-limited`) answers `held` and leaves the row `ready` at its revision | a review destroyed by a busy minute |
| another Nova app already holds the HQ app when Bring it in is pressed: the row is `stopped`, `already-in-nova`, and no `media_assets` row was written for this reading's files | files published into a shared Project for an app that can never be born |

`lib/deployment/reading/__tests__/createMedia.postgres.test.ts` (controlled HQ answers; storage
controlled as part 11's staging tests control it)

| Test | Catches |
|---|---|
| `createFromReadingWithin` over an app of 40 files with a 270 second budget, called until it stops answering `again`, reaches `created`: in two calls where storage answers at once (one that publishes all forty, then the final step), and in more where the test's `now` passes `HQ_MEDIA_PUBLISH_DEADLINE_MS` part way through a publishing step, which then answers `again` with the files it reached recorded on the row; every earlier call answers `again` with a `publishing.done` that rises; and no call that did media work also read CommCare HQ's app (the double counts requests) | a creation that never reaches its final step; a final step run after other work in one call; a publishing step with no bound |
| with the test's `now` moving 70 seconds a media step, a call runs one media step and answers `again`; with `now` still, a call runs media steps until the work is done and still does not start the final step | `stepFits` not consulted between creation's steps |
| a call whose media work is already done runs the final step as its first step, and a creation whose publishing took 200 seconds of an earlier call still answers `created` | publication's time charged to the reader's budget and judged as `too-large` |
| a staged file whose pending bytes are gone when Bring it in is pressed, and CommCare HQ still holds the same bytes: the publishing step reads it again (one request, for that file alone) and publishes it, the row stays `ready` at the same digest throughout, and the app is born | a lapsed file ending the creation or sending the person back to the review |
| the same, and CommCare HQ now holds other bytes for the file: the publishing step answers `again` with that file's verdict dropped, the next step is a fetching step that stages the new bytes, the one after publishes them, the row is `ready` throughout, and the final step answers `review-changed` with a new digest | a file that changed in CommCare HQ born under the review of the old one; a reading sent back to `media` and its review lost |
| a step that publishes and dies before its write (the test throws after `publishReadingMedia` returns): the next call reads and publishes again and the Project holds one ready file of that content | a file published twice; a creation stuck on bytes that are gone |
| a file CommCare HQ no longer has at the re-fetch: its verdict is `missing`, the final step writes `account`, the answer is `review-changed` | a creation born with a reference to no file |
| two concurrent creation media steps: every file is published once, both writes land or merge, and `published` holds every file | a lost publication record |

`lib/deployment/reading/__tests__/readingProjectMove.postgres.test.ts`: an adopted app with no
lookup table is moved to another Project through `commitAppProjectMove`; the reading's row is
byte-equal before and after; a retried creation answers a receipt whose `projectId` is the
destination. Catches a move that strands or rewrites the birth's record.

### Plain Vitest: pure rules

| File | Tests | Catches |
|---|---|---|
| `lib/deployment/reading/__tests__/digest.test.ts` | changing each of `review`'s fields, `document`, one identity row, one media path, or `manifestRevision` changes the digest; changing `readAt` cannot (it is not in the input type); two asset ids of one content give one digest | a part of the review the digest forgot |
| `lib/deployment/reading/__tests__/mediaIds.test.ts` | both mints are stable, differ from each other, and pass `lib/domain/uuid.ts::CANONICAL_UUID_PATTERN` | a provisional id that changes between steps |
| `lib/deployment/reading/__tests__/census.test.ts` | `censusOf` counts by code with standing and owner; `mergeCensuses` over rows counts an app once per code | the inspector's arithmetic |
| `lib/deployment/reading/__tests__/learned.test.ts` | null at the same revision; `everything` when every entry id is now held, kept or inert or gone; `something` for a part; never `everything` beside a circumstance code | a home row that promises what Nova cannot check |
| `lib/deployment/reading/__tests__/budget.test.ts` | part 05's three constants sum to `HQ_READING_STEP_MS`, which is 270,000; the check budget and the write reserve sum to part 05's remainder; `HQ_MEDIA_STEP_WORK_MS` is `HQ_MEDIA_FILES_PER_STEP / HQ_MEDIA_READ_CONCURRENCY` rounded up, times `HQ_MEDIA_FILE_DEADLINE_MS`, and `HQ_MEDIA_STEP_CEILING_MS` is that plus the write reserve and no more than `HQ_READING_STEP_MS`; `HQ_MEDIA_PUBLISH_DEADLINE_MS` plus one file's deadline is `HQ_MEDIA_STEP_WORK_MS`; `HQ_READING_OUTCOME_WRITE_MS` is less than the write reserve; `HQ_READING_STEP_QUIET_SECONDS * 1000` is three times `HQ_READING_STEP_BEAT_MS`; `HQ_READING_STEP_SECONDS + HQ_READING_ROUTE_MARGIN_SECONDS` is 300 and equals the one literal `export const MCP_MAX_DURATION_SECONDS = 300;` of `app/api/mcp/dispatch.ts` (a source read); `stepFits` admits a media step at 59 s and refuses one at 61 s of a 270 s call, and refuses a read step or a final step at any elapsed time above zero | a call that outlives its cap; a step given the request's whole cap; a budget constant changed without its sum |
| `lib/deployment/reading/__tests__/check.test.ts` | `runReadingCheck` in process, over plain data built from part 05's retained answers. With `placesRead` false and a source whose expression reads a place: `placesMissed`, and `media`, `accepted` and `clean` null. With a `choice` table whose binding the test moves to another column by hand: `bindingsMoved` names the tag. With `claims: "full"`: `claims.log` is `serializeClaimLog`'s text; with `"counts"`: null, and `counts` and `handOffs` in both. A failing acceptance: `accepted` holds the check, the signature, `differenceCount` and `signatures`, and no member of the answer holds a sentinel planted in a question's label. Every answer equals its own `structuredClone` | a second pass that never happens; an answer that moves a binding unseen; a claim log held in production's memory; an app's words crossing the worker boundary; an answer that does not survive the clone |
| `lib/commcare/surface/__tests__/revision.test.ts` (the file is B2's, with the revision's cases: stable for the checked-in entries, and changed when one entry's standing is) | B10 adds: `currentStandingOf` answers the standing of a checked-in entry id and null for an id no entry holds; `isDeclaredSurfaceKey` is true for a key some entry's `surfaceKeys` lists and false for a question id | a standing read from a stale copy; an author's name passed off as a declared key |
| `lib/publish/__tests__/hqReadingCopy.test.ts` | every `ReadingRefusal`, `ReadingLearned` and `ReadingPhase` has a sentence, `publishing-media` with a count and with none, and every `CreateResult` answer with each state it can carry has a lead; none holds an em dash or ends a label with an ellipsis; none holds "this reading", "that reading", "a reading" or "Nova's reading", the code's noun for what a person calls the app they are bringing in; every `ReadingRefusal` has a status in `READING_REFUSAL_STATUS` | a code with no words; the code's vocabulary shown to a person |
| `components/chat/__tests__/chatLifecycle.adoption.test.ts` | the thirteen-key receipt parses with its `adoption`; it is refused with a non-null `starter`, `designSessionId` or `changeSetId`, with `adoption.readingId` unequal to `appId`, with an unknown server, with a fourteenth key; the twelve-key receipts of the three existing births parse as before with `adoption: null`; twelve keys plus `adoption: null` is refused | an arm that loosens the strict boundary |

### Routes

`app/api/commcare/readings/__tests__/routes.test.ts`, with the service's functions as the
controlled boundary (the routes are thin shells):

| Test | Catches |
|---|---|
| each route answers 401 with no session | an unauthenticated read of a person's reading |
| each route maps `reading_not_found` to 404, `no_project_access` and `project_access_lost` to 403, and a bad body to 400, each with a body of exactly `{ error, code }`, the create route for a `CreateResult` of kind `refused` as much as the others for a `ReadingResult`; the create route answers every refusal whose `READING_REFUSAL_STATUS` is 200 as 200 with the `CreateResult`; the 400's body holds C1's sentence and no part of the Zod issue; a body over `HQ_READING_REQUEST_MAX_BYTES` is 413 and a thrown error 500, each in `handleApiError`'s shape with no `code` | a refusal answered as a failure, or the reverse; one refusal with two statuses; a parser's message shown to a person |
| a `stopped` or `account` answer is 200 with the row | a stop thrown away as an error status |
| `isPathAllowedOnHost(HOSTNAMES.main, p)` for all six paths, and false for the MCP and docs hosts | the proxy answering 404 in production |
| the two long route files each hold exactly one `export const maxDuration = 300;`, equal to `HQ_READING_STEP_SECONDS + HQ_READING_ROUTE_MARGIN_SECONDS` (a source read), and neither imports `budget.ts` for it | the literal and the step's budget drifting; a route with no time of its own beyond its step |
| the `advance` handler and the `create` handler, each called with a request whose signal the test aborts while the service's controlled step is pending: the step is then released, and the handler's promise resolves with the step's own answer and the service was never handed an aborted signal (its double records its arguments) | a closed tab cancelling a step. This is a behavior, so it is tested as one: a source read could not see a route that passes `req` itself on (`docs/testing.md`: source inspection is for rules about source structure, which the `maxDuration` literal above is and this is not) |

Browser behavior (the flow, the poll, the landing through `landCreatedAppReceipt`, the home rows) is
Playwright's, in part 13's specs (B11); the blank-app smoke that exists today covers the refactor of
the blank path in B10. Two landings are named for those specs, because no Vitest test can hold
them: an app brought in to the Project the tab is looking at lands in the builder with no page
load, and an app brought in to a second Project lands on `/build/{id}` by a page load, with the
builder open on that app, part 13's landing toast shown once and no toast of C6 ("What this part
needs", part 13).

---

## Contracts and docs these changes make false

Subtree `CLAUDE.md` files and code comments change in B10, with the code. `docs/architecture/` and
the root `CLAUDE.md` change in B14, with the text fixed here. Where an old sentence holds a dash
this plan does not print, the quoted words are the ones on either side of it.

**`docs/architecture/contracts.md`, app birth** (B14).

- Old: "App birth comes from the Builder's explicit blank action, a reviewed architect checkpoint, or
  an ordinary authoring session's first valid checkpoint. All three use one genesis writer with
  identical admission:". New: "App birth comes from the Builder's explicit blank action, a reviewed
  architect checkpoint, an ordinary authoring session's first valid checkpoint, or bringing an app
  in from CommCare HQ. All four use one genesis writer with identical admission:".
- After "its session-to-app mapping and exact checkpoint receipt commit with the app.", new
  sentences: "`hq-adoption` is an app brought in from CommCare HQ: it is born `complete` from the
  reader's construction batch, with no holder, reservation, credit or design session. Its lookup
  tables, places, media edges, the adopted deployment with its claim on the HQ app, and its
  reading's `created` commit in that one transaction; its media files are published before it, as
  ordinary ready files, and are all that can outlive a birth that fails."
- Old, the end of the receipt sentence: "the starter UUIDs); a persisted empty app, optional seed
  path, independently reconstructed starter, or pre-app placeholder row is forbidden." New: "the
  starter UUIDs, and on a brought-in app only, where it came from); a persisted empty app, optional
  seed path, independently reconstructed starter, or placeholder `apps` row is forbidden. A design
  session and a reading (`hq_app_readings`) are records of work toward an app and are never an app."

**`docs/architecture/contracts.md`, "HQ deployment safety"** (B14).

- Old: "are held from the publish that first carries them". New: "are held from the publish that
  first carries them, or from the reading that brought the app in".
- Old: "Only a publish or a migration records or replaces a hold that can still express what it
  holds;". New: "Only a publish, a migration or bringing the app in records a hold, and only a
  publish or a migration replaces one that can still express what it holds;".
- Old: "puts it back where the publish recorded it". New: "puts it back where it was last
  recorded".

**`docs/architecture/deployment.md`** (B14). After the opening paragraph's "App, docs, and MCP
public probes finish the deployment.", new sentence: "The deploy names the service's memory
(`--memory=2Gi`), because reading an app from CommCare HQ divides an instance's memory between the
worker that checks the app and the rest of the server (`lib/deployment/reading/budget.ts`): the
figure is checked in, and every deploy holds the service to it." And after "probe checks every saved
app with the incoming validator.", new sentence: "An app brought in from CommCare HQ is a saved app
like any other and passed this gate at its birth, so a rule that tightens ships its scan over saved
apps first, and that scan meets shapes only CommCare HQ's editors author."

**Root `CLAUDE.md`** (B14).

- Mental model 3. Old: "which a publish records." New: "which a publish records, or the reading
  that brought the app in."
- The `lib/db` entry of the map. Old: "the apps/entity-rows/stream/thread/run/credit/usage/lookup
  tables,". New: "the apps/entity-rows/stream/thread/run/credit/usage/lookup tables and the readings
  of CommCare HQ apps (`hq_app_readings`, written only through `lib/deployment/reading`),".
- The `lib/deployment` entry of the map gains, at its end: "`lib/deployment/reading` is the other
  direction: a reading of one CommCare HQ app for one person in one Project, advanced by bounded
  request-scoped steps that keep none of HQ's source, and the `hq-adoption` birth that makes the app
  and its adopted deployment in one transaction."

**`lib/db/CLAUDE.md`** (B10).

- Old: "`appGenesis.ts` is the ONE closed birth owner (`explicit-blank | design-slice`):". New:
  "`appGenesis.ts` is the ONE closed birth owner (`explicit-blank | design-slice | hq-adoption`):".
- After "`createExplicitBlankApp` (the Builder blank-app action) births the canonical survey starter
  `complete`.", new: "`lib/deployment/reading/birth.ts::adoptHqAppInTransaction` births an app
  brought in from CommCare HQ `complete`: it runs the same tail between the HQ app's claim and the
  adopted deployment's writers, and writes the app's lookup tables and places through the tail's
  `afterAppInsert` seam, after the app row is inserted and before the lookup context is read, so the
  gate and export readiness read the tables, and organization integrity reads the places, on the
  same transaction."
- Lock ordering. Old: "or the `design_sessions` row for a pre-app target)". New: "the
  `design_sessions` row for a pre-app target, or the `hq_app_readings` row for a bring-in's birth)".
- Old: "Existing-app protocols lock the app first, while creation is the only shared-gate-first
  exception." New: that sentence, then: "A bring-in's birth is creation too: before the gate it
  locks its reading's row and, through the claim, at most one other app's row, and no row of the app
  it creates. It takes Project state only after the gate and after its app row is inserted."
- A new paragraph after "`design_sessions` is the pre-app generation target": "**`hq_app_readings`
  is the pre-app record of a bring-in, and it holds no run.** One row is one person's reading of one
  CommCare HQ app into one Project; its id becomes the app's id. It is read-write and has no holder,
  lease or reservation: steps are request-scoped, read the row at a `revision` and write `WHERE
  revision = …`, so no lock spans a read of CommCare HQ. It stores Nova's account or review, the
  census, the lookup ids predeclared for the reading and each media file's verdict, and never
  CommCare HQ's source. Rows are not deleted: `removed` clears what names the app, replaces the
  project space and the HQ app's id with a one-way key and keeps the census, and `created` stays as
  the birth's idempotency record. A Project move does not re-tenant it. `project_id` has no foreign
  key, and no app is hard-deleted at runtime, so the future whole-tenant deletion lifecycle must
  list this table, as it must list `project_space_resource_baselines`.
  `lib/deployment/reading` is its only writer."
- The placement paragraph. Old: "else the greatest fold baseline's snapshot, read by". New: "else
  the greatest fold baseline's snapshot (a cutover's holds, or the holds a brought-in app was born
  with), read by".

**`lib/deployment/CLAUDE.md`** (B10). A new section, "Readings", after "Identities": "A reading
(`lib/deployment/reading`, table `hq_app_readings`) is the record of reading one CommCare HQ app for
one person in one Project. `service.ts` advances it one bounded step a request: the read step
(`gather.ts`: nothing else decides whether an app can come in) reads the app under the save
counter's bracket, reads the Project data through `reading/projectData` (the one surface for tables,
places and media), runs the reader and acceptance in a worker thread it stops at their budget and
holds to its own heap limit (`checkInWorker.ts`), and writes a stop, an account, the files still to
fetch or a review with its digest; the media step stages at most twelve files and writes no asset
row. One step has 270 seconds, whoever calls it (`budget.ts`), and its route keeps 30 more. A
process runs one read step at a time (`slot.ts`): a second caller is answered `again` and reads
nothing, because a read step holds CommCare HQ's two bodies in memory and its check a worker. Steps
hold no lock and no lease: they compare the row's `revision`. A running step marks its row every ten
seconds (`beat.ts`, `step_beat_at`), a page drives a reading only where that mark is missing or
thirty seconds old, and the mark refuses nothing. `create.ts` publishes the media in steps that
record each file on the row, then reads again as a call's first step and creates only where the
digest is the one the person reviewed; no answer the review offers changes the digested document.
`birth.ts::adoptHqAppInTransaction` is the one transaction (the reading's row, the claim, the
genesis tail with the tables and places in its seam, `recordAdoptedDeploymentInTransaction`, the
reading's `created`). A retried creation answers the same app. The routes are under
`/api/commcare/readings`; the MCP tools call `advanceReadingWithin` and `createFromReadingWithin`.
Client code imports the reading's types from `lib/deployment`, never `lib/deployment/reading`, which
is server-only. `scripts/inspect-hq-readings.ts` prints the census."

**Code comments** (B10).

| Where | Old | New |
|---|---|---|
| `lib/db/appGenesis.ts`, the file header | "every persisted app is born here, through one of exactly two provenances:" and its two entries | "every persisted app is born here, through one of three provenances:" and a third entry: "`hq-adoption` (`lib/deployment/reading/birth.ts::adoptHqAppInTransaction`): an app brought in from CommCare HQ, born `complete` from the reader's construction batch in the transaction that also writes its Project data and its adopted deployment." The paragraph that begins "Both provenances share ONE preparation" begins "Every provenance shares ONE preparation" |
| `lib/db/appGenesis.ts::GenesisGateRejectedError` | "for a design-slice candidate it is the executor's structured signal to amend the change set." | that sentence, then: "For an `hq-adoption` candidate it is Nova's defect: acceptance passed the same document, and the reading reports `could-not-create`." |
| `lib/db/apps.ts`, the CRUD section's comment (under the `CRUD` rule, after `projectHasApps`) | "`explicit-blank \| design-slice` genesis owner." | "`explicit-blank \| design-slice \| hq-adoption` genesis owner." |
| the same comment | "every persisted app is born through `createExplicitBlankApp` or the design-slice materialization, and no caller inserts an app row and seeds it later." | "every persisted app is born through `createExplicitBlankApp`, the design-slice materialization, or `lib/deployment/reading/birth.ts::adoptHqAppInTransaction`, and no caller inserts an app row and seeds it later." |
| `lib/db/placementAuthority.ts::PLACEMENT_RECORDING_KINDS` | "its `holdPlacements` entries are the recordings an editor's restore is held to." | that sentence, then: "A brought-in app's first recordings are the holds of its genesis baseline's snapshot, which no row of these kinds wrote." |
| `lib/db/placementRecords.ts`, the file header | "since a cutover writes its holds into each app's baseline rather than as mutations." | "since a cutover writes its holds into each app's baseline rather than as mutations, and an app brought in from CommCare HQ is born with them in its genesis baseline." |
| `app/(app)/build/actions.ts::CreatedAppReceiptPayload` | "Nova has exactly two ways an app is born" through "and both hand the client the same thing:" | "This action is one of the ways an app is born, and every one hands the client the same thing:" |
| the same comment | "it accepts this key set exactly." | "it accepts this key set exactly, and for an app brought in from CommCare HQ the same set with `adoption`." |
| `components/chat/ChatContainer.tsx::installCreatedApp` | "Nova has two ways an app is born, the design build's `data-app-materialized` frame and the blank-app action's return value, and both arrive here, so a new app cannot land two different ways." | "A creation receipt reaches this tab three ways: the design build's `data-app-materialized` frame, the blank-app action's return value, and the answer of `POST /api/commcare/readings/[id]/create` for an app brought in from CommCare HQ. All of them arrive here, so a new app cannot land two different ways." |

`lib/apiError.ts`'s comment that lists the request budgets gains one line, in its own form:
"`HQ_READING_REQUEST_MAX_BYTES`: the reading routes' bodies (a key to start, a review's digest with
a name and a few answers to create)." `lib/deployment/index.ts`'s header ("Client surfaces import
types and pure helpers from here; only server modules reach the store, the preflight, and the
service.") stays true as written: B10 adds the reading's types to it and nothing that runs on a
server.

**`components/builder/CLAUDE.md`, "Creation never navigates"** (B10). Old opening: "Both ways an app
is born" through "hand the client the SAME receipt". New: "Every way a receipt reaches the client
(the design build's `data-app-materialized` frame, the blank-app Server Action's return value, and
the bring-in's create route) hands it the SAME receipt". After "through `pushBuilderHistory`, the
builder's own History-API path, never the Next router", the section gains: "A brought-in app's
receipt holds one more key, `adoption`, and is admitted as a second exact key set;
`ChatContainer`'s `landCreatedAppReceipt` is the one function both the blank path and the bring-in
flow call. One creation does load a page: an app brought in to a Project this tab is not scoped to.
The receipt is parsed as always, and then the tab loads `/build/{id}`, because there is no run to
sever and the tab's stores belong to another Project, so nothing of this tab is worth keeping. A
receipt for another Project is still never installed in place."

**`lib/collab/CLAUDE.md`** (B10). Old: "The design build's `data-app-materialized` frame and the
blank-app Server Action return the same authoritative receipt:". New: "The design build's
`data-app-materialized` frame, the blank-app Server Action and the bring-in's create route return
the same authoritative receipt (the last with one more key, `adoption`):". Its sentence "A malformed
or cross-scope receipt opens no stream and preserves the local doc for reload recovery." stays true
and gains: "A brought-in app's receipt for another Project is the one cross-scope receipt that is
expected: the tab loads that app's page and never activates its own reconciler for it."

**The research's contract row** "the closed birth vocabulary gaining `hq-adoption`" (part 10 hands
it here): settled by the `contracts.md` and `lib/db/CLAUDE.md` sentences above.

**Public docs.** None in B10: no person can reach a reading until B11 lands its entry, and B14
carries the pages.

---

## Departures

Where this part departs from the outline, the research or a contract of the repo, and the
alternatives it weighed and did not take. Each item keeps its number, which other parts cite.

1. **The order of the birth: the tables and the places are written inside the genesis tail**,
   through a new seam after the app row is inserted (6.2, 6.3). Part 11 holds the same order: its
   7.4 and 11.4 run both writers through `afterAppInsert`, the tables and then the places. Not
   done: the order "claim, lookup tables (predeclared ids), media edges, genesis sequence 1,
   places, the adopted deployment", with the tables written before the tail and the places after
   it. Evidence, for the tables: the membership gate that order writes the tables behind is the
   tail's own first statement, so "after the gate and before the tail" is no position a statement
   can stand at unless the birth takes the gate a second time on its own; and Project state before
   the membership gate can close a lock cycle with a lookup writer and a membership write, where
   every app-bound lookup writer takes the gate first (`lib/lookup/agentService.ts`). Evidence, for
   the places: `app_locations` references `apps(id)`, so they cannot precede the app row; and the
   tail's `applyOrganizationCommitIntegrity` is where a document and its places are proved to agree
   (placements, values, reverse hops), which every later commit of the app runs, so a copy written
   after it would commit unjudged and could fail the person's first edit instead of the birth.
   That no document names a place, so the integrity step has no edge to resolve, is true and is
   not the reason the step matters (6.2). The claim, the tables, the media edges, sequence 1, the
   places and the adopted deployment are all still written, in one transaction.
2. **Lookup row ids are not minted at the reading step.** Table and column ids are minted with the
   reading and kept on its row. Row ids are minted by the lookup writer inside the transaction, as
   today. Not done: minting table, column and row ids alike as UUIDv7 at the reading step.
   Evidence: no document slot holds a row id
   (`lib/doc/lookupReferences.ts::LookupReferenceTargetSet`), so the candidate needs none, a
   retried transaction may mint them again at no cost, and a table of 5,000 rows would put 5,000
   ids on the reading's row to no reader's benefit.
3. **The three steps: read and check everything but media, then media, then create.** The first is
   kept whole: the first read step runs acceptance as well as the reader, over everything but the
   files, so nothing but a file's own facts is ever learned after the media is fetched (3.3). What
   makes a verdict is one function. After the media is staged the read step runs again and it, not
   the media step, writes the review (Decision 8). Not done: a media step that writes the review
   itself from what the first step kept. Evidence: the verdict after media needs the document
   (which files it references, which platform each must play on, the export budget), a reading
   keeps no HQ source at rest (2.3), and this plan keeps no document at rest either. One more read
   of CommCare HQ buys one place where the rule lives, and the bracket is fresh when the person
   sees the review.
4. **The row stores one of three things: a stop, an account or a review, in three states.** Not
   done: a row that stores only the account or the review, with a stop written as an account.
   Evidence: part 01's section 8.3 makes a `stop` "no finding about the app" that is "never mixed
   into an account".
5. **Remove clears everything that names the app and keeps the row with its content-free census.**
   Not done: deleting the row on Remove. Evidence: step 7's groups are ordered by the census
   (`../6-bring-in.md`, "What step 7 is left"), and the apps people gave up on are the ones whose
   findings matter most to that order. What stays holds no word an author typed.
6. **One more circumstance code, `could-not-create`** (6.5), for a gate or export-readiness refusal
   at the birth, beside the codes part 01 holds in `READ_CIRCUMSTANCES`. Not done: reusing
   `read-back-differs`. Evidence: `read-back-differs`'s block says the check of Nova's own reading
   did not pass, which is false of a reading that passed every check and was then refused by Nova's
   own tail. Part 01 holds the code (its 8.3 and 9.3).
7. **No `discarded` state, no stored source and no `expires_at`.** Not done: a `discarded` state, a
   stored reading (a `reading_gzip` column) or a staging map on the row, an `expires_at`, and a row
   lock held for each step. There is no stored source (2.3), the staging facts are part 11's
   verdicts, and nothing expires (2.6). A row lock per step is replaced by a compared revision
   (3.2; "Executed during planning", the first fact verified).
8. **The step's time is part 05's three constants; no departure stands.** Part 05
   (`05-reading-commcare-hq.md`, B1) gives the step 120, 60 and 90 seconds in its section 3.3, its
   hand-off to this part says the first step holds to those three constants, and this part keeps
   them (3.6).
9. **The birth diffs nothing.** The reader returns the construction batch: part 06 makes it inside
   the reader, as `ReadDraft.batch`, by `diffDocsToMutations(emptyBlueprintDoc(appId), doc)` (its
   2.2). So the document acceptance judges and the birth writes is that batch's reduction, and
   this part holds no second derivation to prove equal (3.3, 6.2). Not done: running that diff
   again at the birth over the reader's document.
10. **The activation receipt's arm is a second exact key set**, not a new key on every receipt
    (7.1), so a tab from before the deploy still lands a build that ends after it.
11. **`GenesisGateRejectedError` gains `check` and `findingCodes`**, so a refusal can be logged and
    worded without the app's words.
12. **What a table that changed under the birth becomes.** The reading is kept, and it is read
    again: the row goes back to `reading` and the answer is `review-changed` (6.5). Part 11 says
    the same of this part (its 7.4). Not done: mapping `BroughtInTableChangedError` and
    `tag_taken` at the birth to `table-differs-in-project`. Evidence: the circumstance's block
    tells the person "You can choose what to do with it in the review"
    (part 01, 9.3), and the review the row holds at that moment is the one made before the table
    changed, which shows no such choice. A stop carrying that block over that review points at a
    control that is not there. The fresh read's review holds the choice, and a creation that then
    leaves it unanswered is answered with the circumstance, where it is true (5.3, step 3; 3.8).
13. **What a `choice` table is bound to before its answer.** It is bound, with no answer, as
    `use-commcare-hq` binds it: the Project table's id, its columns by name, predeclared ids for
    the fields it lacks (5.2). Part 11's 7.4 holds the same rule. Not done: binding it to its
    predeclared ids until the person answers. Evidence: creation proceeds only where the digest of
    what the person reviewed still holds (Decision 15), and the digest covers the document. Under a
    binding to predeclared ids the reviewed document names those ids and the created one names the
    Project table's, for either answer, so every person who met a choice would be sent back to the
    review by their own answer. Under this binding both answers leave every id the reader reads
    where the review had it.
14. **Publication is recorded on the row.** `ReadingMediaPlan` carries `published`,
    `publishReadingMedia` answers each call's plan for this part to write, and a file whose verdict
    it drops is fetched by a creation step on a `ready` row, never by returning the reading to
    `media` (6.1). Part 11's 14.2 holds the same rule. Not done: publishing every file in one call
    with no record on the row, and returning the reading to its media step for a file whose bytes
    had lapsed. Evidence: `publishStagedMedia` deletes the pending object of every file it
    publishes (part 11, 4.1), so a second pass over the same staged files finds their bytes gone
    and reads each from CommCare HQ again; a creation whose final step must be a call's first (4.5)
    spans calls, and without the row's record each call would do that for every file. And the
    `media` state holds no review (2.4's CHECK), so going back to it would discard the review and
    the choices of a person who has just pressed Bring it in.
15. **From `components/builder/CLAUDE.md` ("Creation never navigates"): one landing loads a page.**
    A brought-in app lands in the builder through the one activation receipt (7), and an app
    brought in to a Project the tab is not scoped to lands by a full load of `/build/{id}`, after
    its receipt is parsed (7.3). Evidence: `ChatContainer.tsx` refuses a receipt whose Project is
    not the session's, in both existing landings, and `lib/collab/CLAUDE.md` gives the reason ("A
    malformed or cross-scope receipt opens no stream"); the flow itself offers another Project at
    its first screen (part 13, section 4.1). The rule against navigating protects a live run and a
    held document, and this landing has neither.
16. **The reader and acceptance run in a worker thread** (3.6), in the idiom of
    `lib/preview/engine/evaluateForm.ts`. Not done: running them in the request. Evidence: they
    are synchronous CPU over up to 64 MiB, a step gives them 60 seconds, and one instance serves
    every other request, the SSE relays and the chat lease heartbeats on the same event loop. The
    worker is also what carries the check's own heap limit, which no request can, and what lets a
    check that passes it end as `too-large` with the server untouched (3.6).
17. **The reading adds no form-by-form scan; no departure stands.** Part 06's 17.4 plans no scan
    for the reading. The reading asks part 11's `readReadingProjectData`, whose substring test over
    the source's text (its 5.1 and 11.1) names every tag of CommCare HQ's list that a form-by-form
    scan of the source's reads could name, and possibly more (3.3, step 5). Not done: a first step
    that scans each form's reads to name the candidate tables. Two ways of naming candidate tables
    would be two lists to keep equal; the wider one costs at most the rows of a table the app does
    not read, which the reader then leaves out.

**The outline, item by item where it touches this part.**

| Outline item | Settled |
|---|---|
| 2, "The `hq-import` birth owner, the third owner" | here: the owner is `hq-adoption`, the fourth caller (6); "import" names the other direction in code and copy (`../6-bring-in.md`, "What changed from the outline, and why", item 13) |
| 2, "Lookup tables and media are materialized in Project storage atomically with sequence 1" | here: tables, places and media edges commit with sequence 1 (6.3); media bytes are published before it (6.1), which is the only order bytes allow |
| 2, the HQ app "recorded in the deployment ledger as explicitly adopted"; the identities table's privilege | part 10 (B8); this part calls its writer inside the birth |
| 5, entry points "each confirming the platform declaration before the app exists" | the declaration is a preselected choice of the review and never a gate before the app exists (`../6-bring-in.md`, "What changed from the outline, and why", item 5; part 13, section 8.3); here it is `BringInInput.runsOnlyOn` and `splitDatetime`, validated against the review (5.3). The entries are part 13's |
| 9, "the `hq-import` birth writes the declaration confirmed" | here: the chosen declaration's mutations end the construction batch (6.2). The proposal itself, and the finding for an app that runs on neither platform (`no-platform-runs-everything`), are the reader's (part 06, 16.3, B2); media narrows the offer here (5.1) |
| 9, "Defect 20's confirmations" and 10, "Confirmations" (asking `form-entry-sync-off` and `commtrack-off`, probing same-type child links, at import) | not asked at a bring-in: the birth records only the plan features the source already uses (part 10, 6.5) and leaves the project-space settings to the first publish (`../6-bring-in.md`, "What changed from the outline, and why", item 9) |
| "Cutover and migration" | none in this part: one additive migration, no scan, no Job |
| "Contracts", "the `hq-import` birth owner" | here ("Contracts") |
| "Exit" | part 14, Departure 7 words it; part 15 states it for the step; this part's exit is its tests |

---

## Files by pull request

**B10.** It sits above B7 (acceptance), B8 (the ledger) and B9 (project data), whose functions it
calls, and below B11. Stack B's order is B1, B2, B3, B4, B5, B6, B8, B9, B7, B10, B11, B12, B13,
B14, B15, so B10 also holds B1's readers, B2's reader and `revision.ts`, and B6's
`recordDialectRoundTrip` beneath it.

New:

| File | Holds |
|---|---|
| `lib/case-store/migrations/20261203000000_hq_app_readings.ts` | 2.1 |
| `lib/case-store/migrations/__tests__/hqAppReadings.postgres.test.ts` | "Tests" |
| `lib/deployment/reading/types.ts`, `budget.ts`, `store.ts`, `beat.ts`, `slot.ts`, `service.ts`, `gather.ts`, `check.ts`, `checkWorker.ts`, `checkInWorker.ts`, `mediaIds.ts`, `digest.ts`, `create.ts`, `birth.ts`, `census.ts`, `learned.ts`, `index.ts` | section 3's table. No `mediaState.ts`: the media plan's functions are part 11's `projectData/media.ts` (B9) |
| `lib/deployment/reading/__tests__/`: `readingStore.postgres.test.ts`, `readStep.postgres.test.ts`, `checkInWorker.test.ts`, `slot.test.ts`, `beat.test.ts`, `check.test.ts`, `mediaStep.postgres.test.ts`, `birth.postgres.test.ts`, `birthClaimRace.postgres.test.ts`, `createRetry.postgres.test.ts`, `createDigest.postgres.test.ts`, `createMedia.postgres.test.ts`, `readingProjectMove.postgres.test.ts`, `digest.test.ts`, `mediaIds.test.ts`, `census.test.ts`, `learned.test.ts`, `budget.test.ts` | "Tests" |
| `lib/deployment/reading/__tests__/adoptionFixture.ts` | `adoptFixtureApp`, the birth tests' fixture, exported for part 13's `e2e/lib/bringInSeed.ts` ("Tests") |
| `lib/deployment/reading/__tests__/fixtures/spinningCheckWorker.mjs` | the worker entry `checkInWorker.test.ts` terminates ("Tests") |
| `lib/deployment/reading/__tests__/fixtures/allocatingCheckWorker.mjs` | the worker entry `checkInWorker.test.ts` runs into its heap limit ("Tests") |
| `lib/deployment/reading/__tests__/checkMemory.scale.test.ts`, `lib/deployment/reading/__tests__/fixtures/readStepMemoryChild.ts` | run M1: the scale test and the child that measures the server's share ("Written and not yet run"). The `scale` project and `reader-scale.yml` are part 06's (B3) and do not change |
| `lib/publish/hqReadingCopy.ts`, `lib/publish/__tests__/hqReadingCopy.test.ts` | "Copy", C1 to C6 |
| `app/api/commcare/readings/route.ts`, `[id]/route.ts`, `[id]/advance/route.ts`, `[id]/check-again/route.ts`, `[id]/create/route.ts`, `__tests__/routes.test.ts` | 4.1 |
| `scripts/inspect-hq-readings.ts` | 8.2 |
| `components/chat/__tests__/chatLifecycle.adoption.test.ts` | 7.2 |

Changed:

| File | Change |
|---|---|
| `lib/case-store/migrations/index.ts` | registers the migration |
| `lib/commcare/surface/revision.ts` | B2's file (part 06), which holds `surfaceStandingsRevision`; B10 adds `currentStandingOf` and `isDeclaredSurfaceKey` (3.9) |
| `lib/commcare/surface/__tests__/revision.test.ts` | B2's file, with the revision's cases; B10 adds the cases of the two added functions ("Tests") |
| `lib/db/pg.ts` | `AppDatabase["hq_app_readings"]` |
| `lib/db/privilegeConvergence.ts` | the table joins `RUNTIME_READ_WRITE_TABLES` |
| `lib/db/__tests__/privilegeConvergence.postgres.test.ts` | one row-lock probe (2.2) |
| `lib/apiError.ts` | `HQ_READING_REQUEST_MAX_BYTES` and its line in the budgets comment |
| `scripts/build-xpath-worker.mjs`, `.gitignore` | the third bundle, `public/reading-check/worker.mjs`, with its `require` banner and its check of `metafile.inputs` (3.6) |
| `cloudbuild.yaml`, `scripts/infra/__tests__/cloudBuild.test.ts` | the `deploy` step's `gcloud run deploy` arguments gain `--memory=2Gi`, on the line that holds `--no-cpu-throttling`, and the test's expected argument list gains it at the same place (3.6). The value is the one the service holds, so the deploy changes nothing it runs with |
| `lib/db/appGenesis.ts` | `WritePreparedGenesisArgs.afterAppInsert` and its call; `GenesisGateRejectedError.check` and `findingCodes`; `AppAdoption`, `AdoptedAppReceipt`; the header |
| `lib/db/apps.ts`, `lib/db/placementAuthority.ts`, `lib/db/placementRecords.ts` | comments only |
| `lib/deployment/index.ts` | re-exports, as types only, what a client component needs of a reading: from `reading/types.ts`, `ReadingView`, `ReadingSummary`, `ReadingReview`, `ReviewTable`, `ReviewPlaces`, `ReadingDeclarationChoice`, `ReadingOutcome`, `ReadingRefusal`, `BringInInput`, `CreateResult`, and `ReadingState`, `ReadingPhase` and `ReadingLearned`, which type members of `ReadingView`; from `lib/db/appGenesis.ts`, `AdoptedAppReceipt`; and from part 11's `reading/projectData/reviewTypes.ts`, `LookupTableChoice`. It exports no function of `service.ts`, `create.ts` or `store.ts`: client components import this file today (`components/builder/PublishPanel.tsx`, `PublishDialogBody.tsx`, `DeploymentStatus.tsx`), and those modules reach Kysely, `pg` and `lib/commcare/hq`. Routes and MCP tools import `@/lib/deployment/reading` |
| `components/chat/chatLifecycle.ts` | the second key set; `AppMaterializationActivation.adoption` |
| `components/chat/ChatContainer.tsx` | `landCreatedAppReceipt`; the blank path calls it; the comment |
| `app/(app)/build/actions.ts` | the comment |
| `lib/db/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `components/builder/CLAUDE.md`, `lib/collab/CLAUDE.md` | "Contracts" |
| `lib/publish/hqFindings.ts`, `lib/publish/hqFindingCopy.ts`, `lib/publish/__tests__/hqFindingCopy.test.ts` | part 01's files, as its "Files by pull request" lists for B10 (the edit is B10's, as B1's seven codes are B1's): `could-not-create` in `READ_CIRCUMSTANCES`, `CIRCUMSTANCE_STANDINGS` and `CIRCUMSTANCE_COPY`; `too-large`'s new body (C7; its two time causes, its memory cause and their `detail.name` are raised by this part's own code, 3.6); `findingLine`'s `named: null` for `could-not-create`, with its test case |

Changed only under an outcome of run M1 ("Written and not yet run"), each in B10:

| Outcome | File | Change |
|---|---|---|
| B | `lib/commcare/reader/__tests__/readerScale.scale.test.ts` (part 06's, B3), and the ceiling part 06's run R2 states | the number of forms the source is built with: the largest of 125, 100 and 75 that fits |
| C | `lib/commcare/hq/appReading.ts`, `lib/commcare/__tests__/hqAppReading.test.ts` (part 05's, B1) | `HqAppReading`'s `read` arm loses `application`; `readHqAppForReading` keeps no reference to the resource after its menus are typed |

Not changed, and held so by a test or by reading: `lib/hostnames.ts`, `proxy.ts`,
`config/runtime-capabilities.json`, `scripts/rollout/render-build-config.mjs`,
`lib/db/runtimeDatabaseProbe.ts`, `lib/db/appTests.ts`, `lib/models.ts`, `scripts/test-schema.ts`,
`lib/mcp/**`, `lib/doc/**`.

**B14** lands the `docs/architecture/contracts.md`, `docs/architecture/deployment.md` and root
`CLAUDE.md` text of "Contracts", the sentence on the service's memory among them: the
architecture files land with the stack's other contract text (part 15, decision 7), though the
`deploy` step it describes is B10's. **B15** removes this plan and keeps `scripts/inspect-hq-readings.ts`.

---

## What this part needs of other parts

For parts 01 to 14, what follows is how this part uses what each hands over. Where this part and
another hold one rule between them, both state it and "Departures" lists it. For part 15, each
need is what this part hands the stack.

- **Part 01 (`01-the-bar-and-the-manifest.md`; A2, A3, and its lines of B10).**
  `READ_CIRCUMSTANCES`, `CIRCUMSTANCE_STANDINGS` and `CIRCUMSTANCE_COPY` hold `could-not-create`
  with the row and block of 6.5 (its sections 8.3 and 9.3), and `too-large` holds the "When", the
  `detail` and the body of C7; both are marked B10 there, and B10 makes the edits. Its
  `findingLine` answers `named: null` for both (its 8.4 and 9.2). `table-differs-in-project`
  stands exactly as part 01 holds it: this part raises it where its "When" says, at a creation
  that leaves the choice unanswered (3.8). `findingSchema` parses every finding a row stores (its
  8.1). `standingOf` is total over the entries (`lib/commcare/surface/standing.ts`), which
  `revision.ts` reads. `keptListFor` and `targetFactsFromSource` give the review's kept list
  (5.1; its 6.1).
- **Part 05 (`05-reading-commcare-hq.md`; B1).** `getHqCredentials(userId, requestedDomain)` with
  today's result shape (its section 11); `readHqAppForReading` and `notSummarizedMenus` (its section
  8); `hqReadCircumstance` and `HqFailure` (its section 4); `withHqRequestDeadline` and
  `HqReadDeadline`, which this part opens once for the project data read (3.3, step 5), and the
  three budget constants (its 3.3); `HQ_MEDIA_FILES_PER_STEP`, `HQ_MEDIA_READ_CONCURRENCY` and
  `HQ_MEDIA_FILE_DEADLINE_MS` (its section 9); `HqAppSource.name`, `raw`, `multimediaMap` and
  `cloudcareEnabled`, and `HqMediaType` (its section 7); `retainedReadingRead` for this part's tests
  (its 14.1). Under this part's run M1, outcome C, B10 removes `application` from the `read` arm of
  its `HqAppReading` ("Written and not yet run"). Under its run G3's outcome B, `HqAppReading` gains
  `not-summarized` and this part maps it ("Written and not yet run").
- **Part 06 (`06-the-reader-forms.md`; B2, B3).** `lib/commcare/reader/index.ts::readHqApp(input,
  options)` with its `ReaderInput`, `ReaderOptions`, `ReadOutcome`, `ReadDraft`, `ReaderDefect`,
  `ReaderLookupCatalog`, `ReaderOrganization`, `ReaderMediaIndex` and `ReaderMediaResolution` as its
  2.2 writes them, `HandOffRecord` and `serializeClaimLog` as its 4.5 does, and
  `DeclarationChoices` (with `narrowedByHq` and `keepsWebApps`) as its 16.3 does. Its B2 carries
  `lib/commcare/surface/revision.ts` with `surfaceStandingsRevision` (its 2.1), to which B10 adds
  two functions (3.9). What it asks of this part is met: the reader is called with
  `mintingResolver(appId)` and `recordDialect: recordDialectRoundTrip` (3.3, step 7.1); each
  `unrecognized` finding is logged at error with the reading's id, under a log key and never under
  `detail.name`, and each `ReaderDefect` rides that line's context (10); the census and its
  manifest revision are stored (8.1, 3.9); the chosen declaration's mutations follow the batch at
  the birth (6.2); a contract error of the reader is `read-back-differs` (3.3, step 8); and the
  reading adds no scan of the forms' reads (Departure 17). `ReaderOrganization` is
  `{ levelCodes, levels }` (part 06, 2.2), and part 11 builds it, the lookup catalog and the media
  index, which this part's worker rebuilds from plain data (3.3, steps 5 to 7; 3.6). Its
  `ReadMediaReference` (in `facts.mediaReferences`) and part 11's `HqMediaReference` are two
  types, bridged by part 11's `hqMediaReferencesOf` (its 2.1). Run M1 runs through its
  `.github/workflows/reader-scale.yml` and `scale` Vitest project (B3) over the source its run R2
  builds; under M1's outcome B, B10 lowers the size `readerScale.scale.test.ts` builds and the
  ceiling R2 states ("Written and not yet run").
- **Parts 07 and 08 (`07-the-reader-cases-menus-lists.md`, B4 and B5;
  `08-the-reader-expressions.md`, B6).** This part asks nothing more of either. Neither hands the
  reading a declaration, which is settled inside the reader: part 06's `assembleDocument` is the last
  stage, after expressions, and calls `planDeclarationChoices` over the assembled document, where
  a `listFirst` menu and a leaf one platform lacks are uses `unavailableUses` already counts, so
  each narrows the choices; content no declaration runs is part 06's
  `no-platform-runs-everything`. This part proposes nothing of its own: it offers the choices
  acceptance passed, which are the draft's less those a media file cannot play on (5.1). Part 07's
  held placements ride the last `holdPlacements` mutation of `ReadDraft.batch`, which the birth
  reduces as it is (6.2, 6.4); it keeps no reader note and words no log line (its 2.2 and "Copy").
  Part 08 hands
  `lib/agent/authoring/recordRoundTrip.ts::recordDialectRoundTrip` (its 8.4), which the worker
  passes as `recordDialect`, and `ReadFacts.expressionRounds`, which the `[reading] step` line
  carries (10); its two lines C9 and C12 are `ReaderDefect`s and are logged as every defect is.
- **Part 09 (`09-acceptance-and-the-first-publish.md`; B7).** `acceptReading`,
  `AcceptReadingInput`, `AcceptedReading`, `AcceptedDeclaration`, `AcceptanceCheck` (five checks)
  as part 09's section 2.2 types them; `adoptionExportBoundary(doc, lookupDefinitions, mediaFiles,
  target)` as its 15.2 writes it; `localAppStringTable`. Also `FirstPublishView` and
  `firstPublishViewSchema` (`lib/publish/firstPublishChangeIds.ts`, its 11.1), the `firstPublish`
  input B7 gives part 10's `adoptedAppBaselineWrite` (its 12.3), and `differenceSignature`'s
  grammar for the log (its 14.2). What it asks of B10 is met: `runReadingCheck` builds
  `AcceptReadingInput` whole and passes `chosen` at creation (3.3, step 7.4); `ReadingReview.runsOn`
  is `AcceptedReading.declarations`, each with its `firstPublish` (5.1); the adopted baseline is
  written with the chosen declaration's list and `adoptionExportBoundary` is called with
  `lookup.definitions` (6.2); the failing arm's log line is written for every check, with
  `differenceCount` and `signatures`, and `ReadingCheck` carries no `differences` (3.6, 10); the
  worker bundle resolves `lib/commcare/compiler.ts` and `lib/export/boundaryFindings.ts`, the
  first through the `require` its build gives it (3.6);
  and the reading's step reads with `claims: "counts"`. Run M1 takes the aligned modules, the
  declarations and the media plan its run K4's test builds for R2's source, and starts from the
  ceiling K4's outcome leaves; the smaller of the two runs' ceilings is the plan's ("Written and
  not yet run").
- **Part 10 (`10-identity-and-the-ledger.md`; B8).** As it hands them: `claimHqAppInTransaction`,
  `HqAppKey`, `HqAppAlreadyClaimedError`, `readHqAppClaims`, `recordAdoptedDeploymentInTransaction`,
  `AdoptedDeploymentWrite`, `adoptedIdentityRows`, `assignMediaPaths`, `AdoptedMediaFile`,
  `adoptedAppBaselineWrite` (with B7's `firstPublish` input, its 6.3),
  `adoptionPlanFeatureConfirmations`, `mintingResolver`, `targetWireIdentity`. Its B8 migration
  holds the baseline's `first_publish_changes` column, which the birth's baseline write fills
  through B7's writer (6.2). Its lock order (5.2) is section 6.3's first three rows. Every need it
  lists of B10 is met: the claim is the first statement after the reading's row lock (6.3); the
  adopted deployment is recorded after the tail with `pushedRevision` 1, the creation's own
  bracketed read's version, and the baseline, identity rows, media paths and confirmations of
  6.2's table (6.3, statement 4); `HqAppAlreadyClaimedError` becomes `already-in-nova` and the
  reading stays (6.5); the first step calls `readHqAppClaims` (3.3, step 2), and so does creation
  before it publishes a file (5.3, step 4).
- **Part 11 (`11-project-data.md`; B9).** This part calls the surface of its section 14. Of what
  lies beneath that surface it calls one pure function, `resolveLookupBindings`, and names a few
  others only to say what a step costs. Part 11 lists the same of this part (its "What this part
  needs of other parts", Part 12):
  - Its pure functions and its store functions are in separate files (its section 14, "Pure files
    and store files"), so the check's worker bundle holds no store (3.6): the check imports
    `projectData/index.ts`, `media.ts`, `lookupTables.ts`, `places.ts`, `review.ts` and
    `settlements.ts`, and `readReadingProjectData`, `stageReadingMedia`, `publishReadingMedia`,
    `discardReadingMedia` and the two birth writers come from `read.ts`, `mediaStore.ts`,
    `lookupTableStore.ts` and `placeStore.ts`.
  - The `minted` column holds its `PredeclaredLookupIds`, and this part passes
    `lib/lookup/managed.ts::mintLookupIds` as `mintIds`; no `store.ts::mintLookupIds` is made.
  - Step 5 calls `readReadingProjectData` with `choices: null` at a read step and the accepted
    answers at creation, and `places: "when-source-reads"`, then `"always"` where the document
    reads places and `placesRead` is false (3.3, steps 5 and 7.2).
  - After the reader: `projectDataReadsOf`, then `readingProjectDataFindingsFor`, and for a clean
    read `projectDataReview` and `readingProjectDataWrite` (3.3, steps 7.2 and 7.5).
  - A `choice` tag binds as its 7.4 says, before and after the answer (5.2). Creation validates
    the answers with `resolveTableChoices` (5.3). The check compares bindings through its pure
    `resolveLookupBindings` (`projectData/lookupTables.ts`, its 7.4).
  - The review's `ReviewTable` and `ReviewPlaces`, with `reviewTableSchema`, `reviewPlacesSchema`,
    `LOOKUP_TABLE_CHOICES`, `LookupTableChoice` and `LookupChoiceOffer`, are declared in its
    client-safe `lib/deployment/reading/projectData/reviewTypes.ts` and imported from there (5.1).
  - The `media` column holds its `ReadingMediaPlan`, parsed by `readingMediaPlanSchema`; a staged
    file has no row, and its id is the `reservedId` that `provisionalReadingMediaId`, passed as
    `reserve`, gave it (2.3). `planReadingMedia` keeps a kept file's `published` entry as it keeps
    its verdict.
  - The media step calls `stageReadingMedia` and merges a lost write with
    `mergeReadingMediaPlans` (3.4). The read step calls `readingMediaIndex`, `planReadingMedia`
    with `hqMediaReferencesOf(draft.facts)`, `readingMediaFindings` and
    `narrowDeclarationsByMedia` (3.3, steps 6 and 7.3).
  - Acceptance is handed `handOffSettlements`, `readingLookupSnapshot`, `readingMediaRows` and
    `adoptedMediaFiles(files)`, over the files of `stagedReadingFiles` or of a publication (3.3,
    step 7.4).
  - Creation calls `publishReadingMedia` in recorded steps, writes each answer's plan at the row's
    revision, and on `refetch` writes the plan and keeps the row `ready` (6.1).
  - The birth calls its two writers at `afterAppInsert`: `writeBroughtInLookupTablesInTransaction`,
    then `writeBroughtInPlacesInTransaction` (6.3). `BroughtInTableChangedError` and `tag_taken`
    return the row to `reading` with `review-changed` (6.5).
  - "Remove" calls `discardReadingMedia({ projectId, plan })` (2.6).
  - 3.8 holds its circumstances, each of which makes a read an account.
  - The check's worker runs its pure functions, so each takes and answers plain data and imports
    nothing that reads a database or a bucket: `readerLookupCatalog`, `projectDataReadsOf`,
    `readingProjectDataFindingsFor`, `projectDataReview`, `readingProjectDataWrite`,
    `readingLookupSnapshot`, `resolveLookupBindings`, `readingMediaIndex`, `planReadingMedia`,
    `readingMediaFindings`, `narrowDeclarationsByMedia`, `hqMediaReferencesOf`,
    `handOffSettlements`, `readingMediaRows`, `stagedReadingFiles` and `adoptedMediaFiles`. The
    two it authors in the reader's package, `levelsFromHq` and `worldEntitiesFromReads`
    (`lib/commcare/reader/worldEntities.ts`, B9 and B6), are pure too, and are called by the
    reader and by `readingProjectDataFindingsFor`, never by this part.

  Four rules are held by both parts, in part 11's text as here: where the two writers stand in
  the birth (the seam; Departure 1), what a table that changed under the birth becomes (Departure
  12), what a `choice` table is bound to before its answer (Departure 13), and how publication is
  recorded (Departure 14). What it asks of the digest (each table's
  canonical digest, the places' digest and the media files) is in `review.tables`, `review.places`
  and, for the files, in the document and the media paths named by content (5.2), which is
  stricter than the file keys: a file CommCare HQ swapped under one path changes the digest. This
  part needs no `lib/lookup/managed.ts::readProjectTablesByTag`: step 3 of part 11's 14.1 reads
  the Project's side itself.
- **Part 13 (`13-the-experience.md`; B11, B12).** The flow is mounted on `/build/new`, inside
  `ChatContainer`'s tree (its section 3.1), so a `created` answer lands through
  `landCreatedAppReceipt(receipt, "brought-in")`, whose three answers it handles (7.3: on `leaving`
  it keeps its creating state, since the page is going); the home entries and a home row lead
  there with the reading's id. It calls the six routes, polls as
  4.4 says, drives a reading only where `stepRunning` is false (4.4), calls `advance` again while
  `again` is true, and calls `create` again, with the same
  input, while its answer is `again`. On `review-changed` with a row in `reading` or `media` it
  advances that row and shows the review when it is `ready` again. It shows a `held` answer's
  circumstance above the review, and for `table-differs-in-project` brings the named table's choice
  into view. It reads the home rows from `listOpenReadings` beside `listDesignsInProgress` in
  `app/(app)/(site)/app-list.tsx`, and `app/(app)/(site)/page.tsx` asks `userHasOpenReadings`
  beside `userHasDesignsInProgress` before it shows the empty state; it words the rows from
  `READING_PHASE_LABELS`, `READING_LEARNED_LINES`, the counts and the stop's block, and draws
  `publishing-media` without its count until a creation answer gives one (C4; its 9.1). It renders
  an account with `moreFindingsLine` and, where `mediaChecked` is false, part 11's line R12 ("Nova
  checks pictures and sounds once everything else can come in."). It draws the review from
  `ReadingReview`, the four fields `runsOnWhy` to `platformsOut` and each choice's `firstPublish`
  among them (5.1; its section 8). It imports the reading's types from `lib/deployment` and no
  module of `lib/deployment/reading`. It owns the picker's transport and the Playwright specs of
  the flow, the retry after a reload, and both landings: an app brought in to the Project the tab
  is looking at, with no page load, and one brought in to a second Project, which ends on
  `/build/{id}` with the builder open, part 13's landing toast shown once and no toast of C6. Its
  `unopened` screen reads `UNVERIFIED_LANDING_TITLE` (C6). Its `e2e/lib/bringInSeed.ts` calls this
  part's `adoptFixtureApp` ("Tests"). B12 registers six MCP-only tools (part 13, 14.1), three of
  them over this part's functions; `read_hq_app` and `bring_in_hq_app` answer part 13's projection
  of `ReadingView` and `CreateResult` (its 14.3 and 14.4) with the sentences of "Copy", and pass
  `HQ_READING_STEP_MS` as their budget, never the request's cap (4.5).
  `bring_in_hq_app`'s `table_choices` is `BringInInput.tableChoices`, a tag left unanswered comes
  back as the `held` answer's circumstance, which names it, and an answer that is not offered
  comes back as `choice_not_offered` (5.3; part 11, 7.2). B12 also words `get_deployment` for an
  adopted deployment (9.5) and the guide's sentences about an app from CommCare HQ (9.6).
- **Part 14 (`14-proof.md`; A1, B13).** Nothing of the lane is needed here. It reads this part:
  its `readForLane` calls `runReadingCheck` in process, with `ReadingCheckInput.claims` as its
  `LaneReadInput.claims` and `ReadingCheck.claims.log` as a first reading's claim log (3.6; its
  section 5.2). The retained answers under `proof/hq-reads/reading/` are what this part's service
  tests serve, so a base whose answers a test names is not renamed without the test.
- **Part 15 (`15-stack-contracts-and-exit.md`; B14, B15, the stack).** B10's place in
  stack B (above B7, B8, B9; below B11). If `main` holds a later-stamped migration when this pull
  request is rebased, the stamp moves to the next free hour after `main`'s newest, and every later
  stamp of the stack keeps its order; nothing else changes. B14 lands the three architecture texts
  of "Contracts". The rewrite of `7-rest-of-model.md` says the order of its groups after the first
  is the first table of `scripts/inspect-hq-readings.ts` when step 6 exits, and B15 keeps that
  script. The step's exit is worded by part 14 (its Departure 7) and stated by part 15.

## What other parts read from this one

- **The table**: `hq_app_readings`, its indexes `hq_app_readings_open` and `hq_app_readings_home`,
  the migration `20261203000000_hq_app_readings`, and that it is runtime read-write.
- **Types** (`lib/deployment/reading/types.ts`): `ReadingState`, `READING_STATES`,
  `OPEN_READING_STATES`, `ReadingPhase`, `READING_PHASES`, `ReadingKey`, `ReadingOutcome`,
  `readingOutcomeSchema`, `ReadingReview` (with `runsOnWhy`, `webAppsOnInHq`, `datetimeQuestions`,
  `platformsOut` and a `FirstPublishView` as `firstPublish`), `readingReviewSchema`,
  `ReadingDeclarationChoice` (with `firstPublish`), `ReadingLearned`, `ReadingView`,
  `ReadingSummary`, `ReadingRefusal`, `READING_REFUSALS`, `READING_REFUSAL_STATUS`, `BringInInput`,
  `bringInInputSchema`, `CreateResult`, `READING_MAX_STORED_FINDINGS`. `ReviewTable` and
  `ReviewPlaces` are part 11's, declared in its `projectData/reviewTypes.ts` and re-exported here.
  There is no `MintedLookupIds` and no media type of this part's: the `minted` column holds part
  11's `PredeclaredLookupIds` and the `media` column its `ReadingMediaPlan`.
- **The client's types** (`lib/deployment/index.ts`, types only): `ReadingView`, `ReadingSummary`,
  `ReadingReview`, `ReviewTable`, `ReviewPlaces`, `ReadingDeclarationChoice`, `ReadingOutcome`,
  `ReadingRefusal`, `BringInInput`, `CreateResult`, `AdoptedAppReceipt`, part 11's
  `LookupTableChoice`, and `ReadingState`, `ReadingPhase` and `ReadingLearned`.
- **The service** (`lib/deployment/reading/index.ts`, server-only): `startReading`, `readReading`,
  `listOpenReadings`, `userHasOpenReadings`, `advanceReading`, `advanceReadingWithin`,
  `checkReadingAgain`, `removeReading`, `createFromReading`, `createFromReadingWithin`,
  `ReadingResult`.
- **The store** (`lib/deployment/reading/store.ts`): `ReadingRow`, `ReadingOutcomePatch`, and the
  functions of 3.2.
- **The read step's values**: `gatherReading`, `GatherInput` (with `tableChoices` and `chosen`),
  `GatherResult`, `Gathered` (its `projectData` part 11's `ReadingProjectDataWrite`, its `lookup`
  part 11's snapshot), `GatheredFacts`; `runReadingCheck`, `ReadingCheckInput` (with `claims`),
  `ReadingCheck` (with `claims`, `placesMissed`, `bindingsMoved`, and no `differences`),
  `checkReadingInWorker`, `ReadingCheckAnswer`; `unrecognizedLogKey`.
- **The birth**: `adoptHqAppInTransaction`, `AdoptionBirth`, `AdoptionOutcome`,
  `adoptedDeploymentWrite`, `adoptedAppReceipt`, `readBackAdoptedAppReceipt`,
  `WritePreparedGenesisArgs.afterAppInsert`, `GenesisGateRejectedError.check` and `findingCodes`,
  the lock order of 6.3, and the fixture `__tests__/adoptionFixture.ts::adoptFixtureApp`.
- **The receipt**: `AppAdoption`, `AdoptedAppReceipt`, `AppMaterializationActivation.adoption`, the
  thirteen-key set, `landCreatedAppReceipt` and its three answers (`landed`, `leaving`,
  `unverified`).
- **The digest**: `reviewDigestOf`, `ReviewDigestInput`, `READING_MEDIA_NAMESPACE`,
  `provisionalReadingMediaId`, `reviewMediaId`.
- **Budgets**: `HQ_READING_STEP_SECONDS` (270), `HQ_READING_STEP_MS`,
  `HQ_READING_ROUTE_MARGIN_SECONDS` (30), `HQ_READING_CHECK_BUDGET_MS`,
  `HQ_READING_WRITE_RESERVE_MS`, `HQ_READING_OUTCOME_WRITE_MS`, `HQ_READING_CHECK_HEAP_MB` (736),
  `HQ_READING_CHECK_YOUNG_MB` (32), `HQ_READING_SLOT_WAIT_MS` (20,000),
  `HQ_READING_STEP_BEAT_MS` (10,000), `HQ_READING_STEP_QUIET_SECONDS` (30),
  `HQ_MEDIA_STEP_WORK_MS` (180,000), `HQ_MEDIA_STEP_CEILING_MS` (210,000),
  `HQ_MEDIA_PUBLISH_DEADLINE_MS` (120,000), `stepFits`; `HQ_READING_REQUEST_MAX_BYTES`
  (`lib/apiError.ts`); and `--memory=2Gi` on the `deploy` step of `cloudbuild.yaml`.
- **Liveness and the slot**: `step_beat_at`, `ReadingRow.step_running`, `ReadingView.stepRunning`,
  `withStepBeat` and `beatReadingStep` (3.2); `ReadingSlot`, `ReadingSlots`, `createReadingSlots`
  and `processReadingSlots`, `GatherInput.takeSlot` and `GatherResult`'s `busy`, and the phase
  `waiting` (3.3, 3.6).
- **The census**: `ReadingCensus`, `censusOf`, `mergeCensuses`, `removedAppKey`,
  `scripts/inspect-hq-readings.ts`.
- **What Nova learned**: `surfaceStandingsRevision` (carried by B2), `currentStandingOf`,
  `isDeclaredSurfaceKey` (both B10), `whatNovaLearned`, `ReadingLearned`.
- **Routes**: `POST /api/commcare/readings`, `GET` and `DELETE /api/commcare/readings/[id]`, and
  `POST …/advance`, `…/check-again`, `…/create`, with the bodies of 4.1: a refusal answered as a
  status has the body `{ error, code }` and the status `READING_REFUSAL_STATUS` gives it, on the
  create route as on the others, and a 401, 413, 499 or 500 is `handleApiError`'s `{ error }`.
- **Copy** (`lib/publish/hqReadingCopy.ts`): `READING_REFUSAL_COPY`, `CREATE_RESULT_LEADS`,
  `READING_LEARNED_LINES`, `READING_PHASE_LABELS` (its `publishing-media` entry a function of the
  count, with a form for none), `moreFindingsLine`, `UNVERIFIED_LANDING_TITLE`,
  `UNVERIFIED_LANDING_BODY`; the circumstance `could-not-create`; and `too-large`'s wider "When",
  `detail` and body (C7), both of which part 01 holds.
- **Run M1**, the check's memory at Nova's ceiling, with its outcomes: under B the ceiling part
  06's run R2 states is lowered in B10, and under C part 05's `HqAppReading` loses `application`
  ("Written and not yet run").
- **Log messages**: the seventeen of section 10.
- **Facts**: a reading's id is its app's id; a reading is its person's alone; a row never holds
  CommCare HQ's source or a document; the read step is the only verdict and runs up to three times
  (before media, after it, inside creation), and acceptance runs in all three, over everything but
  the files in the first; the reader and acceptance run in a worker thread, 60 seconds at most and
  under a heap limit of its own, and a check that passes either is `too-large`; a step holds no lock
  across a read of CommCare HQ; one step is at most 270 seconds for every caller, and its route has
  30 more; a fetching media step asks CommCare HQ for at most twelve files, and a publishing step
  starts no file after 120 seconds; a read step and creation's final step run only as a call's first
  step; one read step or final step at a time runs on an instance, and a second is answered `again`
  with nothing read; a running step marks its row every ten seconds, `stepRunning` is true for
  thirty seconds after a mark, a page drives a reading only where it is false, and the mark refuses
  nothing; creation re-reads and creates only on an equal digest, and no answer the review offers
  changes the digested document; an unanswered table choice is `held` with
  `table-differs-in-project`, an answer that is not offered is the refusal `choice_not_offered`, and
  there is no `choice_missing` refusal; project data and media are read, judged and planned through
  part 11's section 14 alone; staging writes no asset row, and creation's media steps record each
  published file on the row, in part 11's plan; the birth's baseline stores the chosen declaration's
  first-publish list; media is published before the birth and is all that can outlive a failed one;
  the birth is one transaction whose tables and places are written inside the genesis tail, in its
  `afterAppInsert` seam, before organization integrity; a brought-in document names no place; an
  adopted app is born `complete` with no holder, credits, design session or thread; a retried
  creation, and a second tab's, return the same app; an app brought in to another Project than the
  tab's lands by a page load of `/build/{id}`; Remove keeps the census and no longer says which app
  was read; a Project move leaves the row alone; no route needs an allowlist entry; nothing in B10
  moves `MODEL_CONTEXT_VERSION` (B9 leaves it at `v7-hq-round-trip-bring-in.b9`) or
  `RUNTIME_VERSION`.
