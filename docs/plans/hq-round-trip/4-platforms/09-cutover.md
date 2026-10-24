# Step 4, part 09: The cutover and its notice

Part of [step 4's plan](../4-platforms.md), which holds the baseline, the decisions, the exit and
the stack. Stack references use the fifteen pull requests by number. This part plans pull request
13, the cutover, and pull request 15, the removal, in full, and names what each takes from the
pull requests beneath it. Citations are `path::symbol` for Nova at `main` `e9e6cd93`; Nova's own
history is read with `git show` at `733dd193` (#789, step 3's cutover, the last commit holding
its tooling), `5cf6e327^` (the last commit holding step 2's) and `4436ba2e` (step 2's plan). This
part makes no CommCare claim of its own: every CommCare fact it relies on is a fact of another
part, cited there at the pins (commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`,
commcare-android `7a5584475580`, formplayer `24383ac71bfb`, commcare-connect `046c7fd78081`,
Vellum `01215f251c57`).

From step 4 every app says where it runs (`appSettings.runsOnlyOn`, pull request 4), and a feature
or a media file a declared platform cannot run is refused. Step 4 changes the stored shape of a
Nova document by one optional key, so the cutover is lean: it gives each existing app the
declaration its content allows, splits each date-and-time question where that is the only way the
app runs anywhere, removes each media reference a declared platform cannot play, records every
media file's format from its stored bytes, and tells each app's members what changed. It writes
through the production commit path, one `blueprint-migration` batch per changed app, with no fold
horizon, no frozen old-shape reader and no emission census. It reads Nova's own database and
Nova's media bucket, and no CommCare HQ state.

One production read was made while planning: a content-free, read-only scan the person approved
(Executed during planning). No count from it enters this plan; what it found is stated where it
decides something (sections 5, 7 and 11). Every count the cutover meets is taken by its own advisory
runs before the window, and every class those runs can find has a planned transform or is a blocker
with its remedy (section 11).

| Section | Owns | Pull request |
|---|---|---|
| 1 to 11 | why no horizon, the holders, the write path, the scripts, the transform, identities and the digest, the media backfill, the ledger in the window, the fleet transaction, postconditions, blockers | 13 |
| 12 | the notice: cutover id, lead, reasons, renderers | 13 |
| 13 and 14 | the Job, its allowlist arm, the bundle, the runbook | 13 |
| 16 | the removal and the cutover's trace | 15 |

**This part is the registry.** Step ids, blocker codes, notice reasons, the Job, the tool and the
migration names below are spelled once here, and other parts use these strings verbatim. The names
of code another pull request lands are that part's, cited here: pull request 7's media API is part
04's, pull request 4's detectors part 01's, and pull request 3's split planner part 03's.

---

## Decisions in brief

1. **No fold horizon.** The declaration is an optional key whose absence means both platforms, so
   every immutable fold baseline and every `app_changes` row still parses under step 4's schema,
   and the cutover writes ordinary admitted mutations (section 1).
2. **One `blueprint-migration` batch per changed app**, through
   `lib/db/apps.ts::appendSyntheticBatchInTransaction`, inside one fleet transaction: actor
   `system:hq-round-trip-platforms`, batch id `hq-round-trip-platforms:<appId>`. The production
   diff, reducer, gate, media admission and edge writers do the writing; the cutover writes no
   blueprint row by hand (section 3).
3. **The transform is production code plus one cutover step.** The declaration and the split come
   from one pure function every editor's consumer shares,
   `lib/doc/platformDeclaration.ts::planContentDeclaration` (pull request 4), which the fuzz
   mapping also reaches through its thin applier `declaredForContent` (part 08 §3.4); only the
   media removal is the cutover's own (section 5).
4. **Neither platform is a blocker, never a guess.** An app whose content runs on neither platform
   is split only where every use Web Apps cannot run is a date-and-time question; any other such
   app is a blocker the author resolves before the window (section 11).
5. **Every ready image, audio and video row gets its format, from its bytes only where its MIME
   cannot give it.** A row whose stored MIME has exactly one variant and whose body check is the
   one its upload ran takes that variant without a byte read; every other row is classified from
   its stored bytes through the production classifier, inside the Job, under a time-conditioned
   bucket read grant that is revoked and read back after each use, following step 2's KMS
   precedent. The grant is made only where a run must read bytes, which the `media` line shows
   (section 7). Production holds image rows alone (JPEG and PNG), so there no byte is read and no
   grant is made unless a row that needs bytes arrives before the window.
6. **The window applies step 4's five ledgered migrations inside the fleet transaction, in two
   phases**: the column drop, the confirmation kind, the format column and the capture size check
   before the backfill; the format CHECK's validation after it (section 8).
7. **Its own Job**, `commcare-nova-hq-round-trip-platforms`, because the cutover needs
   `NOVA_MEDIA_BUCKET`, which no existing contract carries; its stored arguments are the dry run
   (section 13).
8. **The plan digest stays**: the in-window dry run prints it and
   `--execute --expect-plan-digest` refuses a different plan (section 6).
9. **No census and no frozen reader.** Step 3 needed both because its old documents no longer
   parsed and its lift rebuilt every tree by a second path; step 4's sources parse under the head
   schema and its targets are made and replayed by the production reducer (section 4).
10. **Private work is left alone.** Staged steps parse under step 4's schema; a workspace based on
    a sequence the cutover moves meets the existing stale-base refusal, which keeps its work
    (section 2).
11. **The notice** gains cutover `hq-round-trip-platforms`, its lead, three document reasons and one
    deployment reason, and reuses `next-publish-asks-more` and `deep-links-need-republish`
    (section 12).
12. **No announcement.** Nova is dogfooded by its own author; the runbook has no announcement step
    and the scan has no address list.
13. **No `RUNTIME_VERSION` and no `MODEL_CONTEXT_VERSION` value of its own**: pull request 8 moves
    the first for Preview's per-platform runtime, and pull requests 8, 10 and 12 move the second.
14. **Derivation drift is counted, then converged after the deploy.** The cutover writes no case
    schema, but the merged code derives some stored properties' types differently from `main`'s
    (pull request 3's rule R2, pull request 10's context types; part 03 §10, counts 1 and 3). The
    dry run counts that drift against the stored `case_type_schemas` rows as a report line, never a
    blocker, and the window runs the existing drift writer after the deploy and before ingress
    reopens, as step 3's window did (sections 6, 10 and 14).

---

## 1. Why no fold horizon

Every canonical fold strictly parses its baseline before replaying anything:
`lib/db/canonicalMutationFold.ts::foldSuffixCore` runs `blueprintDocSchema.parse` over
`app_change_fold_baselines.snapshot`, and both `replayCanonicalAppChangeSuffix` and
`foldCanonicalAppChangeSuffixBounded` go through it. The baselines are an immutable control table
(`lib/db/CLAUDE.md`, "`app_changes` is permanent history"). A required new key, at the root or
inside `appSettings`, which is a `z.strictObject` (`lib/domain/blueprint.ts::appSettingsSchema`),
would make every stored baseline fail that parse and force a horizon, as step 2's required
`appSettings` root did ("requires slots no earlier document holds", `lib/db/CLAUDE.md`).

Step 4's key is optional, and its absence is the state every existing app is in: Web Apps and
Android (pull request 4, `appSettings.runsOnlyOn?: "web-apps" | "android"`). So:

- **Every baseline still parses.** A snapshot without the key passes the strict object with an
  optional member.
- **Every history row still parses.** `lib/db/persistedJson.ts::parsePersistedAppChangeEnvelope`
  admits each stored `setAppSettings` patch, which names only `showSavedForms` and
  `showIncompleteForms`; both stay optional in pull request 4's explicit patch. Every other
  mutation kind step 4 touches gains only optional keys (`convertField`'s `label` seed, pull
  request 3).
- **No DDL for the key.** `apps.app_settings` is jsonb, and the fold snapshot function
  (`nova_current_app_change_fold_snapshot`, last defined in
  `lib/case-store/migrations/20261015030000_app_settings.ts`) passes it through verbatim as
  `jsonb_build_object('appSettings', app.app_settings)`.
- **Every fold's final gate passes.** `replayCanonicalAppChangeSuffix` gates the folded head with
  `evaluateCommit`. A changed app's suffix ends in the cutover's `blueprint-migration` batch, whose
  target passed the absolute gate; an unchanged app's head is one the transform judged clean under
  step 4's gate (section 5).

`docs/architecture/contracts.md`, "Valid by construction", asks that mutation-bearing changes after
the active baseline always replay, and they do. The contract's other route, a horizon, is not
taken, so `lib/db/CLAUDE.md`'s "accepts exactly five identities" and every migration that admits a
baseline identity stay as they are.

**The window is still needed.** The previous revision's `appSettingsSchema` is strict, so every
strict load of an app the cutover declares for one platform throws on it (builder load, chat, MCP,
autosave's base, the runtime probe), and its `setAppSettings` arm, `.partial().strict()`, refuses
the batch's patch in every stream reader. And the column drop (section 8) is not additive. So the
cutover is a direct maintenance cutover (`docs/architecture/contracts.md`, "Direct maintenance
cutover"): ingress closed, holders drained, one final-shape write, the new image proving it reads
the shape before ingress resumes.

## 2. What else holds state the cutover touches

| Holder | Today | The cutover |
|---|---|---|
| Open builder tabs | a non-collaboration row in a stream suffix forces a reload (`lib/db/CLAUDE.md`: "The browser collaboration wire accepts only `autosave \| mcp \| chat`"); `NEXT_DEPLOYMENT_ID` reloads a stale client | nothing new |
| Private agent work: open `authoring_workspaces`, `authoring_sessions.active_candidate_id`, open `design_change_sets` | staged steps in step 3's dialect | left alone. Every staged step parses under step 4's additive schema. A workspace based on a sequence the cutover moves meets the designed stale-base refusal when it commits (`lib/agent/change-set/CLAUDE.md`: "Even a compatible intervening canonical edit refuses; there is no implicit rebase", and it "preserves private work with an actionable conflict"). No notice line: nothing is discarded |
| Pre-app build sessions | an open genesis workspace | left alone. Its genesis is born declaring both (`NEW_APP_SETTINGS` is unchanged), and the absolute gate at birth judges it as it judges any new app |
| `events` `mutation` rows | `lib/log/types.ts::mutationEventSchema` embeds `mutationSchema` | nothing: the schema change is additive, so every row still parses |
| `chat_stream_chunks`, `presence`, `threads.active_*` | stream holders | nothing beyond the drain |
| Run leases, paused runs, unsettled reservations | `apps` lease columns, `design_sessions` | settled by `--settle-holders` through the production reapers before the write; any left stops the write (section 9, step 2) |
| Actor generation gates | `lib/db/actorGenerationGate.ts`, the first lock of every holder lifecycle transaction | not taken. The fleet transaction claims, settles and releases no holder, and with ingress closed no lifecycle path runs; a reaper that `--settle-holders` runs takes its own gate in its own transaction before the fleet transaction opens. Holding every app row `FOR UPDATE` without a gate cannot deadlock against a path that takes the gate first and the app row second |
| App tests | `lib/db/appTests.ts::RUNTIME_VERSION` | pull request 8's, not the cutover's |
| Entry-point links | `lib/deployment/entryPointLinks.ts::getEntryPointLink` refuses a link whose manifest's `sourceSequence` differs from the app's | a changed app's sequence moves by one, so each live deployment of a changed app with entry points gets `deep-links-need-republish` (section 12) |
| Deployment ledger | baselines, confirmations, `app_deployments.target_web_apps_enabled` (production holds it `true` on some deployments and null on most, the planning scan) | baselines untouched; no confirmation is written, because a person's answer cannot be made up and the next publish asks for each one; the column is dropped by the window's ledger (section 8). Nothing reads the dropped values afterwards: the setup artifact reads the declaration (part 05 §6, §7), and step 4's `next-publish-asks-web-apps` reads the stored baselines, never the column (section 5) |
| `case_type_schemas`, expression indexes | equal `main`'s derivation (runbook step 1(a)) | never written by the cutover. The transform changes no derivation by rule (the split keeps the case write on the original field, with the same property and type), and the plan proves it per app (section 5, step 3). Where the merged code derives a stored property's type differently from `main`'s, the dry run counts the drift (section 6, `schema-drift`), and the existing drift writer converges exactly that after the deploy, with ingress still closed (section 14, step 10) |
| `media_assets` | no format column; production holds ready JPEG and PNG rows and document rows, and no audio or video row (the planning scan) | every ready image, audio and video row gains its format; no row is deleted, the unplayable included (section 7) |
| Lookup, location and media reference edges | `lookup_table_references`, `app_location_references`, `media_asset_refs` | rewritten by the synthetic writer through the kernel's own functions for each changed app |
| Staged captures, in-flight submissions | fenced by path and `app_mutation_seq` | nothing; the fences hold |

## 3. The write path

`lib/db/apps.ts::appendSyntheticBatchInTransaction(tx, args)` composes
`commitPreparedSyntheticBatch` into the caller's transaction. Its contract, read at `e9e6cd93`:

- **Arguments** `{ appId, expectedBaseSeq, targetDoc: PersistedBlueprint, authority, batchId }`.
  System authority is `{ kind: "system", actorId: "system:<task>", reason }`; `syntheticActorId`
  refuses a blank name or reason; the actor id is the durable `app_changes.actor_id`, and the
  reason is not stored.
- **Idempotency.** It locks the app row (`canonicalCommitKernel.ts::lockAppRow`, which does not
  filter `deleted_at`), then reads `app_changes` for `(app_id, batch_id)`: a hit returns
  `{ kind: "deduped" }` before the sequence check. `UNIQUE (app_id, batch_id)` is the latch.
- **Basis.** `mutation_seq` must equal `expectedBaseSeq`, or it throws
  `BlueprintCommitRejectedError`. A system authority loads the source through
  `loadSchemaAdmittedAppSnapshotFromRowInTransaction` (a strict schema parse with no gate on the
  source).
- **Replay.** The target is first hydrated (`prepareSyntheticBatch`:
  `lib/doc/fieldParent.ts::hydratePersistedBlueprint(targetDoc)`), then
  `lib/doc/diffDocsToMutations.ts::diffDocsToMutations(source, hydrated)`, `admitMutationBatch`
  and `prepareMutationCandidate`; the replay must equal the target under `deepEqual` of
  `toPersistableDoc`, or it throws "The requested repair cannot be represented as a deterministic
  mutation batch." A rename-shaped case-property delta throws
  `CasePropertySemanticProvenanceRequiredError`, mapped to a refusal. An empty diff returns
  `{ kind: "noop" }` and writes nothing. A non-empty one is refused where
  `lib/doc/mutationTargetAdmission.ts::mutationTargetsInvalid(source, mutations)` holds.
- **Gate.** `evaluatePreparedMutationCandidate` with the lookup context
  `lookupContextForAuthoritativeWrite` reads: the full absolute gate on the target.
- **Edges, in order, in the caller's transaction**: `admitExactMediaReferences` (from pull request
  7, platform-aware), `applyOrganizationCommitIntegrity`, `replaceLookupReferenceEdges`, then
  `canonicalCommitKernel.ts::writeCommittedBatch` with `kind: "blueprint-migration"`, which writes
  the entity diff, the `app_changes` row and the denormalized `apps` columns, and calls
  `notifyAppStream` (delivered on commit).
- **What it does not do.** It checks no holder and no design session; it runs no case-store Phase
  A; it handles no rename plan. The caller makes the fleet quiescent (section 9), and the
  transform changes no case-store derivation (section 5).

The cutover calls it once per changed app:

```ts
await appendSyntheticBatchInTransaction(tx, {
	appId,
	expectedBaseSeq: plan.baseSeq,
	targetDoc: toPersistableDoc(target),
	batchId: `hq-round-trip-platforms:${appId}`,
	authority: {
		kind: "system",
		actorId: "system:hq-round-trip-platforms",
		reason: "Record where the app runs, and make its questions and media run there",
	},
});
```

and requires `{ kind: "committed", seq: baseSeq + 1 }`; `deduped` or `noop` stops the run as a
postcondition failure, because the already-applied check (section 4) and the plan exclude both.

The precedent is `scripts/lib/caseSelectionMigration.ts::migrateCaseSelectionEntry` (#620), which
writes per app through the same function with `system:case-selection-cutover`. It ran with ingress
open, one transaction per app, taking each holder's actor gate and abandoning open workspaces. The
platforms cutover runs with ingress closed in one fleet transaction, so it takes neither step
(section 2).

## 4. Scripts and their layout

```
scripts/scan-hq-round-trip-platforms.ts        read-only scan: holders, the plan without media bytes, blockers
scripts/migrate-hq-round-trip-platforms.ts     the Job's entrypoint; a dry run unless told otherwise
scripts/lib/hqRoundTripPlatforms/
  source.ts      the fleet read: every app (deleted included), its live deployments and baselines, every ready media row
  media.ts       the classification: one read per stored object, through an injected object reader
  transform.ts   pure: one app's source -> { target, changes, notice entries, blockers }, the four steps of section 5
  removals.ts    pure: the mutation that removes each media carrier
  notice.ts      pure: changes and deployments -> notice entries
  plan.ts        the fleet source -> PlatformsCutoverPlan and its digest
  holders.ts     step 3's file (733dd193:scripts/lib/hqRoundTripExpressions/holders.ts), copied
  ledger.ts      the ledger read and the two-phase savepointed migrator (section 8)
  writer.ts      the one fleet transaction
  report.ts      the content-free JSON Lines report
  run.ts         the modes
  types.ts       step ids, blocker codes, stop codes
  __tests__/
    postgresSeed.ts   raw-SQL seeding at main's migration prefix (section 15)
```

`source.ts` also reads, inside the same fleet read transaction, each app's drift against its stored
`case_type_schemas` rows through `scripts/lib/schemaDrift.ts::computeSchemaDrift(tx, appId,
toPersistableDoc(source))`, the function `scan-schema-drift.ts` and `migrate-schema-drift.ts`
use, so the cutover's count and the drift writer's work are one computation (section 6,
`schema-drift`). It is a plain `SELECT` of `case_type_schemas`, so the scan runs it too.

Both scripts follow the house conventions: first line `import "./lib/loadEnv";`, `commander`,
`scripts/lib/main.ts::runMain`, and `closeCaseStoreDatabase()` from
`lib/case-store/postgres/connection.ts` in a `finally`.

**Arguments.**

| Script | Argument | Meaning |
|---|---|---|
| scan | (none) / `--prod` | the plan over the local database or production (`scripts/lib/prodDb.ts::targetProdDb`), in one `REPEATABLE READ, READ ONLY` transaction of plain `SELECT`s. It reads no media bytes: its `media` line counts the rows the Job will classify, by kind and stored MIME, with `needsBytes`, the rows whose bytes the Job must read (section 7), and its plan removes no media reference and drops the export-readiness code `MEDIA_FORMAT_NOT_PLAYED` (pull request 7), which only a classification can decide. It prints no digest |
| scan | `--app <id>` | one app |
| scan | `--debug-details` | with `--app`, that app's blocker places by entity id and name with each finding's message, and its planned changes with names, on the operator's terminal only; never archived |
| migrate | (none) | the dry run: the fleet read, the classification (a byte read only for a row that needs one, section 7), the full plan, the report and `planDigest`; writes nothing and applies no DDL. The Job's stored arguments |
| migrate | `--prove-media-read` | reads the metadata of one stored object of a ready row that needs its bytes read (the lowest such asset id, section 7) through `lib/storage/media.ts::getStoredObjectSize`, retrying a refusal every 15 seconds for up to ten minutes, and prints `ok`, `no-media` where no ready row needs its bytes read, or `failed`. The runbook runs it only where a grant was made (section 14) |
| migrate | `--settle-holders` | settles every lapsed or paused holder through `lib/db/apps.ts::reapStaleRun` and `lib/db/designSessions.ts::reapStaleDesignSessionRun` (`holders.ts::settleHolders`), prints counts and exits |
| migrate | `--rehearse` | the whole fleet transaction, the ledger included, ending in a sentinel rollback; local databases and tests only, refused by the Job's arm |
| migrate | `--execute --expect-plan-digest <64 hex>` | builds the plan, refuses with nothing written when its digest is not the expected one, then runs the writer and commits |

`--prod` exists only on the scan, which never writes. A production write runs only through the Job.

**Already applied, checked first.** Every mode but `--prove-media-read` first reads the migration
ledger (`ledger.ts::readMigrationLedger`, one plain `SELECT` of `kysely_migration`): where it holds
`20261101030000_hq_round_trip_platforms_media_format_validated`, the run prints `already-applied`
and exits 0 before any other read, any media read included. That migration is applied only inside
the fleet transaction that writes everything else (section 8), so its presence is the cutover's
one marker. The writer repeats the check under its locks.

**Why no frozen reader and no census.** Step 3 read its sources through a frozen copy of the old
schema because they no longer parsed at the head, and gated on a two-tree emission census because
its lift rebuilt every expression tree by a second path. Step 4's sources parse under the head
schema (section 1), so the cutover reads them through the production loader; and every target is
made by the production reducer from mutations the production planners return, then replayed by the
synthetic writer from the production diff. The bytes every app emits move anyway from pull request
5 (`cloudcare_enabled` on every application body), and the proof lane holds what each reader does
with them (pull request 2's reader policy and the corpus declarations).

## 5. The transform, in order

```ts
interface PlatformsStepContext {
	readonly appId: string;
	readonly projectId: string;
	readonly lookupContext: LookupValidationContext;          // the Project's definitions, read once per Project
	readonly formatOf: ((assetId: MediaAssetId) => MediaPlan | undefined) | null; // section 7; null in the scan, which skips step 2
	readonly mediaRecords: ReadonlyMap<MediaAssetId, MediaAssetRecord>; // for export readiness
}
interface AppTransform {
	readonly target: BlueprintDoc;
	readonly changes: readonly PlannedChange[];               // { step, entity uuid, detail counts }: content-free
	readonly notice: readonly MigrationNoticeEntry[];         // with names; never printed
	readonly blockers: readonly CutoverBlocker[];
}
export function transformApp(source: BlueprintDoc, ctx: PlatformsStepContext): AppTransform;
/** Step 3 alone, over any target: the blockers it finds, empty where the target is clean. */
export function judgeTarget(
	source: BlueprintDoc,
	target: BlueprintDoc,
	ctx: PlatformsStepContext,
): readonly CutoverBlocker[];
```

`transformApp` runs steps 1 and 2, then `judgeTarget` over the document they leave, then step 4.
`judgeTarget` is exported so a test can judge a target no step would make (section 15).

The source is each app as `canonicalCommitKernel.ts::loadSchemaAdmittedAppSnapshotFromRowInTransaction`
reads it, from a row with `PERSISTED_BLUEPRINT_APP_COLUMNS` and the three `::text` carriers, selected
without a lock (the scan's role may not lock). Each step applies its mutations with
`lib/doc/commitVerdicts.ts::prepareMutationCandidate(doc, admitMutationBatch(mutations))`, the
reducer every editor's commit uses; a prepared candidate with an admission issue
(`preparedCandidateHasAdmissionIssue`) is the blocker `transform-admission`. A blocker in a step
stops that app's transform; the app is reported and the plan has no target for it.

| # | Step id | What it does | Functions it calls | Blockers | Notice reasons |
|---|---|---|---|---|---|
| 1 | `declare-platforms` | gives the app the declaration its content other than media allows, and splits each date-and-time question where that is the only way it runs anywhere | `lib/doc/platformDeclaration.ts::planContentDeclaration`, which calls `lib/domain/platformUses.ts::platformFeatureUses` (part 01 §3) and `lib/doc/datetimeSplit.ts::planDatetimeSplits` (part 03 §2.11) | `runs-on-neither`, `datetime-split-refused`, `transform-admission` | `platforms-declared`, `datetime-question-split` |
| 2 | `remove-unplayed-media` | removes each authored media reference whose file does not play on every declared platform | `lib/domain/mediaRefs.ts::walkAuthoredAssetRefs`, `lib/domain/builtinIcons.ts::isBuiltinIconRef`, `lib/domain/platforms.ts::declaredPlatforms`, `lib/media/platformPlayback.ts::unplayableReferences` and `playsOnEvery` (part 04 §6.1), `removals.ts::removalFor` | `media-row-missing`, `transform-admission` | `media-not-played-removed` |
| 3 | `judge-target` | proves the target is a document every editor would accept, the synthetic writer can replay, and the case store need not change for | `judgeTarget`: `lib/doc/fieldParent.ts::toPersistableDoc` and `hydratePersistedBlueprint`, `lib/domain/blueprint.ts::blueprintDocSchema`, `commitVerdicts.ts::mutationCommitVerdict`, `commitVerdicts.ts::exportReadinessFindings`, `diffDocsToMutations`, `lib/doc/mutationTargetAdmission.ts::mutationTargetsInvalid`, `lib/case-store/store.ts::buildCaseTypeMap` | `target-parse`, `target-gate`, `target-export-readiness`, `not-representable`, `case-schema-changed`, `not-idempotent` | none |
| 4 | `deployment-lines` | writes nothing; selects the lines each live deployment of the app gets | `lib/deployment/webApps.ts::baselineWebApps`, `lib/domain/platforms.ts::declaresWebApps`, `lib/commcare/planPrivileges.ts::formEntrySyncReasons`, `lib/domain/entryPoints.ts::entryPointInventory` | none | `next-publish-asks-web-apps`, `next-publish-asks-more`, `deep-links-need-republish` |

A second application of steps 1 and 2 to a target returns no mutation (step 3's `not-idempotent`
guard proves it per app).

### Step 1, `declare-platforms`

`planContentDeclaration` lands in pull request 4 beside the declaration, in `lib/doc/` because it
returns mutations and calls the split planner. It is the one declaration planner: the cutover
calls it as its first step, and the fuzz mapping and the test fixtures reach it through the same
module's thin applier `declaredForContent(doc): BlueprintDoc`, which applies a `declared` plan's
mutations and throws `PlatformDeclarationBlocked` on any other kind (part 08 §3.4), at the end of
`xformDocArbitrary.ts::lowerToDoc` and `suiteDocArbitrary.ts::lowerToDoc` (pull request 4). So it
cannot live in `scripts/`, which pull request 15 removes; it stays for step 6's import proposal as
well.

```ts
export type ContentDeclarationPlan =
	| {
			readonly kind: "declared";
			/** The declaration the content allows; undefined is Web Apps and Android. */
			readonly runsOnlyOn: Platform | undefined;
			/** The feature ids of the uses the other platform can't run, for the notice. */
			readonly causes: readonly PlatformFeatureId[];
			/** `setAppSettings` first where the declaration changes, then every split's mutations. */
			readonly mutations: readonly Mutation[];
			/** One entry per split question: its uuid, the two new uuids and ids (part 03 §2.11's type). */
			readonly splits: readonly DatetimeSplit[];
	  }
	| {
			readonly kind: "runs-on-neither";
			readonly webAppsUnavailable: readonly PlatformFeatureId[];
			readonly androidUnavailable: readonly PlatformFeatureId[];
	  }
	| {
			readonly kind: "split-refused";
			readonly fieldUuid: Uuid;
			readonly reason: "self-read-through-a-filter";
	  };
export function planContentDeclaration(doc: BlueprintDoc): ContentDeclarationPlan;
```

Its rule, with W the set of feature ids whose uses read `unavailable` on Web Apps and A the set
whose uses read `unavailable` on Android (`PLATFORM_FEATURES[use.feature].webApps.reading` and
`.android.reading` over `platformFeatureUses(doc)`):

| Content | Declaration | Mutations | Notice |
|---|---|---|---|
| a document that already declares | unchanged | none | none |
| W and A empty | both (absent) | none | none |
| W only | `android` | `setAppSettings({ runsOnlyOn: "android" })` | `platforms-declared`, causes W |
| A only | `web-apps` | `setAppSettings({ runsOnlyOn: "web-apps" })` | `platforms-declared`, causes A |
| both, and W is exactly `{ datetime-question }` | `web-apps` | the declaration, then `planDatetimeSplits(doc)`'s mutations | `platforms-declared` with the split count, and one `datetime-question-split` per question |
| both, any other W | none | none | blocker `runs-on-neither` with W and A |

`connect-app` is in W for every app with `connectType !== null` (pull request 4), so a Connect app
is declared Android only and its date-and-time questions are never split, and a Connect app that
also holds something Android cannot run is `runs-on-neither`.

**What production holds, by row of the table** (the planning scan; its counts stay out of this
plan). No stored app declares yet, so the first row meets none; the rows from "W only" to the
split each meet apps there, and the last row meets none. The Connect arm declares many apps Android
only: Connect apps of both kinds, learn and deliver, some of which also hold date-and-time questions
and so need no split. A few apps that are not Connect apps become Android only for a date-and-time
question alone. A few become Web Apps only, for Search first or for a single-date Search field. A
few run on neither, each because of a date-and-time question beside a single-date Search field, so
the split row runs in production: `planDatetimeSplits` splits their questions and they are declared
Web Apps only. No app meets the `runs-on-neither` blocker (section 11).

`planContentDeclaration` reads every use `platformFeatureUses` returns, the expression leaves among
them: `case-list-here` (each `{ kind: "here" }` node, owned by its case-list column),
`case-list-search-text` (each `{ kind: "case-list-search-text" }` value arm, pull request 10) and,
under outcome A of pull request 10's window width gate, `window-width` (each `session-context`
term with field `window_width`) are features of the platform table like any other (part 01 §4.1),
and `contentRunsOn` reads them all. Under outcome B neither `window-width` nor
`window-width-in-search` reads `unavailable` on any platform (part 01 §4.1), so no window width
read shapes a declaration. The validator reports the structural uses through
`PLATFORM_FEATURE_UNAVAILABLE` and the leaves through the checker's `arm-unavailable` with reason
`platform-unavailable`; that split is the validator's, not the detector's. Under outcome A, a
`window_width` read in a slot a form evaluates (field, Connect, case-operation, form-link and
`lookup_options_source` slots) is refused on every declaration (`SlotProfile.windowWidth`, part 03
§6.2, pull request 10); it reaches step 3 as a gate finding whatever the declaration. Under outcome
B, part 03 §6.4 drops that profile fact and its refusal, so a form-logic `window_width` read is
admitted and reaches step 3 as no finding at all.

The split's mutations are pull request 3's (`lib/doc/datetimeSplit.ts::planDatetimeSplits`, part
03 §2.11): `addField` for `<id>_date` and `<id>_time`, `convertField` to `hidden` (a Hidden Value
declares no label, so it carries no `label` seed), the `updateField` that sets the clock-keeping
calculation, the translation moves, and whatever `kindConversionCascade.ts::planKindConversion`
adds. The planner's one refusal an admitted original can hold, a self read through a step filter
(`self-read-through-a-filter`), is the blocker `datetime-split-refused`.

**Tests** (pull request 4, `lib/doc/__tests__/platformDeclaration.test.ts`, pure, over documents
built with `lib/__tests__/docHelpers.ts::buildDoc`; the one file that also holds part 08 §3.4's
cases of `declaredForContent`): each row of the table above, `connect-app` alone and with a
date-and-time question (Android only, no split), with search first (`runs-on-neither`), a `here`
column alone (Android only), a record-slot `window_width` read alone (Web Apps only under outcome
A; no declaration under outcome B), search first beside a date-and-time question (Web Apps only,
split), search first beside a `here` column (`runs-on-neither`); every returned batch passes
`mutationCommitVerdict` over its document; a second application returns no mutation; a document
that already declares is untouched.

### Step 2, `remove-unplayed-media`

The scan, which classifies nothing (`formatOf` null), removes nothing here. Otherwise, on the
document step 1 leaves (media never shapes the declaration):

- **Every reference has a row.** For each `ref` of `walkAuthoredAssetRefs(doc)` (the walk the
  kernel's own `blueprintMediaRequirements` uses) whose `assetId` is not a built-in icon,
  `ctx.formatOf(ref.assetId)` is the asset's `MediaPlan` (section 7). None, because no ready media
  row of the app's Project holds that id, is the blocker `media-row-missing`; today's kernel
  refuses such a reference, so this is a guard. The cutover checks it itself because
  `unplayableReferences` skips a reference with no entry and leaves its existence to other rules
  (part 04 §6.1).
- **What is removed** is `lib/media/platformPlayback.ts::unplayableReferences(doc, formats,
  declaredPlatforms(doc))` (part 04 §6.1, the same walk with built-in icons skipped), with
  `formats` the Project's plans as `{ mediaFormat: plan.format, mimeType: plan.mimeType }`. A
  reference stays exactly where `playsOnEvery(plan.format, declaredPlatforms(doc))` holds
  (`mediaFormatPlaysOn("unplayable")` is `[]`, so an `unplayable` file plays on none). Each
  `UnplayableReference` returned is removed, with the cause `missing` or `too-large` where the
  plan's cause is that, `neither` for any other `unplayable` file (cause `no-variant`), and
  otherwise `web-apps` or `android`, the one platform its `missing` names (every variant plays on
  at least one platform, part 04 §2.1).
- **H.264 High is never removed.** Android's decode probe decoded it on all three images during
  planning, so `mp4-h264-high` plays on Web Apps and Android (part 04 §8.5), and step 2 removes an
  H.264 reference only where its file is no variant at all (`unplayable`). The `media` line counts
  removed references by format (section 6), so a run shows any removal by its format.
- **What production holds.** Ready JPEG and PNG rows, which play on both platforms, and no audio
  or video row (the planning scan). So step 2 removes no reference there, and the
  `media-not-played-removed` reason meets no app unless a file that plays on one platform alone, or
  on none, arrives before the window; the dry run's `media` line shows it if one does.

`removals.ts::removalFor(doc, ref)` returns the mutation that removes one carrier, each an
existing kind:

| `ref.location.kind` | Mutation | Notice entity, `detail.carrier` |
|---|---|---|
| `field_media_bundle` | `setFieldMedia { fieldUuid, slot: "label" \| "help", media }`, `media` the bundle without the removed kind, or `null` when it held only that one | field; `label` or `help` |
| `option_media` | `updateOption { fieldUuid, uuid, option }`, the option with its `media` bundle less the removed kind (the key left out when empty) | field; `option`, with `detail.option` the option's value |
| `module_icon`, `module_audio_label` | `setModuleMedia { uuid, icon, audioLabel }`, the removed slot `null` and the other slot as it is | module; `menu-icon` or `menu-audio` |
| `case_list_icon`, `case_list_audio_label` | `setCaseListMeta { uuid, patch: { icon: null } }` or `{ audioLabel: null }` | module; `case-list-icon` or `case-list-audio` |
| `form_icon`, `form_audio_label` | `setFormMedia { uuid, icon, audioLabel }`, the removed slot `null` and the other as it is | form; `menu-icon` or `menu-audio` |
| `app_logo` | `setAppLogo { logo: null }` | app; `logo` |
| `image_map_mapping` | `updateColumn { moduleUuid, uuid, column }`, the column's content with that entry left out of `mapping` (the schema admits an empty mapping, `lib/domain/modules.ts`, the image-map column) | caseListColumn; `image-map-row`, with `detail.row` the entry's value |

Removals of one app apply in one batch, grouped so that two references on one carrier make one
mutation. A file is never deleted: the row stays in its Project's library, and an `unplayable`
one is offered nowhere (pull request 7).

Removing an image-map entry changes how that column sorts: its sort key is the index of the first
matching entry, `""` where none matches (`lib/domain/caseListOrder.ts`, `mapping-position`), so
cases holding the removed value now sort with those that match no image. The notice says so.

### Step 3, `judge-target`

On the document steps 1 and 2 leave:

1. `blueprintDocSchema.parse(toPersistableDoc(target))`; a refusal is `target-parse` (a defect of
   the stack: the reducer's output always parses).
2. `mutationCommitVerdict(target, [], ctx.lookupContext)`, the absolute gate every commit and the
   runtime probe run; findings are `target-gate`, each reported by `code` and, for an expression
   finding, `details.checkCode` and `details.checkReason`.
3. `exportReadinessFindings(target, ctx.lookupContext, ctx.mediaRecords)`, the zero-tolerance
   validator export runs, with the Project's media records as
   `lib/db/mediaAssets.ts::mediaAssetRecordFromRow` builds them, each carrying its classified
   format, plus `lib/media/builtinIconAssets.ts::builtinAssetRows`; findings are
   `target-export-readiness`. The scan, which classifies nothing, drops `MEDIA_FORMAT_NOT_PLAYED`
   here and says so in its `media` line.
4. **Representable.** The synthetic writer's own pure checks, in its order: `diffDocsToMutations(source,
   hydratePersistedBlueprint(toPersistableDoc(target)))`, admitted and replayed with
   `prepareMutationCandidate`, must equal the target under `deepEqual` of `toPersistableDoc`, and
   `mutationTargetsInvalid(source, mutations)` must not hold. A difference, a
   `CasePropertySemanticProvenanceRequiredError` or an invalid target is `not-representable`. The
   writer's one other check, `lib/organization/commitIntegrity.ts::applyOrganizationCommitIntegrity`,
   reads and writes the Project's places in the transaction (it sheds removed place-property values
   and replaces the location reference edges), so the read-only dry run cannot run it; `--rehearse`
   on a local database and the window itself prove it, and a refusal there rolls the fleet back
   whole. No step changes an organization level, a place property, a persona or a location read,
   so such a refusal is a defect of the stack.
5. **The case store.** `buildCaseTypeMap(toPersistableDoc(source))` and
   `buildCaseTypeMap(toPersistableDoc(target))` are deep equal, or the app is `case-schema-changed`.
   The split keeps `caseWrite` on the original field, whose `fieldValueType` stays `datetime`
   (pull request 3's rule R3), and no other step touches a case write. This compares two
   derivations under the merged code. What the merged code derives against the stored
   `case_type_schemas` rows, which `main`'s code wrote, is the `schema-drift` line's (section 6),
   and it is equal for source and target because of this check.
6. **Idempotent.** Steps 1 and 2 over the target return no mutation, or `not-idempotent`.

An app whose target equals its source writes nothing; it may still get a notice row from step 4.

### Step 4, `deployment-lines`

Over each live deployment of the app: an `app_deployments` row with a live `app` mapping (an
`app_deployment_resources` row of kind `app` with `superseded_at` and `remote_missing_at` null),
the query step 3's cutover used (`733dd193:scripts/lib/hqRoundTripExpressions/fleet.ts::readDeployments`).

- **`next-publish-asks-web-apps`**, where the deployment's app baseline
  (`app_deployment_baselines`) has origin `push` or `cutover`, its `source_gzip` gunzips to text
  whose SHA-256 is `source_digest`, and `baselineWebApps(JSON.parse(text))` (pull request 5,
  `lib/deployment/webApps.ts`, part 05 §4) differs from `declaresWebApps(target)`; `detail.to` is `on` or
  `off`. A baseline of origin `create` holds no content of Nova's, so its fill writes the
  declaration with no question (pull request 5); an `unread`, absent or unverifiable baseline says
  nothing about what HQ holds, and its next publish stops at its drift check anyway. Pull request
  5 drops `app_deployments.target_web_apps_enabled`, so this line reads the baseline, never the
  column.
- **`next-publish-asks-more`**, where the target declares Web Apps (`detail.planFeatures` holds
  `web-apps`) or `formEntrySyncReasons(target)` is non-empty (`detail.settings` holds
  `form-entry-sync-off`). No live confirmation of either can exist before the window: the
  `web-apps` subject is new, and the kind CHECK admits `form-entry-sync-off` only from the
  window's ledger. So every such deployment's next publish asks.
- **`deep-links-need-republish`**, for a changed app where `entryPointInventory(target)` is
  non-empty.

## 6. Derived identities and the plan digest

Every identity the cutover writes is derived, so the dry run and `--execute` build the same plan:

- **The split's fields**: `lib/domain/datetimeSplitIdentity.ts::datetimeSplitFieldUuid(appId,
  fieldUuid, purpose, attempt = 0)`, UUIDv5 of `["nova-datetime-split-v1", appId, fieldUuid,
  purpose]` (the attempt appended after 0) under namespace `6cbda68f-3426-4851-8dcc-ed0424034b59`,
  the first attempt whose two UUIDs are free (pull request 3, part 03 §2.5); ids from
  `idSlug.ts::suffixUntilFree` over sibling ids, so the same document gives the same ids.
- **The batch id**: `hq-round-trip-platforms:<appId>`.
- **The actor**: `system:hq-round-trip-platforms`.
- **The advisory lock key**: `pg_advisory_xact_lock(hashtextextended('cutover:hq-round-trip-platforms', 0))`.
- Notice rows take `uuidv7()` as their id (`20261015010000_app_migration_notices.ts`), outside the
  plan; `UNIQUE (app_id, cutover)` is their latch.

**The plan.**

```ts
interface PlatformsCutoverPlan {
	readonly format: "hq-round-trip-platforms-1";
	readonly media: readonly MediaPlan[];                // every ready image, audio and video row, by asset id
	readonly apps: readonly AppPlan[];                   // every app, deleted ones included, in code-point order of id
	readonly digest: string;                             // lib/utils/canonicalJson.ts::canonicalJsonDigest of { format, media, apps }
}
interface MediaPlan {
	readonly assetId: string;
	readonly projectId: string;
	readonly rowDigest: string;                          // canonicalJsonDigest of the row's status, kind, mime_type, extension, content_hash and gcs_object_key
	readonly mimeType: AssetMimeType;                    // the row's mime_type, for unplayableReferences' labels
	readonly format: MediaFormatValue;                   // a key of lib/domain/multimedia.ts::MEDIA_FORMATS, or "unplayable" (part 04 §2.1)
	readonly cause: "mime" | "classified" | "no-variant" | "missing" | "too-large"; // "mime": the one variant of its stored MIME, no byte read (section 7)
}
interface AppPlan {
	readonly appId: string;
	readonly projectId: string;
	readonly deleted: boolean;
	readonly baseSeq: number;
	readonly baseDigest: string;                         // canonicalJsonDigest of the source's persistable doc
	readonly declaration: "both" | "web-apps" | "android" | null; // null where a blocker stopped step 1
	readonly targetDigest: string | null;                // null where the app writes nothing
	readonly changes: readonly PlannedChange[];
	readonly notice: readonly MigrationNoticeEntry[];    // empty where the app gets no notice row
	readonly blockers: readonly CutoverBlocker[];
}
interface CutoverBlocker {
	readonly code: CutoverBlockerCode;
	readonly count: number;
	readonly findingCodes: readonly string[];            // validator codes, checker codes and reasons, feature ids
}
```

The digest covers everything the writer would write, and nothing in it comes from outside the
database and the bucket, which are both quiescent in the window. A moved digest means a document,
a holder, a media row or a deployment baseline moved. The notice entries carry authored names and
file names into the digest as hashed bytes only; the report never prints them.

**The report** is content-free JSON Lines in step 3's framing (`report: "hq-round-trip-platforms"`,
`mode` one of `scan`, `dry-run`, `prove-media-read`, `settle-holders`, `rehearse`, `execute`, and
`section`), one Cloud Logging entry per line, each printed as soon as it is made:

- `fleet`: apps, deleted apps, changed apps, `planDigest` (null in the scan), `fleetSeqDigest`
  (the digest of every app's `(id, mutation_seq)`), `ledger` (`validatedApplied` and every
  `pendingMigrations` name), plan milliseconds, peak RSS, database size;
- `declarations`: apps per declaration, and per cause feature id;
- `splits`: apps and questions, each by writer and non-writer (a writer is a question whose field
  carries a case write); this is the split's reach, the `datetime` fields of the apps whose
  content runs on neither platform (part 03 §10, count 2);
- `clock-keeping-dates`: the stored form-logic expression slots holding a node for which
  `lib/domain/expression/datePattern.ts::isClockKeepingDate` holds (part 03 §2.6), and the apps
  holding them by id, by writer and non-writer (whether the slot's field carries a case write), counted
  over the sources (part 03 §10, count 1). Rules R2 and R3 retype each, and both outcomes are
  decided: a hit the target gate refuses (a clock-keeping date compared with a date) is the
  author's `target-gate` blocker (section 11, "Blockers by rule"); a hit the gate admits is
  accepted, and where it is the calculate of a Hidden Value writer that alone types its property,
  the property's derived type moves from `date` to `datetime`, which the `schema-drift` line
  counts. Production stores no clock-keeping date (the planning scan), so there the line is zero;
- `session-context`: the stored `session-context` reads of `drift`, `window_width` and
  `applanguage`, counted over the sources by field and by slot class (`module`,
  `form-display-condition`, `field`, `connect`, `case-operation`, `form-link`,
  `lookup-options-source`, the classes of part 03 §6.2), and the apps holding them (part 03 §10,
  count 3). Any read that stops type-checking under pull request 10's types is also a
  `target-gate` blocker (section 11), and so, under outcome A of pull request 10's window width
  gate, is a `window_width` read in a slot a form evaluates; under outcome B no form-slot
  `window_width` read is a blocker, and the line only counts them. A `drift` or `window_width`
  read that still type-checks as the calculate of a Hidden Value writer that alone types its
  property moves that property from text to a whole number, which the `schema-drift` line counts.
  Production stores no read of the three fields (its session context reads are of `userid` and
  `username`, the planning scan), so there the line is zero;
- `schema-drift`: each app's `computeSchemaDrift` over its source (section 4) against its active
  `case_type_schemas` rows: the apps with drift by id, and the case types and properties by
  class (`missing-row`, `added`, `removed`, `refined`, `retyped` by its from and to types,
  `unresolvable`), the classes `scan-schema-drift.ts` prints. Runbook step 1(a) holds the stored
  rows equal to `main`'s derivation, so every count here is what the merged code derives
  differently (part 03 §10, counts 1 and 3), and `unresolvable`, a stored spec the drift module
  cannot read back, is zero, since `schemaDrift.ts::dataTypeFromSpec` is the inverse of
  `lib/domain/expression/jsonSchema.ts::propertyToSchema`, which wrote every stored spec. Drift is
  never a blocker: the window converges it after the deploy (section 14, step 10), and that step expects exactly
  this line from the window's dry run. The line is outside the digest, because the cutover writes
  no schema row and ingress keeps the rows still from the dry run to step 10;
- `media`: ready media rows by kind and stored MIME, and `needsBytes`, the number of rows whose
  stored MIME cannot give their format and whose objects the Job reads (section 7), with those rows
  by stored MIME in `needsBytesByMime`; under the
  dry run and later modes, rows by format and by cause (`mime` among them), the asset ids of
  `missing` and `too-large` rows, objects read, bytes read, classification milliseconds; removed
  references by cause, by carrier and by format; `classified: false` in the scan. `needsBytes` is
  what the runbook reads to decide each bucket grant (section 14);
- `deployments`: entries per reason;
- `holders`: step 3's census (`holders.ts::readHolderCensus`);
- one `blocker` line per code: count, app ids, finding codes;
- under `--rehearse` and `--execute`, `writer`: each numbered fleet step's milliseconds, WAL from
  step 1 to step 11, database growth, `migrationsApplied`;
- `outcome` last: `ok`, `already-applied`, or `stopped` with any of `blocker`, `holder`,
  `app-changed`, `media-changed`, `digest`, `ledger`, or `error` with its `errorClass`.

App ids, asset ids, deployment ids, migration names, codes and counts are content-free; names,
file names, expressions and values never appear. A run that throws still prints its last
`outcome` line; its stderr holds the cutover's own message or the error's class alone, never a
database error's text, as step 3's did.

## 7. Media: the backfill

From pull request 7, `media_assets.media_format` holds the one variant key of the
`lib/domain/multimedia.ts::MEDIA_FORMATS` registry (part 04 §2.1) a ready image, audio or video
row's bytes are, or `unplayable` for bytes no variant admits (`MediaFormatValue`); upload writes
it, and kernel admission, attach verdicts, the export rule
`MEDIA_FORMAT_NOT_PLAYED` and the runtime probe's media audit read it per declared platform. The
rows that exist before the window have no value. For most MIMEs the stored MIME settles it, since
that MIME has one variant and its upload already ran the check that would pick it; for the rest
nothing in a row tells the variant: MP4 codec and profile and WAV encoding are not stored
(`lib/media/validate.ts`: "step 2 checks no MP4 codec and no WAV encoding"). So the cutover takes
the format from the MIME where that settles it, and reads the bytes where it does not.

**What is classified.** Every `media_assets` row with `status = 'ready'` and `kind` in `image`,
`audio`, `video`, in every Project, referenced or not: the CHECK the window validates (section 8)
holds every one. Pending rows and document kinds stay null.

**Which rows take their format from their MIME.** `media.ts::FORMAT_OF_STORED_MIME` is built from
`lib/domain/multimedia.ts::MEDIA_FORMATS`: each MIME that has exactly one variant in part 04 §2.1,
less `audio/wav`. From the registry as part 04 §2.1 gives it, that is `image/png` → `png`,
`image/jpeg` → `jpeg`, `image/gif` → `gif`, `image/webp` → `webp`, `image/bmp` → `bmp`,
`image/vnd.microsoft.icon` → `ico`, `image/avif` → `avif`, `audio/mpeg` → `mp3`, `audio/mp4` →
`m4a`, `audio/flac` → `flac`, `audio/aac` → `aac-adts`, `audio/amr` → `amr`, `audio/midi` → `midi`
and `video/x-matroska` → `mkv`. A ready row whose `mime_type` is a key takes that value, cause
`mime`, and its object is neither sized nor read. Reason: a ready row's `mime_type` is the sniff
its upload's `validateMediaBytes` made, and the body check that upload ran is the one
`classifyStoredMediaBytes` would run, so the classifier would return the same variant: PNG, JPEG,
GIF and WebP have been read by sharp for their dimensions since the first upload (#45); MP3 by the
same music-metadata parse, which step 2 (#765) only widened (a missing duration stopped refusing);
BMP, M4A and FLAC were first accepted by step 2, whose checks part 04 §3.1 keeps unchanged; and
ICO, AVIF, AAC, AMR, MIDI and MKV are first accepted by pull request 7, whose rows are written with
their format. `audio/wav` has one variant and is left out, because step 4's `wav.ts` check is new:
a stored WAV may be 24-bit or float, so `unplayable` (part 04 decision 8). The rows that need their
bytes read are therefore those of `audio/wav`, `audio/ogg` (two variants), `video/mp4` (five) and
`video/webm` (two), the `media` line's `needsBytes` (section 6). Built from the registry, the map
loses a MIME that later gains a second variant without an edit, and `media.test.ts` holds it to
the classifier over every committed fixture of each MIME it holds (section 15).

Such a row's object is not looked at, so a missing object or one past its cap is not found by the
backfill. Its format is a fact of bytes that passed upload; an object lost since then is no more
this cutover's to find than step 3's, and an export meets it at its byte read as it does today.

**What production holds.** Ready JPEG and PNG rows and no audio or video row (the planning scan),
so every production row takes its format from its MIME, `needsBytes` is zero, and the backfill reads
no object. The byte path below stays the plan for local databases and for any WAV, Ogg, MP4 or WebM
file uploaded before the window, and section 14 writes both branches of the grant.

**How, for a row that needs its bytes.** `media.ts::classifyFleetMedia(rows, reader)` gives each
row of `FORMAT_OF_STORED_MIME` its value, then reads each distinct `gcs_object_key` of the other
rows once, four at a time (`MEDIA_READ_CONCURRENCY = 4`, at most 200 MB of video in memory), through
an injected reader, which it never calls when no row needs bytes:

```ts
interface MediaObjectReader {
	/** The object's byte size, or null where it does not exist. */
	size(key: string): Promise<number | null>;
	/** The object's bytes, refused past `cap` as they stream. */
	bytes(key: string, cap: number): Promise<Buffer>;
}
```

Its production arm, `media.ts::storageMediaReader`, is `lib/storage/media.ts::getStoredObjectSize`
for `size` and `::downloadAssetBytes` for `bytes`. `downloadAssetBytes` refuses an object past its
cap with a plain `Error` like any stream failure, so the size decision is made from `size` before
any download and never from a thrown error's message:

1. `size(key)` is `null` (a 404): every row of that key is `unplayable`, cause `missing`.
2. `size(key)` exceeds `lib/domain/multimedia.ts::ASSET_SIZE_CAPS_BYTES[kind]`: `unplayable`,
   cause `too-large`, with no download (export reads the object under the same cap, so such a file
   could not export).
3. Otherwise `bytes(key, ASSET_SIZE_CAPS_BYTES[kind])`, then `await
   lib/media/validate.ts::classifyStoredMediaBytes(bytes, { mimeType:
   row.mime_type, extension: row.extension })` (part 04 §3.9), the production classifier pull
   request 7 adds over `validateMediaBytes`, which upload runs on every new file, with the stored
   MIME as the claim: its variant key (cause `classified`) or `unplayable` (cause `no-variant`: a
   WAV that is not 8-bit or 16-bit PCM, an MP4 whose video is no profile the registry holds, an
   audio-only MP4, a sniff that disagrees with the stored MIME, and the other refusals part 04
   §3.8 lists).
4. Any error from either call stops the run with `errorClass` `media-read` and nothing written,
   a capped download that throws included: an object that grew past its cap after its size was
   read is a bucket that moved during the run, not a classification:
   `Reading the stored file of media asset {assetId} failed with an error of class {class}, so
   this run stopped before writing anything. Run --prove-media-read to check the Job can read the
   media bucket, then run again.`

No JavaScript package the classifier imports holds a top-level `await` (read during planning:
`file-type` 22.1.1, `music-metadata` 12.2.0 and their tokenizer dependencies; `file-type`'s one
runtime `import()` serves `fromFile`, which the classifier never calls), so esbuild's CommonJS
bundle carries them. `lib/media/validate.ts` also imports `sharp` at module load, for the
PNG, JPEG, GIF, WebP and AVIF reads (`sharp(bytes).metadata()`), so the bundle loads it even though
no backfill run calls it (every image row takes its format from its MIME). It is a native addon
esbuild cannot bundle: `sharp/dist/sharp.cjs` requires its platform's `@img/sharp-<platform>/sharp.node`, which
loads libvips from `@img/sharp-libvips-<platform>` by its own path, and the maintenance image
holds only `/app/*.cjs`. So the bundle leaves `sharp` external (`--external:sharp`), and the
`maintenance` stage copies sharp's installed tree from the `deps` stage beside the bundles, where
the bundle's `require("sharp")` resolves from `/app` (section 13). That tree is exactly three
directories, read from `package-lock.json`: `node_modules/sharp` (0.35.5, with its own
`node_modules/semver`), `node_modules/@img` (`@img/colour` and the Linux musl binding with its
libvips) and `node_modules/detect-libc`. The runner stage copies `@img` from `deps` for the same
reason (its comment in `Dockerfile`). Two runs prove it loads, each a step of its own:
`containerArtifacts.test.ts` runs the bundle against those three directories alone (section 15),
and runbook step 1(b) loads sharp inside the built image; the advisory dry run in the Job (section
14, step 1(d)) then loads the bundle, sharp with it, as every run does.

**Unplayable files are kept.** A row is the Project's file; deleting it is not the cutover's to do.
Its references are removed by step 2, the library and pickers show it as playing nowhere (pull
request 7), and the report names the asset ids of the `missing` and `too-large` rows.

**The Job and the grant.** The Job's identity, `nova-migrate@`, holds no role on the media bucket
(`scripts/infra/provision-deployment-identities.sh` grants the bucket only to the capture cleanup,
media policy and build identities). Step 2's precedent, a time-conditioned grant made for one use,
revoked and read back (`5cf6e327^:docs/plans/hq-round-trip/2-cutover-runbook.md`, "A grant" and
"Its revocation"), is followed with the bucket in place of the key:

- grant: `gcloud storage buckets add-iam-policy-binding gs://nova-multimedia-prod
  --member=serviceAccount:nova-migrate@commcare-nova.iam.gserviceaccount.com
  --role=roles/storage.objectViewer --condition='expression=request.time < timestamp("<expiry>"),title=hq-round-trip-platforms-<advisory or window>'`;
- revocation: `gcloud storage buckets remove-iam-policy-binding gs://nova-multimedia-prod
  --member=serviceAccount:nova-migrate@commcare-nova.iam.gserviceaccount.com
  --role=roles/storage.objectViewer --all` (`--all` removes every binding of that role and member
  whatever its condition);
- read back: `gcloud storage buckets get-iam-policy gs://nova-multimedia-prod --format=json`,
  over which `jq '[.bindings[]?.members[]? | select(contains("nova-migrate@"))] | length'` prints
  `0`.

The bucket has uniform bucket-level access (`lib/storage/media.ts::getBucket`'s contract), which a
conditional binding needs. `scripts/infra/manage-deployment.py check` reads no bucket binding, and
`scripts/infra/capture-bucket-policy.mjs` keeps every binding it does not own, so the grant moves
no deploy check. A grant is made only for a run that must read bytes, which the `media` line's
`needsBytes` shows (section 6), so there are two branches:

- **A row needs bytes.** Two grants are made: an advisory one for the dry run before the window,
  where the scan before it counts `needsBytes` above zero, two hours or the Job's contract timeout
  plus thirty minutes where that is longer (section 13 raises the timeout when the dry run's plan
  takes more than an hour, so the grant always outlasts the run it serves); and the window's, where
  the advisory dry run or the window's own scan counts one, six hours or the planned window plus one
  hour where that is longer. Each is followed by `--prove-media-read` and ended by its revocation
  and the policy read.
- **No row needs bytes** (production as the planning scan found it): no grant, no
  `--prove-media-read` and no revocation; the dry run's `media` line shows `needsBytes` zero and no
  object read, and the bucket policy read, still saved, names `nova-migrate@` nowhere.

The Job keeps `NOVA_MEDIA_BUCKET` and stays its own (section 13) in both branches: the setting is
harmless where nothing is read, and one Job keeps one path whichever branch the window takes.

## 8. The ledger in the window

Five ledgered migrations of the stack are not applied while the previous revision serves. Their
stamps sort in pull request order after `main`'s last, `20261020000000_hq_round_trip_expressions_fold_horizon`,
so each phase's `migrateTo` target reaches exactly the migrations before it:

| Migration | Pull request | What it does | Why in the window |
|---|---|---|---|
| `20261101000000_hq_round_trip_platforms_web_apps_read` | 5 | drops `app_deployments.target_web_apps_enabled` (part 05 §6) | the previous revision reads and writes the column (`store.ts::toDeploymentRecord`, `recordRemoteResource`) |
| `20261101010000_hq_round_trip_platforms_form_entry_sync` | 6 | widens the confirmation kind CHECK with `form-entry-sync-off` (part 05 §10) | additive in effect; it rides the window with the rest so the ledger moves once |
| `20261101020000_hq_round_trip_platforms_media_format` | 7 | adds `media_assets.media_format` (nullable), its per-kind value-domain CHECK `media_assets_media_format_known` (valid at once: every existing row is `NULL`), and the presence CHECK `media_assets_ready_media_format` `NOT VALID` (part 04 §5.1, §5.2) | the backfill needs the column; the presence check holds every write from its commit, and the previous revision confirms and inserts ready media rows without a format, so it must commit only with the backfill, inside the fleet transaction |
| `20261101025000_hq_round_trip_platforms_android_capture_size` | 8 | drops and re-adds `form_attachments_size_check` with the larger bound `size_bytes <= 15727616` (part 06 §16.3) | it only widens, so it would be safe under the previous revision too; it rides the window so the ledger moves once |
| `20261101030000_hq_round_trip_platforms_media_format_validated` | 13 | `ALTER TABLE media_assets VALIDATE CONSTRAINT media_assets_ready_media_format` | it holds only after the backfill |

Should another pull request of the stack add a ledgered migration, it takes a stamp that sorts in
pull request order before the validation migration's and joins this table and phase 1 in pull
request 13; `writer.postgres.test.ts`, which starts from `main`'s migration prefix, holds the
reviewed set to the stack's.

**The validation migration** (pull request 13), registered in `lib/case-store/migrations/index.ts`
as `"20261101030000_hq_round_trip_platforms_media_format_validated": hqRoundTripPlatformsMediaFormatValidated`:

```ts
/** Every ready image, audio and video file records its format. */
export async function up(db: Kysely<unknown>): Promise<void> {
	const missing = await sql<{ count: string }>`
		SELECT count(*)::text AS count FROM media_assets
		WHERE status = 'ready' AND kind IN ('image', 'audio', 'video') AND media_format IS NULL
	`.execute(db);
	const count = Number(missing.rows[0]?.count ?? "0");
	if (count > 0) {
		throw new Error(
			`${count} ready image, audio or video files in this database have no recorded format, so Nova can't check where they play. Nova records a file's format when it is uploaded, and these came before it did. The one-time platforms cutover recorded the formats of the databases that existed then; for this one, make the database again from the migrations, or run that cutover over it from a commit that still has it.`,
		);
	}
	await sql`ALTER TABLE media_assets VALIDATE CONSTRAINT media_assets_ready_media_format`.execute(db);
}
/** Forward only: the constraint holds for every row, and unvalidating it gains nothing. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: every ready media file records its format, and nothing is gained by no longer checking it.",
	);
}
```

On a database made fresh from the migrations it validates an empty or fully recorded table. It
stays after the removal: historical migrations are immutable.

**Two phases inside the fleet transaction.** `ledger.ts::applyLedgerTo(tx, target)` is step 3's
`applyLedger` (`733dd193:scripts/lib/hqRoundTripExpressions/writer.ts::applyLedger`) with a target:
it takes Kysely's migration lock (`pg_advisory_xact_lock` on Kysely's lock id), checks the pending
set, and runs `new Migrator({ db: tx, provider }).migrateTo(target)` with each migration inside
its own savepoint and the whole run inside an outer one, so the DDL commits with the fleet or rolls
back with it; it sets `lock_timeout = '15s'` again after Kysely's lock.

- **Phase 1**, `migrateTo("20261101025000_hq_round_trip_platforms_android_capture_size")`, after
  the blocking scan: the pending set must be exactly the five names above, and phase 1 must apply
  exactly the first four.
- **Phase 2**, `migrateTo("20261101030000_hq_round_trip_platforms_media_format_validated")`, after
  the backfill, the apps and the notices: it must apply exactly the fifth.

Any other ledger stops the run with `errorClass` `ledger` and nothing written:
`The migration ledger is not the one this cutover was reviewed against: it expected exactly
{names} to be pending and found {names}. The cutover stopped with nothing written and no
migration applied. Compare a dry run's ledger line with main's migrations, and find out how the
ledger moved before running again.`

After the commit the ledger holds all five, so the deploy's migrate Job applies none of them and
runs its runtime probe; any deploy from `main` before the merge would meet a ledger naming
migrations `main` does not hold, and Kysely's `Migrator` refuses that (runbook check 3).

## 9. The fleet transaction, step by step

Before it opens: the already-applied read; the ledger read (the pending set must be exactly the
five); the fleet read in one `REPEATABLE READ, READ ONLY` transaction (every app row and its
carriers, every live deployment and its baseline, every ready media row, every Project's lookup
definitions and media records, and each app's drift against its stored `case_type_schemas` rows);
the classification (section 7), outside any transaction; the plan
and its digest check against `--expect-plan-digest`, refusing on a mismatch:
`This run's plan has digest {d}, not the {expected} the dry run printed, so it wrote nothing.
Something in the database or the bucket moved after the dry run. Compare the two runs' reports,
then run the dry run again and pass its digest.` A plan holding any blocker refuses too.

Then one transaction:

1. `pg_advisory_xact_lock(hashtextextended('cutover:hq-round-trip-platforms', 0))`;
   `SET LOCAL lock_timeout = '15s'`; record `pg_current_wal_lsn()`.
2. **The blocking scan under the locks**: every `apps` row `FOR UPDATE` in id order, every
   `design_sessions` row `FOR UPDATE`, every ready image, audio and video `media_assets` row
   `FOR UPDATE`; the locked app ids equal the plan's in code-point order, and each app's
   `mutation_seq` and base digest equal the plan's (`app-changed`); each media row's `rowDigest`
   equals the plan's and no row appeared or left (`media-changed`); `holders.ts::readHolderCensus`
   is empty (`holder`). Each stop writes nothing.
3. **Already applied, again**: the ledger read under the locks; the validation migration present
   stops the run.
4. **Before-images**: every `case_type_schemas` row as text, and the count of `cases` rows per app.
5. **Ledger phase 1** (section 8).
6. **The backfill**: one `UPDATE media_assets AS row SET media_format = planned.format FROM
   unnest(${ids}::text[], ${formats}::text[]) AS planned(id, format) WHERE row.id = planned.id AND
   row.status = 'ready'`, whose row count must equal the plan's media count.
7. **Per changed app**, in code-point order of id: `appendSyntheticBatchInTransaction` as section 3
   gives it, requiring `committed` at `baseSeq + 1`.
8. **Notices**: one `INSERT INTO app_migration_notices (app_id, cutover, entries) VALUES (<app id>,
   'hq-round-trip-platforms', <entries>)` per app with at least one entry, its entries parsed by
   `lib/notices/migrationNotice.ts::migrationNoticeEntriesSchema` first.
9. **Ledger phase 2** (section 8).
10. **Postconditions** (section 10).
11. Read `pg_database_size(current_database())` and `pg_wal_lsn_diff` from step 1's position.
12. Under `--rehearse`, the sentinel rollback.
13. Commit.

`pg_notify` for each changed app is the synthetic writer's own (`writeCommittedBatch` calls
`notifyAppStream`), delivered on commit.

**Capacity.** The transaction writes, per changed app, that app's changed entity rows and one
`app_changes` row; per app with entries, one notice row; one value per ready media row; and the
DDL of section 8's first four migrations and one validation scan. Step 3's fleet transaction rewrote every entity row of every
app and wrote a baseline snapshot per app, so its archived execute report (the WAL and the
database growth inside its transaction, in the evidence bucket under `hq-round-trip-expressions/`)
bounds this one; the runbook compares it with the instance's free storage before the window
(section 14, step 1(a)), and this run's `writer` line records its own.

## 10. Postconditions

Inside the transaction; any failure rolls the fleet back, the DDL with it:

- Every app, deleted ones included, loads through `canonicalCommitKernel.ts::loadAppInTransaction`
  (strict schema and the absolute gate), and its `canonicalJsonDigest` is its `targetDigest`, or
  its `baseDigest` where it wrote nothing.
- Each changed app's `app_changes` row at `baseSeq + 1` has batch id `hq-round-trip-platforms:<appId>`,
  actor `system:hq-round-trip-platforms`, kind `blueprint-migration` and `run_id` null, and
  `lib/agent/change-set/baseLoader.ts::loadCanonicalBlueprintAtSequence(tx, { appId, seq: baseSeq
  + 1, expectedDigest: targetDigest })` folds to it from the app's baseline.
- Every ready image, audio and video row's `media_format` is the plan's, and
  `pg_constraint.convalidated` is true for `media_assets_ready_media_format`.
- Every app's authored references pass `lib/db/mediaAssets.ts::lockAndValidateMediaReferences(tx,
  projectId, blueprintMediaRequirements(doc))`, the platform-aware requirement of pull request 7:
  no app references a file a declared platform cannot play.
- `app_deployments` has no `target_web_apps_enabled` column (`information_schema.columns`), and
  `form_attachments_size_check` is pull request 8's (`pg_get_constraintdef` holds `15727616`).
- Every `case_type_schemas` row equals its before-image as text, and every app's `cases` count is
  unchanged.
- Every app with planned entries has exactly one notice row for `hq-round-trip-platforms`, and no
  other has one.
- The ledger holds the five migrations of section 8.

Outside the transaction, two measurements complete the proof, each a runbook step:

- **The runtime probe's absolute gate.** The deploy's migrate Job ends in
  `lib/db/runtimeDatabaseProbe.ts::runCanonicalRuntimeDatabaseProbe`, which decodes every app with
  the new image as the runtime role, reruns the absolute gate (`auditRuntimeProbeParsedBlueprint`,
  `mutationCommitVerdict(doc, [], lookupContext)`) and audits each app's media projection
  (`auditRuntimeMediaReferenceProjection`, platform-aware from pull request 7); any finding fails
  the deploy, which leaves ingress closed (section 14, rollback).
- **`case_type_schemas` converged.** The fleet transaction leaves every schema row as it was (the
  postcondition above), and the merged code's derivation differs from the stored rows exactly as
  the window's dry run counted (section 6, `schema-drift`). After the deploy, with ingress still
  closed, `scripts/scan-schema-drift.ts --prod` from the merged `main` names the counted drift and
  nothing else, the existing drift writer (`schema-drift.cjs --execute` on
  `commcare-nova-case-type-schema-retirement`) converges it, and the same scan then reports no
  drift (section 14, step 10). The writer's retypes cast stored values to the new types and park
  any value that does not cast, as every drift repair does (`scripts/migrate-schema-drift.ts`).

## 11. The blockers

Each stops the cutover before its first write, for the remedy its row names. The advisory runs are
where each is first met; a non-zero count there is an ordinary result, and the dry run in the
window must count none. The person is the fleet's author during dogfooding, so an author's remedy
is theirs, made in today's builder before the window. A blocker in a deleted app is resolved by
restoring the app, making the change, and deleting it again.

| Code | Meaning | Remedy |
|---|---|---|
| `runs-on-neither` | the app holds something Web Apps cannot run, other than date-and-time questions, and something Android cannot run; the line lists both sets of feature ids | the author's: keep what the platform workers use, and take the other side's uses out. For Android: remove each case-list column's location read (`here()`), or the column, and remove each read of the case list's search text. For Web Apps: turn Search first off, let each menu choose one case, change each date or multiple-choice search field to another kind, or, under outcome A of pull request 10's window width gate (part 01 §4.1), remove each `window_width` read from case lists, display conditions and search values. For a Connect app, whose workers are on Android: the Web Apps side |
| `datetime-split-refused` | a date-and-time question's validation rule reads the question itself through a step filter, which the split cannot rewrite | the author's: write the rule over `.`, or remove the rule |
| `media-row-missing` | an authored reference names no ready media row of the app's Project | a defect or a data repair: today's kernel refuses such a reference |
| `transform-admission` | a step's mutations meet an admission issue (an identity collision, a stale anchor, an invalid target) | a defect of the stack, fixed in the pull request that owns the step |
| `target-parse`, `target-gate`, `target-export-readiness` | the target fails the schema, the absolute gate or export readiness; the line carries the codes | the author's where the finding is about the app (its message names the move; the rows below); a defect of the stack where a step should have changed it |
| `not-representable` | the synthetic writer could not replay the target from the production diff | a defect of the stack (the diff of pull request 3 or 4) |
| `case-schema-changed` | the target derives a case-type map other than the source's | a defect of the stack |
| `not-idempotent` | a second application of the transform changes the target | a defect of the stack |

**Blockers by rule.** Each count below is met as `target-gate` with its code, and each is the
author's to resolve before the window; no step rewrites them, because each needs a choice only the
author can make:

| Count | The author's remedy |
|---|---|
| a stored form-logic clock-keeping date (part 03 §2.6) that rule R2 now types as a date and time, compared with a date, refused as `XPATH_INCOMPATIBLE_VALUES` with `details.reason` `date-datetime` (pull request 3, part 03 §10, count 1) | the finding's own sentence: wrap the date and time in `date()` to compare days. A hit the gate admits is no blocker (section 6, `clock-keeping-dates`) |
| under outcome A of pull request 10's window width gate only: a `window_width` read in a slot a form evaluates (field, Connect, case-operation, form-link and `lookup_options_source` slots), refused on every declaration as `XPATH_FUNCTION_CONTEXT_UNAVAILABLE` with `details.reason` `window-width` (part 03 §6.2: Web Apps sends no width with form requests, and Android sets none). Under outcome B, part 03 §6.4 admits the read, and no row applies | remove the read, or read the width in a case list, a display condition or a search value, where Web Apps sends it |
| a stored `drift` or `window_width` read that no longer type-checks once read as a whole number (pull request 10), for example compared with text | compare it with a number, or remove the read |
| a stored session context read pull request 10 refuses in its slot | the finding's own sentence |

Stops that are not an app's: `holder`, `app-changed`, `media-changed`, `digest`, `ledger`, and
`error` (with `media-read` among its classes).

**What production holds** (the planning scan; its counts stay out of this plan): no app of a
blocker class. No Connect app holds something Android cannot run, no app holds a case-list `here()`
read or a `window_width` read, and every app that runs on neither platform does so only through a
date-and-time question, which the split resolves (section 5, step 1); so no `runs-on-neither` app is
expected. No clock-keeping date and no `drift`, `window_width` or `applanguage` read is stored, so
no blocker by rule is expected either. The advisory runs still count every class, for whatever
changes before the window, and the window's dry run must count none.

## 12. The notice

`lib/notices/migrationNotice.ts::MIGRATION_NOTICE_CUTOVERS` becomes
`["hq-round-trip-emission", "hq-round-trip-expressions", "hq-round-trip-platforms"]`, and
`lib/notices/migrationNoticeCopy.ts::MIGRATION_NOTICE_LEADS` gains:

> `On ${day}, Nova started recording where each app runs: in Web Apps, on Android, or both. Here is what that means for this app.`

`NOTICE_ENTITY_TYPES` is unchanged: every carrier step 2 removes belongs to an app, module, form,
field or case-list column. `lib/notices/store.ts` reads the table tolerantly, so earlier rows keep
rendering. `DOCUMENT_NOTICE_REASONS` gains three reasons after `repeat-read-takes-first-row` and
before `lookup-tag-renamed` (the transform steps' reasons in step order), and
`DEPLOYMENT_NOTICE_REASONS` gains one after `next-publish-asks-before-overwriting` and before
`next-publish-asks-more` (the order a publish meets its questions: the drift check, then the Web
Apps question, then the confirmations). Each has exactly one renderer.

| Reason | Kind and entity | `detail` |
|---|---|---|
| `platforms-declared` | document, the app | `runsOn` (`android` or `web-apps`); `causes`, the comma-joined feature ids of the uses the other platform cannot run; `split`, the count of split questions, absent where none |
| `datetime-question-split` | document, the original field (it keeps its uuid) | `form`; `date` and `time`, the new questions' ids |
| `media-not-played-removed` | document, the carrier's owner (section 5, step 2's table) | `form` (field carriers), `module` (form and image-map carriers), `carrier`, `option` or `row` where the table names one, `media` (`image`, `audio` or `video`), `file` (the row's `display_name`, else `original_filename`, stored only where it is at most `NOTICE_TEXT_MAX` characters), `cause` (`web-apps`, `android`, `neither`, `missing` or `too-large`) |
| `next-publish-asks-web-apps` | deployment | `to` (`on` or `off`) |

**Copy** (`{name}` from `detail` or the entity's current name; a value an older renderer does not know
falls back as stated):

- **`platforms-declared`.** The cause words are a record keyed by every feature id whose platform
  reading is `unavailable` on one platform, `PLATFORM_CAUSE_WORDS` in `migrationNoticeCopy.ts`:
  `datetime-question` "date-and-time questions", `case-list-here` "case-list columns that read the
  worker's location", `case-list-search-text` "reads of the case list's search text",
  `search-first` "menus that use Search first", `several-cases` "menus that choose several cases",
  `search-field-single-date` "date search fields", `search-field-multiple-choice` "multiple-choice
  search fields", `window-width` "reads of the window's width", `connect-app` "CommCare Connect".
  `window-width` is in the record under outcome A of pull request 10's window width gate only;
  under outcome B neither it nor `window-width-in-search` reads `unavailable` (part 01 §4.1), so
  the record leaves both out. The words are joined with `joinedNames`, and an id the record does
  not hold is left out. Where none is left, the possessive phrase "its {words}" becomes "part of
  it": "because Web Apps can't run part of it", "because Android can't run part of it".
  - `runsOn` `android` with `connect-app` among the causes: "Connect workers open this app only in
    the Connect app on Android, so it now runs on Android only."
  - `runsOn` `android`: "This app now runs on Android only, because Web Apps can't run its {words}.
    If workers use it in Web Apps too, you can change those and then set it to run in Web Apps as
    well, in App settings."
  - `runsOn` `web-apps`: "This app now runs in Web Apps only, because Android can't run its
    {words}." then, where `split` is present, " Web Apps can't show a date-and-time question, so
    each one in this app now asks for the date and the time separately." then " Nova no longer
    offers a CCZ of it to install on phones. If workers use it on Android too, you can change those
    and then set it to run on Android as well, in App settings."
- **`datetime-question-split`**: "{form}, {Question}: it now asks for the date and the time
  separately, in {date} and {time}, because this app runs in Web Apps, which can't show a
  date-and-time question. A hidden value with the same name joins the two answers, so your rules
  and saved cases read the same date and time. Workers now see two questions with its label, each
  required wherever it was. You can give each one its own label, such as "Visit date" and "Visit
  time"." Without `date` and `time`, the clause ", in {date} and {time}" is left out; without
  `form`, the line opens with the question.
- **`media-not-played-removed`**: "{form or module}, {Entity}: the {media} {file} {carrier} was
  removed, {cause}.{after}"
  - carrier: `label` "on its label", `help` "on its help", `option` "on its choice {option}" (no
    `option`: "on one of its choices"), `menu-icon` "as its menu icon", `menu-audio` "as its menu
    audio label", `case-list-icon` "as its case list's menu icon", `case-list-audio` "as its case
    list's menu audio label", `logo` "as its logo", `image-map-row` "for {row}" (no `row`: "for one
    of its values"); an unknown carrier "in it".
  - cause: `web-apps` "because Web Apps can't play it", `android` "because Android can't play it",
    `neither` "because neither Web Apps nor Android can play it", `missing` "because its content is
    missing from Nova's storage", `too-large` "because it's larger than Nova accepts for its kind";
    an unknown cause "because this app can't play it where it runs".
  - after: for `image-map-row` first " Sorting by that column now puts those cases with the ones
    that match no image."; then for `web-apps`, `android` and `neither` " The file is still in your
    media library. Exporting it again as {advice} and attaching it again brings it back.", with
    advice read from `lib/media/platformPlayback.ts::REEXPORT_AS` (part 04 §6.1, the one source
    the refusals and the boundary rule read too): image "a PNG or JPEG", audio "MP3, or M4A with
    AAC audio", video "MP4 with H.264 Main video", and "a format both platforms play" for a
    `media` the record does not hold. An advice holding a comma is closed with one, as part 04
    §6.1 has it ("Exporting it again as MP3, or M4A with AAC audio, and attaching it again brings
    it back."). For `missing` " You can upload it again and attach it."; for `too-large` " You can
    upload a smaller copy and attach it."
  - `media` other than the three reads "media"; without `file`, the space before it is left out.
  - Example: "Visit, Photo: the video intro.mp4 on its label was removed, because Web Apps can't
    play it. The file is still in your media library. Exporting it again as MP4 with H.264 Main
    video and attaching it again brings it back."
- **`next-publish-asks-web-apps`**:
  - `to` `off`: "This app runs on Android only, and its Web App setting on {space} is on. The next
    publish there asks you before turning it off, and from the next version Web Apps serves after
    that, nobody there can open the app in Web Apps."
  - `to` `on`: "This app runs in Web Apps, and its Web App setting on {space} is off. The next
    publish there asks you before turning it on, so workers there can open it in Web Apps from the
    next version Web Apps serves."
  - another `to`: "The next publish to {space} asks you about this app's Web App setting there."
- **`next-publish-asks-more`** (existing): its labels name `web-apps` through `PLAN_FEATURES`
  already (pull request 5). Pull request 13 adds the settings id `form-entry-sync-off` to it: the
  label `FORM_ENTRY_SYNC_OFF.label` ("Sync Cases On Form Entry turned off", pull request 6) joins
  the list after "a Connect forwarder", and the sentence "Android phones can't open this app's
  forms that work on a case chosen in a menu with Search while {space's} Sync Cases On Form Entry is
  on, so Nova asks whether it's off." follows the forwarder's.

Each line says what changed, what a worker or a person now sees, and what is theirs to do
(`design/readme.md`, "Content fundamentals"), in sentence case with no em dash and no ellipsis.

**Public docs that move with the notice** (pull request 13, one of the stack's two recorded
exceptions to public docs landing in pull request 14, since a notice row names what changed from
the moment the cutover commits; this part owns these two passages, and part 05 §16 and part 07 §5
edit other paragraphs and rows of the same files): `content/docs/publishing.mdx`,
"Updates to review", first sentence becomes "When Nova changes how it stores, checks or writes
apps, or where they run, an app it changed shows an update to review in the builder's header.";
`content/docs/mcp/tools.mdx`, the `get_app` row, "such as what Nova changed when it changed how it
stores, checks or writes apps" becomes "such as what Nova changed when it changed how it stores,
checks or writes apps, or where they run".

## 13. Where it runs

**The Job.** `config/deployment-jobs.json` gains the contract
`commcare-nova-hq-round-trip-platforms`: `serviceAccount`
`nova-migrate@commcare-nova.iam.gserviceaccount.com`, `command` `["node"]`, `args`
`["hq-round-trip-platforms.cjs"]` (the dry run), `tasks` 1, `parallelism` 1, `maxRetries` 0,
`timeout` `"7200s"`, `cpu` `"4"`, `memory` `"8Gi"`, `vpc` true, and `env` the historical repair's
(`NOVA_DB_WORKLOAD` `migration`, `NOVA_DB_USER`, `NOVA_DB_INSTANCE_CONNECTION_NAME`,
`NOVA_DB_NAME`, `NOVA_MIGRATION_DB_USER`, `NOVA_RUNTIME_DB_USER`, `NOVA_CAPTURE_CLEANUP_DB_USER`,
`NOVA_AUDIT_DB_USER`, `NODE_OPTIONS` `--max-old-space-size=7168`, with the values
`commcare-nova-historical-repair` holds) plus `NOVA_MEDIA_BUCKET` `"nova-multimedia-prod"`. On
Cloud Run the storage client resolves its project from the metadata server
(`lib/storage/media.ts::getStorage`), so no `GOOGLE_CLOUD_PROJECT` is needed.

- **Why its own Job.** `lib/storage/media.ts::getBucket` reads `NOVA_MEDIA_BUCKET`, which
  `commcare-nova-historical-repair` lacks, and step 3's reason for reusing that Job ("it holds no
  `GOOGLE_CLOUD_PROJECT`, which the cutover does not need") does not hold here. Its stored
  arguments are this tool's dry run, so no execution can run another tool by omission. It stays
  its own where no row needs bytes (section 7): the setting is harmless there, and one Job keeps
  one path for both branches of the grant.
- **Why `7200s`.** The run reads the stored object of every ready row that needs its bytes read
  (section 7) before its transaction, and plans every app; production holds no such row today, but
  one may arrive before the window, and no planning read measured the plan's own time. Two hours
  bounds a stuck run and leaves the classification and the plan an hour and more. The advisory dry run measures it (section 14, step 1(d)): where its `fleet` line's plan
  milliseconds exceed 3,600,000, the window is not opened; pull request 13's contract `timeout`
  becomes twice the measured seconds plus 1,800, rounded up to a whole minute, the image is built
  again, and step 1 repeats. The runbook's `--wait-seconds` for this Job is always the contract
  `timeout` plus 60 (7260 for `7200s`), so it moves with the contract (section 14, "Run the
  tool").

**The allowlist arm** (`scripts/rollout/deploy-cloud-run.py::_effective_execution_args`): a new
branch for `short_name == "commcare-nova-hq-round-trip-platforms"` admits exactly
`(tool, "--prove-media-read")`, `(tool, "--settle-holders")` and
`(tool, "--execute", "--expect-plan-digest", <64 lowercase hex>)` with
`tool = "hq-round-trip-platforms.cjs"`; with no override the Job runs its stored dry run.
`PLAN_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")` returns beside `APP_ID_RE` (#789 added it and
#791 removed it). Every other shape is refused, `--rehearse`, `--prod`, `--app` and
`--debug-details` among them.

**The bundle.** One line in `Dockerfile` stage `maintenance-build`, after `schema-drift.cjs`,
leaving `sharp` external (section 7):

```
RUN npx esbuild scripts/migrate-hq-round-trip-platforms.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --external:sharp --outfile=hq-round-trip-platforms.cjs
```

three lines in stage `maintenance`, after its `COPY --from=maintenance-build` line, which put
sharp's installed tree where the bundle's `require("sharp")` resolves from `/app`:

```
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/sharp ./node_modules/sharp
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/@img ./node_modules/@img
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/detect-libc ./node_modules/detect-libc
```

and three `.dockerignore` lines after `!scripts/lib/prodDb.ts`:
`!scripts/migrate-hq-round-trip-platforms.ts`, `!scripts/lib/hqRoundTripPlatforms/` and
`scripts/lib/hqRoundTripPlatforms/__tests__/`, the lines #789 added for step 3's tool. The writer
writes no `apps` row itself (the synthetic writer in `lib/db/apps.ts` does), so
`lib/db/__tests__/runHolderWriteGuard.test.ts`'s allowlist is unchanged.

**The exports.** `lib/db/designSessions.ts::reapStaleDesignSessionRun` is exported for the
cutover's lifetime, returning `Promise<StaleRunReapOutcome | "failed">` (the reap's outcome from
`refundStaleDesignSessionRun`, `"state_changed"` for a non-build identity, `"failed"` where it
logged a failure), exactly as #789 did. `abandonPreAppDesignSessionInTransaction` stays private:
the cutover ends no session.

**The maintenance image** is built by hand (`docker build --platform=linux/amd64
--target=maintenance`) from the head of pull request 14, contracts and public docs, the one beneath
the removal; that commit never reaches `main`, because the merge squashes. The operator manages
the Job and runs the scan from a checkout of that same commit.

## 14. The runbook

`docs/plans/hq-round-trip/4-cutover-runbook.md`, written in pull request 13 from this section in
step 3's runbook's form (`733dd193:docs/plans/hq-round-trip/3-cutover-runbook.md`) and removed by
pull request 15. `<14>` and `<15>` are the heads of those pull requests; `$IMAGE` the maintenance
image's digest reference; `$JOB` `commcare-nova-hq-round-trip-platforms`; `$DRIFT_JOB`
`commcare-nova-case-type-schema-retirement`, whose contract admits `schema-drift.cjs --execute`
with an optional `--app <id>` (`deploy-cloud-run.py::_effective_execution_args`); `$BUCKET`
`gs://nova-multimedia-prod`; `$SA` `serviceAccount:nova-migrate@commcare-nova.iam.gserviceaccount.com`;
`$EVIDENCE` a local directory whose files go to `gs://commcare-nova-cutover-evidence/hq-round-trip-platforms/`
at each step's end; `$MAIN_TREE` a checkout of `main`'s tip.

**Checks.**

1. **The trees.** `git diff --stat <14>..<15> -- lib app` names only `lib/db/designSessions.ts`;
   otherwise the gate that migrated is not the gate that probes.
2. **`main` is frozen** from the image build to the merge: `git ls-remote origin refs/heads/main`
   prints the same commit at step 1(b) and at step 9.
3. **No deploy from `main`** between the execute run and the merge.
4. **The advisory dry run is at most three days old** when the window opens.

**The order.** There is no announcement step.

| # | Step |
|---|---|
| 1 | **Before the window.** (a) From `$MAIN_TREE`: `npx tsx --conditions=react-server scripts/scan-schema-drift.ts --prod` and `npx tsx scripts/scan-case-type-schema-retirement.ts --prod` report zero, or the repair each prints runs first as step 3's runbook gives it; `gcloud storage ls gs://commcare-nova-cutover-evidence/hq-round-trip-expressions/` names step 3's execute run's report, whose `writer` line gives its WAL and growth, and `gcloud sql instances describe nova-cases --project=commcare-nova --format='value(settings.dataDiskSizeGb,settings.storageAutoResize)'` shows room for them. (b) From a clean checkout of `<14>`: the image built, pushed and its digest resolved; `docker run --rm --platform=linux/amd64 --entrypoint=node "$IMAGE" -e 'require("sharp")'` exits 0, which loads sharp's binding and libvips from the image's own tree (section 7); for each of `$JOB` and `$DRIFT_JOB`: `python3 scripts/infra/manage-deployment.py job --job <job> --image "$IMAGE"`, then with `--apply`, then `python3 scripts/rollout/deploy-cloud-run.py --verify-job --project=commcare-nova --region=us-central1 --job=<job> --image="$IMAGE" --wait-seconds=120`. (c) The scan, `npx tsx --conditions=react-server scripts/scan-hq-round-trip-platforms.ts --prod > $EVIDENCE/scan-<moment>.jsonl`, for holders and every blocker that needs no media bytes; its `media` line's `needsBytes` (`jq 'select(.section == "media") \| .needsBytes'`) decides (d)'s grant. (d) The bucket policy read (it names `nova-migrate@` nowhere). Where (c)'s `needsBytes` is above zero: the advisory grant, two hours; the Job with `--prove-media-read` until `ok`; the Job's dry run, the full advisory plan; the revocation and the policy read. Where it is zero, as production held at planning: the Job's dry run alone, with no grant and no `--prove-media-read`, whose `media` line shows `needsBytes` zero and no object read. The evidence either way. (e) Every blocker resolved by its remedy (section 11), and (c) and (d) repeated until the dry run's outcome is `ok`; its `schema-drift` line, the drift the window converges in step 10, is recorded, and so is its `media` line's `needsBytes`, which plans step 5. |
| 2 | **Open.** Detach `nova-neg` from `nova-backend`; pause the `commcare-nova-capture-cleanup` Scheduler job. |
| 3 | **Drain.** The scan until its `holders` line counts no live holder (at most `cloudRunRequestSeconds`, 3600 s); the Job with `--settle-holders`; the scan counting no holder at all, whose `media` line's `needsBytes` is recorded for step 5 (ingress is closed, so no row arrives after it). A paused build becomes reapable once `buildStalenessSeconds` (600 s) has passed. |
| 4 | **Restore point.** `gcloud sql backups create --instance=nova-cases --project=commcare-nova --description=hq-round-trip-platforms-restore-point`; its id from `gcloud sql backups list --instance=nova-cases --project=commcare-nova --filter='description=hq-round-trip-platforms-restore-point' --format='value(id)'`. |
| 5 | **The window's grant, where a row needs bytes.** Where step 1(e)'s dry run or step 3's last scan counts `needsBytes` above zero: the policy read; the grant; the Job with `--prove-media-read` until `ok`. Where both count zero: the policy read alone, and steps 6 to 8 run with no grant; a dry run whose `media` line counts `needsBytes` above zero, which after step 3's zero scan is a defect to explain, stops at `media-read`; the grant and its proof are made before step 6 repeats. |
| 6 | **Dry run.** The Job with no override; its report; `planDigest` recorded; the outcome is `ok`, and its `fleet` line's `ledger` is `{"validatedApplied":false,"pendingMigrations":[<the five names of section 8>]}`; its `schema-drift` line is recorded as the drift step 10 expects. |
| 7 | **Migrate.** The Job with `--execute --expect-plan-digest <digest>`; its report (the `writer` line); the outcome is `ok`. A `stopped` outcome with `digest` means the database or the bucket moved after step 6: compare the reports, then repeat step 6, or close the window. Any other stop or error rolled back whole, the DDL with it; a dry run then tells it apart from a commit whose acknowledgement was lost (`already-applied` means the commit landed). |
| 8 | **Post-migration.** Where step 5 made a grant, the revocation and the policy read; the Job's dry run prints `already-applied` (that exit comes before any media read); resume the capture cleanup Scheduler job, whose database authority is `form_attachments` only and which the deploy's prerequisite check requires enabled (`manage-deployment.py`, `scheduler_findings`); `python3 scripts/infra/manage-deployment.py check` passes. |
| 9 | **Deploy.** `git ls-remote origin refs/heads/main` is step 1(b)'s commit; `gh stack merge <top> --squash`. List the merge commit's check runs first (`gh api repos/voidcraft-labs/commcare-nova/commits/<merge sha>/check-runs --jq '.check_runs[] \| {name, app: .app.name, status, conclusion}'`) and watch the deploy check by the name and app that list shows; an empty list is an error to look into. `gcloud builds describe <build id> --project=commcare-nova --region=us-central1 --format=json \| jq '.steps[] \| {id, status}'` shows `migrate` and `deploy` at `SUCCESS`; `verify` fails while the NEG is detached, as it did in steps 2 and 3. The migrate Job finds the ledger applied, converges privileges and runs the runtime probe (section 10). |
| 10 | **Converge.** From `$MAIN_TREE` at the merge commit (`git -C $MAIN_TREE pull --ff-only`, `npm ci`): `npx tsx --conditions=react-server scripts/scan-schema-drift.ts --prod > $EVIDENCE/drift-before-<moment>.txt` names exactly the apps of step 6's `schema-drift` line, with its totals (retypes, case types that need only a re-sync, no unresolvable spec). Then the drift writer, `python3 scripts/rollout/deploy-cloud-run.py --execute-job --project=commcare-nova --region=us-central1 --job=$DRIFT_JOB --image="$IMAGE" --wait-seconds=3060 --execution-arg=schema-drift.cjs --execution-arg=--execute` (`$IMAGE`'s `lib` and `app` are the merged `main`'s by check 1, and pull request 15 does not touch `schema-drift.cjs`'s sources; 3060 is the Job's `3000s` timeout plus 60), its execution's log saved with the execution form below, `$DRIFT_JOB` as the job and no `report` term in the filter. Then the same scan, to `$EVIDENCE/drift-after-<moment>.txt`, reports no drift. An app the writer could not migrate (it isolates each app's failure) is run again with `--execution-arg=--app --execution-arg=<id>` until the scan reports none. A first scan that differs from step 6's line is recorded and explained after the window, and the writer still runs, since past the deploy the only way is forward (rollback, below); ingress reopens only on the zero scan. |
| 11 | **Resume.** Reattach the NEG; `gcloud builds retry <build id> --project=commcare-nova --region=us-central1`, whose `verify` passes; the three public probes of `cloudbuild.yaml`'s `verify` step: `curl --fail --silent --show-error --max-time 30 https://commcare.app/ >/dev/null`, the same for `https://docs.commcare.app/`, and `curl --silent --show-error --max-time 30 --dump-header - --output /dev/null --header 'content-type: application/json' --data '{"jsonrpc":"2.0","id":"cutover","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"nova-cutover","version":"1"}}}' https://mcp.commcare.app/mcp`, which answers `401` with a `www-authenticate` header holding `Bearer` and `resource_metadata=`. |
| 12 | **Close.** For each of `$JOB` and `$DRIFT_JOB`: `gcloud run jobs describe <job> --project=commcare-nova --region=us-central1 --format=json > $EVIDENCE/<job>.json`; `gcloud run jobs executions list --job=<job> --project=commcare-nova --region=us-central1 --format=json > $EVIDENCE/<job>-executions.json`; the evidence; `gcloud run jobs delete <job> --project=commcare-nova --region=us-central1 --quiet`. `$DRIFT_JOB`'s contract stays in `config/deployment-jobs.json`, so the next drift repair makes it again, as step 3's window left it. |

**The commands every step uses.**

- **Run the tool:** `python3 scripts/rollout/deploy-cloud-run.py --execute-job --project=commcare-nova
  --region=us-central1 --job=$JOB --image="$IMAGE" --wait-seconds=7260`, which is the dry run; an
  override adds one `--execution-arg=<word>` per word of an admitted shape, the first being
  `hq-round-trip-platforms.cjs`. `--wait-seconds` is the contract's `timeout` plus 60: 7260 for
  `7200s`, and where section 13 raises the timeout, the runbook's value moves with it in the same
  change.
- **The execution and its report:** `gcloud run jobs executions list --job=$JOB
  --project=commcare-nova --region=us-central1 --sort-by=~metadata.creationTimestamp --limit=1
  --format='value(metadata.name)'`; `gcloud logging read 'resource.type="cloud_run_job" AND
  resource.labels.job_name="commcare-nova-hq-round-trip-platforms" AND
  labels."run.googleapis.com/execution_name"="<execution>" AND
  jsonPayload.report="hq-round-trip-platforms"' --project=commcare-nova --order=asc
  --limit=1000000 --format=json > $EVIDENCE/<execution>.json`; `jq` over it by `section`.
- **The bucket policy, the grant and the revocation:** section 7's three commands, the policy read
  saved to `$EVIDENCE/bucket-policy-<moment>.json` each time.
- **The NEG:** `gcloud compute backend-services remove-backend nova-backend --global
  --network-endpoint-group=nova-neg --network-endpoint-group-region=us-central1
  --project=commcare-nova` and `add-backend` with the same flags, each followed by `gcloud compute
  backend-services describe nova-backend --global --project=commcare-nova
  --format='value(backends[].group)'` into `$EVIDENCE/neg-<before or after>.txt`.
- **The Scheduler job:** `gcloud scheduler jobs pause commcare-nova-capture-cleanup
  --project=commcare-nova --location=us-central1`, and `resume` with the same flags.

**The window** runs as long as its steps: about 5 minutes to open, up to 70 to drain, 10 for the
restore point, up to 15 for the grant and its check where step 5 makes one, the dry run, the execute run, 10 for step 8,
about 20 for the deploy, 10 for the drift writer and its two scans, and 10 to resume. The dry run
and the execute run each take about the advisory dry run's duration, so the operator plans 2 hours
30 minutes plus twice that.
A stop before the commit (a blocker, a holder, a moved app, media row or digest, a ledger, an error)
closes the window with nothing written and no DDL applied: reattach, resume, and revoke any grant step 5 made.

**Rollback.** Before step 7's commit nothing needs restoring: the DDL and the backfill roll back
with the fleet, and the bucket is only read. After the commit and until the merge, the ledger holds
migrations `main` does not have, so a window that closes in that span without merging restores step
4's backup before `main` deploys again (`gcloud sql backups restore <backup id>
--restore-instance=nova-cases --project=commcare-nova`, then the tool's dry run shows
`validatedApplied` false), revokes the grant where step 5 made one, resumes the Scheduler job and reattaches the NEG.
What is lost is only what the capture cleanup removed after step 8. Once the merge's deploy has
started, the only way is forward: a probe failure at step 9 leaves ingress closed, and the fix ships
as a pull request whose deploy passes the probe.

**What the operator records**, each in the evidence prefix: the prerequisite scans of step 1(a)
and step 3's capacity figures read there; every scan and dry-run report with its `fleetSeqDigest`;
each blocker cleared; the `needsBytes` of step 1(c), step 1(e) and step 3 and which branch of the
grant each step took; `<14>`, `<15>`, the image's digest, check 1's diff, `main`'s commit at
step 1(b) and step 9; every bucket policy read, each grant's expiry and its revocation where one was made; the NEG
before and after; the restore point's id; the window's dry run `planDigest`; the execute report
(durations, WAL, growth, peak RSS) and its `schema-drift` line; the post-migration
`already-applied`; the merge commit, its build, the retry; the drift scans before and after the
writer and the writer's execution log; both Jobs' definitions and executions.

**Local databases** go through the same script from a checkout of `<14>`, with the local bucket in
`NOVA_MEDIA_BUCKET`: `NOVA_DB_WORKLOAD=migration npx tsx --conditions=react-server
scripts/migrate-hq-round-trip-platforms.ts --rehearse`, then `--execute --expect-plan-digest <d>`
with the digest a dry run prints, then `NOVA_DB_WORKLOAD=migration npx tsx
--conditions=react-server scripts/migrate-schema-drift.ts --execute` for the drift its
`schema-drift` line counted, as step 3's local path did. A database made fresh from the migrations needs nothing. One that
still holds unrecorded media after the merge stops at the validation migration with its message,
and is made again from the migrations.

## 15. Tests

They run Nova's own code and prove what it does to Nova's database and to a stored document; none
is offered as proof of what a CommCare reader does with an app, which the lane holds (pull request
2 and the corpus). All live in `scripts/lib/hqRoundTripPlatforms/__tests__/` unless named.

| Test | Proves | Boundary |
|---|---|---|
| `transform.test.ts` | each row of the declaration table through `transformApp`; each removal carrier and each cause, the image-map entry removed whole with its sort line; a target that keeps every playable reference; each notice entry's entity and `detail`; `runs-on-neither`, `datetime-split-refused` and `media-row-missing`; a form-logic `window_width` read as `target-gate` under outcome A of pull request 10's window width gate, and under outcome B as no `target-gate` finding; a stored clock-keeping date compared with a date as `target-gate` (`XPATH_INCOMPATIBLE_VALUES`, `date-datetime`); through `judgeTarget`, planted targets no step would make: one the diff cannot replay and one whose mutations `mutationTargetsInvalid` refuses, each `not-representable`, one with a changed case write as `case-schema-changed`; a split app's case-type map unchanged; a second application writes nothing | pure, over documents built with `buildDoc` |
| `deployments.test.ts` | `next-publish-asks-web-apps` for a `push` and a `cutover` baseline that differ, in both directions; none for `create`, `unread`, absent, a digest that does not verify, or an equal value; `next-publish-asks-more` with `web-apps` and with `form-entry-sync-off`; `deep-links-need-republish` only for a changed app with entry points | pure, over baseline rows gzipped by the test |
| `media.test.ts` | `FORMAT_OF_STORED_MIME` holds exactly the MIMEs of `MEDIA_FORMATS` with one variant less `audio/wav`, and for every committed fixture of each of its MIMEs `classifyStoredMediaBytes` returns the map's variant, so the map is what the bytes would give; a row of each such MIME takes its variant with cause `mime` and neither `size` nor `bytes` called, and a fleet of such rows alone never calls the reader; classification through an injected `MediaObjectReader` over the media fixtures pull request 7 commits for the other MIMEs: a variant per fixture, `no-variant` for a 24-bit WAV, `missing` where `size` answers null, `too-large` where `size` answers more than the kind's cap, with `bytes` never called, one read per object key shared by two rows, an error from `size` and one from `bytes` each stopping the run as `media-read` with no format kept; `--prove-media-read` prints `no-media` and reads no object over a fleet whose ready rows all take their format from their MIME, and `ok` over a fleet with one row that needs its bytes read, the fake reader answering its size | pure, with a fake reader at the storage boundary |
| `mediaReader.test.ts` | the production arm `storageMediaReader` over controlled storage responses, the `@google-cloud/storage` client mocked as `lib/storage/__tests__/captureStorageAuthority.test.ts` mocks it: a 404 from `getMetadata` is a null size; a reported size is returned as a number; an object whose stream runs past the cap after a smaller reported size makes `bytes` throw, which `classifyFleetMedia` stops on as `media-read`, never `too-large` | the storage adapter, with controlled external responses |
| `plan.test.ts`, `report.test.ts` | the digest is stable across runs and moves with a base sequence, a base digest, a target, a change, a blocker, a media format or a baseline's held value; the `splits`, `clock-keeping-dates` and `session-context` lines count a writer and a non-writer apart, and each field and slot class apart; the `schema-drift` line counts each drift class apart and leaves the digest unmoved; the `media` line counts removed references by format, and `needsBytes` counts a WAV, an Ogg, an MP4 and a WebM row and no image row; the report holds no authored string or file name from any fixture | pure |
| `writer.postgres.test.ts` | from `main`'s migration prefix, which is every migration before the five of section 8 (`setupAppStateTestDb` with `caseStoreMigrationsBefore` the first of them), seeded through `postgresSeed.ts`, because the head's production writers read `media_assets.media_format`, which that prefix does not hold: several apps, a soft-deleted one among them, one with a date-and-time question (Android only), one with Search first and a date-and-time question (Web Apps only, split), one referencing an HEVC video while declaring both (reference removed, cause `web-apps`), one referencing an H.264 High video while declaring both (kept), one referencing a non-PCM WAV (`unplayable`, removed), one Connect app, an unreferenced ready image (cause `mime`, no object read), a pending row and a missing object behind a WAV row (cause `missing`); the ledger pending exactly the five, phase 1 applying the first four and phase 2 the fifth, and any other ledger refused; a live holder, a moved app, a moved media row and a wrong digest each stop it with nothing written and no DDL; a failure injected after each numbered step leaves the database byte-identical, `target_web_apps_enabled` present, `media_format` absent and `form_attachments_size_check` at its old bound; `--rehearse` leaves nothing; after the commit every app loads, folds from its baseline to its target, and `runCanonicalRuntimeDatabaseProbe` finds nothing; `case_type_schemas` byte-identical; a second run in every mode is `already-applied` | real Postgres |
| `scan.postgres.test.ts` | the scan's counts over a pre-step database seeded through `postgresSeed.ts`, run as a role holding only `SELECT`, which proves it takes no lock and writes nothing; a Hidden Value writer whose calculate holds a clock-keeping date, its stored schema row typing the property `date` (`seedStoredSchemas`), gives a `schema-drift` line with one `date` to `datetime` retype, and an app whose stored rows equal the head's derivation gives none | real Postgres |
| `holders.postgres.test.ts` | step 3's cases (`733dd193:scripts/lib/hqRoundTripExpressions/__tests__/holders.postgres.test.ts`), adapted: that file imports step 3's `fleet.ts`, `run.ts`, `writer.ts` and seed, so this one reads through `source.ts`, `run.ts` and `ledger.ts` and seeds through `postgresSeed.ts`. Holders settle through the production reapers, and a live holder stops the write | real Postgres |
| `lib/case-store/migrations/__tests__/mediaFormat.postgres.test.ts` (part 04 §10's file from pull request 7, the one file for both media-format migrations; pull request 13 adds these cases) | the validation migration validates an empty table and a fully recorded one, and refuses one ready image without a format with its message and the constraint still `NOT VALID`. That case runs in order, because a `NOT VALID` check still holds every insert after it: migrate to the prefix before `20261101020000_hq_round_trip_platforms_media_format`, insert the ready image row, migrate through `20261101025000_hq_round_trip_platforms_android_capture_size`, then run the validation migration and assert its message and `pg_constraint.convalidated` false. Kept after the removal | real Postgres |
| `scripts/infra/tests/test_deployment_policy.py::test_hq_round_trip_platforms_admits_its_runbook_shapes_and_nothing_else` | the stored dry run with no override; the three admitted overrides; refused: `--rehearse`, `--execute` without a digest, a digest of 63 or 65 characters, an uppercase or newline-ended digest, a trailing argument, flags reordered, `--prod`, `--app <id>`, `--debug-details`; the tool refused on `commcare-nova-migrate` and `commcare-nova-historical-repair` | infra |
| `scripts/infra/__tests__/containerArtifacts.test.ts`, new test "the HQ round-trip platforms cutover runs a maintenance bundle of its migrate script on its own Job" | the one `maintenance-build` line with `--external:sharp`, the `maintenance` stage's three `COPY --from=deps` lines naming exactly `node_modules/sharp`, `node_modules/@img` and `node_modules/detect-libc`, the Job contract (`args`, `maxRetries` 0, `serviceAccount`, `NOVA_MEDIA_BUCKET`), the three `.dockerignore` lines, and the runner stage not depending on `maintenance-build`; the bundle's text requires no package but `sharp` and `pg-native`; the existing test "the authored job bundle commands produce self-contained operator executables" bundles the new line and runs its `--help` from a directory of its own whose `node_modules` holds only those three directories, copied from the repository's, so the bundle loads sharp from exactly the tree the image copies, while every other bundle still runs with no `node_modules` | infra |
| `lib/notices/__tests__/migrationNoticeCopy.test.ts`, `migrationNotice.test.ts`, `components/builder/notices/__tests__/appNoticeModel.test.ts` | every new reason renders with present and absent details and a removed entity; `PLATFORM_CAUSE_WORDS` holds exactly the feature ids `PLATFORM_FEATURES` reads `unavailable` on a platform; the lead; the reasons' places in both orders; `next-publish-asks-more` with `form-entry-sync-off`; the dialog groups three cutovers' notices | pure |

`__tests__/postgresSeed.ts`, the helper the three Postgres tests seed through, writes raw SQL at
`main`'s migration prefix, after step 3's helper of the same name: app rows with their entity rows
and fold baselines, ready and pending media rows without a format, deployments with their resources
and baselines, stored `case_type_schemas` rows (`seedStoredSchemas`), cases, and `databaseImage`
for the byte-identical checks.

The cutover adds no lane group and moves no proof timing. Five things are proven by the real system
in the runbook and by no test: check 1; sharp loading in the built image (step 1(b)); the format of
production's rows (the advisory dry run, which reads bytes only where a row needs them, section 7);
the fleet transaction's duration over production's rows; and the drift writer converging exactly
the counted drift (step 10).

## 16. Removal and the cutover's trace

Pull request 15, the removal, at the top of the stack, removes: both scripts and
`scripts/lib/hqRoundTripPlatforms/` with its tests; the `Dockerfile` `maintenance-build` line and
the `maintenance` stage's three sharp `COPY` lines, and the three `.dockerignore` lines; the Job
contract in `config/deployment-jobs.json`; the allowlist branch and `PLAN_DIGEST_RE` in
`scripts/rollout/deploy-cloud-run.py` with their rows in `test_deployment_policy.py` and
`containerArtifacts.test.ts`; the `scripts/README.md` entry; the `docs/architecture/deployment.md`
paragraph naming the tool; the runbook; and this plan (`docs/plans/hq-round-trip/4-platforms.md`
and `4-platforms/`). It makes `reapStaleDesignSessionRun` module-private again with today's body
and `Promise<void>`. The cutover's Job is already deleted by runbook step 12. The squash merge
leaves the tooling in `main`'s history and none on its tip, in one deploy.

It updates `docs/plans/hq-round-trip/README.md` at each of its four links to `4-platforms.md`, so
no file names the plan or its parts:

- the steps table's step 4 row reads done, and its link points at a new "Step 4 is done" section,
  which names where what endures lives (the subtree contracts and `docs/architecture/`), the
  baseline step 4's plan read (`main` at `e9e6cd93`) and the cutover's trace below;
- "What step 3 left to later steps" drops `4-platforms.md` from its list, which then names the
  outlines of steps 5, 6 and 7, and names "Step 4 is done" for what step 4 took;
- the finding 74 paragraph says step 4 closed it, its stop held on `targeted-datetime-ordering`'s
  control in `proof/walk-stops.json`, and its link ("Proof") points at "Step 4 is done";
- the "Step 4's plan reads `main` at `e9e6cd93`" bullet's link ("The baseline this plan was written
  against") points at "Step 4 is done", which records that baseline, as the step 3 bullet beside it
  points at "Step 3 is done".

The outlines of steps 5 to 7 cite those homes in place of step 4's plan.

What stays, the cutover's trace:

- the five migrations of section 8 and `mediaFormat.postgres.test.ts` (immutable);
- `lib/doc/platformDeclaration.ts` (`planContentDeclaration` and `declaredForContent`) and its one
  test file (pull request 4; the fuzz mapping and step 6's import proposal read it);
- the cutover id, its lead, the four reasons, `PLATFORM_CAUSE_WORDS` and the `next-publish-asks-more`
  extension (stored rows render for good);
- each changed app's `blueprint-migration` row by `system:hq-round-trip-platforms`;
- the two docs sentences of section 12;
- the evidence prefix `hq-round-trip-platforms/`, content-free reports and IAM policy reads only,
  never deleted from.

## 17. Files by pull request

**Pull request 13, the cutover.**

- Storage: `lib/case-store/migrations/20261101030000_hq_round_trip_platforms_media_format_validated.ts`
  (new), `lib/case-store/migrations/index.ts`,
  `lib/case-store/migrations/__tests__/mediaFormat.postgres.test.ts` (the validation cases, in
  pull request 7's file), `lib/db/designSessions.ts` (one export).
- Notice: `lib/notices/migrationNotice.ts`, `lib/notices/migrationNoticeCopy.ts`,
  `lib/notices/__tests__/migrationNotice.test.ts`, `lib/notices/__tests__/migrationNoticeCopy.test.ts`,
  `components/builder/notices/__tests__/appNoticeModel.test.ts`.
- Docs kept: `content/docs/publishing.mdx`, `content/docs/mcp/tools.mdx`.
- Scripts and the runbook, new, deleted by pull request 15: `scripts/scan-hq-round-trip-platforms.ts`,
  `scripts/migrate-hq-round-trip-platforms.ts`, `scripts/lib/hqRoundTripPlatforms/**`,
  `docs/plans/hq-round-trip/4-cutover-runbook.md`.
- Infrastructure and docs, edited, their pull request 13 additions removed by pull request 15:
  `config/deployment-jobs.json` (the Job contract), `Dockerfile` (the `maintenance-build` line and
  the `maintenance` stage's three sharp `COPY` lines), `.dockerignore` (three lines),
  `scripts/rollout/deploy-cloud-run.py` (the allowlist branch, `PLAN_DIGEST_RE`),
  `scripts/infra/tests/test_deployment_policy.py` and `scripts/infra/__tests__/containerArtifacts.test.ts`
  (their rows), `scripts/README.md` (the entry), `docs/architecture/deployment.md` (one paragraph: "The HQ round-trip
  platforms cutover runs on its own Job, `commcare-nova-hq-round-trip-platforms`, from the
  maintenance image as `hq-round-trip-platforms.cjs`, with a time-conditioned read grant on the
  media bucket made only for a run that must read stored media bytes and revoked after it. With no override the Job runs the dry run,
  which writes nothing; `--prove-media-read`, `--settle-holders` and `--execute
  --expect-plan-digest <digest>` are its only other admitted shapes. Its runbook is
  `docs/plans/hq-round-trip/4-cutover-runbook.md`; the tool, the Job, the runbook and this
  paragraph leave together once the cutover has run.").

**Pull request 15, the removal.**

- Deleted: both scripts, `scripts/lib/hqRoundTripPlatforms/**`,
  `docs/plans/hq-round-trip/4-cutover-runbook.md`, `docs/plans/hq-round-trip/4-platforms.md` and
  `docs/plans/hq-round-trip/4-platforms/`.
- Edited, their pull request 13 additions removed: `config/deployment-jobs.json`, `Dockerfile`,
  `.dockerignore`, `scripts/rollout/deploy-cloud-run.py`,
  `scripts/infra/tests/test_deployment_policy.py`, `scripts/infra/__tests__/containerArtifacts.test.ts`,
  `scripts/README.md`, `docs/architecture/deployment.md`.
- Edited otherwise: `lib/db/designSessions.ts` (`reapStaleDesignSessionRun` module-private,
  `Promise<void>`); `docs/plans/hq-round-trip/README.md` (the four sites of section 16);
  `docs/plans/hq-round-trip/5-case-writes-forms-navigation.md`, `6-import.md`, `7-rest-of-model.md`
  (their citations of this plan point at where what endures lives).

**What this part takes from beneath it**, each named in the pull request that adds it:
`appSettings.runsOnlyOn`, the `setAppSettings` null arm and its diff arm, `declaredPlatforms`,
`declaresWebApps`, `PLATFORM_FEATURES`, `lib/domain/platformUses.ts::platformFeatureUses` with the
leaf uses and `contentRunsOn` (part 01 §3), and `lib/doc/platformDeclaration.ts` (4);
`planDatetimeSplits` with `DatetimeSplit`, `datetimeSplitFieldUuid`, the `convertField` label seed
and the converted-field media diff (3); `lib/deployment/webApps.ts::baselineWebApps` (part 05 §4),
`PLAN_FEATURES["web-apps"]` and the column drop migration (5); `formEntrySyncReasons`,
`FORM_ENTRY_SYNC_OFF` and the kind migration (6); the format column migration with
`media_assets_media_format_known` and `media_assets_ready_media_format`, `MEDIA_FORMATS`,
`MediaFormatValue`, `mediaFormatPlaysOn`, `classifyStoredMediaBytes`, `playsOnEvery`,
`unplayableReferences` and `REEXPORT_AS` (part 04 §2.1, §3.9, §6.1), the platform-aware
`blueprintMediaRequirements`, `lockAndValidateMediaReferences` and runtime probe audit,
`MEDIA_FORMAT_NOT_PLAYED`, `mediaFormat.postgres.test.ts`, and the new readers' fixtures (7); the
capture size migration (8, part 06 §16.3); the context typings, the `case-list-search-text` value
arm and, under outcome A of the window width gate, `SlotProfile.windowWidth`'s refusal in every
slot a form evaluates (10). From `main` as it stands: `scripts/lib/schemaDrift.ts::computeSchemaDrift`,
`schema-drift.cjs` and the `commcare-nova-case-type-schema-retirement` contract and allowlist arm.

---

## Departures

- **`next-publish-asks-more` entries**, beyond the four new reasons the step's decision names: every
  published app that declares Web Apps meets the `web-apps` confirmation at its next publish, and
  some meet `form-entry-sync-off`, which step 2's cutover told members of in the same reason; the
  renderer gains the sync setting so that line can name it.
- **Two bucket grants where a row needs bytes**, an advisory one before the window as well as the
  window's: the full plan needs the media classification, which runs only in the Job, and step 2's
  KMS precedent made the same pair. Where no row needs bytes, as production held at planning, no
  grant is made (section 7).
- **The Connect arm of `platforms-declared` drops "Its next publish turns off Web Apps for it in
  CommCare HQ."**: whether that is true depends on each project space, and the per-deployment line
  `next-publish-asks-web-apps` says it where it is.
- **No prerequisite orphan-key scan**: the cutover declares no property and writes no case
  schema, so step 3's orphan check has nothing to act on.
- **The drift writer runs in the window, as step 3's did**, though the cutover writes no case
  schema: the merged code derives some stored properties' types differently from `main`'s (part 03
  §10, counts 1 and 3), so the dry run counts that drift (section 6) and step 10 converges exactly
  it before ingress reopens. The fleet transaction itself leaves every schema row and every case
  row as it was (section 10).

## Executed during planning

Content-free, on this machine. One read touched production: the content-free, read-only scan of
item 6, which the person approved.

1. Nova history at `733dd193` (step 3's `writer.ts::applyLedger`, `holders.ts`, `fleet.ts::readDeployments`,
   the runbook, the `Dockerfile`, `.dockerignore`, `deploy-cloud-run.py` and infra test diffs), at
   `5cf6e327^` (step 2's runbook: its time-conditioned KMS grants, revocations and policy reads) and
   `5cf6e327` (the removal of step 2's Job contract).
2. The installed Google Cloud SDK's source (`lib/surface/storage/buckets/add_iam_policy_binding.py`,
   `remove_iam_policy_binding.py`, `lib/googlecloudsdk/command_lib/iam/iam_util.py::_AddConditionFlagsForRemoveBindingFromIamPolicy`):
   both bucket binding commands take `--condition`, and `--all` removes every binding of a role and
   member whatever its condition.
3. `node_modules` reads of `file-type` 22.1.1, `music-metadata` 12.2.0, `strtok3`, `token-types`,
   `@tokenizer/inflate` and `uint8array-extras` for top-level `await` (none), and of `file-type`'s
   one runtime `import()` (`fromFile` only).
4. Reads of `node_modules/sharp/dist/*.cjs` (every `require`: `@img/colour`, `detect-libc`,
   `semver` and the platform's `@img/sharp-<platform>/sharp.node`) and of `package-lock.json`
   (`node_modules/sharp` 0.35.5 with its own `node_modules/sharp/node_modules/semver`,
   `@img/sharp-linuxmusl-x64` and `@img/sharp-libvips-linuxmusl-x64` for the Alpine image), with
   the `Dockerfile`'s `maintenance` and runner stages, for the sharp tree of section 13.
5. Reads of `scripts/lib/schemaDrift.ts`, `scripts/scan-schema-drift.ts`,
   `scripts/migrate-schema-drift.ts`, `config/deployment-jobs.json`'s
   `commcare-nova-case-type-schema-retirement` contract and its allowlist arm, and step 3's
   runbook step 10 at `733dd193`, for the drift step of section 14.
6. A content-free, read-only scan of production on 2026-10-23, reporting classes, never names or
   values; no count from it enters this plan. It found: Connect apps of both kinds, some also
   holding date-and-time questions; a few other apps Android only for a date-and-time question
   alone; a few Web Apps only (for Search first or for a single-date Search field); a few on
   neither, each a date-and-time question beside a single-date Search field; no app of a blocker
   class; no stored `drift`, `window_width` or `applanguage` read (the session context reads are of
   `userid` and `username`) and no clock-keeping date; ready media rows of JPEG and PNG only beside
   document rows; and `app_deployments.target_web_apps_enabled` `true` on some deployments and null
   on most. Sections 2, 5, 7 and 11 state where each decides something.
7. A read of `lib/media/validate.ts`'s history (`git log`, `git show c14d45cb` and `d07c38df`) for
   section 7's rule: the sharp read of PNG, JPEG, GIF and WebP and the music-metadata parse of MP3
   since #45, and BMP, M4A and FLAC first accepted by #765 with the checks part 04 keeps.
