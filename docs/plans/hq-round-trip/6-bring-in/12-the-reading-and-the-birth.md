# Step 6, part 12: The read and the birth

This part plans how one CommCare HQ app goes from "a person picked it" to "a Nova app exists". It
is two plain requests and nothing between them. The read fetches the app from CommCare HQ, reads
it, checks it and answers a stop, an account of what Nova cannot hold, or a review with a digest.
The create reads it again, goes on only where the digest is the one the person reviewed, adds the
app's files to the Project and creates the app, its tables, its places, its adopted deployment and
its claim in one transaction. The part holds the function both requests share, the ids that make a
stored record unnecessary, the review and its digest, the two routes and the stream each answers,
the `hq-adoption` birth through the transaction-taking writers of part 10
(`10-identity-and-the-ledger.md`) and part 11 (`11-project-data.md`), the activation receipt's
adoption arm, what each failure answers, and what every other surface does with an app that was
brought in.

Citations are `path::symbol`: Nova at `main` `1f103305`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`.
This part reads CommCare HQ through part 05's readers only (`05-reading-commcare-hq.md`) and couples
to no HQ field of its own. The CommCare HQ facts it writes into `docs/architecture/complex-apps.md`
("Contracts") were read at `d6c6e16d8ae1`.

Nothing here changes a tool the Solutions Architect is given, a tool description or a guide
sentence, so nothing of this part reaches `MODEL_CONTEXT_VERSION`: the MCP tools that call its two
functions are part 13's (`13-the-experience.md`, section 14.1), and the seven progress tags it adds
to `lib/mcp/progress.ts` ride no tool input and no description. It changes no evaluator and no
document an App Test pins, so nothing here moves `lib/db/appTests.ts::RUNTIME_VERSION`. It adds no
table, no migration and no `scripts/test-schema.ts` entry.

| Section | Owns |
|---|---|
| 2 | what the two requests rest on: nothing stored, and the ids that make that possible |
| 3 | the read: what it answers, each call's deadline, `gatherReading` in order, media, project data, the size cap, the wait, what each circumstance answers |
| 4 | transport: the two routes, the stream, what an MCP call is given |
| 5 | the review, its digest, and the create in order |
| 6 | the `hq-adoption` birth: when media is published, the candidate, the one transaction and its lock order, refusals, every repeat of one create |
| 7 | the receipt's adoption arm: key set, parser, installer |
| 8 | failure by failure, what a read and a create answer |
| 9 | App Tests, app copy, delete and restore, Project move, the read tools, the first edit turn, the deploy probe, each traced |
| 10 | observability: log lines and Sentry grouping |

---

## Decisions in brief

1. **Bringing an app in is two requests** (2.1). `POST /api/commcare/bring-in/read` reads the app
   and answers a stop, an account or a review. `POST /api/commcare/bring-in/create` reads it again
   and creates the app. Each runs whole on its request, in the serving process.
2. **Nothing is stored between them** (2.2). There is no table, no row, no state and no job. A read
   leaves nothing behind, and nothing of the app is at rest in Nova until the person chooses Bring
   it in.
3. **Every id is derived, so nothing has to be remembered** (2.3). The read mints one `readingId`.
   The app's id, every entity id, every new lookup table and column id and every provisional media
   id is a function of it and of CommCare HQ's own names. The create is sent the `readingId` back
   and derives the same ids.
4. **One function makes every verdict, and both requests call it** (3.3). `gatherReading` reads the
   app under part 05's bracket, reads the Project data, runs the reader, judges every referenced
   file and runs acceptance. A create passes one argument a read does not, to keep the bytes of the
   files it will publish. So an equal digest means every check that passed at the review passed
   again, on the same content.
5. **Everything but the files is judged before a file is fetched, and a review is never answered
   before every file is judged** (3.3). An app with findings answers its account having fetched no
   file. Where an app can run depends on where its files play, so a review waits for them.
6. **Acceptance runs once in a read, whole, and judges every document a choice can make** (3.3).
   It takes no choice of the person's: a split the review offers has already been read back.
7. **Each call to CommCare HQ has its own deadline, and no number is added to another** (3.2).
   A closed tab stops a read at its next call. A create is never stopped by its caller.
8. **Two plain limits bound the work** (3.4, 3.6). An app body over part 05's byte cap is refused
   unparsed, as the circumstance `too-large`. An app with more files, or more bytes of them, than
   one publish can carry is a finding, by the export ceiling Nova already has.
9. **Progress is the response itself** (4.3). Both routes answer a stream of NDJSON lines: the
   stage that is running, a file count that moves, then one last line with the answer.
10. **The review digest is the SHA-256 of everything the person was shown and everything the birth
    would write that they were not** (5.2): the review, the document with each media file named by
    its content, the identity rows and the media paths. The date of the read is left out. No answer
    the review offers changes the digested document.
11. **The create trusts nothing the client sends about CommCare HQ** (5.3). It reads again, checks
    again, and creates only where its own digest is the one sent. The person's answers are then
    checked against its own fresh review. A table's choice left unanswered is refused
    `choice_missing`.
12. **Media is published once the create will create** (6.1): after the digest and the answers have
    passed, as ordinary ready files found by Project and content hash. A create that is turned back
    adds nothing to the Project.
13. **The document that is born is one acceptance judged** (5.3, step 8). After publication the
    check runs once more over facts already fetched, under the published ids and under the person's
    table answers, and must give the digest again.
14. **The birth is one transaction in one stated lock order** (6.3): the HQ app's claim, the
    genesis tail (membership, the app row, then inside a new seam the lookup tables and the places,
    then the gate, export readiness, media edges, entities, the baseline, the case schemas), and
    the adopted deployment.
15. **`writePreparedGenesisInTransaction` gains one optional seam, `afterAppInsert`** (6.2), which
    runs after the app row is inserted and before the lookup context is read. It is what lets export
    readiness see the tables the same transaction created, and what lets the tail's organization
    integrity judge the places the birth copies before anything commits.
16. **An adopted app is born `complete`, with no holder, no reservation, no credits, no design
    session, no authoring session and no thread** (6.4).
17. **A refusal of Nova's own checks at the birth is `read-back-differs`, answered `check-failed`**
    (6.5). It is Nova's defect, worded as Nova's and logged at error with no word of the app.
18. **A repeated create answers the same app** (6.6). The derived id fixes the app's id, and one
    rule covers every overlap: before a create answers anything but the app, it looks for the app
    once more.
19. **The receipt's adoption arm is a second exact key set** (7): the twelve keys every birth sends
    plus `adoption`. The three existing births send what they send today, so a tab that loaded
    before the deploy still lands a build that finishes after it.
20. **An MCP call has no deadline of Nova's own, and reports progress** (4.4). The two tools hand
    this part the same event sink the routes do.
21. **Nothing else in Nova needs to know an app was brought in** (9): App Tests, delete and restore,
    a Project move, `search_blueprint`, `get_app` and the first edit turn each meet an ordinary
    `complete` app. Nova has no app copy.
22. **An app brought in to a Project the tab is not looking at lands by a full load of
    `/build/{id}`** (7.3). The in-tab installer keeps its strict Project check.
23. **No log line holds a word of an app** (10): not in its message, which titles a Sentry issue,
    and not in its context.

---

## Executed during planning

Read, not run. Nothing here was executed against a database, CommCare HQ or the proof lane. The one
measurement this part leans on is part 05's: Nova's own parsers over HQ's starter apps, from which
its section 3.3 sets the byte cap (its "Executed during planning").

- **The genesis writer.** `lib/db/appGenesis.ts`, end to end: `prepareGenesisCandidate`,
  `writePreparedGenesisInTransaction`, `GenesisGateRejectedError`, `genesisBatchId`,
  `admitGenesisRuntimeSchemas`, `createExplicitBlankApp`, `AppMaterializationReceipt`;
  `lib/agent/change-set/materializeGenesis.ts::materializeSessionGenesis` (the born-`complete`
  composition this part copies); `app/(app)/build/actions.ts::createStarterApp` and
  `CreatedAppReceiptPayload`; `e2e/lib/smokeSeedFactory.ts` (a held document born through
  `diffDocsToMutations` and the write tail).
- **The kernel and its locks.** `lib/db/CLAUDE.md` (lock ordering, the membership gate, "creation is
  the only shared-gate-first exception", the Project move, "Media byte copies are the only
  non-destructive pre-transaction work");
  `lib/db/canonicalCommitKernel.ts::assertProjectCapabilityInTransaction`,
  `lookupContextForAuthoritativeWrite`, `admitExactMediaReferences`;
  `lib/db/projectMembership.ts::projectRoleForInTransaction`; `lib/db/projectMembershipGate.ts`;
  `lib/db/placementAuthority.ts::PLACEMENT_RECORDING_KINDS`, `PLACEMENT_CHANGE_REFUSAL`;
  `lib/db/placementRecords.ts` (the greatest fold baseline's snapshot counts as a recording);
  `lib/db/pg.ts::withAppTx` (its retry).
- **Lookup and organization writers.** `lib/lookup/CLAUDE.md`, "Valid writes";
  `lib/lookup/authoringBatch.ts::applyLookupAuthoringBatchInTransaction`;
  `lib/lookup/agentService.ts` (membership before Project state);
  `lib/lookup/service.ts::orderedColumns`, `orderedRows` (ordered by `order_key`, then `id`);
  `lib/domain/lookupIds.ts::LOOKUP_UUID_V7_PATTERN`;
  `lib/organization/commitIntegrity.ts::extractLocationReferenceTargets` and
  `applyOrganizationCommitIntegrity` with the six checks it runs; the DDL of `app_locations` and
  `app_location_references` (`lib/case-store/migrations/20260802010000_organization_model.ts`, both
  `REFERENCES apps(id)`); `lib/export/boundaryValidation.ts::organizationExportFindings` (a
  fixed-place owner is refused by export readiness, `LOCATION_OWNER_EXPORT_NOT_ACTIVE`).
- **Media.** `lib/media/CLAUDE.md` (two statuses; two concurrent key-lock bodies against three
  pooled connections); `lib/storage/mediaObjectKeyLock.ts::withMediaObjectKeyLock`;
  `lib/db/sessionAdvisoryLock.ts::MAX_LOCAL_SESSION_LOCKS` (one fewer than
  `lib/case-store/postgres/connection.ts::POOL_MAX_PER_INSTANCE`, which is 3);
  `lib/db/mediaAssets.ts`'s exports (`loadAssetsByIds`, `getAssetsInTransaction` and its `FOR SHARE`
  in id order); `lib/domain/mediaRefs.ts::remapAssetRefs`;
  `lib/domain/multimedia.ts::ASSET_SIZE_CAPS_BYTES`, `MAX_MEDIA_EXPORT_ASSETS` (500) and
  `MAX_MEDIA_EXPORT_BYTES` (200 MiB); `lib/media/exportBudget.ts`, whose header says every export
  path loads every referenced ready asset's bytes into memory at once;
  `lib/mcp/tools/uploadMediaAsset.ts` (publication found or made by Project and content hash).
- **Access.** `lib/db/appAccess.ts::resolveProjectAccess`, `userInProject`,
  `resolveAuthorizedAppSnapshot`; `lib/auth/projectRoles.ts::roleAllowsApp`;
  `lib/auth-utils.ts::requireSession`, `resolveActiveProjectId`.
- **Transport and limits.** `config/runtime-capabilities.json` (`cloudRunRequestSeconds`, 3600);
  `lib/hostnames.ts::HOSTNAME_ALLOWLIST`, `isPathAllowedOnHost`; `app/api/commcare/upload/route.ts`
  (it exports no `maxDuration`); `app/api/media/[assetId]/extract/route.ts::POST`, which answers
  `application/x-ndjson` lines, drops a line whose client has gone and runs its work to completion
  after a disconnect; `app/api/chat/route.ts::maxDuration` and its comment (advisory on the
  standalone server); `lib/apiError.ts::handleApiError`, `readJsonBody` and the request budgets
  beside them; `lib/case-store/postgres/connection.ts::POOL_CONNECTION_TIMEOUT_MS` (10 seconds);
  `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, "Sequential dispatch on the
  client".
- **MCP.** `app/api/mcp/dispatch.ts::MCP_MAX_DURATION_SECONDS` and `app/api/mcp/route.ts::
  maxDuration`, both 300, and the comments on each; `lib/mcp/progress.ts::ProgressStage`,
  `createProgressEmitter`; `lib/mcp/context.ts::initMcpCall` and its local `McpCallExtra`;
  `lib/mcp/tools/uploadAppToHq.ts`, which reports a long call's progress through that emitter;
  the SDK's handler context (`node_modules/@modelcontextprotocol/server/dist/mcp-BCJHyo7l.d.mts`:
  `mcpReq.signal`, "An abort signal used to communicate if the request was cancelled from the
  sender's side"; `DEFAULT_REQUEST_TIMEOUT_MSEC`, 60000; `resetTimeoutOnProgress`).
- **Ids.** The `uuid` package at 14.0.2, whose `v7` `lib/case-store/postgres/store.ts` imports
  today: `node_modules/uuid/dist/v7.js::v7` passes `options.random` and `options.msecs` straight to
  `v7Bytes` and touches its shared `_state` only where no options are given, so with both options
  it is a pure function.
- **The client.** `components/chat/chatLifecycle.ts::parseAppMaterializationReceipt`,
  `AppMaterializationActivation`; `components/chat/ChatContainer.tsx::installCreatedApp`,
  `verifyActivationDigest`, the `data-app-materialized` handler and `handleCreateStarterApp` (both
  refuse a receipt whose Project is not the session's); `app/(app)/build/[id]/[[...path]]/page.tsx`
  (an existing app's page takes the Project of `resolveAuthorizedAppSnapshot`, never the active
  one); `components/builder/CLAUDE.md`, "Creation never navigates"; `lib/collab/CLAUDE.md`;
  `components/ui/AccountMenu.tsx` (the account menu's "Give feedback").
- **Planning.** `lib/doc/platformDeclaration.ts::planContentDeclaration`, `declaredForContent`;
  `lib/doc/diffDocsToMutations.ts`'s header; `lib/db/apps.ts::appendSyntheticBatchInTransaction`'s
  equality check, `softDeleteApp`, `commitAppProjectMoveInTransaction`; `biome.json`'s
  `noRestrictedImports` (`lib/deployment/**` may import `lib/commcare`).
- **Other surfaces.** `lib/logger.ts::log`, `captureToSentry` (an error passed to `log.error` is
  captured with its message; a message alone is a message event), `SENTRY_TAG_KEYS`;
  `lib/commcare/validator/rules/app.ts` (`NO_MODULES`, `EMPTY_APP_NAME`);
  `docs/architecture/contracts.md` (app birth; "HQ deployment safety").
- **Real sizes.** HQ's four starter apps, under
  `corehq/apps/app_manager/static/app_manager/template_apps/`: the `app.json` files are 160,669,
  356,578, 359,994 and 509,917 bytes, with 4, 6, 6 and 9 forms, and the three `multimedia.json`
  files name 10, 7 and 13 files. The app sources the proof lane retains are at most 85 KB.
- **CommCare HQ, for the section `docs/architecture/complex-apps.md` gains ("Contracts").**
  `corehq/apps/app_manager/models/applications.py::Application.scrub_source` and
  `ApplicationBase._meta_fields` with `Application.export_json`;
  `corehq/apps/app_manager/util.py::update_form_unique_ids`;
  `corehq/apps/api/resources/v0_4.py::ApplicationResource.dehydrate_module`.

**Claims corrected, and facts verified.**

- **Verified: a publish is a route's `fetch`, not a Server Action.** A publish is
  `fetch("/api/commcare/upload")` (`components/builder/PublishDialogBody.tsx::handleUpload`);
  `lib/deployment/actions.ts` says so itself ("Publishing itself stays on `/api/commcare/upload`")
  and carries the card's short actions. A bring-in follows the publish (4.2).
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
- **Verified: no document slot holds a lookup row's id.**
  `lib/doc/lookupReferences.ts::LookupReferenceTargetSet` is `tableIds` and `columnTargets`, and
  `rg -n "rowId" lib/domain` finds nothing. Table and column ids are derived; row ids stay the
  lookup writer's (Departure 2).
- **Verified: nothing at run time reads a route's `maxDuration` on this server.** Next reads the
  export when it builds, for platforms that take it (`node_modules/next/dist/build/`), and its
  standalone server does not: under `node_modules/next/dist/server/` the name is in the
  type-checking rules and the type generator alone. `app/api/chat/route.ts`'s comment says the same
  of its own. So the 300 of `app/api/mcp/route.ts` and `app/api/mcp/dispatch.ts` bounds nothing,
  and the service's request ceiling is the real one (4.4).
- **Claim corrected (the outline, item 2): "the third owner of the one genesis writer".** The
  writer has three production callers today (`createExplicitBlankApp`,
  `materializeAppFromGenesis`, `materializeSessionGenesis`) and `docs/architecture/contracts.md`
  already lists three births. `hq-adoption` is the fourth.
- **Claim corrected (`docs/architecture/contracts.md`): "a persisted empty app, optional seed path,
  independently reconstructed starter, or pre-app placeholder row is forbidden".** The sentence
  means a placeholder `apps` row; `design_sessions` is already a pre-app row. The sentence is
  reworded so it says what it means ("Contracts"). A bring-in adds no pre-app row of any kind.

---

## Written and not yet run

This part waits on no run of its own. Every fact it rests on is Nova's own code, read above, or a
reader of part 05's, whose retained answers are part 05's to make. Its tests run in the work's own
CI, the real-Postgres ones and the one at the byte cap among them ("Tests"), and each failure there
is fixed in the code the test names.

Eight things are unmeasured. None is a run, and each has its decision here:

| What is unmeasured | What is done about it |
|---|---|
| The reader's and acceptance's own time on an app at the byte cap | Part 05 sets the cap from Nova's parsers' measured rate with ten times that allowed (its section 3.3). `cap.test.ts` holds each synchronous piece of a read at the cap under five seconds, in ordinary CI. A failure is a defect in the reader or in acceptance and is fixed there, never a reason to lower the cap. Every answered read logs `checkMs` and `sourceBytes` (10), so the rate real apps show is on record |
| What the reader holds in memory beside a body (3.6) | No test, and nothing divided. Three bounds are enforced, so every input of a request is bounded before it is held. What the reader makes of the two bodies at the cap, 32 MiB of text, is unmeasured, and 3.6 claims no margin for it: 200 MiB of kept files is about six times that text |
| CommCare HQ's time to answer, its throughput for files, and its time to serve an app near the cap | No run. The deadlines of 3.2 stand, each one constant. One that proves short shows as `[commcare] <label> unavailable` with the read's name |
| Storage's time to take a file | No run. It is inside the count the person watches |
| Whether stream lines arrive unbuffered in production | No run. `app/api/media/[assetId]/extract/route.ts` already depends on it. Where a line is late the answer still arrives whole and only the count stands still |
| Whether a create outlives a closed tab on the platform | No run. The screen promises only what holds either way (6.1) |
| How long the birth's transaction holds a Project's lookup state for an app at the cap | No run. The transaction takes no deadline of its own (6.3), and `[reading] created` logs its time with its counts (10) |
| Which MCP clients keep a call open on progress, and whether a tool call's signal fires on a dropped connection | No run. Progress is sent wherever a token is given, the tools' descriptions say what to do where a client stops waiting (part 13, sections 14.3 and 14.4), and a read nobody is waiting for stores nothing |

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
  an app). Each mints the app's id on the server (`createExplicitBlankApp`: `crypto.randomUUID()`).
  The database knows one thing about a birth: the sequence-one batch id `genesis:<app_id>`
  (`genesisBatchId`).
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
- **Long work in the browser is one request.** A publish is one `POST /api/commcare/upload`; the
  route exports no `maxDuration`. The service's real request ceiling is Cloud Run's
  (`config/runtime-capabilities.json::cloudRunRequestSeconds`, 3600); a route's `maxDuration` is
  advisory on the standalone server (`app/api/chat/route.ts`'s comment), and
  `scripts/rollout/render-build-config.mjs::requireStaticRouteTimeout` holds only the two stream
  routes to the manifest.
- **One route already answers its progress as lines on its own response.**
  `app/api/media/[assetId]/extract/route.ts::POST` streams NDJSON while it works and finishes its
  work where the client has gone.
- **A long MCP call already reports progress.** `lib/mcp/tools/uploadAppToHq.ts` sends
  `notifications/progress` through `lib/mcp/progress.ts::createProgressEmitter`, which is a no-op
  where the call carries no progress token.
- **`/api/commcare` is on the main host's allowlist** (`lib/hostnames.ts::HOSTNAME_ALLOWLIST`), and
  matching is by path segment, so every path under it is reachable in production.
- **Nothing reads an app from CommCare HQ.** `rg -i "bring-in|hq-adoption"` over `lib`, `app`,
  `components` and `scripts` finds nothing.

---

## 2. Two requests, and nothing stored between them

### 2.1 What the design rests on

- **Two requests.** `POST /api/commcare/bring-in/read` reads the app from CommCare HQ, runs the
  reader and acceptance, and answers a stop, an account or a review. `POST
  /api/commcare/bring-in/create` reads it again, proves it is what the person reviewed, and creates
  the app in one transaction. Everything runs in the serving process, on the request.
- **The sizes are real, and they are small.** HQ's own starter apps are 160 to 510 KB of source
  with 7 to 13 files, and reading and checking an app of that size is well under a second of
  processing ("Executed during planning"; part 05, section 3.3). So the ordinary read is seconds
  (3.7), and the tail is bounded by two plain limits (3.4, 3.6), never by machinery.
- **The create's read is the read's read.** Both requests call `gatherReading` (3.3), and one
  argument differs: whether the bytes of held files are kept. The create runs no check the read did
  not run.
- **The digest is the proof.** The review carries a SHA-256 of everything the person was shown and
  everything the birth would write (5.2). The create computes it again from its own fresh read and
  creates only where the two are equal.
- **Files are fetched in both requests.** The read fetches each file to judge it and keeps nothing.
  The create fetches each file again and judges it again, and only once the digest and the person's
  answers have passed does it publish the files to the Project's library and create the app (6.1).
  For the ordinary app that second fetch is a second or two.
- **Retry is safe by construction.** The derived app id makes a repeated create answer the same
  app, in every overlap of the two (6.6), and part 10's claim lets one Nova app hold one HQ app
  (its section 5.2).

"Reading" stays the code's word for one read of one HQ app (`../6-bring-in.md`, "What changed from
the outline, and why", "One name"). It names a request and the id that request mints, and nothing
that is kept. No sentence a person reads says it: to them it is the app they are bringing in.

### 2.2 Each need, and how it is met without a row

| Need | Met by |
|---|---|
| Coming back to an account or a review later | The page's address names the app (part 13, section 3.2 owns its spelling). Opening it reads the app again and shows where it stands now. A stored account would show a list CommCare HQ may have left; "Copy the list" (part 13, section 7.5) is how a person keeps one |
| A reload while a create is in flight | One per-tab key in the browser's session storage, which makes the page send the same create again (part 13, section 9.1). The server stores nothing for it, and 6.6 is why sending it again is safe |
| An MCP client's two calls | The read answers `readingId` and `reviewDigest` with the review, and the create is sent both back with the answers. The client holds them, as it holds any tool result (part 13, sections 14.3 and 14.4) |
| Ids minted at the read | Derived, never stored (2.3) |
| The first-publish list shown again at the first publish | Written at the birth on the deployment's read baseline (part 09, `09-acceptance-and-the-first-publish.md`, section 12.3; part 10, section 6.3), from the create's own acceptance |
| A repeated create returning the same app | The derived app id (6.6) |
| One HQ app held by one Nova app | Part 10's claim, inside the birth (6.3) |
| A list of apps that are part way in | Nothing is part way in. A read is one request that leaves nothing behind, so the home list shows apps, and an app appears there when its birth commits |

### 2.3 The ids

```ts
// lib/deployment/reading/appId.ts (server-only)
export const BROUGHT_IN_APP_NAMESPACE = "01616c9c-4e63-4e67-80dd-67bcb59e8431";
/** UUIDv5 under the namespace of
 *  `canonicalJsonText([actorUserId, projectId, server, domain, remoteAppId, readingId])`. */
export function broughtInAppId(actorUserId: string, key: ReadingKey, readingId: string): string;
```

- **`readingId`** is a UUIDv7 the server mints at the start of every read with the `uuid`
  package's `v7`. It names nothing stored. The create validates the one it is sent against
  `READING_ID_PATTERN` (5.3) and nothing more.
- **The app's id** is `broughtInAppId(...)`. The client never chooses an app's primary key: it can
  send any `readingId`, and the id that results is a hash it cannot aim at an existing app or at an
  id another record is waiting to use. The person's own id is in the hash, so no one else's request
  derives it. Today's births mint theirs on the server too (section 1).
- **Entity ids** are part 10's, unchanged: its `mintingResolver(appId)` (its sections 2.2 and
  2.3). Equal `appId` gives equal ids in both requests.
- **Provisional media ids** are `mediaIds.ts::provisionalReadingMediaId(appId, mediaType,
  multimediaId)` (5.2). They name a file in a document before any asset exists and never reach
  storage. The digest never sees an asset id (5.2, "Media ids").
- **Lookup table and column ids** are UUIDv7, derived from the reading's id and the tag, and for a
  column the field name, by part 11 (its section 5.5): every lookup id must match
  `lib/domain/lookupIds.ts::LOOKUP_UUID_V7_PATTERN`, and `v7` with both of its options given is a
  pure function ("Executed during planning"). Row ids stay the lookup writer's, minted in the
  transaction (Departure 2).
- **The time bits move no order a person relies on.** Columns and rows order by `order_key` first
  and by `id` only to break a tie (`lib/lookup/service.ts::orderedColumns`, `orderedRows`), and row
  ids are the writer's. Tables are listed by name and then by id
  (`lib/lookup/service.ts::getLookupManifest`), so the time bits decide only the order of two tables
  of one name. So a `readingId` a client made up, with any time in it, moves no order a person
  relies on.

---

## 3. The read

`lib/deployment/**` is an allowed consumer of `lib/commcare` (`biome.json`), so the code here may
call the reader in `lib/commcare/reader/` and part 05's readers. No file of `lib/db` imports
`lib/deployment` at run time today (`lib/db/pg.ts` imports two types of
`lib/deployment/entryPointTypes` and nothing else), and none does after this part.

| File of `lib/deployment/reading/` | Exports |
|---|---|
| `types.ts` | client-safe: `ReadingKey`, `readingKeySchema`, `READING_ID_PATTERN`, `ReadingAnswer`, `READING_MAX_LISTED_FINDINGS`, `READING_STAGES`, `ReadingStage`, `ReadingEvent`, `ReadingReview`, `ReadingDeclarationChoice`, `bringInInputSchema`, `BringInInput`, `CreateAnswer`, `READING_REFUSALS`, `ReadingRefusal`, `READING_REFUSAL_STATUS`; and, re-exported from part 11's `projectData/reviewTypes.ts`, `ReviewTable` and `ReviewPlaces`. Its run-time imports are `zod`, `PLATFORMS` (`@/lib/domain`), `COMMCARE_SERVER_IDS` (`lib/commcare/servers.ts`, constants) and part 11's `LOOKUP_TABLE_CHOICES`; everything else it imports is a type |
| `appId.ts` | `BROUGHT_IN_APP_NAMESPACE`, `broughtInAppId` (2.3) |
| `mediaIds.ts` | `READING_MEDIA_NAMESPACE`, `provisionalReadingMediaId`, `reviewMediaId` (5.2). It imports nothing else of this directory, so part 11's media functions import it |
| `gather.ts` | `gatherReading`, `GatherInput`, `gatherFromHq`, `GatherSources`, `GatherResult`, `GatherClaims`, `Fetched`, `Gathered`, `GatherFacts`, `checkFetched`, `unrecognizedLogKey` (3.3, 10) |
| `read.ts` | `authorizeBringIn`, `BringInActor`, `readHqAppForReview` (3.1) |
| `digest.ts` | `reviewDigestOf`, `ReviewDigestInput` (5.2) |
| `create.ts` | `createFromReview`, `movedBindingCount` (5.3) |
| `birth.ts` | `adoptHqAppInTransaction`, `AdoptionBirth`, `AdoptionOutcome`, `adoptedDeploymentWrite`, `adoptedAppReceipt`, `readBackAdoptedAppReceipt` (6, 7) |
| `stream.ts` | client-safe: `readBringInStream` (4.3) |
| `index.ts` | `import "server-only"`; the server surface: `authorizeBringIn`, `readHqAppForReview`, `createFromReview`. The two routes and the MCP tools import it; no client module does |

The Project data and the files are read, judged and planned through part 11's one surface (its
section 14); this part composes none of it a second time.

### 3.1 What a read answers

```ts
// lib/deployment/reading/types.ts (client-safe)
import type { CommCareServer } from "@/lib/commcare/servers";
import type { CircumstanceFinding, Finding } from "@/lib/publish/hqFindings";

export interface ReadingKey {
	readonly projectId: string;
	readonly server: CommCareServer;
	readonly domain: string;
	readonly remoteAppId: string;
}
/** The read route's body. Both routes also hold `domain` to `isValidDomainSlug` (4.1). */
export const readingKeySchema = z.strictObject({
	projectId: z.string().min(1).max(255),
	server: z.enum(COMMCARE_SERVER_IDS),
	domain: z.string(),
	remoteAppId: z.string().regex(/^[\w-]{1,255}$/),
});

export type ReadingAnswer =
	/** The read ended at something that is no fact about the app's content. */
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding }
	/** What Nova could not hold, in the app's own order. */
	| { readonly kind: "account";
	    /** CommCare HQ's name for the app, or null where the app's own read did not complete. */
	    readonly appName: string | null;
	    /** At most `READING_MAX_LISTED_FINDINGS`, sorted by place, then code. */
	    readonly findings: readonly Finding[];
	    /** How many findings beyond those the read met. */
	    readonly more: number;
	    /** Over every finding the read met, the ones past the listed limit too. */
	    readonly counts: { readonly notYet: number; readonly never: number;
	                       readonly fixInHq: number };
	    /** False where the read answered before every referenced file was judged. */
	    readonly mediaChecked: boolean }
	/** What creating will make. */
	| { readonly kind: "review";
	    /** Sent back at creation. Every id of the app derives from it (2.3). */
	    readonly readingId: string;
	    readonly reviewDigest: string;
	    readonly review: ReadingReview };

export const READING_MAX_LISTED_FINDINGS = 2000;
```

Each finding is part 01's `Finding` (`01-the-bar-and-the-manifest.md`, section 8.1). A circumstance
finding is made only through its `circumstanceFinding(code, place, detail)`, which fills the
standing from the code's row and cuts a long name. An account's findings are sorted by `place`, in
the order of part 06's `placeOrder` (its section 5.2: the app, its settings, its languages, then
each menu with its case list, detail, search and forms, each form's questions, then lookup tables,
media and the organization), then by `code`.
An app whose every question holds one unsupported appearance could give tens of thousands of
findings; the answer lists the first two thousand and the count of the rest, and the account says
how many more there are (part 13's sentence over `more`; "Copy", C5). `ReadingReview` and
`ReadingDeclarationChoice` are 5.1.

A stop, an account and a review are all a successful request: the answer is the answer (4.1).

```ts
// lib/deployment/reading/read.ts
declare const bringInAuthorized: unique symbol;
/** Proof that the person held `edit` in the Project when the request began. Only
 *  `authorizeBringIn` makes one: the brand's key is not exported. */
export interface BringInActor {
	readonly userId: string;
	readonly projectId: string;
	readonly [bringInAuthorized]: true;
}
/** `lib/db/appAccess.ts::resolveProjectAccess(userId, projectId, "edit")`. Null where it refuses. */
export function authorizeBringIn(userId: string, projectId: string): Promise<BringInActor | null>;

/** One whole read. Mints the reading's id, derives the app's, and answers. Writes nothing. */
export function readHqAppForReview(
	actor: BringInActor, key: ReadingKey,
	options: { readonly onEvent: (event: ReadingEvent) => void; readonly cancel?: AbortSignal },
): Promise<ReadingAnswer>;
```

A read needs `edit` in the Project although it writes nothing, because it reads the Project's own
side of the lookup tables the app reads (part 11, section 14.1): their revisions, the apps that
read them and the sibling mappings. The Project is the one the person chose at the first screen
(part 13, section 4.1), passed as an argument; nothing here reads the session's active Project, as
`app/(app)/build/actions.ts::createStarterApp` does not. `authorizeBringIn` is its own function so
that a route can answer 403 before it opens a stream and an MCP tool can answer its own error
(4.1, 4.4), and `BringInActor` is what makes a caller that skipped it fail to compile. The birth
asserts `edit` again inside its transaction, through the tail.

The brand proves `edit` in `actor.projectId`, and a key names a Project too. So `gatherReading`
and `createFromReview` each begin by holding the key's `projectId` to the actor's, before anything
is read, and throw an invariant failure where the two differ ("Copy", C8): a caller that
authorized one Project cannot read or create in another. Both routes hand `authorizeBringIn` the
`projectId` of the body they then pass on (4.1), so no request of theirs reaches the throw.

`readHqAppForReview` is `gatherReading` (3.3) with `keepMedia: false`, then the answer: a `stop` or
an `account` as gathered, or the `review` with its `readingId` and digest, the `Gathered` value
dropped. It logs the request's lines (10).

### 3.2 Deadlines, and stopping early

A deadline is a timeout on one call, through its last byte. Part 05's section 3.3 holds each call's
deadline and byte bound: 60 seconds each for the application resource and the source, 60 for a media
file, and the 30 seconds a read has today for every other read. No deadline is shared between calls
and no number is added to another. A read cut off by its deadline is the stop `hq-unavailable`,
whose block says CommCare HQ didn't answer in time (part 01, section 9.3), and part 05's log line
names which read ran out. Its throttle rule stands as written (its section 3.2): at most three
sends, a short wait inside the read's own deadline, the throttled reads one at a time.

**Stopping early is not a deadline.** `gatherReading` takes `cancel?: AbortSignal` and hands it to
every reader of part 05's and to part 11's two calls, each of which joins it to its call's own
signal with `AbortSignal.any` (part 05, section 2.3).

| Caller | `cancel` | So |
|---|---|---|
| the browser's read route | `req.signal` | a closed tab stops the read at its next call; nothing was made |
| MCP's `read_hq_app` | the tool call's own signal (4.4) | a read the client gave up on stops at its next call |
| the browser's create route, and MCP's `bring_in_hq_app` | none | once a person has chosen Bring it in, the work runs to its end (6.1) |

### 3.3 `gatherReading`, in order

```ts
// lib/deployment/reading/gather.ts
export interface GatherInput {
	readonly actor: BringInActor;
	readonly key: ReadingKey;
	readonly readingId: string;
	/** `broughtInAppId(actor.userId, key, readingId)` (2.3). */
	readonly appId: string;
	/** False in a read. True in a create: the plan keeps the bytes of each held file (6.1). */
	readonly keepMedia: boolean;
	/** Stage and file-count events (4.3). `gatherReading` never emits `done` or `failed`. */
	readonly onEvent: (event: ReadingEvent) => void;
	readonly cancel?: AbortSignal;
}

/** What one request read of CommCare HQ and of the Project. In memory until the request answers. */
export interface Fetched {
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
	/** The save counter both ends of the bracketed read held. */
	readonly hqVersion: number;
	/** ISO 8601: when the bracketed read answered. */
	readonly readAt: string;
	/** Part 11's `ReadingProjectData` (its 14.1), bound with no answer of the person's. */
	readonly data: ReadingProjectData;
	/** Part 05's flag answer where the source holds a write saved only if changed (step 3);
	 *  absent where it holds none. */
	readonly saveOnlyEditedApplied?: boolean;
}

/** A clean read, held in memory for the length of one request and never stored. */
export interface Gathered {
	readonly fetched: Fetched;
	/** Part 06's draft: the document, its construction batch, its identities, its declarations. */
	readonly draft: ReadDraft;
	readonly accepted: Extract<AcceptedReading, { ok: true }>;
	/** Part 11's `projectDataReadsOf` for this draft: what the reader read of project data. */
	readonly reads: ReaderProjectDataReads;
	/** Part 11's `readingLookupSnapshot`: the tables the document reads, as the birth will hold
	 *  them. Acceptance's `lookup`, and what `adoptionExportBoundary` names its tables from (6.2). */
	readonly lookup: LookupFixtureDataSnapshot;
	/** Part 11's plan: every referenced file with its verdict; in a create, the kept bytes of each
	 *  held file and then its published asset (6.1). */
	readonly media: ReadingMediaPlan;
	/** Part 11's `adoptedMediaFiles`: one entry per referenced path of every held file. */
	readonly mediaFiles: readonly AdoptedMediaFile[];
	readonly review: ReadingReview;
	readonly reviewDigest: string;
}

export type GatherResult =
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding }
	| { readonly kind: "account"; readonly account: Extract<ReadingAnswer, { kind: "account" }> }
	| { readonly kind: "clean"; readonly gathered: Gathered };

/** What the request's log line and the test at the cap read (10, "Tests"). */
export interface GatherFacts {
	/** `Buffer.byteLength(JSON.stringify(source.raw))`: CommCare HQ's source body less its white
	 *  space. Null where the source was not read. */
	readonly sourceBytes: number | null;
	/** The time the request's synchronous pieces took together, and the longest of them (3.6). */
	readonly checkMs: number;
	readonly longestPieceMs: number;
	readonly mediaTotal: number;
	/** `ReadFacts.expressionRounds` where the reader gave a draft. */
	readonly expressionRounds: number | null;
}

/** Steps 1 and 2 from Nova's own store, then `gatherFromHq`. What both requests call. */
export function gatherReading(
	input: GatherInput,
): Promise<{ readonly result: GatherResult; readonly facts: GatherFacts }>;

/** What steps 1 and 2 resolve before anything of the app is read. */
export interface GatherSources {
	readonly creds: CommCareCredentials;
	/** Part 11's `ReadingProjectSide` (its 14.1). Production's is its `postgresProjectSide`. */
	readonly project: ReadingProjectSide;
}

/** What the reader claimed in one gather. `log` is the reader's claim log as
 *  `serializeClaimLog` writes it, present where the full log was asked for. */
export interface GatherClaims {
	readonly counts: ClaimLog["counts"];
	readonly log?: string;
}

/**
 * Steps 3 to 9. It reads CommCare HQ and, through `sources.project`, the Project's side, and
 * nothing else of Nova's store.
 */
export function gatherFromHq(
	input: Omit<GatherInput, "actor"> & GatherSources & {
		/** Counts alone by default, as every request keeps them. The proof lane asks `full`. */
		readonly claims?: "counts" | "full";
	},
): Promise<{ readonly result: GatherResult; readonly facts: GatherFacts;
             /** Null where the reader never ran: a stop before step 6. */
             readonly claims: GatherClaims | null }>;

/**
 * Step 8 and step 9 over facts already fetched and a plan whose every file has a verdict: the
 * reader where it must run, part 11's findings, acceptance, the review and its digest. It makes
 * no request. `first` is step 6's outcome, which a read hands it so the reader runs again only
 * where the plan changes what a path resolves to; a create's second pass hands it none (5.3,
 * step 8).
 */
export function checkFetched(input: {
	readonly appId: string; readonly key: ReadingKey;
	readonly fetched: Fetched; readonly media: ReadingMediaPlan;
	readonly first?: ReadOutcome;
}): Promise<{ readonly result: Exclude<GatherResult, { kind: "stop" }>;
              readonly facts: GatherFacts }>;
```

`gatherReading` begins by holding the key's Project to the actor's (3.1). It is then the two reads
of Nova's own store (steps 1 and 2) and `gatherFromHq` with the credentials step 1 answered and
`postgresProjectSide({ projectId, actorUserId, appId, origin })`. The cut is where Nova's own store
ends, for two callers that hold no database: the test at the byte cap, which runs steps 3 to 9 whole
in production's order ("Tests", `cap.test.ts`), and the proof lane's reading. Beside `gatherReading`
and those two, nothing calls `gatherFromHq`.

The proof lane's reading runs production's steps 3 to 9 and no copy of them: it calls
`gatherFromHq` with its retained peer's credentials, a Project side that holds nothing and
`claims: "full"`, and reads the claim log from the answer's `claims.log` (part 14, `14-proof.md`,
section 5.2, step 2). So the lane assembles no reader input and no acceptance input of its own. A
request passes no `claims`, so it keeps counts alone and holds no claim log in memory.

The steps, in order. Every numbered step that can end the request says how. The stage a step
names is the stage the stream shows while it runs (4.3); a step that names none is too short to
show.

1. **Connection** (`connecting`). `lib/db/settings.ts::getHqCredentials(actor.userId, key.domain)`
   (part 05, section 11). `not_configured`, or credentials whose `server` is not the key's (a person
   stores one connection, on one server): `stop`, `not-connected`. `not_authorized` (the project
   space is not among the stored `approved_domains`): `stop`, `key-cannot-reach-space`. No request
   is sent for either. `ambiguous` cannot be answered where a project space is named, and is thrown
   as an invariant failure ("Copy", C8).
2. **The claim, as advice.** `lib/deployment/store.ts::readHqAppClaims({ viewerUserId, server, domain,
   remoteAppIds: [remoteAppId] })` (part 10, section 5.5). A view: `stop`, `already-in-nova`, with
   the view, less its `remoteAppId`, as `detail.claim`. This read decides nothing; the claim
   inside the birth does (6.3).
3. **The app** (`reading-app`). `lib/commcare/hq/appReading.ts::readHqAppForReading(creds, domain,
   remoteAppId, { cancel })`, one bracketed attempt (part 05, section 8.2).

   | Answer | Result |
   |---|---|
   | `read` | go on |
   | `changed` | the attempt is made once more, in this same request. A second `changed` is `stop`, `changed-while-reading` |
   | `linked`, `remote`, `deleted`, `gone` | `stop`: `linked-app`, `remote-app`, `app-deleted`, `app-gone` |
   | `failed` | `hqReadCircumstance(failure)` (part 05, section 4.3): `stop` where part 01's `CIRCUMSTANCE_STANDINGS` says `stop`, else an account of that one finding, which is `too-large` (3.6), with `appName` null where the application resource was the body over the bound |

   Then, only where part 07's `publishedCaseBlocks.ts::sourceHoldsEditMode` says the source holds a
   write saved only if the worker changed it (`07-the-reader-cases-menus-lists.md`, section 6.1),
   `lib/commcare/client.ts::readHqSaveOnlyEditedAnswers(creds, domain, { cancel })` (part 05, section
   10.5). `applied` and `not-applied` become `Fetched.saveOnlyEditedApplied`, which the reader is
   handed (part 07, section 3.2). `not-a-member` is `stop`, `not-a-member`. `failed` is the stop
   `hqReadCircumstance(failure)` gives. No answer is guessed, and most apps make no such read.
4. **Menus CommCare HQ could not summarize.** `notSummarizedMenus(modules)` (part 05, section 8.3):
   `app` is an account of one `app-unreadable-in-hq`; `menus` adds one `menu-unreadable-in-hq`
   finding at each index (place `{ kind: "menu", menu, name }`, the name from the source) to the
   findings of step 6 and makes the result an account whatever the reader says. HQ's message goes
   to the log with the menu's position and to no person (part 01, section 8.3).
5. **Project data** (`reading-project-data`). One call of part 11's (its 14.1):

   ```ts
   readReadingProjectData({ creds, server, domain, appId, readingId, source, project,
   	places: "when-source-reads", cancel })
   ```

   Everything of project data is inside that call, and this part makes none of its reads itself:
   the table list and the rows of each table the source's text may name, the ids derived for them
   (2.3), the Project's side through `project` (its tables of those tags, the apps that read them,
   the sibling mappings, the person's role), each table's standing and binding, the reader's lookup
   catalog, and, where the source may read places, CommCare HQ's levels and places. Part 06 plans
   no scan of the forms' reads (`06-the-reader-forms.md`, section 17.4), and this part adds none:
   part 11's source test is the one way candidate tables are named. A table that asks the person a
   choice is bound here as it is bound under either answer (5.2), so the call takes no answer, in
   a read or in a create.

   A `failed` answer is `hqReadCircumstance(failure)`, as in step 3. A `read` answer carries
   `data`, which is `Fetched.data`. A table whose rows CommCare HQ could not send is no failure of
   this step: it is that table's finding, raised in step 6 where the app reads the table.
6. **The reader, and everything but the files** (`checking`).
   1. **The reader.** `lib/commcare/reader/index.ts::readHqApp({ appId, target, source, modules,
      resolver: mintingResolver(appId), lookup: data.lookups, organization: data.organization,
      media, appStrings, recordDialect: recordDialectRoundTrip, saveOnlyEditedApplied })` (part 06,
      section 2.2; part 10's resolver). `target` is the server's origin
      (`lib/commcare/servers.ts::COMMCARE_SERVERS[key.server].baseUrl`) and the project space.
      `media` is part 11's `readingMediaIndex` over the source with no plan (its 14.2): a path
      resolves `no-entry`, `unreadable` or `asset`, and every asset is named by its provisional id
      (2.3), so the document is the same before the files are judged and after (part 06's rule,
      its 17.4). `appStrings` is part 09's
      `lib/deployment/reading/appStrings.ts::readingAppStrings(lookupContext)` (its 15.1), which
      answers `null` for a document Nova's gate refuses and `localAppStringTable` of it otherwise.
      `lookupContext` is the gate's context over every table `data.lookups` binds, under the
      catalog's own ids: `kind: "available"`, the reading's Project and the revision step 5 read,
      and one definition for each binding (part 11, section 5.5). It is built once, here, before
      the reader runs, and the same function goes to acceptance's re-read in
      `AcceptReadingInput.reader`. `recordDialect` is part 08's
      `lib/agent/authoring/recordRoundTrip.ts::recordDialectRoundTrip`
      (`08-the-reader-expressions.md`, sections 2.5 and 8.4). The reader keeps claim counts alone,
      its default, unless `gatherFromHq` was asked for the full log.
   2. **The project data, judged.** `reads = projectDataReadsOf(data, outcome)`, then
      `readingProjectDataFindingsFor(data, reads, draft?.doc ?? null, mintingResolver(appId))`
      (part 11, 14.1): every finding of project data for this read, raised in this one place. A
      table matters only where the app reads it, and levels and places only where the app reads
      places, which is why the findings wait for the reader. Where `reads.readsPlaces` is true and
      `data.placesRead` is false, the source test of step 5 missed a spelling: step 5 runs once
      more with `places: "always"` and then the reader again (part 11, 11.1's backstop), and the
      miss is logged at error (10). It is one extra pass and never a loop, since the second call
      always reads places.
   3. **The files, planned.** Where the reader gave a draft, `planReadingMedia({ source, appId,
      references: hqMediaReferencesOf(draft.facts), runsOn })` (part 11, 14.2) answers `{ plan,
      media }`: `plan` is the `ReadingMediaPlan` of this request, and `media` the `HqMediaPlan` of
      this read. `runsOn` is the platforms of the declaration the draft proposes (part 06, 16.3),
      and `hqMediaReferencesOf` is part 11's bridge from the reader's two lists of references (its
      2.1).

   **An account here ends the request before any file is fetched**, with `mediaChecked: false`:
   any finding of step 4, of the reader or of the project data, or part 11's finding for an app
   that references more files than one publish carries (3.4). The reader's own contract error
   (part 06, section 2.2) is an account of one `read-back-differs` at the app, `detail.name`
   `reader`, logged at error.
7. **The files, judged** (`checking-media`, with a count). Part 11's `judgeReadingMedia({ creds,
   plan, keep: keepMedia, onProgress, cancel })` (its 14.2) fetches each referenced file once and
   gives it a verdict (3.4). `onProgress` becomes a `files` event. `failed` (CommCare HQ failed a
   file after its one resend) is the stop `hqReadCircumstance(failure)` gives: a file CommCare HQ
   could not send this minute is no fact about the app. An app that references no file skips this
   step, and its stage is not named.
8. **Everything, with the files' facts** (`checking`). This step and the next are `checkFetched`,
   which a read reaches with the plan step 7 answered and step 6's outcome.
   1. **The reader once more, only where it must.** Where a file's verdict is `missing`, the
      reader runs again with an index built from the plan, in which that file resolves
      `unreadable`, so the document holds no asset in that place. The plan and its verdicts
      stand: the reference list is the same whichever way the index answers (part 11, section
      14.2). A create's second pass hands in no first outcome, so the reader runs again
      there too, with each published file named by its asset and the tables bound under the
      person's answers (5.3, step 8). Wherever the reader runs again, step 6.2's
      `projectDataReadsOf` and `readingProjectDataFindingsFor` run again over its outcome and the
      data in hand. Otherwise step 6's outcome and its findings stand.
   2. **The files' findings.** `readingMediaFindings({ media, plan, runsOn: offered })`, `offered`
      being every platform some declaration choice of the draft declares, answers the files'
      findings, `playsOn` and `complete`. `narrowDeclarationsByMedia(draft.declaration, playsOn)`
      leaves the choices every held file plays on. Where it leaves none, `readingMediaFindings`
      has already given `media-not-played-where-app-runs` (part 11, 2.4), so the read is an
      account and acceptance is not called.
   3. **Acceptance.** `lib/deployment/reading/acceptance.ts::acceptReading(input)` (part 09,
      section 2.2): its five checks, in the order of its `ACCEPTANCE_CHECKS`. It is called where
      the reader read clean and no step above gave a finding. A draft that part 11 holds a finding
      against is no document Nova would return (part 06, section 10.1), so judging it would word
      part 11's finding a second time as Nova's own defect. Step 4's menu findings do not hold
      acceptance back: its check 5 skips the forms of a menu CommCare HQ could not summarize (part
      09, section 7.5). `input` is part 09's `AcceptReadingInput`, and no value of this part's own is
      handed to it:

      | Member | Value |
      |---|---|
      | `appId`, `source`, `modules` | the reader's own |
      | `target` | `{ server: key.server, domain: key.domain }` |
      | `outcome` | the reader's `read` outcome |
      | `reader` | the reader input's `target`, `lookup`, `organization`, `media`, `appStrings`, `recordDialect` and `saveOnlyEditedApplied` |
      | `choices` | `narrowDeclarationsByMedia(outcome.draft.declaration, playsOn)` |
      | `settlements` | `handOffSettlements(outcome.claims.handOffs, media, findings)` (part 11, its 14.3), `media` being this read's `HqMediaPlan` and `findings` those of steps 6.2 and 8.2 |
      | `lookup` | `readingLookupSnapshot(data, reads)` (part 11, its 14.3) |
      | `mediaLeftOut` | `HqMediaPlan.inert.length` |
      | `media` | `{ files: adoptedMediaFiles(plan), rows: readingMediaRows(plan) }` (part 11, its 14.2 and 14.3): the plan's held files, each under the id the document names it by, which is its provisional id until a create publishes it and its published asset's after |

      A failing answer is an account of one `read-back-differs` at the app, with `mediaChecked:
      true`. Its `differences` stay inside `acceptReading`'s answer and are never logged; the log
      takes the check, the count and the signatures (10).
9. **A clean read's values.** Where there is no finding: `projectDataReview(data, reads, doc,
   mintingResolver(appId))` (the review's `tables` and `places`), the `lookup` snapshot and the
   `adoptedMediaFiles(plan)` of step 8.3, then the review and its digest (5.1, 5.2).
   Each call of part 11's takes a resolver of its own, as step 6.2's does: a resolver answers a key
   once (part 10, 2.3), each of part 11's functions claims the levels' keys, and every
   `mintingResolver(appId)` mints the same UUIDs.

   The digest covers the identity rows the birth would write, `adoptedIdentityRows(draft.identities,
   fetched.modules)` (part 10, section 3.1). That call answers `ok: false` only for a form with no
   real id, which no read that reached here holds: step 4 ends a reading with a menu CommCare HQ
   could not summarize. Should it answer so, the result is what the reader's own contract error
   gives, an account of one `read-back-differs` at the app with `detail.name` `reader`, logged at
   error with the signature `identity-rows` (10).

The result, by what the steps gave:

| The steps gave | Result |
|---|---|
| any stop | `stop` |
| any finding, from step 4, 6 or 8 | `account`, its findings in the order of 3.1. `mediaChecked` is true exactly where the reader gave a draft and every referenced file was judged. Each `unrecognized`, each reader defect and each `read-back-differs` is logged (10) |
| no finding | `clean`, with the review and its digest |

**Everything but the files is judged before a file is fetched.** An app with findings answers its
account at step 6, having fetched no file. **A review is never answered before every file is
judged**, because where the app can run depends on where its files play
(`narrowDeclarationsByMedia`), and a review that left files unjudged could turn into an account
after the person had chosen everything.

**Acceptance runs once in a read, after the files, with their facts.** It has one mode. A mode that
judged everything but the files before they were fetched would tell a person a little sooner about
a failure that is Nova's own defect and is logged at error, and would cost every read with files a
second pass over the whole app (Departure 20).

**Acceptance judges every document a choice can make.** Its check 2 judges the document under every
offered choice (part 09, section 4). Its check 3 judges the reader's document and, where any
offered choice splits date and time questions, the split document too, in every call (part 09,
section 5.4): every splitting choice splits the same questions (5.1, `datetimeQuestions`) and check
3's document leaves `appSettings.runsOnlyOn` out, so the splitting choices share one split document
and it is checked once. A split that does not read back is a `read-back-differs` account at the
read, as any other failure of acceptance is. So `acceptReading` takes no choice of the person's,
a read and a create hand it the same input, and a review never offers a choice that then fails
after the person presses Bring it in.

The document acceptance judges under each choice is the reduction of `[...draft.batch,
...choice.mutations]` from `emptyBlueprintDoc(appId)`, through
`lib/doc/commitVerdicts.ts::mutationCommitVerdict` (part 09, section 4). That is the batch the
birth itself reduces for the choice the person makes (6.2), so what acceptance judged is what
`prepareGenesisCandidate` will reduce, but for the name.

**The synchronous pieces.** The reader's run and acceptance's run are each one synchronous
computation, and step 9's digest is a third. `gather.ts` times each with `performance.now()` into
`GatherFacts`, and between any two of them that no awaited read separates it awaits
`node:timers/promises::setImmediate()`, so the event loop turns between pieces. Section 3.6 says
why a piece's length matters and what holds it.

### 3.4 Media: judged in both requests

Two functions of part 11's, one for each thing done with a file. `judgeReadingMedia` is what both
requests call: it fetches each file the document references, once by `(mediaType, multimediaId)`,
gives it a verdict, and stores nothing (its sections 2.2 and 2.3). `publishKeptReadingMedia` is
what a create calls, and only after its digest and its answers have passed (6.1; its section 4.1).

**Where the bytes are before the app exists.** In a read, nowhere: they are judged and dropped. In
a create before its digest and its answers have passed, in the request's memory and nowhere else.
In a create after that, in the Project's library as ordinary ready files (6.1).

**What one request holds.** Part 05 holds the window a fetch runs in (its section 9), so the bytes
in flight are at most 64 MiB whatever the app holds, and in a read that is all Nova holds. A create
also keeps the held files until each is published, which part 11 bounds by the export ceiling (its
sections 2.2 and 4.3): what a publish of the same app already holds in this process. So a bring-in
never asks more of the process than publishing the same app does. For the ordinary app, 13 icons,
either number is under a megabyte.

**The export ceiling ends a request early.** An app with more files, or more bytes of them, than
one publish carries could never be published from Nova, so part 11 makes it a `not-yet` finding
(its section 4.3). Over the count, which is known from the reader, no file is fetched and the
account of step 6 holds the finding. Over the bytes, which are known as files arrive, no further
file is started and the account holds the finding with `mediaChecked: false`. No new number is
invented.

**What can be said before the files are fetched.** An account answered before the files are judged
says so (`mediaChecked: false`, which part 13 words), so the person knows a later check looks at
them. A review says how many files come in (`creates.mediaFiles`), how many references point at no
file and are left out (`mediaLeftOut`), and where the app can run given where they play. The
create's stream names two counts in turn: `checking-media` while it fetches and judges the files
again, then `bringing-in-media` while it adds them to the Project (4.3).

### 3.5 Lookup tables and places

**Where.** In both requests, at step 5 of 3.3: after the app is read, before the reader runs. Both
requests read them fresh. Tables and places are rows outside the app's document, so the save
counter's bracket does not cover them (part 05, section 8.2), and the digest does: `review.tables`
holds each table's digest of CommCare HQ's columns and rows and the met Project table's revisions,
and `review.places` the places' digest (5.2). A row edited between review and create changes the
digest.

**What.** Part 11's one call (its 14.1): the table list once; the rows of each table the source's
text may name, one table at a time (part 05, section 3.2); the Project's side; and CommCare HQ's
levels and places only where the source may read places.

**Written.** At the create, inside the birth, through the `afterAppInsert` seam: tables, then
places (6.3). Nothing of them is written before.

**Limits.** Nova's own, as part 11 holds them, each a `not-yet` finding: the caps of one table and
of every table the app reads together (its 5.3), and the most places an app holds (its 11.4). For
a bring-in a read stops once such a finding is certain: a table's rows are not paged past the cap
and the place list is not read past the limit (part 05, sections 10.2 and 10.4), so what one
request holds of project data is at most what the caps admit.

### 3.6 The size cap

`lib/commcare/hq/appReading.ts::HQ_BRING_IN_APP_MAX_BYTES` is 16 MiB, and part 05 holds the number,
the measurement it is set from and the bounded read that enforces it (its section 3.3): a body over
it is never parsed and never held. It is a refusal threshold, never a size anything is designed
for. What follows is what the cap means to this part's two requests.

**Time at the cap.** Processing is synchronous on the request, in pieces with the event loop
turning between them (3.3): the reader's run, the reader's second run where one is due, acceptance,
the digest, and in a create the same again under the published ids (5.3, step 8). While a piece
runs, the instance answers nothing else, and a timer that comes due during a piece does not merely
fire late: Node runs expired timers before it reads the network answers that arrived meanwhile, so
another request's wait that ran out during the piece fails even though its answer had arrived. The
nearest such timer is the 10 second wait for a database connection
(`lib/case-store/postgres/connection.ts::POOL_CONNECTION_TIMEOUT_MS`), on a pool of three
(`POOL_MAX_PER_INSTANCE`). The next is the 30 second deadline on a CommCare HQ read. So what must
be short is a piece, not the request. By part 05's arithmetic an app at the cap is under six
seconds of processing in a read, over at least three pieces, and `cap.test.ts` holds each piece of
such a read under five seconds ("Tests"). A piece that runs longer is a defect in the reader or in
acceptance, fixed there by cutting the piece where it is long, and never a reason to lower the cap.

**Memory at the cap.** Three bounds are real, because each is enforced: a body is at most 16 MiB,
so the two bodies of one read, the application resource and the source, are at most 32 MiB of
text; the files in flight are at most 64 MiB and in a create the kept files at most 200 MiB (3.4);
and the table rows are at most what part 11's caps admit (3.5). What the reader makes of a body is
not a bound from the body's size and is written here as none: the size of a parsed JSON value
beside its text, of the Nova document and its batch, of one form's XML as a tree, of acceptance's
emission and re-read. There is no wide margin to lean on either. The 200 MiB that one publish of
an app at Nova's media ceiling already holds in this process is about six times the two bodies at
the cap, and nothing measured says the reader's own values stay under six times their text. So
this part does not say that an app at the cap costs less memory than its files do.

What the decision rests on is the three bounds themselves. Every input of a request is bounded
before it is held, so what a request holds is some multiple of bounded inputs and never follows an
app past them. The cap is a refusal threshold thirty-two times HQ's largest starter app (part 05,
section 3.3), and the ordinary app's source is half a megabyte or less ("Executed during
planning"). So nothing is divided: the service's memory is not divided, pinned or named anywhere.
And no test is written: the ordinary test run cannot force a collection to measure what the
reader holds (`vitest.config.mts` passes no `--expose-gc`).

**What the person reads.** The circumstance `too-large` (part 01, sections 8.3 and 9.3) has one
cause, a body over the bound, and carries no `detail.name`. It is answered as an account of that
one finding. Part 01's block promises no update, because nothing plans one, and offers a step the
person can take today. Where the app's name is not known, because the application resource was the
body over the bound, the account's `appName` is null and the block's `{app}` reads "This app" (part
01's `circumstanceBlock`, its section 8.4).

### 3.7 How long it takes

Three assumptions, each unmeasured ("Written and not yet run"): a CommCare HQ JSON read for an app
the size of HQ's starter apps answers in 1 to 2 seconds, a small media file answers in about half a
second, and a large one moves at about 2 MiB a second on each of four connections.

The ordinary read is four JSON calls one after another (the resource, the source, the counter, the
table list), then 7 to 13 files four at a time, then the processing:

    4 calls x 1 to 2 s             = 4 to 8 s
    13 files / 4 at a time x 0.5 s = about 2 s
    reader and acceptance          = under 1 s
    total                          = about 6 to 11 s

A create is the same again, plus one upload and one row a file, two files at a time (6.1), plus the
birth: a few seconds more.

An app at the media ceiling is slow because of the network. By count, 500 files four at a time at
half a second is about a minute. By bytes, 200 MiB over four connections is 25 seconds. So about
a minute to a minute and a half in each request, and four to six minutes if CommCare HQ is four
times slower than assumed. The count says so as it moves, and the request has room for it: the
service's request ceiling is 3,600 seconds
(`config/runtime-capabilities.json::cloudRunRequestSeconds`).

What the person sees while it runs is part 13's (its sections 5 and 9.1), from two things this part
sends: the stage that is running, by name, and a count of files that moves (4.3).

### 3.8 What each circumstance answers

The rule is one line: a circumstance a read raises is answered as a stop where its
`CIRCUMSTANCE_STANDINGS` entry is `stop`, and inside an account otherwise. At a create the fresh
read's stop that is a fact about the HQ app is answered `changed` with that stop; any other stop is
answered `held`, because the person can clear it and create again with the review they hold. An
account is answered `changed` with the account (5.3, step 5).

| Code | Raised by | A read answers | A create answers |
|---|---|---|---|
| `not-connected` | `getHqCredentials` | a stop | `held` |
| `key-cannot-reach-space` | `getHqCredentials` | a stop | `held` |
| `key-not-accepted` | any read, through `hqReadCircumstance` | a stop | `held` |
| `plan-lacks-api-access` | the application resource | a stop | `held` |
| `not-a-member` | a 403 the app list confirms; the flag read (step 3) | a stop | `held` |
| `cannot-edit-apps` | the source read; a table's rows | a stop | `held` |
| `cannot-access-apis` | the application resource; the table list | a stop | `held` |
| `app-gone` | `readHqAppForReading`: `gone` | a stop | `changed`, with the stop |
| `app-deleted` | `deleted` | a stop | `changed`, with the stop |
| `linked-app` | `linked` | a stop | `changed`, with the stop |
| `remote-app` | `remote` | a stop | `changed`, with the stop |
| `rate-limited` | any read, after its waits | a stop | `held` |
| `hq-unavailable` | any read: no answer in time, or one Nova cannot read | a stop | `held` |
| `changed-while-reading` | this part: the second `changed` of one request | a stop | `held` |
| `already-in-nova` | `readHqAppClaims`; `HqAppAlreadyClaimedError` at the birth | a stop | `changed`, with the stop, unless the holder is this reading's own app, which is `created` (6.6) |
| `hq-gateway-refused`, `api-cut-off`, `browser-only` | any read | a stop | `held` |
| `cannot-read-organization` | the level or the place read | a stop | `held` |
| `too-large` | a body of the app's read over the byte bound (3.6) | an account | `changed`, with the account |
| `menu-unreadable-in-hq`, `app-unreadable-in-hq` | `notSummarizedMenus` | an account | `changed`, with the account |
| `shadow-disagrees`, `unrecognized`, `no-platform-runs-everything` | the reader (part 06) | an account (`unrecognized` logged at error) | `changed`, with the account |
| `read-back-differs` | acceptance; the reader's contract error; the birth's own checks (6.5) | an account, logged at error | from the fresh read, `changed` with the account; from the birth, `check-failed` |
| `media-file-unreadable` | part 11's `readingMediaFindings`: its rule for a drawn slot whose file is missing (its 3.2, row 3) | an account | `changed`, with the account |
| `media-not-played-where-app-runs` | part 11's `readingMediaFindings` | an account | `changed`, with the account |
| `places-over-nova-limit`, `place-not-holdable` | part 11's `readingProjectDataFindingsFor` | an account | `changed`, with the account |
| `table-rows-unreadable` | part 11's `readingProjectDataFindingsFor`, from a rows read | an account | `changed`, with the account |
| `table-cell-unrepresentable`, `table-choices-unusable` | part 11's `readingProjectDataFindingsFor` | an account | `changed`, with the account |
| `owner-rule-needs-one-place` | part 11's `readingProjectDataFindingsFor` | an account | `changed`, with the account |

Together the rows hold every code of part 01's `READ_CIRCUMSTANCES` (34), each answered by the
standing its `CIRCUMSTANCE_STANDINGS` gives it (part 01, section 8.3).

`held` is a create's answer and nothing more: it carries the circumstance for the page to show, and
since nothing is stored there is nothing it could have changed. The review the person holds still
stands, and they answer it again once the circumstance is cleared.

---

## 4. Transport

### 4.1 The two routes

| Route | File | Body | Calls |
|---|---|---|---|
| `POST /api/commcare/bring-in/read` | `app/api/commcare/bring-in/read/route.ts` | `readingKeySchema` (3.1) | `readHqAppForReview`, with `cancel: req.signal` |
| `POST /api/commcare/bring-in/create` | `app/api/commcare/bring-in/create/route.ts` | `bringInInputSchema` (5.3) | `createFromReview`, with no `cancel` |

`lib/hostnames.ts::HOSTNAME_ALLOWLIST` holds `"/api/commcare"` for the main host and
`isPathAllowedOnHost` matches by path segment, so no allowlist entry is added and neither route is
reachable on the MCP or the docs host. A test holds both ("Tests"), because a route that works on
localhost and 404s in production is this repo's most common deploy surprise. Neither route exports
`maxDuration`, as `app/api/commcare/upload/route.ts` exports none: the service's request ceiling is
what bounds a request (section 1).

Each route is a thin shell, in two halves.

**Before the stream opens**, as `app/api/commcare/upload/route.ts` does:
`lib/auth-utils.ts::requireSession(req)`; a strict Zod parse of the JSON body through
`lib/apiError.ts::readJsonBody(req, HQ_READING_REQUEST_MAX_BYTES)`; `domain` held to
`lib/commcare/client.ts::isValidDomainSlug`, as the publish route holds it; and
`authorizeBringIn(userId, projectId)`. `HQ_READING_REQUEST_MAX_BYTES = 16 * 1024` is a new constant
of `lib/apiError.ts`, beside `PRESENCE_REQUEST_MAX_BYTES` and with its line in that file's list of
budgets: the larger body is `BringInInput`, a key, a digest, a name and a few answers. A refusal
here is ordinary JSON with a status:

| Status | When | Body |
|---|---|---|
| 401 | no session | `handleApiError`'s `{ error }` |
| 413 | a body over the bound | `handleApiError`'s |
| 499 | the client went away while its body was being read | `handleApiError`'s client-abort arm |
| 400 | the body fails its schema, or `domain` is no project space slug | `{ error, code: "invalid_input" }` |
| 403 | `authorizeBringIn` answers null | `{ error, code: "no_project_access" }` |

`error` is the sentence of "Copy" (C1) and `code` the `ReadingRefusal`, so the page branches on the
code and shows the sentence. A 400's Zod issue is logged with `log.warn("[reading] request
refused")` and is not in the body.

**Then the stream** (4.3): the route answers 200 with the stream as its body and calls the service
function inside it, handing it an `onEvent` that writes one line. A stop, an account, a review and a
create that did not create are all answers on the last line, never statuses, as a refused publish
is 200 with its deployment. Anything thrown inside the stream that is no answer is a `failed` line
and a log (10).

One table gives a refusal its status, for the two refusals a route can meet before its stream and
for the five that only ever ride a `CreateAnswer`:

```ts
// lib/deployment/reading/types.ts
export const READING_REFUSALS = ["no_project_access", "invalid_input", "name_missing",
	"choice_not_offered", "choice_missing", "project_changed", "app_unavailable"] as const;
export type ReadingRefusal = (typeof READING_REFUSALS)[number];
export const READING_REFUSAL_STATUS = {
	no_project_access: 403, invalid_input: 400,
	name_missing: 200, choice_not_offered: 200, choice_missing: 200, project_changed: 200,
	app_unavailable: 200,
} as const satisfies Record<ReadingRefusal, 200 | 400 | 403>;
```

`no_project_access` is met twice: by the route, before the stream, as the 403; and by the birth,
whose own check of `edit` can refuse after the stream is open (6.5), where it rides the last line
as a `refused` answer. An MCP tool calls the functions and no route, and reads the same refusals
(4.4).

The picker's reads (`listHqApps`, `probeHqApiAccess`, `readHqAppClaims` over a list) are part 13's
transport (its section 4.2).

### 4.2 Why routes, and not Server Actions

Next dispatches a client's Server Actions one at a time: "If a user triggers three actions in quick
succession, the second waits for the first to finish"
(`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, "Sequential dispatch on the
client"). A read of an app with hundreds of files is a minute or more (3.7). As an action it would
hold every other action of the page behind it, and an action returns once, so it could carry no
count as it moved. A route is a plain `fetch`: its body can be read as it arrives, its arguments are
JSON by construction (the WAF rule that refuses a multipart action body never sees it), and it is
the shape a publish already has.

### 4.3 The stream

Both routes answer `Content-Type: application/x-ndjson; charset=utf-8` with `Cache-Control:
private, no-store`, one JSON object a line:

```ts
// lib/deployment/reading/types.ts
export const READING_STAGES = ["connecting", "reading-app", "reading-project-data", "checking",
	"checking-media", "bringing-in-media", "creating"] as const;
export type ReadingStage = (typeof READING_STAGES)[number];

export type ReadingEvent =
	| { readonly type: "stage"; readonly stage: ReadingStage }
	/** With `checking-media` and `bringing-in-media`: files that have a verdict, or are published,
	 *  of those planned. */
	| { readonly type: "files"; readonly done: number; readonly total: number }
	/** Always the last line. */
	| { readonly type: "done"; readonly answer: ReadingAnswer | CreateAnswer }
	/** Always the last line: something was thrown that is no answer. It is logged (10). */
	| { readonly type: "failed" };
```

A read's stream names `connecting`, `reading-app`, `reading-project-data`, `checking`,
`checking-media` with its count, then `checking` again. A create's names the same six, then
`bringing-in-media` with its count, then `creating`. A stage with nothing to do is not named: an
app with no files names neither media stage. `gatherReading` emits the stage and file events (3.3);
the route writes the one `done` or `failed` line.

**Why a stream and not a poll.** Nothing is stored, so there is nothing to poll. The count has to
ride the one request that is doing the work, and lines on its own response body are the smallest
thing that carries it. `app/api/media/[assetId]/extract/route.ts::POST` already answers this way,
so the shape is known to pass the proxy and the platform. Where a line is late the answer still
arrives whole and only the count stands still.

**A write to a stream whose client has gone is dropped and never fails the work.** For a read the
work then stops by `cancel` (3.2). For a create it runs on (6.1).

```ts
// lib/deployment/reading/stream.ts (client-safe; pure but for the response it is handed)
/**
 * Reads a bring-in route's response body line by line, calls `onEvent` for each stage and file
 * event, and resolves with the last line's event. It resolves `{ type: "lost" }` where the body
 * ends with no `done` or `failed` line, or a line is no JSON object of a known `type`.
 */
export function readBringInStream(
	response: Response,
	onEvent: (event: Extract<ReadingEvent, { type: "stage" | "files" }>) => void,
): Promise<Extract<ReadingEvent, { type: "done" | "failed" }> | { readonly type: "lost" }>;
```

It is the one client-side reader of the stream. A stream that ends with no last line is a lost
request: the instance ended, or the network did. Section 8 says what the page does with `lost` and
with `failed`.

### 4.4 What an MCP call is given

Part 13 registers the tools (its section 14.1): `read_hq_app` calls `readHqAppForReview` and
`bring_in_hq_app` calls `createFromReview`, each after `authorizeBringIn`, and each answers part
13's projection of the answer (its 14.3 and 14.4) with the sentences of "Copy". The tools' inputs,
descriptions, paging and scopes are part 13's. What this part gives a tool call is three things.

**No deadline of Nova's own.** Nothing enforces a length on an MCP call but the service's request
ceiling of 3,600 seconds: `app/api/mcp/dispatch.ts::MCP_MAX_DURATION_SECONDS` and
`app/api/mcp/route.ts::maxDuration` are 300, and nothing at run time reads either ("Executed during
planning"). A timer of Nova's own under that 300 would throw away a create that was about to
finish, only for the client's retry to fetch the files again. There is none. The two comments are
corrected, since both describe a limit that is not there: `app/api/mcp/route.ts` calls its
`maxDuration` "the only enforcement", and `app/api/mcp/dispatch.ts` calls the 300 a "ceiling". Each
is reworded to what `app/api/chat/route.ts` says of its own ("Contracts"). No value changes.

**The caller's own cancellation.** `lib/mcp/context.ts::McpCallExtra`'s `mcpReq` gains `signal?:
AbortSignal` beside `notify`, the SDK's own field for a request its sender cancelled. `read_hq_app`
passes it as `cancel`, as the browser's read passes `req.signal`, so a read the client gave up on
stops at its next call. `bring_in_hq_app` passes none, as the browser's create passes none: once
asked, it runs to its end. A client that stopped waiting calls again with the same arguments, and
that call answers the app if it was created and creates it if it was not (6.6).

**Progress, through the one event sink.** An MCP client built on the SDK's defaults stops waiting
for a call after 60 seconds unless progress resets its timer. The ordinary read is well inside
that. A read of an app with hundreds of files is not (3.7), and a client that timed out would call
again, fetch every file again and time out again. So both tools report progress through what Nova
already has, `lib/mcp/progress.ts::createProgressEmitter`, and they hand the service the same
`onEvent` the routes hand it, so no second path exists:

```ts
// lib/mcp/progress.ts
export type ProgressStage =
	| /* today's eleven tags */
	| "hq_connecting" | "hq_reading_app" | "hq_reading_project_data" | "hq_checking"
	| "hq_checking_media" | "hq_bringing_in_media" | "hq_creating";

/**
 * The `onEvent` an MCP tool hands a bring-in. A `stage` event sends one notification, tagged
 * `hq_` and the stage with its hyphens as underscores, its message the stage's label
 * (`READING_STAGE_LABELS`, "Copy", C4). A `files` event sends one under the tag of the stage last
 * named, with `done` and `total` as `extra`, at most one a second, and always the one whose
 * `done` is `total`. `done` and `failed` events send nothing: the tool's result says them.
 */
export function readingProgressSink(
	emitter: ProgressEmitter, now?: () => number,
): (event: ReadingEvent) => void;
```

The upload's three tags are already outside the build's chapter vocabulary, so the seven follow
the file as it is. A call with no progress token sends none: the emitter is a no-op, as today.

---

## 5. The review, its digest, and the create

### 5.1 The review

```ts
// lib/deployment/reading/types.ts
import type { Platform, PlatformFeatureId } from "@/lib/domain";
import type { DeploymentConfirmationKey } from "@/lib/deployment/types";
import type { FirstPublishView } from "@/lib/publish/firstPublishChangeIds";
import type { KeptLabelId } from "@/lib/publish/keptValues";
// Declared once, by part 11, in its client-safe module (below).
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
	/** CommCare HQ's `cloudcare_enabled`. */
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
is `zod`. `types.ts` re-exports both, and `lib/deployment/index.ts` re-exports them from there.
Their members are the ones the review needs: for a table, its `tag`, its `standing` (`"new" |
"same-managed" | "same-equal" | "choice"`), `hqDigest` (the digest of CommCare HQ's columns and
rows), `projectTable` (`{ tableId, definitionRevision, rowsRevision }` of the Project table it met,
the two revisions as decimal text, or null for `new`), and for a `choice` its `differs`, the `apps`
that read the Project's table and each answer's offer (`options`); for the places, `count` and
`digest` (`ManagedPlacePlan.digest`).

Where each field comes from, in `gather.ts`, after acceptance:

| Field | From |
|---|---|
| `appName` | `HqAppSource.name` (part 05, section 7), or the empty string where CommCare HQ sent none. Where it is blank the person types one (`name_missing` until they do) |
| `readAt` | the clock when `readHqAppForReading` answered `read` (`Fetched.readAt`) |
| `creates` | the document: `moduleOrder.length`, the count of `forms`, the count of `fields`, `caseTypes`' names sorted, `localization`'s wire codes with the default first, and the number of the plan's files whose verdict is `held` |
| `runsOn` | `AcceptedReading.declarations`, one `ReadingDeclarationChoice` each, in order, each with its `firstPublish`; `gather.ts` filters none. The narrowing by files is done once, before acceptance, as `AcceptReadingInput.choices` (3.3, step 8.3). `runsOnlyOn`, `splitDatetime`, `preselected` and `firstPublish` are the `AcceptedDeclaration`'s at the same position. `recordedFeatures` is `lib/deployment/adoption.ts::adoptionPlanFeatureConfirmations` (part 10, 6.5) over the document under that declaration's `mutations`, the target, `source.cloudcareEnabled` and `AcceptedReading.sourceHoldsSaveToCase`. At least one remains: where the content runs nowhere the reader gave `no-platform-runs-everything`, and where no remaining platform plays a file part 11 gave `media-not-played-where-app-runs`, and either is an account |
| `runsOnWhy` | `web-apps-off-in-hq` where the draft's `narrowedByHq` is true and the proposal stands, `keeps-web-apps` where `keepsWebApps` is true and the proposal stands, and `content` otherwise, including where part 11's files removed the proposal. The proposal stands where the choice at the draft's `proposed` index is the preselected entry of `runsOn` |
| `webAppsOnInHq` | `draft.facts.webAppsOnInHq` (part 06, section 17.3) |
| `datetimeQuestions` | the count of date-and-time questions a splitting choice changes: `splits.length` of a choice of `AcceptReadingInput.choices` whose `split` is true (every such choice splits the same questions); 0 where no choice splits |
| `platformsOut` | one entry per platform no offered choice declares, in `PLATFORMS`' order: `features` the distinct features of `platformUses.ts::unavailableUses(doc, [platform])` in table order, and `media` true where `readingMediaFindings().playsOn` leaves the platform out |
| `kept` | `keptListFor(facts)` (part 01, section 6.1), `facts` being `targetFactsFromSource` over the source as the adopted baseline will store it, with `observedAt` the read's `readAt`, `adopted: true` and `novaOwnsAutoGpsCapture` the `autoGpsCapture` of the ownership part 10's `adoptedAppBaselineWrite` gives that baseline (its 6.3); the empty list where the answer is null |
| `tables`, `places` | `projectDataReview(data, reads, doc, mintingResolver(appId))` (part 11, 14.1) |
| `mediaLeftOut` | `HqMediaPlan.inert.length` |
| `firstPublish` | `AcceptedReading.firstPublish`, the preselected declaration's |

The review holds no sentence: part 13 words it from these values and the copy tables of parts 01,
09, 10 and 11. Nothing parses a review at run time: the server builds the typed value, digests it
whole (5.2) and sends it, so a field added to the type is in the digest by construction.

### 5.2 The digest

```ts
// lib/deployment/reading/digest.ts
export interface ReviewDigestInput {
	readonly v: 1;
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

**What it leaves out.** `readAt`, so the same app read a minute later has the same digest. CommCare
HQ's save counter, so a save that changed nothing Nova reads does not send the person back to the
review. The person's choices, which are made after it and validated against `review.runsOn` and
`review.tables`; what each choice would do is in the digest, as the option it answers. And the
surface manifest's revision (Departure 21): a deploy between the two requests changes the digest
only where it changes what this app's review or document holds.

**Why it is the same number in both requests when nothing changed.** The ids are derived from the
same `readingId` (2.3). A file is named by the SHA-256 of its bytes, which the create computes from
the bytes it fetched itself. And no answer the review offers changes the digested document.

**No choice changes the digested document.** The digest is made at the review, before any answer,
and compared at the create, after them, so the document it covers must be the same under every
answer the review offers. Three kinds of answer exist, and each is held to that:

- **The name.** `document` is the reader's document, which carries CommCare HQ's name. The name the
  person chose is applied to the candidate after the comparison (6.2).
- **The declaration.** That document is also before any choice's mutations. Each offered choice is
  in `review.runsOn`, and its mutations are a function of the document
  (`lib/doc/platformDeclaration.ts::planDeclarationChoices`, part 06), so an equal document and an
  equal `runsOn` give equal mutations.
- **A table's answer.** A table that asks a choice is read, before and after the answer, under one
  binding: the Project table's id, its columns by field name, and derived ids (2.3) for the fields
  it lacks. That is the binding part 11 gives a `choice` tag before any answer and the one
  `use-commcare-hq` keeps (its 7.4 and 7.2). `use-project` gives the Project table as it is, and is
  offered only where the app reads no field that table lacks, so for every field the reader binds
  it gives the same column ids. The document is therefore one document under no answer and under
  either, which is part 11's rule too ("No answer moves a binding the reader read", its 7.4;
  Departure 13 here gives the evidence). The create holds it before it publishes a file (5.3, step
  6).

**Media ids.** A file's asset id is not stable across the two requests. In a read, and in a create
until its publish, it is the provisional id, a name the reading gives the file before any asset
exists. After the publish it is the published file's, which may be one the Project already held.
So the digest never sees an asset id:

```ts
// lib/deployment/reading/mediaIds.ts
import type { HqMediaType } from "@/lib/commcare/hq/appSource"; // part 05, section 7

export const READING_MEDIA_NAMESPACE = "4374916f-4ced-42c6-b00d-f7fb7b45aaaf";
/** UUIDv5 under `READING_MEDIA_NAMESPACE` of
 *  `canonicalJsonText([appId, mediaType, multimediaId])`. */
export function provisionalReadingMediaId(
	appId: string, mediaType: HqMediaType, multimediaId: string,
): MediaAssetId;
/** UUIDv5 under the same namespace of `canonicalJsonText(["content", contentHash])`: one id per
 *  file content. `contentHash` is the SHA-256 a held file's verdict carries. */
export function reviewMediaId(contentHash: string): MediaAssetId;
```

`document` is `canonicalJsonDigest(remapAssetRefs(persistable, map))`, where `map` sends each asset
id the document holds to `reviewMediaId` of that file's content hash, from its `held` verdict.
`mediaPaths` is `assignMediaPaths` (part 10, 4.2) run over the files with each `assetId` already
set to `reviewMediaId(contentHash)`, not a remap of the real assignment: two media documents of
CommCare HQ's that hold the same bytes are two files with two provisional ids at the review and one
ready file at the birth, and the assignment collapses paths per asset, so only an assignment keyed
by content is the same at both moments. It is also the assignment the birth will write, up to the
ids' names, so what part 09's register says of collapsed and re-derived paths at the review is what
happens. `lib/domain/mediaRefs.ts::remapAssetRefs` is the production rewrite the Project move uses,
which touches every slot `walkAssetRefs` reads; built-in icon refs fall through unchanged. A digest
is computed only where every file the document names has a `held` verdict (3.3 answers an account
otherwise, and a missing file on a slot no platform draws is in no document), so every id has a
hash.

**Lookup ids need no such step.** A tag binds to the Project's own table where it meets one and to
its derived ids otherwise (2.3). Both are the same at the review and at the create unless the
Project's tables changed in between, which is a change the person must see and which
`review.tables` holds; and no answer moves a binding the reader reads, by the rule above.

### 5.3 The create, in order

```ts
// lib/deployment/reading/types.ts
/** The UUIDv7 layout: the same expression as `lib/domain/lookupIds.ts::LOOKUP_UUID_V7_PATTERN`. */
export const READING_ID_PATTERN: RegExp;

export const bringInInputSchema = z.strictObject({
	projectId: z.string().min(1).max(255),
	server: z.enum(COMMCARE_SERVER_IDS),
	domain: z.string(),
	remoteAppId: z.string().regex(/^[\w-]{1,255}$/),
	/** The reading the person reviewed. */
	readingId: z.string().regex(READING_ID_PATTERN),
	/** The digest of the review the person is answering. */
	reviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
	appName: z.string(),
	runsOnlyOn: z.enum(PLATFORMS).nullable(),
	splitDatetime: z.boolean(),
	/** The answer for each table whose review entry asks a choice, by tag (part 11, 7.2). */
	tableChoices: z.record(z.string(), z.enum(LOOKUP_TABLE_CHOICES)),
});
export type BringInInput = z.infer<typeof bringInInputSchema>;

export type CreateAnswer =
	| { readonly kind: "created"; readonly receipt: AdoptedAppReceipt }
	/** The app or the Project is not what was reviewed. `now` is where it stands. */
	| { readonly kind: "changed"; readonly now: ReadingAnswer }
	/** A Project table changed under the birth. The caller reads the app again. */
	| { readonly kind: "read-again" }
	/** One of Nova's own checks stopped the create though the review matched. */
	| { readonly kind: "check-failed"; readonly finding: CircumstanceFinding }
	/** A stop the person can clear. The review they hold stands. */
	| { readonly kind: "held"; readonly finding: CircumstanceFinding }
	| { readonly kind: "refused"; readonly refusal: ReadingRefusal };

// lib/deployment/reading/create.ts
/** One whole create. It takes no `cancel`: once asked, it runs to its end (6.1). */
export function createFromReview(
	actor: BringInActor, input: BringInInput,
	options: { readonly onEvent: (event: ReadingEvent) => void },
): Promise<CreateAnswer>;
```

It re-reads and re-checks everything: nothing the client sends is trusted to say what CommCare HQ
holds. And it adds nothing to the Project until it knows it will create. Before step 1 it holds
`input.projectId` to `actor.projectId`, as `gatherReading` does (3.1).

1. **The app's id.** `appId = broughtInAppId(actor.userId, key, input.readingId)`, `key` being the
   input's four key fields.
2. **Has this create already happened?** One read of `apps` by `appId`. A row there is this
   person's own earlier create of this same reading (6.6): the answer is `created`, with the
   receipt read back, before any call to CommCare HQ.
3. **The name.** `appName.trim()` is 1 to 255 characters, else `refused: name_missing`. That needs
   no read of CommCare HQ, so it comes before one.
4. **The read, again.** `gatherReading` with `keepMedia: true`: the steps of 3.3 exactly as a read
   runs them, with the same provisional media ids, the same stages and the same results. The one
   difference is that the bytes of each held file stay in the request's media plan (6.1). Nothing
   is published here.
5. **By its result:**

   | The fresh read gives | The create answers |
   |---|---|
   | a stop that is a fact about the app (`app-gone`, `app-deleted`, `linked-app`, `remote-app`, `already-in-nova`) | `changed`, `now` the stop |
   | any other stop (the connection, the key, access, a slow or throttled CommCare HQ, `changed-while-reading`) | `held`, with that finding |
   | an account | `changed`, `now` the account |
   | a review whose digest is not the one sent | `changed`, `now` that review, under the same `readingId` |
   | a review whose digest is the one sent | go on |

6. **The person's answers, against the fresh review**, which is now known to be the one they saw.
   `(runsOnlyOn, splitDatetime)` is a member of `review.runsOn`, else `refused:
   choice_not_offered`. The table answers go through part 11's
   `resolveTableChoices(review.tables, input.tableChoices)` (its 14.1): an answer it lists as
   `unknown` (the tag is no `review.tables` entry that asks a choice) or `notOffered` (the offer is
   `offered: false`) is `refused: choice_not_offered`, and a tag it lists as `missing` is
   `refused: choice_missing`. The page stops a missing answer before it sends (part 13, section
   8.9); the server holds the same rule for every other caller.

   Then the bindings. `gatherReading` bound every table with no answer. Part 11's pure
   `underTableChoices(fetched.data, choices)` (its 14.1) gives the same data with each answered
   table bound as its answer says, and each `choice` table's binding there must hold the same
   table id and, for each field the reader bound, the same column. The comparison is one pure
   function of `create.ts`, so a plain test holds it ("Tests"):

   ```ts
   type GatheredTables = ReadingProjectData["gathered"]["tables"];
   /** How many `choice` tags hold, under the answers, another table id than as read, or another
    *  column for a field the reader read. A column of a field the reader did not read is not
    *  compared. 0 where no answer moved a binding. Pure. */
   export function movedBindingCount(
   	read: GatheredTables, answered: GatheredTables,
   	lookupFields: ReaderProjectDataReads["lookupFields"],
   ): number;
   ```

   Where it answers more than 0, an answer moved a binding the reader read, which part 11's rule
   and its offers rule out: the answer is `check-failed`, the finding `read-back-differs` with
   `detail.name` `birth-bindings`, logged with the count (6.5; "Copy", C8). The data under the
   answers is what steps 8 and 9 read. It is computed in memory; nothing is read.

   Any answer of steps 5 and 6 but "go on" drops the kept bytes. Nothing was published, so nothing
   was added to the Project.
7. **Publish** (`bringing-in-media`). Part 11's `publishKeptReadingMedia` publishes each held file
   from the bytes in hand (6.1). An app that references no file skips this step.
8. **The check once more, over exactly what will be born** (`creating`). `checkFetched` over step
   4's `Fetched`, with its data under the answers, and the published plan: the reader, part 11's
   findings, acceptance, the review and its digest run again. Nothing is fetched. Two things can
   differ from step 4's run, and this run is what judges them:

   - **The published ids.** The media index now names each held file by its published asset. Two
     files of CommCare HQ's that hold the same bytes are two provisional ids and one published
     file, and the path assignment collapses per file (5.2), so the emission under the final ids
     is not always the emission under the provisional ones.
   - **A table the person chose to keep as the Project has it.** No answer moves a binding, so the
     document is the same document. `use-project` does change what stands behind the tag: the
     Project's own columns, with their types, and the Project's own rows, where step 4 judged
     CommCare HQ's (part 11, section 14.1). Part 11's findings and acceptance's gate and export
     readiness read those rows.

   The digest names a file by its content and a table by what the review showed of it, so it must
   again be the one the person sent, and the run must again be clean. Where it answers anything
   else, Nova has a defect, in this part or in an offer part 11 made: the answer is `check-failed`,
   `detail.name` `birth-integrity`, logged (6.5).

   An app that references no file, created under answers that keep no table as the Project has
   it, skips this step: step 4's run already judged exactly what will be born.
9. **The birth.** The candidate, the adopted deployment's write and the one transaction (6.2, 6.3),
   from step 8's run, or from step 4's where step 8 was skipped.
10. **Before any answer but `created`**, one more read of `apps` by `appId` (6.6).

The digest is compared after a full reader and acceptance run on the fresh read, never before.
Equal digests mean the document, the ids, the paths, the project data and the review are the ones
the person saw.

---

## 6. The `hq-adoption` birth

`createFromReview` continues from 5.3 with a clean read whose digest is the person's and with
answers the review offers.

### 6.1 Media is published once the create will create

Three facts put the publish where it is (5.3, step 7): after the digest and the answers have
passed, and before the candidate is prepared.

- **Bytes cannot join a Postgres transaction**, and the birth's own media admission
  (`lib/db/canonicalCommitKernel.ts::admitExactMediaReferences`) locks ready rows. So the files are
  ready rows before the transaction opens. `lib/db/CLAUDE.md` says the same of a Project move:
  "Media byte copies are the only non-destructive pre-transaction work". A Project move makes its
  copies once it is going to move. A create publishes once it is going to create.
- **The id a reference ends up naming is known only once a file is published.** Publication runs
  under the Project and content-hash lock and adopts a ready file where the Project already holds
  the same bytes (`lib/media/CLAUDE.md`), so the document must be read again under the published
  ids (5.3, step 8) before a candidate exists.
- **A create that is turned back must add nothing to a Project.** Every `held` answer, every
  `changed` answer that comes from the fresh read, and every refusal of the person's answers come
  before the publish (5.3, steps 5 and 6). So a create sent with a made-up `readingId`, an empty
  name, a digest that no longer holds or an answer the review never offered puts no file in the
  Project.

The publish is one call of part 11's, `publishKeptReadingMedia({ projectId, actorUserId, plan,
onProgress })` (its section 4.1): each held file is published from the bytes the request kept, as
an ordinary ready file of the Project, found or made by Project and content hash, two at a time.
The plan records each file's asset and drops its bytes. `onProgress` becomes a `files` event under
the stage `bringing-in-media`. What it throws is answered here:

| Thrown | Means | The answer |
|---|---|---|
| part 11's `MediaPublishPermissionError` | the person lost `edit` in the Project since the request's own check | `refused: no_project_access` |
| anything else | storage or Postgres failed | thrown on: the stream ends in a `failed` line (4.3), and a retry finds what was published by its hash |

**A create is not given the request's signal.** Once a person has chosen Bring it in, the work runs
to its end even if the tab closes, as `app/api/media/[assetId]/extract/route.ts` runs its work past
a disconnect. Where it finishes, the app is in the person's apps. That an instance with no open
request is kept long enough to finish is not known ("Written and not yet run"), so part 13's screen
promises only what holds either way (its "Copy").

**Nothing is half-made.** No app, table, place, deployment or claim exists until the one
transaction commits (6.3).

**What can exist without the app** is files in the Project's library, and only where a create ended
after its publish: the connection or the instance was lost, the birth was refused (`read-again`,
`refused: project_changed`, `check-failed`, another app's claim, lost edit access), or step 8 found
Nova's own defect. They are ordinary ready files that no app references, visible in Files and
removable there by anyone with `edit`. The leads of `read-again`, `check-failed` and `changed`
with `already-in-nova` say they stay ("Copy", C2), and `project_changed`'s sentence says the next
create adds its file back (C1). A person who lost edit access is told that and nothing of files
(C1, `no_project_access`): the files stay, and the Project's editors see them in Files. Nova
sweeps none, for the reason part 11 gives (its section 4.2).

**What a retry reuses.** Each file already in the Project's library is found by its content hash
and is not uploaded again. It is fetched from CommCare HQ again, because only its bytes say what
its hash is.

**Weighed and not taken: keeping the bytes between the two requests**, so that a create need not
fetch them again (Departure 18).

### 6.2 The candidate, and one seam in the tail

**The construction batch** is the reader's batch (`Gathered.draft.batch`), then the mutations of
the declaration the person chose (the `AcceptedDeclaration` of `gathered.accepted.declarations`
whose `runsOnlyOn` and `splitDatetime` are the input's: its `mutations`, which are part 06's for
that choice, a `setAppSettings` where it narrows and then each split's mutations, in the order
`planDeclarationChoices` gives them), then `{ kind: "setAppName", name: input.appName.trim() }`
where that differs from the document's. `gathered` is the run the birth is made from (5.3, step
9), so the batch names final asset ids. The birth diffs nothing itself: the reader hands over the
batch with its document (part 06, section 2.2, `ReadDraft.batch`), so this part holds no second
derivation of the document to prove equal to the first (Departure 9).

```ts
const candidate = prepareGenesisCandidate({
	appId,                    // broughtInAppId(...), 2.3
	projectId: key.projectId,
	mutations: batch,
});
```

It is prepared once, outside the retryable transaction, with the bindings' lookup ids (the
Project's own, or the derived ones). A serialization retry of the transaction reuses it, as
`createExplicitBlankApp`'s does.

The declaration's mutations and the name are applied after acceptance judged the reader's document,
and acceptance has already judged them: a read is clean only where the document under each offered
declaration's mutations passes the gate and export readiness (part 09, section 4), and the one
rule the gate holds a name to is that it is not blank (`EMPTY_APP_NAME`,
`lib/commcare/validator/rules/app.ts`), which 5.3's step 3 already required. So the candidate is a
document acceptance passed, under a choice acceptance passed.

**The adopted deployment's write** is assembled once, beside the candidate:

```ts
// lib/deployment/reading/birth.ts
export function adoptedDeploymentWrite(input: {
	readonly appId: string;
	readonly key: ReadingKey;
	readonly actorUserId: string;
	readonly gathered: Gathered;
	/** The declaration the person chose, from `gathered.accepted.declarations`. */
	readonly chosen: AcceptedDeclaration;
	readonly candidate: PreparedGenesisCandidate;
}):
	| { readonly ok: true; readonly write: Omit<AdoptedDeploymentWrite, "at"> }
	/** `adoptedIdentityRows` answered `ok: false` (6.5). */
	| { readonly ok: false };
```

Every field of part 10's type (its 6.2), and where it comes from:

| Field | Value |
|---|---|
| `appId`, `projectId`, `actorUserId` | `appId`, `key.projectId`, the person |
| `target` | `{ server: key.server, domain: key.domain }` |
| `remoteAppId` | `key.remoteAppId` |
| `remoteRevision` | `gathered.fetched.hqVersion`: the save counter this create's own bracketed read held, never one the review was made at. The digest leaves the counter out (5.2), so a save in CommCare HQ that changed nothing Nova reads lets the review stand; recording an earlier counter beside the create's baseline would then make the first publish's drift check see a change since the baseline and stop for nothing |
| `pushedRevision` | 1, the birth's sequence |
| `identities` | `adoptedIdentityRows(gathered.draft.identities, gathered.fetched.modules)`'s `rows` (part 10, 3.1), the rows the digest covered (3.3, step 9) |
| `baseline` | `adoptedAppBaselineWrite({ remoteAppId, source, prepared, target, identity, novaRevision, mediaFiles, observedAt, firstPublish })` (part 10, 6.3; `firstPublish` is part 09's input, its 12.3): `source` is `gathered.fetched.source`, `identity` `targetWireIdentity(rows)`, `novaRevision` 1, the birth's sequence, `mediaFiles` part 15's `hqMediaRecordFromSource` over the wire paths of the `mediaPaths` rows below and `gathered.fetched.source.multimediaMap` (`15-changes-made-in-commcare-hq.md`, section 7.8), `observedAt` `gathered.fetched.readAt`, and `firstPublish` `chosen.firstPublish`, from this create's own acceptance. `prepared` is part 09's `adoptionExportBoundary(doc, lookup.definitions, mediaFiles, target)` (its 15.2): `doc` the candidate's document, `lookup` `gathered.lookup`, `mediaFiles` `gathered.mediaFiles`, and `target` the server's origin and the project space, as the reader takes it |
| `mediaPaths` | `assignMediaPaths(gathered.mediaFiles).rows` (part 10, 4.2): the kept paths, by published asset |
| `confirmations` | `adoptionPlanFeatureConfirmations` over the candidate's document, the target, `source.cloudcareEnabled` and `accepted.sourceHoldsSaveToCase` (part 10, 6.5): the `recordedFeatures` the review showed for the chosen declaration, computed again from the document being born |

The project data's write is part 11's `readingProjectDataWrite(data, reads, doc,
mintingResolver(appId))` (its 14.1) over the data under the answers (5.3, step 6): the origin, the
tables to create or refresh with each one's answer, and the places to copy, or null where the app
reads none.

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
  admit. So `extractLocationReferenceTargets` is empty at a birth, and no place id has to be known
  before the transaction.

### 6.3 The one transaction

```ts
// lib/deployment/reading/birth.ts
export interface AdoptionBirth {
	readonly actorUserId: string;
	/** Attribution only: an adoption holds no run. Minted outside the transaction. */
	readonly runId: string;
	readonly candidate: PreparedGenesisCandidate;
	readonly hqApp: HqAppKey;
	/** Part 11's `ReadingProjectDataWrite` (6.2): the origin, the tables to create or refresh, and
	 *  the places to copy (null where the app reads none). */
	readonly projectData: ReadingProjectDataWrite;
	/** Part 10's write, less its time: `adoptedDeploymentWrite`'s answer (6.2). */
	readonly deployment: Omit<AdoptedDeploymentWrite, "at">;
	readonly at: Date;
}
export type AdoptionOutcome =
	| { readonly kind: "born"; readonly role: string }
	/** This reading's create already committed: answer from the saved app (6.6). */
	| { readonly kind: "replay" };

export function adoptHqAppInTransaction(
	tx: Transaction<AppDatabase>, birth: AdoptionBirth,
): Promise<AdoptionOutcome>;
```

`createFromReview` calls it inside `lib/db/pg.ts::withAppTx`. The body is pure of side effects:
the candidate, the deployment's write, `runId` and `at` are made before it, and a retry runs the
same statements.

In order, with the lock each statement takes:

| # | Statement | Lock |
|---|---|---|
| 1 | `lib/db/hqAppClaims.ts::claimHqAppInTransaction(tx, hqApp)` (part 10, 5.2). An `HqAppAlreadyClaimedError` whose `holder.appId` is this `appId` is caught and answered `replay` | the HQ app's transaction advisory lock; where the holder is in recently deleted, that app's row `FOR UPDATE` |
| 2 | `writePreparedGenesisInTransaction(tx, { candidate, actorUserId, runId, status: "complete", afterAppInsert })`: | |
| 2a | `assertProjectCapabilityInTransaction(…, "edit")` | the shared membership gate; the member row is read |
| 2b | `INSERT apps` at sequence 1, `status` `complete`, no holder and no reservation columns | a new row |
| 2c | `afterAppInsert`, with `write` being `birth.projectData` and `origin` `write.origin`: part 11's `writeBroughtInLookupTablesInTransaction(tx, { projectId, actorUserId }, { origin, tables: write.tables, at })` (its 7.4), which derives each standing again under the lock and throws `BroughtInTableChangedError` where one is no longer the standing its binding was made for | `lookup_project_state FOR UPDATE`, then each table it creates or refreshes |
| 2d | `afterAppInsert`, after 2c: part 11's `writeBroughtInPlacesInTransaction(tx, { appId, projectId, actorUserId }, { origin, places: write.places, at })` (its 11.4), which takes a null `places` and then writes nothing; otherwise it reaches `lib/organization/managed.ts::writeManagedPlacesInTransaction` | new rows: the new app's `app_organization_state` and its `app_locations` |
| 2e | lookup context; the absolute gate; `getAssetsInTransaction` over the referenced assets; export readiness | the candidate's tables `FOR KEY SHARE` (those 2c wrote are already held); each referenced asset `FOR SHARE`, in id order |
| 2f | organization integrity, which reads the places 2d wrote; `admitExactMediaReferences`; lookup edges | the same assets, already held |
| 2g | entity rows; the sequence-one `fold-baseline` change; the immutable baseline through `nova_insert_app_change_genesis_fold_baseline`; the runtime case schemas | new rows |
| 3 | `lib/deployment/store.ts::recordAdoptedDeploymentInTransaction(tx, { ...deployment, at })` (part 10, 6.2): the deployment at `uploaded`, the `adopted` mapping at `pushed_revision` 1, the `read` baseline with `nova_revision` 1 and its media record, the identity rows, the media paths, the confirmations, the deployment poke | new rows; the claim index entry |
| 4 | `projectRoleForInTransaction(tx, actorUserId, projectId)` for the receipt | the shared gate, held since 2a |

**The order is free of a cycle**, by four facts:

- **The claim's locks are part 10's** (its 5.2): an advisory lock is never waited for while an app
  row is held, and a birth waits for at most one existing app's row.
- **The membership gate comes after every app row and before Project state**, the order of every
  existing-app protocol and of every app-bound lookup writer. A membership write takes the gate and
  no row.
- **After Project state the birth asks for no app row.** `lib/lookup/CLAUDE.md`: "No code may hold
  Project state or a lookup table and later request an app lock." Statement 3 reads the new app's row
  without a lock (part 10, 6.2), and that row is this transaction's own insert, which nothing else
  can see or wait on.
- **Media rows are locked after the gate, as media deletion locks them** (gate, then the asset), and
  no lookup writer locks an asset.

`hq-adoption` is creation, so it is gate-first in the sense the contract means: it locks no row of
the app it creates before the gate. The one row it can lock before the gate is, through the claim,
another app's.

**What "atomic" covers.** One commit makes the app, its entities, its baseline and history row, its
case schemas, its lookup tables and their edges, its media edges, its places and its deployment
with the claim. A failure of any statement leaves none of them. The only things that can exist
without the app are the published media files of 6.1.

**The transaction takes no deadline of its own.** It is one reduction, one validation, and one row
for each menu, form and field, inserted in batches, so an app at the cap writes thousands of rows.
Where the app reads a lookup table the transaction holds `lookup_project_state FOR UPDATE` from the
seam to its commit, and other lookup writes in that Project wait for it. How long that is at the
cap is not measured: `[reading] created` logs the birth's time with its counts (10), so the first
large apps say.

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

Everything `createFromReview` can meet once the digest and the answers have passed, and what it
answers. The first row comes before any file is published; every other can come after one has
been.

| Thrown, or returned | Means | The answer |
|---|---|---|
| an answer moved a binding the reader read (5.3, step 6) | part 11's rule (its 7.4) and its offers rule it out | `check-failed`, `birth-bindings` |
| `MediaPublishPermissionError` at the publish (6.1) | the person no longer edits in the Project | `refused: no_project_access` |
| the check under the published ids and the answers is not clean, or does not give the digest again (5.3, step 8) | Nova judged two runs over the same facts differently, or part 11 offered an answer that cannot be created | `check-failed`, `birth-integrity` |
| `adoptedDeploymentWrite` answers `ok: false` (6.2) | a form with no real id reached a birth. The same call answered rows for this run's digest (3.3, step 9), so nothing reaches this arm in production; it guards the birth against a change to either | `check-failed`, `birth-identity`; no transaction opens |
| `replay` | another call of this reading's create committed first | `created`, with the receipt read back (6.6) |
| `HqAppAlreadyClaimedError` with any other holder, the null holder of part 10's index floor included | a live Nova app publishes to this HQ app | by 6.6's rule: `created` where this reading's own app exists; otherwise `changed` with the stop `already-in-nova`, its `detail.claim` from a fresh `readHqAppClaims` |
| a primary-key conflict on `apps` | this reading's app exists and is in recently deleted: only a delete racing a replay gives it | as `replay` |
| `GenesisGateRejectedError` | the tail's gate or export readiness refused a document acceptance had just passed | `check-failed`, `birth-` and the error's `check`: `birth-gate` or `birth-export` |
| part 11's `BroughtInTableChangedError`; its `LookupError` with code `tag_taken` or `conflict` | a table the app reads changed in the Project between this create's read and the birth's lock: a table of that tag was created, edited, or taken over with Manage in Nova | `read-again`. The caller reads the app again, and the fresh review shows the table as it now stands, with its choice where it asks one |
| `BlueprintCommitRejectedError`, and some published asset is no longer a ready file of the Project (`lib/db/mediaAssets.ts::loadAssetsByIds` after the rollback) | someone removed a file from the Project's library between its publication and the birth | `refused: project_changed`. The next create fetches and publishes the file again |
| `BlueprintCommitRejectedError`, and every published asset is still a ready file of the Project | the tail's lookup context, organization integrity or media admission refused what acceptance and part 11's plans had passed | `check-failed`, `birth-integrity` |
| `CommitReauthError` | the person no longer edits in the Project | `refused: no_project_access` |
| anything else | infrastructure, or a bug of Nova's | thrown on: the route writes a `failed` line and logs `[reading] failed` (10) |

`BlueprintCommitRejectedError` is thrown by several statements of the tail (the lookup context,
organization integrity, media admission, the lookup edges) and carries nothing that tells them
apart (`lib/db/commitGuard.ts`), so the create asks the one question that does: are the files it
published still there. That read is of at most the ids the plan published, once, after a rollback.

**`check-failed` carries one finding**, `circumstanceFinding("read-back-differs", { kind: "app" },
{ name })`, `name` one of the five `birth-` names part 01 lists for the code (its section 8.3).

**A refusal of Nova's own checks at the birth is Nova's defect.** Acceptance ran the same gate and
the same export readiness over the same document moments before; the tail disagreeing means two
Nova code paths disagree. The person meets it through `read-back-differs`, whose block is true of
it (part 01, section 9.3): one of Nova's own checks on what it read did not pass, it is Nova's
mistake and not the app's, and it has been reported. So a person meets one situation and one next
step whether acceptance or the birth refused, and a developer tells the two apart by
`detail.name`'s `birth-` prefix and by the log line (Departure 6). The answer is its own arm and
not `changed`, because `changed`'s lead says something changed since the review, and here nothing
did. Its lead says what stays in the Project's files, since this answer can come after the publish
("Copy", C2).

It is logged with `log.error("[reading] could not create: " + check, undefined, { appId,
projectId, userId, operation: "create", phase: check, findingCodes })`, `check` being the name
without its prefix (`gate`, `export`, `integrity`, `identity` or `bindings`): a message and a
context, and no error object. The thrown error must not be passed. `GenesisGateRejectedError`'s
message is the findings' own sentences (`describeCommitFindings`, and each export finding's
`message`), which hold the app's words, and `lib/logger.ts` sends an error it is given to Sentry
(`Sentry.captureException`) and writes its stack to Cloud Logging. A message alone is a message
event, which groups by its text: one issue per check, which is section 10's rule. `findingCodes` is
the validator codes (the `findingCodes` of either error class, and empty for the three checks that
hold none), never a sentence. For `identity` and `bindings` the context also carries `why`, C8's
line for the check ("Copy"): its slots are the derived app id and, for `bindings`,
`movedBindingCount`'s answer, so it holds no word of the app.

### 6.6 Every repeat of one create

**A repeated create answers the same app.** The same `readingId` gives the same `appId` (2.3), so
every create of one reading prepares the same `apps.id`, and whether one committed is one read of
`apps`.

**One rule covers every overlap.** Before `createFromReview` answers anything but `created`, it
reads `apps` by `appId` once more. A row there is this reading's own app, committed by another
request while this one was working, and the answer is then `created` with
`readBackAdoptedAppReceipt(appId, key, actorUserId)` (7.1). The same read follows
`HqAppAlreadyClaimedError` at the birth, whatever its holder. So a create that overlaps another
create of the same reading answers the app wherever the other committed: before its step 2, during
its claim advice (which would otherwise name the person's own new app as the holder), during its
read of Project data (the first create's tables change `review.tables`, so the digest would
differ), during its files, or at the birth's lock. No overlap answers `changed` or shows a stop for
the person's own app.

- **A retry after a lost response, and a second press in the same tab.** Step 2 of 5.3 finds the
  app and answers `created`, before any call to CommCare HQ. Part 13's page takes the review off
  screen while a create is in flight (its section 9.1), so a second press is rare; the server does
  not rely on that.
- **Two identical creates at once.** Both pass step 2. Where the second reaches the birth before
  the first commits, it waits on the HQ app's advisory lock, finds the claim held by its own
  `appId`, and is `replay`. Where the first commits while the second is still gathering, the rule
  above answers the app.
- **A reload while a create is in flight.** Part 13's page sends the same create again (its
  section 9.1). It answers `created` where the first committed, joins the first where it is still
  running, and runs whole where the first died.
- **Two tabs, or two people.** Two reads are two `readingId`s and two app ids. The first create
  commits. The second meets the claim, as advice in its own read or as `HqAppAlreadyClaimedError`
  in its birth, and answers `changed` with the stop `already-in-nova`, whose block names the app
  and offers to open it (part 01, section 9.3; part 10, section 5.5). No interleaving makes two
  apps.
- **A create that died before its commit** left nothing where it died before its publish, and
  only files in the Project's library where it died after (6.1). The next create runs whole.

`readBackAdoptedAppReceipt` calls `lib/db/appAccess.ts::resolveAuthorizedAppSnapshot(appId, userId,
"view")`, the builder's own hydration read, and builds the receipt from it: the saved app at its
current sequence (it may have been edited since), `batchId` `genesisBatchId(appId)`, `snapshotDigest`
`canonicalJsonDigest(blueprint)`, and the role and Project the snapshot resolved, which is the app's
Project today, not the one the create named. `AppAccessError` is answered `refused:
app_unavailable` ("Copy", C1): the app was brought in and is now in recently deleted, or the
person is no longer a member of its Project.

---

## 7. The receipt's adoption arm

### 7.1 The key set

`lib/db/appGenesis.ts` gains, beside `AppMaterializationReceipt`:

```ts
/** What a brought-in app's receipt says of where it came from. */
export interface AppAdoption {
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
`blueprint` `candidate.persistable`, `canEdit` `roleAllowsApp(role, "edit")`, `adoption` the key's
server, project space and HQ app), and `readBackAdoptedAppReceipt` on a repeat (6.6), where
`adoption` is the repeated create's own key:

```ts
// lib/deployment/reading/birth.ts
export function adoptedAppReceipt(
	candidate: PreparedGenesisCandidate, key: ReadingKey, role: string,
): AdoptedAppReceipt;
/** Rejects with `AppAccessError` where the person can no longer open the app (6.6). */
export function readBackAdoptedAppReceipt(
	appId: string, key: ReadingKey, actorUserId: string,
): Promise<AdoptedAppReceipt>;
```

**Why a second key set, and not a thirteenth key on every receipt.** The parser admits a key set
exactly. A build that began before a deploy can finish after it, and its `data-app-materialized`
frame then reaches a tab running the previous client; an added key would make that tab refuse the
receipt of a build the person watched finish. So the blank app, a reviewed build and a session's
first save send the twelve keys they send today, byte for byte, and only the create route sends
thirteen, to a client that knows them.

### 7.2 The parser

`components/chat/chatLifecycle.ts`:

- `AppMaterializationActivation` gains `readonly adoption: AppAdoption | null` (the type is declared
  again here, client-side, with `server` as `string`; `components/**` imports nothing of
  `lib/commcare`).
- `parseAppMaterializationReceipt` admits two key sets. The twelve-key set parses exactly as today
  and yields `adoption: null`. The thirteen-key set requires, beyond every rule the twelve-key set
  already holds: `designSessionId === null`, `changeSetId === null`, `starter === null`; `adoption`
  a plain object whose keys are exactly `domain,remoteAppId,server`, each a non-blank string;
  `adoption.server` one of `production`, `india`, `eu`. Any other shape is `null`, as today.
- The rule that a receipt's blueprint holds at least one menu stays for both: the gate refuses an
  app with none (`NO_MODULES`, `lib/commcare/validator/rules/app.ts`), so no birth sends one.

### 7.3 The installer

`components/chat/ChatContainer.tsx::installCreatedApp` does for an adopted app exactly what it does
for every other: identity and capability into the session store, the blueprint under a remote-apply
bracket, the URL promoted to `/build/{id}` through `pushBuilderHistory`, the reconciler activated at
the receipt's `seq`, the app list marked stale. It is unchanged but for its comment ("Contracts").

The landing is made reusable. The block inside the blank-app handler that parses a raw receipt,
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
today's toast. Part 13's flow, which is mounted on `/build/new` inside `ChatContainer`'s tree (its
section 3.1), is handed the function as a prop and calls it with `"brought-in"` and the `receipt`
of a `created` answer (its section 9.2). `verifyActivationDigest` runs wherever a receipt is
installed: an adopted receipt arrives on the stream's last line, and the digest is over the same
canonical JSON text.

**A receipt for another Project.** The first screen of the flow offers "Add it to <Project>",
preselected to the Project the person is looking at (part 13, section 4.1), so choosing another
is an ordinary act; and a repeated create answers with the app's Project today, which a move may
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

The last row is a full page load, and it is the one place a creation navigates (Departure 15). What
`components/builder/CLAUDE.md` protects by forbidding a route change after a creation is a live run
and the document the client already holds. Here there is no run (an adoption holds none, 6.4), and
the tab's stores belong to a Project the new app is not in, so there is nothing of this tab to
keep. The app's page hydrates through `resolveAuthorizedAppSnapshot` and takes the app's own
Project (`app/(app)/build/[id]/[[...path]]/page.tsx`), exactly as opening that app from a link
does today; the person's active Project is not changed for them. The receipt is still parsed first,
so the id the tab loads is one the strict boundary admitted.

Nothing in the session or the doc store records that an app was brought in: the app's deployment
says it (part 10: the `adopted` mapping, `adoptedByName`), and what the builder shows on landing is
part 13's, read from `activation.adoption`.

---

## 8. Failure by failure, what a read and a create answer

Section 3.8 gives the answer for each circumstance code. This table is by what happened, and names
where the words a person then reads are held: a circumstance's block is part 01's (its section
9.3), a lead and a refusal's sentence are this part's ("Copy"), and the screen is part 13's.

| What happened | A read answers | A create answers |
|---|---|---|
| CommCare HQ is slow: a call passes its own deadline (3.2) | the stop `hq-unavailable` | `held` with that finding. The review the person holds stands |
| CommCare HQ is down, or throttling past the short waits | the stop `hq-unavailable` or `rate-limited` | `held` |
| The app changed in CommCare HQ between the review and the create | not applicable | `changed` with the fresh review. Where the change brings a finding, `changed` with the account. Neither lead names a cause, because Nova cannot always know one |
| The app was saved while Nova was reading it | Nova reads it once more in the same request; a second save is the stop `changed-while-reading` | the same, answered `held` |
| The app was deleted, or became a linked or a remote app | the stop `app-deleted`, `app-gone`, `linked-app` or `remote-app` | `changed` with that stop |
| The person's CommCare HQ access changed: the key, the project spaces Nova holds for it, the membership, a permission, the plan's API access | the stop for it (`key-not-accepted`, `key-cannot-reach-space`, `not-a-member`, `cannot-edit-apps`, `cannot-access-apis`, `plan-lacks-api-access`), each with its own next step | `held` with that finding |
| The person lost edit access to the Project | 403 `no_project_access`, before the stream opens | the same 403 from the request's own check; `refused: no_project_access` from the publish or the birth (6.5) |
| A file CommCare HQ holds no bytes for | no failure: the verdict `missing`, judged by where the reference is drawn (part 11, section 3): a finding, or left out and counted in the review | the same. A file that went missing since the review changes the digest, so `changed` |
| A file CommCare HQ fails to send after its one resend | the stop `hq-unavailable`: a file CommCare HQ could not send this minute is no fact about the app | `held`. Nothing was added to the Project: the publish comes only after every file is fetched and the digest has passed |
| A file over Nova's limit, in a format no platform plays, or of the wrong kind | a finding in the account (part 11, section 2.4) | cannot newly arise without the digest changing: `changed` |
| Another Nova app took this HQ app meanwhile | the stop `already-in-nova`, whose block names the app and offers to open it where the person can see it | `changed` with that stop, whether the advice or the birth's claim found it, under a lead of its own. Where the holder is this reading's own app the answer is `created`, never this (6.6) |
| A lookup table the app reads changed in the Project under the birth | not applicable | `read-again`: the caller reads the app again |
| A file was removed from the Project's library between its publication and the birth | not applicable | `refused: project_changed` |
| One of Nova's own checks stopped the birth (6.5) | not applicable | `check-failed`, with the one `read-back-differs` finding |
| A deploy changed Nova between the review and the create | not applicable | the create goes on where the deploy changed nothing of this app's review or document, and answers `changed` with the fresh review where it did (5.2) |
| Nova itself failed: something was thrown that is no answer | the `failed` line. The page shows `READING_FAILED_COPY.read` ("Copy", C9) and waits for the person | the `failed` line, and `READING_FAILED_COPY.create`. Sending the same create again is safe (6.6) |
| The request ended part way: a deploy, the instance, the network | the stream ends with no last line, and `readBringInStream` answers `lost` (4.3). Nothing was made | the same. A create sent again answers the same app or creates it (6.6) |
| The tab closed | the read stops at its next call (3.2); nothing was made | the create runs on; where it finishes, the app is in the person's apps (6.1) |

How the platform treats a request in flight during a rollout is not known here. The design does not
depend on it: either outcome is the lost-request row or the closed-tab row.

Two rules keep this part's sentences true wherever part 13 draws them:

- **A create's answer never says "Nothing was created".** That sentence is false after a publish,
  which has added files to the Project. Every lead and refusal a `CreateAnswer` carries says "No
  app was created" where it says anything of the kind, which is true before the publish and after
  it. Three answers can follow the publish and leave its files behind: `read-again`,
  `check-failed`, and `changed` with the stop `already-in-nova` where the birth's claim found the
  holder (6.5). Each says what stays in the Project's files, worded with "any" so the sentence is
  true where no file had been added: a `check-failed` of `birth-bindings` comes before the
  publish, the claim's advice finds a holder before any file is fetched, and an app with no file
  has no publish. `project_changed` says which kind of thing is gone and that bringing the app in
  again adds it back. `no_project_access` after the publish says nothing of files, because the
  person it is said to no longer edits the Project: the files stay, and the Project's editors see
  them in Files (6.1).
- **A `failed` line is not a lost stream.** A lost stream may be the network's doing, so the same
  request may be sent again without the person. A defect answers the same way twice, so the words
  for a `failed` line offer the person the retry and promise nothing else.

---

## 9. What every other surface does with an adopted app

An adopted app is an `apps` row at `complete` with entities, a baseline and a deployment. Each
surface below was traced from its entry to what it reads; "none" means no line of it changes.

### 9.1 App Tests

`lib/db/appTests.ts` pins an app's document at a sequence and evaluates it on Preview's engine over
the app's case rows. It reads nothing about how an app was born. An adopted app holds no personas
and no users (CommCare HQ's app holds neither; part 10, 2.2), so a journey starts as it does for any
app without them. Nothing of this part changes an evaluator. **Work: none.**

### 9.2 App copy

Nova has none: `rg -i "duplicateApp|copyApp|cloneApp|duplicate_app|copy_app"` over `lib`, `app` and
`components` finds nothing, and the home list offers no copy. Bringing the same HQ app in twice is
refused by the claim. **Work: none.**

### 9.3 Delete and restore

`lib/db/apps.ts::softDeleteApp` sets `deleted_at` and writes nothing else; part 10 decides what the
claim does and what `restoreApp` settles (its sections 5.3, 5.4 and 8.4). A repeated create of a
deleted app answers `app_unavailable` (6.6). A new read of the same HQ app is allowed while the app
is in recently deleted, since the claim passes over a deleted holder. **Work: none here.**

### 9.4 Project move

Part 10 re-maps the deployment's media paths in the move (its section 4.6). Nothing of a bring-in
is stored beside the app, so a move has nothing more to carry, and a repeated create after one
answers a receipt whose Project is the destination (6.6). **Work: none here.**

### 9.5 `search_blueprint`, `get_app` and the other read tools

They read the saved document through `loadApp` and its projections. An adopted document is made of
the same union every app is; the reader admits exactly what the gate admits (the bar's clause (a):
part 01, "The admission bar"), so no projection meets a shape it has no arm for that a
Nova-authored app could not also hold.
`get_deployment` shows the adopted deployment through part 10's projection, which part 13 words.
**Work: none here.**

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
tools as for any app. **Work: none here.** What the guide says about an app that came from
CommCare HQ (managed tables, kept settings) is part 13's (its section 15.1).

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

Cloud Logging is the stream and Sentry the grouping (`lib/logger.ts`). A bring-in has no run, so it
writes nothing to `lib/log`'s per-run event stream. Every line carries `appId` (the derived app id,
2.3), `projectId`, `userId` and `operation` (`read` or `create`), all `SENTRY_TAG_KEYS`; none
carries the project space, the HQ app's id or name, or any finding's `place` or `detail`. The
derived id joins the lines of one request, and a create's lines to its read's, since both derive it
from one `readingId`; it names an app only where the create committed. No line holds a word of an
app, in its message or in its context: a message titles a Sentry issue, and the context reaches
Sentry as `extra`. `defects` is no exception. A reader defect's `why` is built only by the
constructors of part 06's `reader/defects.ts::readerDefect`, each from closed slots (the defect's
words, the place by position as `placeKey` prints it, a registered claim's name, a manifest
entry's id, a standing, a kind word, an issue code, a position), and never from a name, a label, a
tag, a column, a path, a value, an expression or a parser's message. Part 06's `defects.test.ts`
holds that over every constructor (its section 5.1 and "Tests").

| Message | Level | When | Further context |
|---|---|---|---|
| `[reading] answered` | info | a read or a create answered | `phase`: `stop`, `account`, `review`, `created`, `changed`, `read-again`, `check-failed`, `held` or `refused`; `elapsedMs`; `checkMs` and `longestPieceMs`, the time the request's synchronous pieces took and the longest of them, with `sourceBytes`, which together say what the reader's rate is on real apps (3.6); `mediaTotal`; for an account, `findingCount`, `codeCount`, `notYet`, `never`, `fixInHq`; `expressionRounds` where the reader gave a draft (`ReadFacts.expressionRounds`, the count part 08's section 2.5 keeps for this line) |
| `[reading] failed` | error | something was thrown that is no answer, and the stream ended in a `failed` line | `phase`: the stage that was running, and the error itself. What reaches it is infrastructure or a bug of Nova's, never a judgment of content: acceptance never throws for content (part 09, section 2.5), and the errors whose messages hold the app's words are caught and answered before it (6.5) |
| `[reading] stopped` | warn | a stop was answered | `phase`: the circumstance code |
| `[reading] places read missed` | error | 3.3, step 6.2: the document reads places and part 11's source test named none, so the request read them in a second pass | |
| `[reading] unrecognized: <log key>` | error | once per distinct log key of the request's `unrecognized` findings | `defects`: the `why` of each `ReaderDefect` whose `name` gives that log key, at most five (below) |
| `[reading] read-back differs: <check>: <signature>` | error | once per distinct signature of the request | `phase`: the check; `differenceCount`; `signatures`, the request's distinct signatures, at most five (part 09, 14.3); for `accounting/defect`, `defects`, the `why` of each defect, at most five |
| `[reading] could not create: <check>` | error | 6.5; a message with no error object | `findingCodes`; for `identity` and `bindings`, `why`, C8's line for the check |
| `[reading] request refused` | warn | a route body failed its schema (4.1) | `phase`: the route; the first Zod issue as `<top-level key>: <issue code>`, never a deeper path (a key of `tableChoices` is a table's tag) and never a value |
| `[reading] created` | info | the birth committed | `elapsedMs`, the transaction's own time; `tables`, `places`, `mediaFiles`, `identityRows` as counts |

A read and a create each write one `[reading] answered` line, in `read.ts` and `create.ts`; a
create's line carries the facts of its own gathering. The MCP tools call the same two functions, so
a tool call logs the same lines.

**Sentry grouping for `read-back-differs`.** A message-only `log.error` reaches Sentry as a
message event, which groups by its text. So the text is made of exactly what should define an
issue: the check that failed, any of part 09's five `ACCEPTANCE_CHECKS` (`accounting`, `gate`,
`fixed-point`, `identity`, `summary`), or `reader` with the signature `contract` for the reader's
own contract error and `identity-rows` for a form with no real id (3.3, steps 6 and 9), and the
signature of the first difference acceptance met. The signature is part 09's
(`lib/deployment/reading/signature.ts::differenceSignature`, its 14.2): the check and then segments
from a closed vocabulary that holds no word of any app, joined with `/` and cut at the last whole
segment within 80 characters, as in `fixed-point/question/relevant`. A failing arm's `check` is
never null and its `signature` is always present, so the line is written for every check. One
defect in the reader is then one issue however many apps meet it, and two defects are two issues.
`gather.ts` reads the failing arm's `check`, `signature` and the count and signatures of its
`differences`, and never a difference's `detail`, so no difference's own words can reach a log.

**The log key of an `unrecognized` finding.** The finding's `detail.name` is for the person's
account and is not safe in a message: part 06 (4.4) fills it with a surface key, which is a
declared schema key (`schema:Application.multimedia_map`) or else an undeclared JSON key or an XML
element or attribute name (`xform:<qualified name>`, and an instance's element names are an
author's question ids), or with a value as the app writes it (an appearance), and part 11 fills it
with a file path or a table's tag. So the message is built by
`gather.ts::unrecognizedLogKey(name: string): string`, which returns the name itself only where
`isDeclaredSurfaceKey(name)` (below), and otherwise one word of a closed set, by the name's shape:
`undeclared-json-key` (a `<class>.<key>` with no `schema:` prefix), `xform-element` (an `xform:`
name with no `@`), `xform-attribute` (one with an `@`), or `other`. `[reading] unrecognized: <log
key>` then groups by something that is never an app's content. The finding itself, with its full
`detail.name`, is in the account the person was answered and nowhere else: nothing stores it, and
reading the app again gives it again.

```ts
// lib/commcare/surface/revision.ts (new; its one export)
/** True where some manifest entry's `surfaceKeys` holds the key: a key of CommCare's own schema,
 *  and no content of an app. Computed once per process over `lib/commcare/surface/entries/*.json`. */
export function isDeclaredSurfaceKey(key: string): boolean;
```

**A reader defect.** Where the reader itself is at fault it raises `unrecognized` and returns a
`ReaderDefect` beside it, whose `name` is that finding's surface key and whose `why` is one of
part 06's developer lines (its 5.1 and its "Copy"), each built from closed slots and holding no
word of the app. Each is logged at error on the finding's own line: the `unrecognized` line of a
log key carries, as `defects`, the `why` of each defect whose `name` gives that key. `why` rides in
the context and never in the message, so it titles no issue, and it is never shown. A defect
beside a clean read has no such finding: acceptance answers it as `accounting/defect` (part 09,
section 3), and the `read-back differs` line of that signature carries `defects` the same way.

`log.warn` stays Cloud-Logging-only, so a stop is searchable and raises no issue: a busy CommCare HQ
is not Nova's defect.

---

## Copy

Every string this part adds that a person, a developer or a model reads. All of it follows
`design/readme.md`, "Content fundamentals". The strings a person reads live in one new client-safe
file, `lib/publish/hqReadingCopy.ts`, beside part 01's `hqFindingCopy.ts`, because the page and the
MCP tools show the same sentences. The account's and the review's own layout, headings and buttons
are part 13's; every circumstance's block is part 01's. The ids below are the ones other parts
cite; C3 and C7 name nothing.

```ts
// lib/publish/hqReadingCopy.ts. No run-time import: its key types come from the client barrel.
import type { ReadingRefusal, ReadingStage } from "@/lib/deployment";

export const READING_REFUSAL_COPY: Readonly<Record<ReadingRefusal, string>>;                 // C1
export const CREATE_ANSWER_LEADS: {                                                           // C2
	/** By what `now` holds. A stop of `already-in-nova` has its own. */
	readonly changed: Readonly<Record<"review" | "account" | "stop" | "already-in-nova", string>>;
	readonly "read-again": string;
	readonly "check-failed": string;
	readonly held: string;
	/** Added after a `changed` or `read-again` lead where an answer could not be kept. */
	readonly choicesDropped: string;
};
type FileCount = { readonly done: number; readonly total: number };
export const READING_STAGE_LABELS: {                                                          // C4
	readonly [S in Exclude<ReadingStage, "checking-media" | "bringing-in-media">]: string;
} & {
	readonly "checking-media": (count: FileCount | null) => string;
	readonly "bringing-in-media": (count: FileCount | null) => string;
};
export function moreFindingsLine(more: number): string;                                      // C5
export const UNVERIFIED_LANDING_TITLE: string;                                                // C6
export const UNVERIFIED_LANDING_BODY: string;                                                 // C6
export const READING_FAILED_COPY: Readonly<Record<"read" | "create", {                        // C9
	readonly title: string;
	/** `app` is CommCare HQ's name for the app, or null where it is not known. */
	readonly body: (app: string | null) => string;
}>>;
```

"Reading" is the code's word (2.1). No sentence a person reads says it.

### C1. Refusals (`READING_REFUSAL_COPY`, keyed by `ReadingRefusal`)

| Code | From | Answered as (`READING_REFUSAL_STATUS`, 4.1) | Sentence |
|---|---|---|---|
| `no_project_access` | `authorizeBringIn`; the publish and the birth (6.5) | 403 before the stream; `refused` after it | You don't have edit access to this Project, so Nova can't add an app to it. You can choose another Project, or ask one of its admins for edit access. |
| `invalid_input` | a body that fails its schema | 400 | Nova couldn't read that request. Reloading the page and trying again usually fixes it. |
| `name_missing` | the create (5.3, step 3) | `refused` | The app needs a name of up to 255 characters. You can keep the one from CommCare HQ or type another. |
| `choice_not_offered` | the create (5.3, step 6) | `refused` | One of the choices sent isn't one this review offers. The review may have changed, so you can reload it and choose again. |
| `choice_missing` | the create (5.3, step 6) | `refused` | A lookup table this app reads needs your choice before Nova can create the app. You can choose what to do with it in the review. |
| `project_changed` | the birth (6.5) | `refused` | A file this app uses was removed from your Project while Nova was creating the app, so Nova stopped before creating it. You can bring it in again, and Nova adds the file back. |
| `app_unavailable` | a repeated create (6.6) | `refused` | This app was brought in already, and you can't open it from here. If it's in recently deleted, you can restore it from your apps. If you've left its Project, one of its admins can add you back. |

The Zod issue of an `invalid_input` goes to the log (`[reading] request refused`, section 10) and
not to the person: a path and a parser's message are Nova's own words for its own mistake. A
refusal is a code with one sentence and carries nothing else: `choice_missing` names no table,
because the caller holds the review, whose `tables[].choice` names every table that asks. The
unauthenticated answer is `requireSession`'s existing 401.

### C2. What stands after a create that did not create (`CREATE_ANSWER_LEADS`)

One sentence above whatever the answer carries.

| Answer | It carries | Sentence |
|---|---|---|
| `changed` | a review | Something changed since you reviewed this app, so Nova read it again. Here is the review as it stands now. |
| `changed` | an account | Something changed since you reviewed this app, and Nova can't bring it in as it stands now. Here is what Nova found. No app was created. |
| `changed` | a stop other than `already-in-nova` | Nova couldn't finish creating this app. Here is where things stand. No app was created. |
| `changed` | the stop `already-in-nova` | This app was brought into Nova after you reviewed it, so Nova didn't create a second one. Any pictures and sounds Nova already added to your Project stay in its files. |
| `read-again` | nothing; the caller reads again | A lookup table this app reads changed in your Project while Nova was creating the app, so Nova is reading it again. No app was created. Any pictures and sounds Nova already added to your Project stay in its files, and bringing the app in uses them. |
| `check-failed` | the one `read-back-differs` finding | Nova stopped before creating this app. Any pictures and sounds Nova already added to your Project stay in its files. |
| `held` | a circumstance | Nova stopped before creating anything. Your review is still here. |
| `changed` with a review, or `read-again`, where an answer the person had given could not be kept | | (added after the lead) Some of your choices no longer apply, so Nova chose for those again. |

Under a `held` answer the page shows the circumstance's own title, body and next step (part 01,
section 9.3). The lead says nothing of why, because the circumstances it sits above differ: a key
CommCare HQ refused, a membership that ended, a busy minute. Each block says its own. `held` comes
before any file is published, so "before creating anything" is true of it.

The lead of a `changed` answer with a review names no cause, in CommCare HQ or in the Project,
because Nova cannot always know one. The lead above `already-in-nova` says what Nova did and what
stays in the Project's files, since the birth's claim can refuse after the publish (6.5); the
block under it names the app and, where the person can open it, offers to (part 01, section 9.3).
Which answers the page keeps across a review that comes back, and so when the last row is added,
is part 13's (its section 3.3).

### C4. The stages, by name (`READING_STAGE_LABELS`, keyed by `ReadingStage`)

| Stage | Label |
|---|---|
| `connecting` | Connecting to CommCare HQ |
| `reading-app` | Reading the app |
| `reading-project-data` | Reading its lookup tables and places |
| `checking` | Checking what Nova read |
| `checking-media`, with a count | Checking pictures and sounds, {done} of {total} |
| `checking-media`, with none | Checking pictures and sounds |
| `bringing-in-media`, with a count | Bringing in pictures and sounds, {done} of {total} |
| `bringing-in-media`, with none | Bringing in pictures and sounds |
| `creating` | Creating your app |

A media stage's entry is a function of the count: the page draws it with the last `files` event,
and with none between the stage's own line and its first count. An MCP progress notification's
message is the form with none, and the count rides its `extra` (4.4).

### C5. An account longer than the answer lists (`moreFindingsLine(more)`)

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
`ChatContainer` for the toast and by part 13's screen for the same case (its section 9.2).

### C8. For a developer

Each is logged or thrown, so none holds a word of an app or of its project space (10): a slot is
the derived app id, a file of Nova's own, a code, or a count. "The reading ${id}" names the
derived app id, which joins the request's log lines.

| Where | Message |
|---|---|
| `gather.ts` and `create.ts`, a key whose Project is not the actor's (3.1) | `A bring-in was authorized for one Project and asked to work in another. The actor must come from authorizeBringIn called with the same projectId the key holds. Look at the caller of lib/deployment/reading/index.ts.` It has no slot |
| `gather.ts`, `getHqCredentials` answering `ambiguous` for a named project space | `Nova asked for CommCare HQ credentials for a named project space and was told the choice is ambiguous, which a named project space can't be. Look at lib/db/settings.ts::resolveHqTarget.` |
| `gather.ts` (3.3, step 9) and `create.ts` (6.2), `adoptedIdentityRows` answering `ok: false` | `The reading ${id} holds a form that has no real CommCare HQ id. A reading with a menu CommCare HQ could not summarize should have ended as an account. Look at gather.ts, step 4.` The answer's `at` is not printed: it names a menu or a form of the app |
| `create.ts`, the bindings under the answers differ from the bindings read (5.3, step 6) | `The reading ${id} bound ${count} of its lookup tables one way before the person answered and another way after. No answer the review offers may move a binding the reader read. Look at lib/deployment/reading/projectData/lookupTables.ts::resolveLookupBindings.` `${count}` is `create.ts::movedBindingCount`'s answer (5.3, step 6); the tags reach no log |

### C9. Nova's own failure (`READING_FAILED_COPY`)

What the page shows for a `failed` line (4.3). The titles follow the design system's own for this
state, "Couldn't build your app" (`design/readme.md`, "Take responsibility, offer the next step").
`{app}` is CommCare HQ's name for the app, or "this app" where `app` is null.

| Form | Title | Body |
|---|---|---|
| `read` | Couldn't read this app | Nova ran into a problem of its own while reading {app}. That's on Nova, and the team has been told. Nothing was created, and nothing changed in CommCare HQ. |
| `create` | Couldn't create your app | Nova ran into a problem of its own while creating {app}. That's on Nova, and the team has been told. No app was created. Trying again is safe: if the app was created after all, Nova opens it. |

"The team has been told" is true of both: a `failed` line is written only beside `[reading]
failed`, which is logged at error and so reaches Sentry (10). The actions under either form are
part 13's.

---

## Tests

Read `docs/testing.md` first. Each test is named with the boundary it runs at and the failure it
would catch. Transactions run on real Postgres in `*.postgres.test.ts` files. CommCare HQ is
controlled at the HTTP boundary through part 05's retained answers (`proof/hq-reads/reading/`,
served by its `retainedReadingRead`, its section 14.1), never by replacing a reader of
`lib/commcare/hq`. Storage is controlled at its own boundary, as part 11's media tests control it.
The stored key's decryption is controlled at the KMS boundary, `lib/commcare/encryption.ts`, as
`lib/deployment/__tests__/publishSequence.postgres.test.ts` controls it today, and one create test
holds a request there. Pure rules run in plain Vitest, and nothing here renders a component. Every
Postgres test owns its pool clients and joins its concurrent work in `try`/`finally`. All of it
runs in the work's own CI.

### Real Postgres: the read

`lib/deployment/reading/__tests__/read.postgres.test.ts`

| Test | Catches |
|---|---|
| a retained readable app reads to a review; the same app with one variant reads to an account | a wrong answer for a readable app, or for one Nova cannot hold |
| table-driven over every code 3.8 lists as raised by a read: the controlled answer gives a stop where the table says a stop and an account where it says an account | a circumstance answered as an account, or the reverse |
| the row counts of every table, and the storage peer's writes, are equal before and after each of those reads | a read that leaves a row, a file or a byte behind |
| the save counter moves once and then holds: a review. It moves twice: the stop `changed-while-reading` | mixing two versions of the app; stopping on the first save |
| an app that references files and holds one finding: the account has `mediaChecked: false` and the media peer saw no request | fetching every file of an app that cannot come in |
| an app that references files and reads clean: the review comes only after the media peer answered every file, and `creates.mediaFiles` is the count of held files | a review offered before its files were judged |
| a menu CommCare HQ could not summarize gives `menu-unreadable-in-hq` at that menu beside the reader's other findings, in one account | a first finding hiding the rest |
| an account of 2,500 findings lists 2,000, with `more` 500 and `counts` over all 2,500 | an unbounded answer; counts that leave out what was not listed |
| a source holding a write saved only if changed makes one flag read and hands the reader its answer; a source holding none makes none (the peer counts requests) | a guessed flag; a probe every read pays for |
| `cancel` aborted while the HQ peer holds the source open: the request in flight is aborted, the promise settles, and no later request is sent | a read that outlives a closed tab |
| a person who edits two Projects: with the actor `authorizeBringIn` gave for the first and a key that names the second, `readHqAppForReview` and `createFromReview` each reject, the HQ peer saw no request and no row of any table was written | a caller that authorizes one Project and reads or creates in another (3.1) |
| a reader defect behind an `unrecognized` finding, over a source whose every menu name, form name, question id, table tag and file path is a marker string: the finding's log line carries the defect's `why` in its context and not in its message, and no line the read logged holds the marker in its message or in its context | a defect a developer cannot find; a defect's text titling an issue; a word of an app in a log line |

### Real Postgres: the create

`lib/deployment/reading/__tests__/create.postgres.test.ts`

The fixture these tests start from is exported for part 13's Playwright seed:
`lib/deployment/reading/__tests__/adoptionFixture.ts::adoptFixtureApp(input: { projectId: string;
actorUserId: string }): Promise<{ appId: string; receipt: AdoptedAppReceipt }>`, which
`e2e/lib/bringInSeed.ts` calls. It reads the suite's small controlled source for that person into
that Project and creates from the review through the production functions, with CommCare HQ
answered from part 05's retained answers, and returns the born app's id with its receipt.

| Test | Catches |
|---|---|
| read, then create with the review's `readingId` and digest: the app exists at sequence 1, `complete`, with its entities, baseline, case schemas, each lookup table under its derived ids with its edges, each media edge, each place, and the deployment; `publishedRemoteApp` of that deployment is the adopted mapping and `nextPublishAction` answers `updates` | an adopted app that reads as an empty shell; a writer left outside the birth |
| the born deployment row, field by field against 6.2's table: target, HQ app id, `pushed_revision` 1, the baseline's origin `read` with `first_publish_changes` the chosen declaration's list, one identity row per menu and form, the kept media paths, the confirmations of the chosen declaration | a ledger write assembled from the wrong read; a first-publish list other than the one the person reviewed |
| between the read and the create the controlled source changes one label: `changed` with a review of another digest, no row of any table was written, and the storage peer saw no write | creating from a state CommCare HQ has left; files added for an app that did not come in |
| between the read and the create a Project table of a tag the app reads is created: `changed` | a table meeting a Project table unseen |
| a save in CommCare HQ that changes nothing Nova reads (the counter alone moves): the digest is equal, the app is born, and the deployment's `remote_revision` is the create's counter | sending a person back to a review that did not change; a first publish that stops at drift nobody caused |
| each with no row written and no storage write: CommCare HQ answers 503 on the counter during the create (`held`); a `readingId` no read minted (`changed`); a declaration the review does not offer (`refused: choice_not_offered`); a table's choice left unanswered (`refused: choice_missing`); an empty name, where the HQ peer also saw no request (`refused: name_missing`) | the create route as a way to put files in a Project; a choice the gate was never asked about; an unanswered choice created past |
| a review with a table that asks a choice, whose Project table holds other rows than CommCare HQ's, created with `use-commcare-hq` and with `use-project`: the app is born, the document names the Project table's id under either, the HQ peer saw no request after the create's one read, and the table is refreshed in `adopt` mode or, under `use-project`, holds the columns, rows and revisions it held before. With an answer whose offer is `offered: false`: `refused: choice_not_offered` | an answer that changes the document after its digest was taken, so every answering person is sent back to the review; a check under the answers that reads CommCare HQ again; a kept table written to |
| an app with two files of the same bytes is created: its document names one asset for both, the Project holds one ready file of that content, and the digest was equal | an app born from a document acceptance never judged; a digest that sees asset ids |
| a file the Project already held (a ready file of the same bytes, under another id): the digest is equal and the app is born naming that file | a second copy of a file the Project holds |
| the same create sent twice in turn: one app, the same receipt, no request to CommCare HQ and no `app_changes` row from the second, and its receipt passes `parseAppMaterializationReceipt` | a lost response making a second app |
| an app that reads no table: create B is held where its stored key is decrypted, which is after its own first read of `apps` and before its claim advice read (3.3, steps 1 and 2); create A of the same reading commits; B is released: B's claim advice names A's app as the holder, B answers `created` with A's receipt, and one app exists | the overlap that meets the claim advice (6.6): the stop `already-in-nova` shown for the person's own new app |
| an app that reads no table: create B is held at the HQ peer's first media answer, create A of the same reading commits, B is released: B answers `created` with A's receipt, and one app exists | the overlap that meets the birth's lock: a second app, or an error for the person's own app |
| an app that reads one lookup table: B is held at the HQ peer's answer for the app, A commits, B is released: B's own read now meets A's table, and B still answers `created` with A's receipt | 6.6's rule on the path where the digest differs: `changed` or `already-in-nova` shown for the person's own app |
| two reads and two creates of one HQ app, by two people: one app is born, the other create answers `changed` with `already-in-nova`, and the loser left no table, no deployment and no app | two Nova apps publishing over one HQ app |
| another Nova app already holds the HQ app when the create is sent: `changed` with `already-in-nova`, and no `media_assets` row was written for this reading's files | files published into a shared Project for an app that can never be born |
| after an edit raises the app's sequence, the repeated create's receipt carries that sequence and the edited blueprint, with a digest that matches it; after the app moves to another Project, the receipt names the destination; after it moves to recently deleted, the answer is `refused: app_unavailable` | a stale receipt installing over newer work; a receipt for an app the person cannot open |
| a create that fails after its publish (the test's seam throws before the transaction) and is sent again: one app, and no second copy of any file | media that is not idempotent by content |

### Real Postgres: the birth

`lib/deployment/reading/__tests__/birth.postgres.test.ts`

| Test | Catches |
|---|---|
| a document whose select reads a table the same transaction creates passes the tail; with the seam's lookup writer left out it is refused for a missing table | export readiness not seeing same-transaction rows |
| a birth handed a place plan whose place stands at a level that may not nest under its parent's (a plan the test builds itself, past `planManagedPlaces`' own check) is refused inside the tail, nothing exists afterwards, and the create answers `check-failed` with `detail.name` `birth-integrity`; the same birth with a sound plan commits and the places exist | places written where the tail's organization integrity never reads them, so a bad copy commits and breaks the app's first edit |
| a born app's document names no place: `extractLocationReferenceTargets` of it is empty and `app_location_references` holds no row for it | a brought-in document that came to name a place the transaction did not know |
| the holds the batch carries are what `readRecordedPlacementHolds` answers for the born app | a birth whose holds are not recordings |
| no `design_sessions`, `authoring_sessions`, `threads`, `credit_months` or `usage_months` row is written, and no holder or reservation column is set | a birth that charges or holds |
| rollback, table-driven over each seam (a candidate the gate refuses; one export readiness refuses; a lookup writer that throws; a place writer that throws; a duplicate identity row; a throw after the deployment is recorded): `adoptHqAppInTransaction` is run in a transaction the test owns, and afterwards there is no `apps` row of that id, no table of the derived ids, no place, no deployment and no claim index entry; the ready media rows stand | a partial birth |
| a `GenesisGateRejectedError` carries `check` and `findingCodes`, and the create answers `check-failed` with `read-back-differs` and `detail.name` `birth-gate`. The candidate holds a sentinel in a question's label that the gate's finding sentence quotes; a capture of everything `log.error` was called with (message, error argument and context) holds the check and the codes, an `undefined` error argument, and no occurrence of the sentinel | Nova's defect shown as the app's; an app's words reaching Sentry through an error's message |
| a published asset deleted from the Project's library before the birth: the answer is `refused: project_changed`, and the next create publishes the file again and is born | a removed file answered as Nova's defect; a retry that fails forever on a dead asset id |
| a table of a tag the app reads is created in the Project after the create's read and before the birth's lock (the test's seam between them): the birth rolls back, the answer is `read-again`, and the next read's review holds the table's choice | a table that changed under the birth answered with a stale review |
| a second connection holds the HQ app's advisory lock: the birth is pending (asserted by a statement that returns while it waits), then commits when the lock is released | the claim not serializing births before either writes |
| a second connection holds `lookup_project_state` of the Project, and a third then begins a membership write: the birth, the lookup writer and the membership write all finish, in an order the test joins | the gate-after-Project-state cycle of 6.2 |
| the HQ app's holder is in recently deleted: the birth commits and the holder's mapping is released | a deleted app holding its HQ app against a bring-in |
| the three existing births pass no `afterAppInsert` and write exactly what they wrote (the existing genesis tests, unchanged, stay green) | the seam changing an existing birth |

### No database

| File | Tests | Catches |
|---|---|---|
| `lib/deployment/reading/__tests__/cap.test.ts`, over `gatherFromHq` with a Project side that holds nothing and the HQ peer controlled; its own timeout of 60 seconds | an application resource one byte over `HQ_BRING_IN_APP_MAX_BYTES`, and then a source one byte over it, each answer an account of one `too-large` (the first with `appName` null), and the peer's stream was cancelled at the bound each time. A source and its resource just under the cap, built by repeating one retained menu under fresh ids, read to a review, with `GatherFacts.longestPieceMs` under 5,000 | a body held or parsed past the bound; a synchronous piece long enough to fail another request's timer on the same instance (3.6). A failure of the second case is fixed in the reader or in acceptance, by cutting the piece where it is long, and the cap stands |
| `lib/deployment/reading/__tests__/create.test.ts` | `movedBindingCount` over two lists of part 11's gathered tables the test builds by hand: equal bindings under the answers answer 0; a `choice` table whose binding the test moves to another column for a field the reader read answers 1, and so does one whose binding it moves to another table id; a column moved for a field the reader did not read answers 0 | an answer that moves a binding the reader read going on to a birth unseen (5.3, step 6), so an app born from a document its digest never covered; `use-project` refused for a column the app never reads |
| `lib/deployment/reading/__tests__/appId.test.ts` | `broughtInAppId` is stable, passes `lib/domain/uuid.ts::CANONICAL_UUID_PATTERN`, and differs when any one of its six inputs does | an app id two people, two Projects or two readings share |
| `lib/deployment/reading/__tests__/digest.test.ts` | changing each of `review`'s fields, `document`, one identity row or one media path changes the digest; changing `readAt` cannot (it is not in the input type); two asset ids of one content give one digest | a part of the review the digest forgot |
| `lib/deployment/reading/__tests__/mediaIds.test.ts` | both mints are stable, differ from each other, and pass `CANONICAL_UUID_PATTERN` | a provisional id that changes between the two requests |
| `lib/deployment/reading/__tests__/gather.test.ts` | `unrecognizedLogKey`: a declared surface key is returned whole; `xform:<an author's question id>` returns `xform-element`, an undeclared `<class>.<an author's key>` returns `undeclared-json-key`, a file path, a table's tag and an appearance's value return `other`, and the result holds no character of the planted name | an app's own names in a Sentry issue title |
| `lib/deployment/reading/__tests__/stream.test.ts` | `readBringInStream` over a `Response` whose body the test feeds in chunks that split a line: each stage and file event reaches `onEvent` once, in order, and the promise resolves with the `done` line's event; a body that ends after a stage line resolves `lost`; a `failed` line resolves `failed`; a line that is no JSON object of a known `type` resolves `lost` | a line lost at a chunk's edge; a dropped connection read as an answer |
| `lib/commcare/surface/__tests__/revision.test.ts` | `isDeclaredSurfaceKey` is true for a key some checked-in entry's `surfaceKeys` lists and false for a question id | an author's name passed off as a declared key |
| `lib/publish/__tests__/hqReadingCopy.test.ts` | every `ReadingRefusal` has a sentence and a status in `READING_REFUSAL_STATUS`; every `ReadingStage` has a label, the two media stages with a count and with none; every kind of `CreateAnswer` that is not `created` or `refused` has a lead, `changed` one for each thing `now` can hold; both forms of `READING_FAILED_COPY` answer with a name and with null; none holds an em dash or ends a label with an ellipsis; none holds "this reading", "that reading", "a reading" or "Nova's reading", the code's noun for what a person calls the app they are bringing in; no lead or refusal a `CreateAnswer` carries holds "Nothing was created"; and the leads of `read-again`, `check-failed` and `changed` with `already-in-nova` each hold "stay in its files" | a code with no words; the code's vocabulary shown to a person; a sentence that is false after a publish; an answer that can follow a publish and says nothing of the files it left (section 8) |
| `components/chat/__tests__/chatLifecycle.adoption.test.ts` | the thirteen-key receipt parses with its `adoption`; it is refused with a non-null `starter`, `designSessionId` or `changeSetId`, with a fourth key in `adoption`, with an unknown server, with a fourteenth key; the twelve-key receipts of the three existing births parse as before with `adoption: null`; twelve keys plus `adoption: null` is refused | an arm that loosens the strict boundary |
| `lib/mcp/__tests__/readingProgress.test.ts` | `readingProgressSink` over a recording emitter and the test's own clock: every `ReadingStage` sends one notification under its `hq_` tag with the stage's label; `files` events one a second at most, and always the one whose `done` is `total`; `done` and `failed` events send nothing | a stage with no tag; a client flooded by a count; a last count that never arrives |

### Routes

`app/api/commcare/bring-in/__tests__/routes.test.ts`, with the two service functions as the
controlled boundary (the routes are thin shells):

| Test | Catches |
|---|---|
| each route answers 401 with no session, 400 with `code: "invalid_input"` for a body that fails its schema or a `domain` that is no project space slug, 403 with `code: "no_project_access"` where `authorizeBringIn` answers null, and 413 for a body over `HQ_READING_REQUEST_MAX_BYTES`, each as JSON with its status and with no stream opened; the 400's body holds C1's sentence and no part of the Zod issue | an unauthenticated read; a refusal answered as a stream; a parser's message shown to a person |
| each route answers 200 with stage lines and then exactly one `done` line, for a stop, an account, a review and each kind of `CreateAnswer` | a stop thrown away as an error status; two last lines |
| a service function that throws: the stream ends in one `failed` line, and `[reading] failed` is logged once with the stage that was running | an error that ends a stream with no last line, or with a status nothing reads |
| `isPathAllowedOnHost(HOSTNAMES.main, p)` is true for both paths and false on the MCP and docs hosts | the proxy answering 404 in production |
| the read handler, called with a request whose signal the test aborts while the service's controlled read is pending, hands the service a signal that is then aborted; the create handler hands its service none | a closed tab that leaves a read running; a closed tab cancelling a create |

### Held by other parts' tests

- **The files.** The window a fetch runs in, a file's verdict, what `judgeReadingMedia` keeps, and
  what `publishKeptReadingMedia` writes are held by part 11's tests of `mediaStore.ts` (its
  "Tests"), with both peers controlled and no database.
- **The lookup ids.** Derived, stable, and of the layout `LOOKUP_UUID_V7_PATTERN` holds: part 11's
  (its "Tests").
- **An offered split that does not read back** is `read-back-differs` in a call that passes no
  choice of the person's: part 09's (its "Tests").
- **The two tools.** Progress on a call that carries a token, a cancelled `read_hq_app` aborting
  its HQ requests, and `bring_in_hq_app` sent twice answering the same app: part 13's (its
  "Tests").
- **The browser.** The flow, the stream as the page reads it, the landing through
  `landCreatedAppReceipt` and a reload during a create are Playwright's, in part 13's specs. The
  blank-app smoke that exists today covers the refactor of the blank path. Two landings must be
  among those specs, because no Vitest test can hold them: an app brought in to the Project the
  tab is looking at lands in the builder with no page load, and an app brought in to a second
  Project lands on `/build/{id}` by a page load, with the builder open on that app, part 13's
  landing toast shown once and no toast of C6.

---

## Contracts and docs these changes make false

Each text changes with the code it describes. Where an old sentence holds a dash this plan does
not print, the quoted words are the ones on either side of it.

**`docs/architecture/contracts.md`, app birth.**

- Old: "App birth comes from the Builder's explicit blank action, a reviewed architect checkpoint, or
  an ordinary authoring session's first valid checkpoint. All three use one genesis writer with
  identical admission:". New: "App birth comes from the Builder's explicit blank action, a reviewed
  architect checkpoint, an ordinary authoring session's first valid checkpoint, or bringing an app
  in from CommCare HQ. All four use one genesis writer with identical admission:".
- After "its session-to-app mapping and exact checkpoint receipt commit with the app.", new
  sentences: "`hq-adoption` is an app brought in from CommCare HQ: it is born `complete` from the
  reader's construction batch, with no holder, reservation, credit or design session. Its lookup
  tables, places, media edges and the adopted deployment with its claim on the HQ app commit in
  that one transaction; its media files are published before it, as ordinary ready files, and are
  all that can outlive a birth that fails."
- Old, the end of the receipt sentence: "the starter UUIDs); a persisted empty app, optional seed
  path, independently reconstructed starter, or pre-app placeholder row is forbidden." New: "the
  starter UUIDs, and on a brought-in app only, where it came from); a persisted empty app, optional
  seed path, independently reconstructed starter, or placeholder `apps` row is forbidden. A design
  session is a record of work toward an app and is never an app."

**`docs/architecture/contracts.md`, "HQ deployment safety".**

- Old: "are held from the publish that first carries them". New: "are held from the publish that
  first carries them, or from the birth that brought the app in".
- Old: "Only a publish or a migration records or replaces a hold that can still express what it
  holds;". New: "Only a publish, a migration or bringing the app in records a hold, and only a
  publish or a migration replaces one that can still express what it holds;".
- Old: "puts it back where the publish recorded it". New: "puts it back where it was last
  recorded".

**`docs/architecture/deployment.md`.** After "probe checks every saved app with the incoming
validator.", new sentence: "An app brought in from CommCare HQ is a saved app like any other and
passed this gate at its birth, so a rule that tightens ships its scan over saved apps first, and
that scan meets shapes only CommCare HQ's editors author."

**`docs/architecture/complex-apps.md`, a new section after "Export, publishing, and the deployment
record", "### Bringing an app in from CommCare HQ".** It is where the binding facts of the whole
feature are read once this plan has left `docs/plans/`. It is written here because this part owns
what its first paragraph states: an app comes in whole, or nothing is created. The three CommCare
HQ facts of its second and third bullets were read at `d6c6e16d8ae1`:
`corehq/apps/app_manager/models/applications.py::Application.scrub_source` calls
`corehq/apps/app_manager/util.py::update_form_unique_ids(source, ids_map={})`, which gives every
form whose id the map lacks a new random id;
`corehq/apps/api/resources/v0_4.py::ApplicationResource.dehydrate_module` reads each form's stored
`unique_id`; and `ApplicationBase._meta_fields` holds `version`, every key of which
`Application.export_json` deletes from the source it serves.

> An app that lives in CommCare HQ comes in as an ordinary Nova app exactly when a document and
> ledger rows exist such that the document passes the absolute gate and export readiness;
> publishing it back changes nothing a runtime, CommCare HQ's servers or existing data read,
> apart from the first-publish changes Nova declares; reading Nova's own emission of it gives
> the same document; and every item of the HQ app's source has one standing in the surface
> manifest. There is no partial bring-in: an app Nova cannot hold whole is answered with every
> finding it met, and nothing is created. `lib/commcare/CLAUDE.md` ("The reader") and
> `lib/deployment/CLAUDE.md` ("Readings", "Accepting a reading", "One HQ app, one Nova app",
> "Ending a deployment") own the detail. The binding facts:
>
> - **Nothing is kept until the app exists.** A read answers a stop, an account or a review and
>   stores nothing. A create reads the app again and creates it, in one transaction, only where
>   the digest of what it read is the one the person reviewed (`lib/deployment/reading`).
> - **The source and the resource are read as one bracket.** The stored source and the
>   application resource share no revision (`ApplicationBase._meta_fields`,
>   `Application.export_json`), so a reading brackets them with the app's version read before
>   and after, and reads again where it moved
>   (`lib/commcare/hq/appReading.ts::readHqAppForReading`).
> - **A form's own id needs API access.** The source read serves a freshly minted id for each
>   form (`models/applications.py::Application.scrub_source`, through
>   `app_manager/util.py::update_form_unique_ids`), and the application resource serves the
>   stored one (`api/resources/v0_4.py::ApplicationResource.dehydrate_module`). So bringing an
>   app in needs API access on the project space, checked when the space is chosen
>   (`lib/commcare/hq/apps.ts::probeHqApiAccess`) and again at the read, whose first request is
>   the application resource (`lib/commcare/hq/appReading.ts::readHqAppForReading`).
> - **CommCare HQ's ids stay on the project space they came from.** A brought-in app's menu
>   ids, form ids and `xmlns` are rows of `app_deployment_identities`, and its media paths rows
>   of `app_deployment_media_paths`, for that project space alone. Every other project space,
>   and the HQ app file, take Nova's derivation
>   (`lib/commcare/wireIdentity.ts::targetWireIdentity`).
> - **Spelling is free; behavior is declared.** Nova writes every form in its own spelling.
>   What a first publish changes beyond spelling is the closed register
>   `lib/deployment/reading/firstPublishChanges.ts::FIRST_PUBLISH_CHANGES`, drawn from
>   `lib/commcare/emissionRewrites.ts::EMISSION_REWRITES`, and the proof lane holds the
>   predicted set equal to the observed one on every app made in CommCare HQ
>   (`proof/first-publish-changes.json`).
> - **One HQ app, one Nova app.** A unique index over live app mappings holds it across
>   Projects (`lib/db/hqAppClaims.ts`).
> - **Project data comes in as copies CommCare HQ manages.** The lookup tables and places an
>   app reads are read for Preview and validation, refreshed before a publish, and never
>   written in the project space that manages them (`lib/lookup/CLAUDE.md`, "Tables from
>   CommCare HQ"; `lib/organization/CLAUDE.md`).

**Root `CLAUDE.md`.**

- Mental model 3. Old: "which a publish records." New: "which a publish records, or the birth of
  an app brought in."
- The `lib/deployment` entry of the map gains, at its end: "`lib/deployment/reading` is the other
  direction: two requests that read one CommCare HQ app, keep nothing between them, and create the
  app with its adopted deployment in one transaction."

**`lib/db/CLAUDE.md`.**

- Old: "`appGenesis.ts` is the ONE closed birth owner (`explicit-blank | design-slice`):". New:
  "`appGenesis.ts` is the ONE closed birth owner (`explicit-blank | design-slice | hq-adoption`):".
- After "`createExplicitBlankApp` (the Builder blank-app action) births the canonical survey starter
  `complete`.", new: "`lib/deployment/reading/birth.ts::adoptHqAppInTransaction` births an app
  brought in from CommCare HQ `complete`: it runs the same tail between the HQ app's claim and the
  adopted deployment's writers, and writes the app's lookup tables and places through the tail's
  `afterAppInsert` seam, after the app row is inserted and before the lookup context is read, so the
  gate and export readiness read the tables, and organization integrity reads the places, on the
  same transaction."
- Old: "Existing-app protocols lock the app first, while creation is the only shared-gate-first
  exception." New: that sentence, then: "A bring-in's birth is creation too: before the gate it
  locks, through the claim, at most one other app's row, and no row of the app it creates. It
  takes Project state only after the gate and after its app row is inserted."
- The placement paragraph. Old: "else the greatest fold baseline's snapshot, read by". New: "else
  the greatest fold baseline's snapshot (a cutover's holds, or the holds a brought-in app was born
  with), read by".

**`lib/deployment/CLAUDE.md`.** A new section, "Readings", after "Identities": "A reading
(`lib/deployment/reading`) is one request that reads one CommCare HQ app for one person into one
Project and stores nothing. `gather.ts::gatherReading` is the one function that decides whether an
app can come in: it reads the app under the save counter's bracket, reads the Project data through
`reading/projectData` (the one surface for tables, places and media), runs the reader, judges every
referenced file, and runs acceptance over every document a choice can make. `read.ts` answers a
stop, an account or a review with its digest. `create.ts` runs the same function again and goes on
only where the digest is the one the person reviewed and their answers are ones the review offers;
only then does it publish each file to the Project's library, run the check once more over exactly
what will be born, and create the app. No answer the review offers changes the digested document.
Every id is derived from the reading's id, so both requests name the same app.
`birth.ts::adoptHqAppInTransaction` is the one transaction (the claim, the genesis tail with the
tables and places in its seam, `recordAdoptedDeploymentInTransaction`). Before a create answers
anything but the app, it looks for the app once more, so a repeated create answers the same app in
every overlap. Both routes are under `/api/commcare/bring-in` and answer a stream of NDJSON lines;
the MCP tools call the same two functions. An app whose source is over
`HQ_BRING_IN_APP_MAX_BYTES` is refused. Client code imports the reading's types from
`lib/deployment`, never `lib/deployment/reading`, which is server-only."

**Code comments.**

| Where | Old | New |
|---|---|---|
| `lib/db/appGenesis.ts`, the file header | "every persisted app is born here, through one of exactly two provenances:" and its two entries | "every persisted app is born here, through one of three provenances:" and a third entry: "`hq-adoption` (`lib/deployment/reading/birth.ts::adoptHqAppInTransaction`): an app brought in from CommCare HQ, born `complete` from the reader's construction batch in the transaction that also writes its Project data and its adopted deployment." The paragraph that begins "Both provenances share ONE preparation" begins "Every provenance shares ONE preparation" |
| `lib/db/appGenesis.ts::GenesisGateRejectedError` | "for a design-slice candidate it is the executor's structured signal to amend the change set." | that sentence, then: "For an `hq-adoption` candidate it is Nova's defect: acceptance passed the same document, and the create answers `check-failed`." |
| `lib/db/apps.ts`, the CRUD section's comment (under the `CRUD` rule, after `projectHasApps`) | "`explicit-blank \| design-slice` genesis owner." | "`explicit-blank \| design-slice \| hq-adoption` genesis owner." |
| the same comment | "every persisted app is born through `createExplicitBlankApp` or the design-slice materialization, and no caller inserts an app row and seeds it later." | "every persisted app is born through `createExplicitBlankApp`, the design-slice materialization, or `lib/deployment/reading/birth.ts::adoptHqAppInTransaction`, and no caller inserts an app row and seeds it later." |
| `lib/db/placementAuthority.ts::PLACEMENT_RECORDING_KINDS` | "its `holdPlacements` entries are the recordings an editor's restore is held to." | that sentence, then: "A brought-in app's first recordings are the holds of its genesis baseline's snapshot, which no row of these kinds wrote." |
| `lib/db/placementRecords.ts`, the file header | "since a cutover writes its holds into each app's baseline rather than as mutations." | "since a cutover writes its holds into each app's baseline rather than as mutations, and an app brought in from CommCare HQ is born with them in its genesis baseline." |
| `app/(app)/build/actions.ts::CreatedAppReceiptPayload` | "Nova has exactly two ways an app is born" through "and both hand the client the same thing:" | "This action is one of the ways an app is born, and every one hands the client the same thing:" |
| the same comment | "it accepts this key set exactly." | "it accepts this key set exactly, and for an app brought in from CommCare HQ the same set with `adoption`." |
| `components/chat/ChatContainer.tsx::installCreatedApp` | "Nova has two ways an app is born, the design build's `data-app-materialized` frame and the blank-app action's return value, and both arrive here, so a new app cannot land two different ways." | "A creation receipt reaches this tab three ways: the design build's `data-app-materialized` frame, the blank-app action's return value, and the answer of `POST /api/commcare/bring-in/create` for an app brought in from CommCare HQ. All of them arrive here, so a new app cannot land two different ways." |
| `app/api/mcp/route.ts::maxDuration` | "(the v2 SDK has no protocol-level duration knob, so the platform cap here is the only enforcement)" | "(the v2 SDK has no protocol-level duration knob). Advisory only: on the Next `standalone` server nothing enforces this export, and the real per-request ceiling is the Cloud Run service's `timeoutSeconds`." |
| `app/api/mcp/dispatch.ts::MCP_MAX_DURATION_SECONDS` | "so this ceiling is per-tool, not bundled." | "so this figure is per-tool, not bundled. It is advisory: nothing at run time reads it or `route.ts`'s `maxDuration`, and the service's request timeout is the real ceiling." |

No value changes in either MCP file. `lib/apiError.ts`'s comment that lists the request budgets
gains one line, in its own form: "`HQ_READING_REQUEST_MAX_BYTES`: the bring-in routes' bodies (a key
to read, a review's digest with a name and a few answers to create)." `lib/deployment/index.ts`'s
header ("Client surfaces import types and pure helpers from here; only server modules reach the
store, the preflight, and the service.") stays true as written: this part adds the reading's types
to it and nothing that runs on a server.

**`components/builder/CLAUDE.md`, "Creation never navigates".** Old opening: "Both ways an app
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

**`lib/collab/CLAUDE.md`.** Old: "The design build's `data-app-materialized` frame and the
blank-app Server Action return the same authoritative receipt:". New: "The design build's
`data-app-materialized` frame, the blank-app Server Action and the bring-in's create route return
the same authoritative receipt (the last with one more key, `adoption`):". Its sentence "A malformed
or cross-scope receipt opens no stream and preserves the local doc for reload recovery." stays true
and gains: "A brought-in app's receipt for another Project is the one cross-scope receipt that is
expected: the tab loads that app's page and never activates its own reconciler for it."

**The research's contract row** "the closed birth vocabulary gaining `hq-adoption`": settled by the
`contracts.md` and `lib/db/CLAUDE.md` sentences above.

**Public docs.** The page that tells a person how to bring an app in is part 13's (its section
17.1). Nothing this part builds is said to a person anywhere else.

---

## Departures

Where this part departs from the outline, the research or a contract of the repo, and the
alternatives it weighed and did not take. The numbers other parts cite are kept, so the list has
gaps.

1. **The order of the birth: the tables and the places are written inside the genesis tail**,
   through a new seam after the app row is inserted (6.2, 6.3). Part 11 holds the same order: its
   7.4 and 11.4 run both writers through `afterAppInsert`, the tables and then the places. Not
   done: the order "claim, lookup tables, media edges, genesis sequence 1, places, the adopted
   deployment", with the tables written before the tail and the places after it. Evidence, for the
   tables: the membership gate that order writes the tables behind is the tail's own first
   statement, so "after the gate and before the tail" is no position a statement can stand at
   unless the birth takes the gate a second time on its own; and Project state before the
   membership gate can close a lock cycle with a lookup writer and a membership write, where every
   app-bound lookup writer takes the gate first (`lib/lookup/agentService.ts`). Evidence, for the
   places: `app_locations` references `apps(id)`, so they cannot precede the app row; and the
   tail's `applyOrganizationCommitIntegrity` is where a document and its places are proved to agree
   (placements, values, reverse hops), which every later commit of the app runs, so a copy written
   after it would commit unjudged and could fail the person's first edit instead of the birth.
   That no document names a place, so the integrity step has no edge to resolve, is true and is
   not the reason the step matters (6.2). The claim, the tables, the media edges, sequence 1, the
   places and the adopted deployment are all still written, in one transaction.
2. **Lookup table and column ids are derived; row ids are the lookup writer's.** Table and column
   ids are a function of the reading's id and CommCare HQ's own names (2.3). Row ids are minted by
   the lookup writer inside the transaction, as today. Not done: minting table, column and row ids
   alike at the read. Evidence: no document slot holds a row id
   (`lib/doc/lookupReferences.ts::LookupReferenceTargetSet`), so the candidate needs none, and a
   retried transaction may mint them again at no cost.
6. **The birth's own refusals are `read-back-differs`, answered `check-failed`** (6.5). A person
   meets one situation and one next step. A developer tells the birth from acceptance by
   `detail.name`'s `birth-` prefix and by the log line. Not done: a circumstance code of its own,
   whose block said the same thing in other words.
9. **The birth diffs nothing.** The reader returns the construction batch: part 06 makes it inside
   the reader, as `ReadDraft.batch`, by `diffDocsToMutations(emptyBlueprintDoc(appId), doc)` (its
   2.2). So the document acceptance judges and the birth writes is that batch's reduction, and
   this part holds no second derivation to prove equal (3.3, 6.2). Not done: running that diff
   again at the birth over the reader's document.
10. **The activation receipt's arm is a second exact key set**, not a new key on every receipt
    (7.1), so a tab from before the deploy still lands a build that ends after it.
11. **`GenesisGateRejectedError` gains `check` and `findingCodes`**, so a refusal can be logged and
    worded without the app's words.
12. **What a table that changed under the birth becomes.** The create answers `read-again` and the
    caller reads the app again (6.5). Part 11 says the same of this part (its 7.4). Not done:
    answering `BroughtInTableChangedError` and `tag_taken` at the birth with a stop that tells the
    person to choose in the review. Evidence: the review the person holds at that moment is the one
    made before the table changed, which shows no such choice, so the words would point at a
    control that is not there. The fresh read's review holds the choice, and a create that then
    leaves it unanswered is refused `choice_missing` (5.3, step 6).
13. **What a `choice` table is bound to before its answer.** It is bound, with no answer, as
    `use-commcare-hq` binds it: the Project table's id, its columns by name, derived ids for the
    fields it lacks (5.2). Part 11's 7.4 holds the same rule. Not done: binding it to its derived
    ids until the person answers. Evidence: a create goes on only where the digest of what the
    person reviewed still holds, and the digest covers the document. Under a binding to derived
    ids the reviewed document names those ids and the created one names the Project table's, for
    either answer, so every person who met a choice would be sent back to the review by their own
    answer. Under this binding both answers leave every id the reader reads where the review had
    it.
15. **From `components/builder/CLAUDE.md` ("Creation never navigates"): one landing loads a page.**
    A brought-in app lands in the builder through the one activation receipt (7), and an app
    brought in to a Project the tab is not scoped to lands by a full load of `/build/{id}`, after
    its receipt is parsed (7.3). Evidence: `ChatContainer.tsx` refuses a receipt whose Project is
    not the session's, in both existing landings, and `lib/collab/CLAUDE.md` gives the reason ("A
    malformed or cross-scope receipt opens no stream"); the flow itself offers another Project at
    its first screen (part 13, section 4.1). The rule against navigating protects a live run and a
    held document, and this landing has neither.
18. **Weighed and not taken: keeping a file's bytes between the two requests**, under the media
    contract's `pending/` prefix, so that a create need not fetch them again. It would cost a
    storage layout with no asset row, a second publication path from stored bytes, a third path
    for bytes that lapsed after the bucket's one day (`config/media-bucket-policy.json`), ids
    reserved to name the objects, and bytes of an app at rest in Nova for a person who may never
    create it. The ordinary app pays about two seconds for the second fetch (3.7), and the tail is
    bounded by the export ceiling (3.4). So one path is built: fetch, judge, and at a create
    publish.
19. **Weighed and not taken: a reader and an acceptance that yield to the event loop inside a
    run**, so that no piece is long whatever an app's size (3.6). `readHqApp` is one synchronous
    pure function (part 06, section 2.2) and acceptance calls it whole. Making both resumable is
    more change than one constant and one test, for apps of a size nothing here has seen: the cap
    is set where the measured rate leaves each piece short, and the test at the cap holds it.
20. **Acceptance has one mode and takes no choice of the person's** (3.3). Not done: a mode that
    judges everything but the files before they are fetched, and a create that hands acceptance
    the chosen declaration so that the split document is checked only once it is chosen. The
    first would cost every read with files a second pass over the whole app, to say a little
    sooner what is Nova's own defect and is logged at error. The second let a review offer a
    split that then failed after the person pressed Bring it in, and made the create run a check
    the read never ran.
21. **The surface manifest's revision is not in the digest** (5.2). Not done: digesting it, so
    that a deploy between the review and the create that changed what Nova holds sends the person
    back. Every effect such a deploy can have on this app already shows elsewhere: a different
    reading changes `document` or `review`, a new finding turns the fresh read into an account,
    and a different first-publish list changes `review.runsOn[].firstPublish`. And the create
    builds from its own fresh read, never from what the client sent. So the revision could only
    send a person back to a review that is word for word the one they answered, for a change that
    touched nothing of their app.
22. **An MCP call has no deadline of Nova's own** (4.4). Not done: a timer under the 300 seconds
    the MCP route names. Nothing at run time reads that number, so the timer would be the only
    limit there is, and it would throw away a create that was about to finish, only for the
    client's retry to fetch the files again.
23. **Weighed and not taken: a stored reading**, a row that keeps an account or a review between
    the read and the create and lists the apps a person is part way through bringing in. A read
    is one request of seconds at real sizes (3.7), so nothing is ever part way in. A stored
    account would show a list CommCare HQ may have left, where reading again costs seconds and
    says exactly what Nova holds now. And a stored record would need a table, its states, its
    retention, its place in a Project move and a way to remove it, each of which exists only to
    keep the record. What a row would have remembered is derived instead (2.2, 2.3).

**The outline, item by item where it touches this part.**

| Outline item | Settled |
|---|---|
| 2, "The `hq-import` birth owner, the third owner" | here: the owner is `hq-adoption`, the fourth caller (6); "import" names the other direction in code and copy (`../6-bring-in.md`, "What changed from the outline, and why", "One name") |
| 2, "Lookup tables and media are materialized in Project storage atomically with sequence 1" | here: tables, places and media edges commit with sequence 1 (6.3); media bytes are published before it (6.1), which is the only order bytes allow |
| 2, the HQ app "recorded in the deployment ledger as explicitly adopted"; the identities table's privilege | part 10; this part calls its writer inside the birth |
| 5, entry points "each confirming the platform declaration before the app exists" | the declaration is a preselected choice of the review and never a gate before the app exists (part 13, section 8.3); here it is `BringInInput.runsOnlyOn` and `splitDatetime`, validated against the review (5.3). The entries are part 13's |
| 9, "the `hq-import` birth writes the declaration confirmed" | here: the chosen declaration's mutations end the construction batch (6.2). The proposal itself, and the finding for an app that runs on neither platform (`no-platform-runs-everything`), are the reader's (part 06, 16.3); media narrows the offer here (5.1) |
| 9, "Defect 20's confirmations" and 10, "Confirmations" (asking `form-entry-sync-off` and `commtrack-off`, probing same-type child links, at import) | not asked at a bring-in: the birth records only the plan features the source already uses (part 10, 6.5) and leaves the project-space settings to the first publish |
| "Cutover and migration" | none in this part: no table, no migration, no scan |
| "Contracts", "the `hq-import` birth owner" | here ("Contracts") |

---

## Files

New:

| File | Holds |
|---|---|
| `lib/deployment/reading/types.ts` | client-safe: the types, schemas and constants of section 3's table (3.1, 4.1, 4.3, 5.1, 5.3) |
| `lib/deployment/reading/appId.ts`, `mediaIds.ts` | the derived ids (2.3, 5.2) |
| `lib/deployment/reading/gather.ts` | `gatherReading`, `gatherFromHq`, `checkFetched` and their types; `unrecognizedLogKey` (3.3, 10) |
| `lib/deployment/reading/read.ts` | `authorizeBringIn`, `BringInActor`, `readHqAppForReview` (3.1) |
| `lib/deployment/reading/digest.ts` | `reviewDigestOf`, `ReviewDigestInput` (5.2) |
| `lib/deployment/reading/create.ts` | `createFromReview`, `movedBindingCount` (5.3, 6.5, 6.6) |
| `lib/deployment/reading/birth.ts` | `adoptHqAppInTransaction`, `AdoptionBirth`, `AdoptionOutcome`, `adoptedDeploymentWrite`, `adoptedAppReceipt`, `readBackAdoptedAppReceipt` (6.2, 6.3, 7.1) |
| `lib/deployment/reading/stream.ts` | client-safe: `readBringInStream` (4.3) |
| `lib/deployment/reading/index.ts` | `import "server-only"`: `authorizeBringIn`, `readHqAppForReview`, `createFromReview` |
| `lib/deployment/reading/__tests__/`: `read.postgres.test.ts`, `create.postgres.test.ts`, `birth.postgres.test.ts`, `cap.test.ts`, `create.test.ts`, `appId.test.ts`, `digest.test.ts`, `mediaIds.test.ts`, `gather.test.ts`, `stream.test.ts` | "Tests" |
| `lib/deployment/reading/__tests__/adoptionFixture.ts` | `adoptFixtureApp`, the create tests' fixture, exported for part 13's `e2e/lib/bringInSeed.ts` ("Tests") |
| `app/api/commcare/bring-in/read/route.ts`, `app/api/commcare/bring-in/create/route.ts`, `app/api/commcare/bring-in/__tests__/routes.test.ts` | the two routes (4.1). Neither exports `maxDuration` |
| `lib/publish/hqReadingCopy.ts`, `lib/publish/__tests__/hqReadingCopy.test.ts` | "Copy", C1 to C9 |
| `lib/commcare/surface/revision.ts`, `lib/commcare/surface/__tests__/revision.test.ts` | `isDeclaredSurfaceKey` (10) |
| `components/chat/__tests__/chatLifecycle.adoption.test.ts` | 7.2 |
| `lib/mcp/__tests__/readingProgress.test.ts` | 4.4 |

Changed:

| File | Change |
|---|---|
| `lib/db/appGenesis.ts` | `WritePreparedGenesisArgs.afterAppInsert` and its call; `GenesisGateRejectedError.check` and `findingCodes`; `AppAdoption`, `AdoptedAppReceipt`; the header (6.2, 7.1, "Contracts") |
| `lib/apiError.ts` | `HQ_READING_REQUEST_MAX_BYTES` and its line in the budgets comment (4.1) |
| `lib/deployment/index.ts` | re-exports, as types only, what a client component needs of a bring-in: from `reading/types.ts`, `ReadingKey`, `ReadingAnswer`, `ReadingReview`, `ReviewTable`, `ReviewPlaces`, `ReadingDeclarationChoice`, `ReadingStage`, `ReadingEvent`, `ReadingRefusal`, `BringInInput`, `CreateAnswer`; from `lib/db/appGenesis.ts`, `AdoptedAppReceipt`; and from part 11's `reading/projectData/reviewTypes.ts`, `LookupTableChoice`. It exports no function of `read.ts`, `create.ts` or `gather.ts`: client components import this file today (`components/builder/PublishPanel.tsx`, `PublishDialogBody.tsx`, `DeploymentStatus.tsx`), and those modules reach Kysely, `pg` and `lib/commcare/hq`. A client module that needs a value of `reading/types.ts` or `reading/stream.ts` (the schema, the stages, the stream's reader) imports that client-safe file itself. Routes and MCP tools import `@/lib/deployment/reading` |
| `lib/mcp/progress.ts` | `ProgressStage` gains the seven `hq_` tags; `readingProgressSink` (4.4) |
| `lib/mcp/context.ts` | `McpCallExtra`'s `mcpReq` gains `signal?: AbortSignal` (4.4) |
| `app/api/mcp/route.ts`, `app/api/mcp/dispatch.ts` | the two comments ("Contracts"); no value |
| `components/chat/chatLifecycle.ts` | the second key set; `AppMaterializationActivation.adoption` (7.2) |
| `components/chat/ChatContainer.tsx` | `landCreatedAppReceipt`; the blank path calls it; the comment (7.3) |
| `app/(app)/build/actions.ts`, `lib/db/apps.ts`, `lib/db/placementAuthority.ts`, `lib/db/placementRecords.ts` | comments only ("Contracts") |
| `lib/db/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `components/builder/CLAUDE.md`, `lib/collab/CLAUDE.md`, the root `CLAUDE.md`, `docs/architecture/contracts.md`, `docs/architecture/deployment.md`, `docs/architecture/complex-apps.md` | "Contracts" |

Not changed, and held so by a test or by reading: `lib/hostnames.ts`, `proxy.ts`,
`config/runtime-capabilities.json`, `scripts/rollout/render-build-config.mjs`, `cloudbuild.yaml`,
`lib/case-store/migrations/**`, `lib/db/pg.ts`, `lib/db/privilegeConvergence.ts`,
`lib/db/runtimeDatabaseProbe.ts`, `lib/db/appTests.ts`, `lib/models.ts`, `scripts/test-schema.ts`,
`lib/doc/**`.
