# Step 3, part 09: The cutover and its notice

Part of [step 3's plan](../3-expressions.md), which holds the baseline, the decisions and the exit;
part 10 holds the stack. Stack references use the fifteen pull requests by number and name.
Citations are `path::symbol` for Nova at `main` `5cf6e327`; Nova's own history is read at
`f9218b7e`, the last commit holding step 2's cutover tooling (`git show f9218b7e:<path>`). This part
makes no CommCare claim of its own: every CommCare fact it relies on is a fact of another part,
cited there at the pins (commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`,
commcare-android `7a5584475580`, formplayer `24383ac71bfb`, commcare-connect `046c7fd78081`,
Vellum `01215f251c57`).

Step 3 changes the stored shape of every expression slot of every Nova document once, in one direct
maintenance cutover (`docs/architecture/contracts.md`, "Direct maintenance cutover"), and tells
each app's members what changed in a notice. The cutover is lean: it reads no CommCare HQ state,
decrypts no key, and needs no KMS grant. Everything it decides comes from Nova's own database.

Where production holds a shape this part lifts or refuses, the part says so in words. As in step 2,
no count from production enters this plan: two read-only production scans and this part's
content-free probe decided which lifts, refusals and blockers the cutover meets, and the dry run
counts each at the window.

| Part | Owns | Pull request |
|---|---|---|
| The pre-step half | the frozen pre-step fixtures and their capture test, the frozen copy of today's XPath printer, the emission normalizer and the base emitter | pull request 2, the cutover skeleton, whose `lib` and `app` trees still equal production's but for pull request 1's one test table (§3) |
| The cutover | the fold-horizon DDL, the scan and migrate scripts, the lift, the ordered steps, the fleet write, the notice writer, the runbook, the Job's allowlist arm, the two re-exports, `RUNTIME_VERSION` | pull request 13, the cutover, above pull request 12, the authoring |
| The notice | the new cutover id, its lead, every new reason with its renderer | pull request 13 |
| The removal | every one-off piece above | pull request 15, the removal, the top of the stack |

**This part is the registry.** Step ids, their order, blocker codes and notice reasons are spelled
once here, and other parts use these strings verbatim.

---

## Decisions in brief

1. **One fold horizon per app, deleted apps included**, with marker
   `fold-baseline:hq-round-trip-expressions` and actor `system:hq-round-trip-expressions`, admitted
   by one new DDL migration that copies both admit functions of
   `lib/case-store/migrations/20261015000000_hq_round_trip_fold_horizon.ts` whole with a fifth
   identity pair. No suffix rewrite and no `blueprint-migration` batch (§1).
2. **The lift is the production parser.** Each stored `XPathExpression` is printed to text with a
   frozen copy of today's `lib/domain/xpath/print.ts::projectXPath` over the raw rows and parsed with
   the production step 3 parser (`lib/commcare/xpath/expressionAst.ts::parseFormExpression`, part 02
   §1.2) against the target document. There is no second lifting dialect, and any parse refusal is a
   blocker by construction (§4, step `form-logic-lift`).
3. **Record expressions map structurally.** Every record arm keeps its stored bytes (part 01,
   Decisions in brief, item 1); the step rewrites only a record `div` over two integers to
   `quotient` (production holds none) and a literal opposite a static-select answer to `choice`
   (production holds some) (§5).
4. **Seven ordered steps**, each one stored-shape change with its old-to-new mapping, its blockers
   and its notice reason (§5). The lift's sub-changes (canonical respelling, relative paths, case
   queries, session datums, `choice`, absence) are classes of one step, because one parse produces
   them, and each class is counted and named on its own.
5. **Declarations of properties expressions read** take the least type their reads admit: `text`
   unless a read orders the property against a number or a temporal value, or does arithmetic on it.
   Production meets a few declarations, in very few apps, all `text` (§5, step
   `declare-read-properties`). The case store converges after the deploy through the existing drift
   writer (option A), before ingress reopens (§8).
6. **The plan digest stays**, as a cheap guard: the in-window Job dry run prints it and
   `--execute --expect-plan-digest` refuses a different plan. It covers only database state, so a
   quiescent database cannot move it (§3).
7. **No clone rehearsal; no rehearsal in the window.** Step 2's archived execution (the evidence
   bucket) shows the fleet transaction fits the window with a wide margin, and its WAL and growth
   fit the instance's storage many times over. The window runs the Job's dry run and then
   `--execute`, as step 2's window actually ran. `--rehearse` exists for local databases and the
   writer tests and is not allowlisted (§13, §14).
8. **The Job is `commcare-nova-historical-repair`**, whose contract `config/deployment-jobs.json`
   still holds but which production no longer has (read during planning: only `commcare-nova-migrate`
   and `commcare-nova-capture-cleanup` exist). The runbook makes it from the maintenance image, adds
   one tool to its allowlist arm, and deletes it after archiving. The drift writer runs on
   `commcare-nova-case-type-schema-retirement`, made the same way, under its existing arm (§13).
9. **The emission census is a gate on unexplained differences, content-free**: the base half runs
   at pull request 2's head (production's emitter), the head half at the cutover's, and both compare
   digests of normalized files, never bytes. An app whose head bytes differ from its base bytes for
   no named reason stops the cutover as a defect of the stack (§7).
10. **The notice** gains cutover `hq-round-trip-expressions`, its lead, nine document reasons and one
    deployment reason, and reuses `unsaved-assistant-work-discarded` and `deep-links-need-republish`
    (§12).
11. **`RUNTIME_VERSION` 15 → 16** in pull request 13; **`MODEL_CONTEXT_VERSION` takes no
    value of its own here**, because every pull request that changes model-facing schema or prose
    bumps it: pull requests 3, 5, 9, 10 and 12, the projection, the shape, instances and session,
    CSQL and the authoring (part 10, "The model-addition checklist", item 13), which already retires
    every model context made before the deploy, and the stack merges together.
12. **`abandonPreAppDesignSessionInTransaction` and `reapStaleDesignSessionRun`** are exported again
    for the cutover's lifetime and made module-private again by the removal, as #767 left them.
13. **Every dry-run count that can block is a blocker by rule**: `HIDDEN_VALUE_WRITER_TYPE_MISMATCH`,
    `CYCLE`, a record verdict moved by inference, `SELECT_PRELOAD_WRITE_NOT_AN_OPTION`,
    `case-query-untyped`, `selected-cases` as one value, a prose repeat read used as one value and
    `day-only-on-device`. Each non-zero count is resolved by the author in the app before the window,
    and none waits on a decision there (§11).

---

## 1. Why a fold horizon, and its DDL

Step 3 replaces `lib/domain/xpath/ast.ts::xpathExpressionSchema` and
`lib/domain/predicate/types.ts::predicateSchema` / `valueExpressionSchema` with one `Expression`
union (part 01). Every schema that embeds them changes: every field kind, `selectOptionsSource.ts`,
`forms.ts` (form links, Connect), `modules.ts` (display conditions, case lists, search),
`blueprint.ts` (the catalog loses `required`, `validation` and `validation_msg`, decided with the
person, 2026-10-17). Every mutation kind that carries one of them then stops parsing under the new
`mutationSchema`, so pre-horizon history cannot replay (`docs/architecture/contracts.md`, "Valid by
construction").

- **A `blueprint-migration` batch is impossible**: `lib/db/apps.ts::appendSyntheticBatch` loads its
  source through the current strict schema, which no pre-step document passes.
- **A suffix rewrite is rejected**, for step 2's reasons (step 2's plan, part 10, "Why this is a
  fold-horizon cutover") and one more of its own: lifting a relative path or a `casedb` query in a
  historical mutation needs the form tree as it stood at that row, so it would fold history per row.
  Nor is the suffix replayed through the lift: the horizon takes each app's head, which already
  holds every committed edit, and history behind it becomes opaque. The suffix is also empty today
  (production held no `app_changes` row after any app's step 2 baseline at both scans and at this
  part's probe), so nothing is lost by the horizon at the planning snapshot.
- **Decision: one horizon per app**, deleted apps included, uniform because every document's shape
  changes. `app_changes.batch_id = 'fold-baseline:hq-round-trip-expressions'`,
  `actor_id = 'system:hq-round-trip-expressions'`, `run_id NULL`, kind `fold-baseline`,
  `mutations []`. The batch id is the idempotency latch (`UNIQUE (app_id, batch_id)`).

**The DDL.** `lib/case-store/migrations/<timestamp>_hq_round_trip_expressions_fold_horizon.ts`, its
timestamp later than every other migration of the stack, registered in `migrations/index.ts`. It
replaces `nova_admit_app_change_fold_baseline_insert` and `nova_require_app_change_fold_baseline`,
each body copied whole from `20261015000000_hq_round_trip_fold_horizon.ts` with one more operator
arm:

```sql
((marker.batch_id = 'fold-baseline:canonical-identity-foundation' AND marker.actor_id = 'system:canonical-identity-foundation')
 OR (marker.batch_id = 'fold-baseline:unified-authoring' AND marker.actor_id = 'system:unified-authoring')
 OR (marker.batch_id = 'fold-baseline:hq-round-trip-emission' AND marker.actor_id = 'system:hq-round-trip-emission')
 OR (marker.batch_id = 'fold-baseline:hq-round-trip-expressions' AND marker.actor_id = 'system:hq-round-trip-expressions'))
AND marker.run_id IS NULL
```

and the same arm, over `NEW.batch_id` / `NEW.actor_id`, in `nova_require_app_change_fold_baseline`.
Every other check stays (the snapshot equals `nova_current_app_change_fold_snapshot` as text, the
`xmin` checks, digest and Project). Step 3 adds no root `apps` column (case types already live in
`apps.case_types`), so `nova_current_app_change_fold_snapshot` is unchanged; a pull request of the
stack that adds a root column replaces it in its own migration, as `20261015030000_app_settings.ts`
did. The generalization to a control table of identities is rejected: it saves one file per step and
changes a stated contract (`lib/db/CLAUDE.md`: "Adding another baseline identity needs new DDL").

`lib/db/CLAUDE.md`'s sentence becomes "accepts exactly five identities", naming the
`hq-round-trip-expressions` pair. The pre-horizon read rule needs nothing new: it lives once in
`lib/agent/change-set/baseLoader.ts::greatestFoldBaselineSeq` and serves any later horizon.

Every ledgered migration of the stack is additive and safe while the old revision is deployed,
because the execute run applies the whole pending ledger (`lib/case-store/migrate.ts::runCaseStoreMigrationsWithReport`)
before the merge. A pull request of the stack whose migration is not safe that way is a defect of
the stack, found by `writer.postgres.test.ts` (§15), which starts from `main`'s migration prefix.

## 2. What else holds expression-shaped state

| Holder | Today | The cutover |
|---|---|---|
| Open builder tabs | a `fold-baseline` row in a stream suffix makes the client reload (`lib/collab/CLAUDE.md`, "Reload reconciliation"); `NEXT_DEPLOYMENT_ID` reloads a stale client | nothing new |
| Private agent work: `authoring_workspaces` open, `authoring_sessions.active_candidate_id`, `design_change_sets` open | staged steps in the old dialect | clears every pointer, abandons every open workspace and change set; reason `unsaved-assistant-work-discarded` on each app that had one (none at the probe) |
| Pre-app build sessions holding open work | an open genesis workspace of old-dialect steps | ended through `lib/db/designSessions.ts::abandonPreAppDesignSessionInTransaction`, exported again; no notice (no app exists) |
| `events` `mutation` rows | `lib/log/types.ts::mutationEventSchema` embeds `mutationSchema`, so an old one fails its run's read | archived into `archived-mutation` by step 2's statement (§9). At the probe the table holds no `mutation` row (step 2 archived them; `archived-mutation` and `conversation` rows remain); whatever accrues until the window is archived |
| `events` `conversation` rows | tool inputs and outputs are `z.unknown()` (`lib/log/types.ts::conversationPayloadSchema`) | nothing |
| `chat_stream_chunks`, `presence`, `threads.active_*` | stream holders | cleared |
| Paused conversations (`threads.input_round`) | identities only | nothing stored; the drain settles holders |
| App tests | `lib/db/appTests.ts::RUNTIME_VERSION` is 15 | 16, in pull request 13: the horizon changes the document every stored snapshot was taken over (step 2's precedent). The horizon's `+1` also ends every running test |
| Model contexts | `lib/models.ts::MODEL_CONTEXT_VERSION` decides whether a compaction checkpoint replays | no value of its own (decision 11) |
| Thread transcripts | `lib/chat/sanitizeToolParts.ts::sanitizeHistoricalToolParts` | no rewrite |
| Entry-point links | `lib/deployment/entryPointLinks.ts` refuses a link whose manifest sequence is stale | nothing stored; `deep-links-need-republish` is written again (§12) |
| `apps.localization` | translation overlays hold prose | nothing: prose keeps its stored shape (part 01 §4, prose parts), and no translation unit owns a catalog `validation_msg` (`lib/domain/translationUnits.ts` lists only a catalog property's option labels, `case-property-option-label`), so the catalog's retired slots move no overlay entry |
| Lookup and location reference edges | `lookup_table_references`, `lookup_column_references`, `app_location_references` | rebuilt per app through the commit kernel's own functions (§9). Production's stored form logic reads no table and no place (part 05 §6.1), so the rebuild adds no edge at the snapshot |
| `case_type_schemas`, expression indexes | equal today's derivation (prerequisite scan, §14) | never written by the fleet transaction; the target's derivation differs only by the planned declarations and inference typings, which the drift writer converges after the deploy (§8) |
| Deployment ledger baselines | HQ's sources | untouched; a byte change at the next publish is not drift |
| Staged captures, in-flight submissions | fenced by path and `app_mutation_seq` | nothing; the existing fences hold |

Three runtime reads that fold behind a horizon were fixed permanently in step 2
(`lib/agent/build/orchestrator.ts`, `lib/agent/change-set/materializeGenesis.ts::readMaterializedGenesisReceipt`,
`app/api/apps/[id]/stream/route.ts`), all through `greatestFoldBaselineSeq`; they serve this horizon
unchanged, and `lib/agent/change-set/__tests__/preHorizonReads.postgres.test.ts` gains a case with two
horizons (§15).

## 3. Scripts and their layout

```
                                                    (pull request)
scripts/emit-hq-round-trip-expressions-base.ts       2    read-only base half of the census: normalized-file digests at production's emitter
scripts/scan-hq-round-trip-expressions.ts            cut  read-only scan: the plan, the blockers, the census head half
scripts/migrate-hq-round-trip-expressions.ts         cut  the Job's entrypoint; a dry run unless told otherwise
scripts/lib/hqRoundTripExpressions/
  frozenPrinter.ts       2    a frozen copy of today's projectXPath and xpathPrintContext, over raw rows
  emissionNormal.ts      2    the census normalizer (Lezer canonical XPath text, unread instance declarations dropped)
  oldShape.ts            cut  the one reader of the pre-step carriers; step 2's file (f9218b7e) copied
  transform.ts           cut  pure: raw carriers -> { target, changes, blockers }, running steps/ in order
  steps/<step>.ts        cut  one module per row of §5
  behavior.ts            cut  pure: one selection function per no-write reason (§6)
  census.ts              cut  head half of the census and its verdicts (§7)
  holders.ts             cut  step 2's file copied: settles lapsed and paused holders through the production reapers
  plan.ts                cut  fleet source -> ExpressionsCutoverPlan and its digest
  writer.ts              cut  the one fleet transaction
  notice.ts              cut  changes -> notice rows
  report.ts              cut  the content-free JSON Lines report
  __tests__/             2 and cut   fixtures/pre-step/ and its capture test in 2; every other test in cut
```

"2" is pull request 2, the cutover skeleton; "cut" is pull request 13, the cutover. Both scripts follow the house conventions: first line
`import "./lib/loadEnv";`, `commander`, `scripts/lib/main.ts::runMain`, `closeCaseStoreDatabase()` in
a `finally`. The step 2 files to copy from are at `f9218b7e`: `scripts/lib/hqRoundTripCutover/oldShape.ts`,
`holders.ts`, the writer's fleet transaction in `writer.ts`, `report.ts`'s line framing, and
`scripts/migrate-hq-round-trip-cutover.ts`'s argument handling; the HQ, KMS, matching, pacing, ledger
and prestep-fold modules are not copied.

**Why the pre-step half is its own pull request 2.** Three pieces need production's code at the
moment they run or are checked: the fixtures must be validated against the pre-step schema and gate
when captured; the frozen printer must be held equal to today's `projectXPath`; the base emitter must
emit with production's emitter. Pull request 1, the lane mechanics, changes nothing Nova emits and
adds one file under `lib`, the test table `lib/commcare/__tests__/instantOrderingTable.ts` (part 08
§7); pull request 2 adds only `scripts/` files. So pull request 2's head is production's code plus
these files and that table, and runbook check 1 holds it:
`git diff --stat main..<2> -- lib app ':(exclude,glob)**/__tests__/**'` is empty. The pre-step half
sits in a pull request of its own, not in the lane mechanics one, so a proof pull request carries no
cutover file and the cutover's base is reviewed as the cutover's. The capture test's validity half
and the printer's equality half compare against `lib/domain/xpath` and the pre-step
`blueprintDocSchema`, so pull request 5, the shape, deletes those two halves with the code they
compare against; the fixtures' digest manifest stays checked at every head. The census normalizer
is never edited after pull request 2, so both halves of the census run the same file.

**Arguments.**

| Script | Argument | Meaning |
|---|---|---|
| base emitter | `--prod` | reads production as the operator (`scripts/lib/prodDb.ts::targetProdDb`), one `REPEATABLE READ, READ ONLY` transaction; prints one JSON line per app and emitted file: `{ app, file, digest }`, and a `fleet` line with `fleetSeqDigest` (§7). No content |
| scan | (none) / `--prod` | the plan over the local database or production, read-only, one `REPEATABLE READ, READ ONLY` transaction, plain `SELECT`s |
| scan | `--base-digests <file>` | adds the census head half against the base emitter's output (§7) |
| scan | `--app <id>` / `--debug-details` | one app; with `--debug-details`, that app's blocker places by entity id and name with the expression, on the operator's terminal only, never archived |
| scan | `--recipients [--app <id>]` | the announcement's address list (step 2's rule), on the terminal only |
| migrate | (none) | the dry run: the full plan, the report and `planDigest`; writes nothing, applies no DDL. The Job's stored-args form for this tool |
| migrate | `--settle-holders` | settles every lapsed or paused holder through `lib/db/apps.ts::reapStaleRun` and `lib/db/designSessions.ts::reapStaleDesignSessionRun` (step 2's `holders.ts`), prints counts and exits |
| migrate | `--rehearse` | applies the ledgered DDL, runs the whole fleet transaction and ends it in a sentinel rollback; local databases and tests only, not allowlisted |
| migrate | `--execute --expect-plan-digest <sha256>` | applies the ledgered DDL, builds the plan, refuses with nothing written when its digest is not the expected one, then runs the writer and commits |

`--prod --execute` exists on neither script; a production write runs only through the Job.

**Already applied, checked first.** Every mode first counts the `apps` rows carrying the marker:
all prints `already-applied` and exits 0 before any old-shape read; some and not all refuses; none
goes on. The fleet transaction repeats the count under its locks.

**The plan and its digest.**

```ts
interface ExpressionsCutoverPlan {
  readonly format: "hq-round-trip-expressions-1";
  readonly apps: readonly AppPlan[];                       // by app id
  readonly digest: string;                                 // lib/utils/canonicalJson.ts::canonicalJsonDigest of every field below
}
interface AppPlan {
  readonly appId: string; readonly projectId: string;
  readonly baseSeq: number; readonly baseDigest: string;  // the raw carriers as read
  readonly targetDigest: string;                           // canonicalJsonDigest(target)
  readonly changes: readonly DocumentChange[];             // the steps' and behavior.ts's entries
  readonly blockers: readonly CutoverBlocker[];            // content-free
  readonly schemaChanges: readonly PlannedSchemaChange[];  // §8: { caseType, property, from: DataType | null, to: DataType, source: "declared" | "inferred" }
  readonly discardsPrivateWork: boolean;
  readonly deployments: readonly { deploymentId: string; server: string; domain: string; hasEntryPoints: boolean }[];
}
interface CutoverBlocker { readonly code: CutoverBlockerCode; readonly count: number; readonly findingCodes: readonly string[] }
```

The digest covers every field: nothing in it comes from outside the database, and the window's
database is quiescent, so a moved digest means a document, a holder or a deployment moved. The
execute run builds the plan before its transaction (as step 2 did, keeping the locked span short),
refuses on a digest mismatch, and under its locks re-reads every app's `mutation_seq` and raw-carrier
digest and stops on any difference. That locked re-read is the contract's "blocking scan under the
migration's locks"; the digest is what makes the run write exactly the plan the operator read in the
dry run, for about 50 lines.

**The report.** Content-free JSON Lines, step 2's framing (`report: "hq-round-trip-expressions"`,
`mode`, `section`), one Cloud Logging entry per line: `fleet` (apps, deleted apps, `planDigest`,
`fleetSeqDigest`, database size, peak RSS, plan milliseconds, and under `--execute` each numbered
fleet step's milliseconds with `pg_database_size` and `pg_wal_lsn_diff` at step 10, the capacity
proof), `steps` (per step and class: apps and changes), `behavior`, `schema` (per planned schema
change kind: count, apps, and the rows `conversionImpact` finds uncastable), `holders`,
`private-work`, `blocker` (per code: count, app ids, finding or issue codes), `census` (scan only),
and `outcome` (`ok`, `already-applied`, or `stopped` with `blocker`, `holder`, `digest`). App ids,
deployment ids, codes and counts are content-free; names, expressions and values never appear.

## 4. Reading the old shape, and the target in two phases

**`oldShape.ts`** is step 2's file: it reads `apps` and `blueprint_entities` carriers as JSON through
`lib/db/persistedJson.ts::parsePersistedJsonText` and assembles a `RawDocument` the way
`lib/db/blueprintRows.ts::assembleBlueprint` does, stopping before `blueprintDocSchema`. Reason, as in
step 2: at the head the old schemas are gone, and a frozen copy of them would be a second dialect.

**`frozenPrinter.ts`** is a copy of today's `lib/domain/xpath/print.ts::projectXPath` and the three
lookups of `xpathPrintContext` (`fieldPathSegments`, `userPropertySlug`, `searchInputName`), each built
over the raw rows (`fieldOrder`, `userProperties`, a module's `searchInputs`). It prints `text` runs
verbatim, `field-ref` as `#form/<path>`, `path-ref` as `/data/<path>`, `case-ref` as `#<type>/<prop>`,
`user-ref` and `user-property-ref` as `#user/<name>`, `search-answer-ref` as `#search/<name>`. A leaf
that resolves to nothing (the printer's `[reference needs repair]`) is the blocker `old-reference-dangling`;
none can be stored today, since the gate refuses it, so it is a guard.

**The target, in two phases.** Nothing outside the expression slots changes shape in step 3 except
the catalog's retired slots and a form link's datum names, so:

1. **Structure.** Apply the structural steps (§5, steps 1 and 2) to the raw document, set every
   expression slot absent, parse with the head's `blueprintDocSchema` and hydrate
   (`lib/doc/fieldParent.ts::hydratePersistedBlueprint`). This is the document the parser resolves
   against: field paths, options, case types, catalog membership, entry datums and search inputs are
   all final in it, because none of them depends on an expression.
2. **Expressions.** Fill each slot from its old value, in registry order: a record value through the
   structural map (step 3), a form-logic value through print and parse (step 4), then the declarations
   (step 5) and the first-row lift (step 6), each re-judging only the slots it touched.

The slots visited are the head registry's data, never a hand-written list: every slot of
`lib/domain/expression/profiles.ts` (part 01 §4), each read from the raw row at the slot's key path.
`equality.test.ts` holds that this walk visits exactly the slots the registry lists, over documents the
test builds in the head schema and decomposes through `lib/db/blueprintRows.ts::blueprintScalars` and
`::decomposeBlueprint`, as step 2's equality test did.

## 5. The transform steps, in order

```ts
interface ExpressionsStep {
  readonly id: string;
  apply(doc: WorkingDocument, ctx: StepContext): StepResult;   // mutates a private copy
}
interface StepContext {
  readonly appId: string;
  readonly projectId: string;
  readonly lookup: LookupDefinitionIndex;   // the Project's rows-free definitions, read once per Project
}
interface StepResult { readonly changes: readonly DocumentChange[]; readonly blockers: readonly CutoverBlocker[] }
```

The order is fixed: structure first (the target must hydrate before any parse), then records, then
form logic, then what needs the lifted trees (declarations read every lifted read; the first-row lift
needs the checker's typed verdict). A second application of the transform to its own output changes
nothing. The "Production" column says what the planning scans and this part's probe found over live
apps, in words; the dry run counts each.

| # | Step id | Old → new | Blockers | Notice reason | Production |
|---|---|---|---|---|---|
| 1 | `catalog-rules` | every catalog property's `required`, `validation` and `validation_msg` deleted from `apps.case_types` (decided with the person, 2026-10-17) | none | `case-property-rules-removed`, one per property, naming which of the three it held | many properties, in many apps, each of the three among them |
| 2 | `form-link-datum-names` | `FormLink.datums[].name`, a datum id string, becomes `FormLinkDatumName { kind: "selected-case", module }`, resolved through the target entry's `lib/commcare/formLinkProjection.ts::entryDatumIds`, the printed id to the ref it supplies (part 05 §1.5) | `form-link-datum-unresolved`: the name is not a selected-case datum the target entry supplies | none: the link sends the same datum id | production's form links hold no manual datum: none |
| 3 | `record-expressions` | every `Predicate` / `ValueExpression` value becomes an `Expression` with its bytes unchanged (part 01 §1.4: every widening admits every stored value), except two rewrites: (a) `arith` `div` whose two operands are `int` under the record rule set, with an operand typed only by step 3's Hidden Value inference read as unknown so the verdict is today's, becomes `quotient`; (b) a literal opposite a `field` of a static select in `eq`, `neq`, `in.values` or `switch.cases[].when`, whose value is one option's value (or the space-joined values of several for a multi-select), becomes `choice { field, options }`; a literal matching no option stays a literal. `equality.test.ts` holds (b) equal to the head record dialect's binder (part 02 §2.2) over built documents | none of its own; what the target gate refuses is `target-gate` | `expressions-follow-choices` (one line per app, with the count, shared with step 4's class) for (b); none for (a): meaning and emitted bytes are unchanged | (a) none: production's record arithmetic holds `+` and `mod`, no `div`; (b) some lifted, a few stay literals |
| 4 | `form-logic-lift` | every stored `XPathExpression` (form logic, Connect slots, a form link's condition and datum values, `ids_query`, `repeat_count`, defaults) is printed by `frozenPrinter.ts` and parsed by `parseFormExpression(text, scope)` with the slot's `ExpressionSlotRef`, the Project's lookup definitions and no `authoring` scope. Its classes, each counted: **(4a) canonical respelling**, the stored text differs from the canonical print of the parsed tree; **(4b) relative paths** become `field { spelling: "relative" \| "current", climb? }` and `repeat-row`; **(4c) case queries** become `cases { source: "casedb" }` typed by rule 1 (`@case_type` literal), rule 2 (`@case_id` with a known `caseIdOf`) or rule 3 (the one declaring case type, stored in the tree and printed with no predicate, so the text reads back unchanged; a re-parse of an edited slot takes the slot's current tree as its binding hint, part 02 §1.3); **(4d) session datums** become `session-datum { datum: selected-case }`, parsed against pull request 5's `DatumRef` and `entryDatumSupplies`, where session datum identity lands; **(4e) choices** become `choice` leaves; **(4f) empty** `{ parts: [] }` becomes absence in an optional slot | `expression-parse-refused` with the issue code (part 02 §1.4), among them `case-query-untyped`, `relative-unknown`, `wildcard`, `unknown-datum`, `unknown-search-input`; `empty-required-expression` for an empty `datums[].xpath`, `repeat_count` or `ids_query`; `old-reference-dangling` | (4a) `expressions-respelled`, one per app with the count; (4e) `expressions-follow-choices`; (4b), (4c), (4d), (4f) none: nothing a person or a worker sees changes, since each prints the same text and means the same node | no stored expression fails to parse today. (4a) some, in a minority of apps; (4b) many, in many apps, every one resolving; (4c) queries in some apps; the reads with no `@case_type` literal split, by the probe, into standard reads, which need no type, custom reads that bind to one type, custom reads that several types declare (the expected `case-query-untyped` blockers), and reads that a `@case_id` from a known source types, which step 5 declares; (4d) a few, in very few apps, all selected-case; (4e) many lifted, in most apps, a few stay literals; (4f) the empty form in a `relevant` only, none in a required slot |
| 5 | `declare-read-properties` | each `(caseType, property)` a lifted typed read names (a `prop` in a `cases` row or `project`, a `form-case`) that the case type's effective catalog does not hold is added to `apps.case_types` as `{ name, label: <the name>, data_type }`, with `data_type` the least type its reads admit: `decimal` where a read does arithmetic on it or orders it against a number, `date` / `datetime` where a read orders it against one, else `text`. Then every slot step 4 refused only with `case-query-untyped` is parsed again against the document with the declarations, so a query that now has one declaring type binds | `declared-property-type-conflict` (two reads admit no common type); `declared-property-has-stored-values` (a `cases` row of the app and type already holds the key: an orphan, `scripts/scan-orphan-property-keys.ts`'s residue, which a declaration would make readable and validated again) | `case-property-declared`, one per declaration, naming the case type, the property, its type and one form that reads it | a few reads, in very few apps, of properties no catalog declares, all text use, in queries typed by a `@case_type` literal or by `@case_id` from a known source; a few declarations, all `text`; the probe shows no collision, and the dry run counts them |
| 6 | `repeat-read-first-row` | each structural several-value read (a repeat answer read from outside the repeat, used as one value: the checker's `many-values`, part 03 §3.4) gains `FieldStepFilter { step: <repeat uuid>, where: [literal 1] }` on its repeat step, printed `[1]`, the only value Core reads without failing; then the slot is checked again | a several-value read in a prose part, which has no filter: it stays a `target-gate` finding (`XPATH_MANY_VALUES`) for the author | `repeat-read-takes-first-row`, one per read, naming the form, the field and the repeat | a few, in very few apps (in `concat` and `selected`); prose not scanned, so the dry run counts it |
| 7 | `lift-round-trip` | none: a guard that reruns `record-position`, `SELECT_DEFAULT_NOT_AN_OPTION` and the round-trip law `parse(print(e)) = e` over every slot steps 3 to 6 wrote | `round-trip` (a lifted tree that does not survive its own print is a defect of the stack, never an author's) | none | expected none |

Two readings above came from planning scanners, not from the production parser: the several-type
binds and the declarations used a planning shape scanner's effective index, and the respellings part
04's prototype printer. The dry run's counts are the production code's and replace them.

### After the last step

1. The target is parsed with the head's `lib/domain/blueprint.ts::blueprintDocSchema` and hydrated.
2. It is judged by `lib/doc/commitVerdicts.ts::mutationCommitVerdict(target, [], lookupContext)` and
   `::exportReadinessFindings(target, lookupContext, mediaAssets)`, with the Project's lookup
   definitions and media manifest read once per Project, step 2's pair with step 2's inputs. Export
   readiness runs the zero-tolerance validator, so every new rule is in the verdict: `CYCLE` from
   relative-read edges (part 07 §1.4), `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` (part 03 §4.3),
   `XPATH_INCOMPATIBLE_VALUES` with `date-datetime` and `day-only-on-device`, `datetime-literal-precision`,
   part 06's CSQL findings, `SESSION_DATUM_NOT_SUPPLIED`, `XPATH_MANY_VALUES` in prose, and every
   lowered date-and-time comparison emitted through `toWire` (part 04 §5.5, item 3). A finding is
   `target-parse`, `target-gate` or `target-export-readiness`, with its codes.
3. **The finding multiset.** The base's gate multiset is empty, because every deploy's runtime probe
   reruns the gate over every stored app, so every gate finding of the target is new; export
   readiness at the base cannot be recomputed at the head, so every export-readiness finding of the
   target is reported and blocks. The report lists each code with its count (part 03 §5.4, item 9), so
   a code no row of §11 names still surfaces.
4. **The case-schema plan** (§8): `lib/case-store/store.ts::buildCaseTypeMap(target)` is compared, per
   case type, with the app's active stored `case_type_schemas` rows. Each difference must be a
   declaration of step 5 or a property whose type step 3's inference newly knows; any other is
   `case-schema-unplanned`. The worker's own case and inactive rows are skipped, as in step 2.
5. `behavior.ts` reads the target and returns the no-write lines (§6).

## 6. Changes that write nothing and still get a line

| Reason | Kind | Selected by | Says |
|---|---|---|---|
| `search-today-is-workers-day` (part 06 §3.4) | document, entity module | each module whose effective `_xpath_query` reads `today` (a `today` arm in a CSQL position of `caseListConfig.filter` with Search effective, or of an advanced input's predicate) | part 06's copy |
| `search-date-time-equality-matches` (part 06 §3.13) | document, entity module | each module whose effective `_xpath_query` holds `eq`, `neq` or `in` on a `datetime` anchor | part 06's copy |
| `date-time-comparison-compares-moments` (finding 56) | document, entity the field, form or module whose slot holds it | each device-evaluated slot (targets XF or SU) holding an ordering, `=`, `!=`, `in` or `switch` between two `datetime` operands that the lowering rewrites (part 04 §3.3) | below |
| `case-property-type-now-known` | document, entity app | each planned schema change of source `inferred` (§8): a property whose type is unknown today and known from step 3's Hidden Value inference | below |
| `unsaved-assistant-work-discarded` | document, entity app | `AppPlan.discardsPrivateWork` | step 2's copy |
| `deep-links-need-republish` | deployment | every deployment (live `app` mapping) of an app with entry points: the horizon's `+1` makes every manifest stale | step 2's copy |
| `expressions-sent-at-next-publish` | deployment | every deployment of an app with at least one entry of `expressions-respelled`, `repeat-read-takes-first-row`, `date-time-comparison-compares-moments`, `case-property-type-now-known`, or part 06's two | below |

Production holds no CSQL `today()` and no CSQL datetime equality, a few date-and-time orderings
(`now()` against a question read relatively) and no date-and-time equality; inference typings are
the dry run's to count (part 03 §5.4, item 2).

Two changes get no line, each for a stated reason:

- **Nova's own scaffolding respelled** (the suite's datum filters, preload setvalues, calculated
  columns, the integer-division and guard parentheses, part 04 §5.1) and **unread instance
  declarations dropped** (part 04 §5.2). Neither changes a value, a data path, an export column or
  what a worker sees, and neither is anything a person wrote. Their only trace is a new form version at
  the next build and the spacing HQ's form builder shows; `content/docs/publishing.mdx` says so once.
- **Bindings that print the same text**: relative paths (4b), case-query row types (4c), a bound
  untyped query among them (it stores its case type and prints no predicate, so a device reads the
  same rows), session datums (4d), absence for an empty condition (4f), `quotient` (3a). Each reads
  and means what it did; what changes is that later renames follow them, which is what step 3 is
  for. A query that binds to no type or several is a blocker (§11), never a line.

## 7. The emission census

The postcondition this part owes: the emitted bytes of every app before and after the cutover
differ only by the named changes. Neither image can emit both: the maintenance image holds the head
emitter only, and the base emitter is gone at the head. So the census runs in two halves, compared by
digest, and no content leaves either process. It is a gate: an app whose head bytes differ from its
base bytes for no named reason stops the cutover (part 04 §5.5).

- **Normalization** (`scripts/lib/hqRoundTripExpressions/emissionNormal.ts`, pull request 2, never
  edited after): parse each file with `lib/commcare/xmlParse.ts::parseXml` (XForms, `suite.xml`) or as
  JSON (the HQ import body's app JSON, whose XForm attachments are parsed as XML); rewrite every XPath
  attribute or string part 04 §5.1 lists through a Lezer canonical printer
  (`lib/commcare/xpath/grammar.lezer.grammar`, the rule of part 04 §2.3: one space after every comma
  and either side of every binary operator, which is Vellum's own normal form, as R2's run
  39061476968 showed (part 08 §6.4, part 01 §2.5), parentheses only where precedence needs them, single quotes
  unless the value holds one, shortest round-trip number); drop every `<instance>` no attribute of
  its scope reads; serialize canonically and digest. Never a regex over XPath.
- **Base half** (`scripts/emit-hq-round-trip-expressions-base.ts --prod`, run from a checkout of pull
  request 2's head): every live app through production's `lib/commcare/expander.ts::expandDoc` (the HQ
  body) and the local archive's XForms and suite (`lib/commcare/compiler.ts`, the XForm and suite
  writers, without media and fixture bytes, which step 3 does not change), with the Project's lookup
  definitions; prints `{ app, file, digest }` lines and `fleetSeqDigest`, the digest of every app's
  `(id, mutation_seq)`.
- **Head half** (`scan --base-digests <file>`, run from a checkout of the maintenance image's commit,
  pull request 14's head): the lifted target through the head emitter, normalized the same way,
  compared file by file.

**Verdicts, per app**: `unchanged`; `respelled-only` (every file equal after normalization);
`named` (a file differs after normalization, and every such file belongs to an entity a named change
names: a form's XForm and HQ form entry for a `repeat-read-takes-first-row` or a form-logic
`date-time-comparison-compares-moments`; `suite.xml` and the HQ module entry for a module-level one or
part 06's two; any file of the app for a declaration or an inference typing, whose binds and listings
are app-wide, the bind changes inference causes through `fieldValueType` among them, which part 04's
census names and this measurement counts, part 03 §5.3); `unexplained`. An `unexplained` app stops
the cutover as a defect of the stack, fixed in the pull request that owns the emission, never by an
author; the report names the app id and the file position, and `--debug-details --app <id>` shows
the difference on the operator's terminal. `emissionNormal.test.ts` holds that the head serializer's
output is a fixed point of the normalizer over the whole corpus emission, so a respelling the
serializer makes and the normalizer does not would show there, not in the census.

Expected at the snapshot: `named` in very few apps (those with the lowering, the first-row reads or
the declarations), `respelled-only` in most apps with a case list (scaffolding), `unexplained` in
none. The census runs with the advisory scan before the window, and again in the window only when
the window's `fleetSeqDigest` differs from the advisory one (§14); either run with an `unexplained`
app stops the cutover. Both halves run on the operator's machine with
one worker, at the cost of the host corpus emission; neither starts Docker.

## 8. Declaring properties: the case store

Two kinds of planned schema change reach `materializableCaseTypes`, and with it
`case_type_schemas` and the expression indexes (`lib/case-store/CLAUDE.md`, "The case-type map is the
MATERIALIZABLE view" and "Per-data-type index coverage"):

- **declared** (step 5): a property added to the catalog, `text` in production, which adds its key to
  the closed JSON Schema and a GIN trigram index;
- **inferred**: a property whose writers are Hidden Values with an inferable calculation, unknown
  today and typed from step 3 (part 03 §5.3, class 1). Its Hidden writers' binds follow it (part 03
  §5.2), and a `text` to typed change is a retype, which parks every value that does not cast.

**Decision: option A.** The fleet transaction writes no schema row (index DDL is `CREATE INDEX
CONCURRENTLY` and cannot run in a transaction). After the deploy reports ready and before ingress
reopens, the existing drift writer converges every stored row: `schema-drift.cjs --execute` on
`commcare-nova-case-type-schema-retirement` from the same maintenance image, whose `lib` equals the
deployed one but for the two `designSessions.ts` exports (runbook check 1), then `scripts/scan-schema-drift.ts --prod` from the merged `main`
reports zero. Uncastable values park with their review entries (`lib/case-store/CLAUDE.md`, Phase A
step 2). No request sees the unconverged rows, because ingress is still closed; option B (Phase A
inside the fleet transaction) is rejected as more code in the riskiest span for no gain.

**The orphan check.** A declaration is not a same-name transition, so Phase A would not park an
orphan value under the new key (`lib/case-store/CLAUDE.md`, "Per-property transition detection"). So
the plan counts, for each declared pair, the app's `cases` rows of that type holding the key, and any
row is the blocker `declared-property-has-stored-values`, for a person to look at. For each inferred
pair it counts the rows `lib/case-store/store.ts::SchemaCaseStore.conversionImpact` finds uncastable,
which the notice line states and which never block (parking is the designed path).
`conversionImpact` takes no lock: its Postgres implementation (`lib/case-store/postgres/store.ts`) is
plain `SELECT`s over `cases` and `parked_case_values`, and the scan's `SELECT`-only test (§15) holds
that. The prerequisite
`scripts/scan-orphan-property-keys.ts --prod` runs before the advisory scan, and its output is archived
with the evidence. Probe: no case of the type the literal-typed reads name is stored; the dry run checks the others.

## 9. The fleet transaction, step by step

Before it opens: the already-applied count; the ledgered DDL (`--execute` only); the fleet read;
the plan and its digest check. One transaction for the whole fleet, as step 2's.

1. `pg_advisory_xact_lock(hashtextextended('cutover:hq-round-trip-expressions', 0))`;
   `SET LOCAL lock_timeout = '15s'`; record `pg_current_wal_lsn()`.
2. **The blocking scan under the locks**: every `apps` row `FOR UPDATE` in id order and every
   `design_sessions` row; per app, `mutation_seq` and the raw-carrier digest equal the plan's; no live
   holder or unsettled reservation (`lib/db/runLiveness.ts::runLeaseState`, `::designSessionLeaseState`).
3. **Already applied, again**: any marker row stops the run.
4. **Before-images, then the event archive**: per app the count and digest of its `cases` rows, every
   `case_type_schemas` row as text, the count and summed bytes of `mutation` events; then step 2's
   statement verbatim:
   ```sql
   UPDATE events SET kind = 'archived-mutation',
     event = jsonb_build_object('kind', 'archived-mutation', 'runId', event -> 'runId', 'ts', event -> 'ts',
                                'seq', event -> 'seq', 'source', event -> 'source', 'archived', event)
   WHERE kind = 'mutation';
   ```
5. **Clear live streams**: `threads.active_stream_id` and `active_holder_nonce`, `chat_stream_chunks`,
   `presence`.
6. **Abandon private work**: `authoring_sessions.active_candidate_id` cleared, open
   `authoring_workspaces` and `design_change_sets` abandoned, and each pre-app session holding open work
   ended through `abandonPreAppDesignSessionInTransaction(tx, row)`.
7. **Per app**, in id order: the root slots from `blueprintScalars(target)` and the columns
   `lib/db/canonicalCommitKernel.ts::denormalize` derives; every `blueprint_entities` row deleted and
   reinserted from `decomposeBlueprint(target)`; exact media references
   (`::replaceExactMediaReferencesForApp`), lookup edges, location references and
   `lib/organization/commitIntegrity.ts::applyOrganizationCommitIntegrity`; `mutation_seq = baseSeq + 1`
   (`apps.updated_at` untouched); the marker `app_changes` row; the baseline as
   `nova_current_app_change_fold_snapshot(app_id)` with its SQL digest.
8. **Notices**: one `app_migration_notices` row per app with at least one entry, `cutover =
   'hq-round-trip-expressions'` (no DDL: `cutover` is free text, `UNIQUE (app_id, cutover)` is the latch).
9. **Postconditions** (§10), inside the transaction.
10. Read `pg_database_size` and `pg_wal_lsn_diff`; `pg_notify('nova_app_stream', …)` per app; commit, or
    under `--rehearse` a sentinel rollback.

Step 2's execution (the evidence bucket, `hq-round-trip-emission/evidence/execute-report.json`)
records each numbered step's duration, the WAL and the database growth inside the transaction, and
peak RSS: its fleet transaction fit the window with a wide margin, most of its time in the per-app
writes and the postconditions, its WAL and growth fit the instance's storage many times over, and
its peak RSS stayed well under the Job's 8 GiB. Step 3's transaction writes the same rows except the
archive, which meets about none.

## 10. Postconditions

Inside the transaction; any failure rolls the fleet back.

- Every app loads through `lib/db/canonicalCommitKernel.ts::loadAppInTransaction` under the new schema
  and gate, its `canonicalJsonDigest` equals `targetDigest`, and `exportReadinessFindings` over it is
  empty: the full validator, as export runs it.
- `lib/agent/change-set/baseLoader.ts::loadCanonicalBlueprintAtSequence` at the new sequence folds from
  the new baseline to `targetDigest`.
- Every lifted expression satisfies `parse(print(e)) = e` under its slot's grammar.
- Every `case_type_schemas` row is byte-identical to its before-image, and the derivation from each
  target differs from the active stored rows by exactly the plan's `schemaChanges`.
- No `cases` row changed (count and digest per app).
- The archived events' count and bytes equal the before-image; no `events` row has `kind = 'mutation'`.
- No open workspace or change set; no `active_candidate_id`.
- Every app with a planned entry has exactly one notice row for `hq-round-trip-expressions`.

Outside the transaction, two measurements complete the proof, each a runbook step: the census (§7,
before the window) and the post-deploy drift scan reporting zero (§8). The deploy's own migrate Job
ends in `lib/db/runtimeDatabaseProbe.ts::runCanonicalRuntimeDatabaseProbe`, which decodes every app
with the new image and reruns the gate.

## 11. The blockers

Each stops the cutover before its first write, for the remedy its row names. The advisory scan is
where each is first met; a non-zero count there is an ordinary result.

| Code | Meaning | Remedy | Expected at the snapshot |
|---|---|---|---|
| `expression-parse-refused` | the production parser refuses a stored expression; the line carries the issue codes | the author's, in the builder: for `case-query-untyped`, the parser's own sentence ("You can add [@case_type = '<type>'] so CommCare knows which records to read."); for any other code, its part 02 §1.4 sentence | `case-query-untyped`: a few reads, in a few apps (probe); every other code none |
| `empty-required-expression` | an empty stored `datums[].xpath`, `repeat_count` or `ids_query` | the author's | none |
| `form-link-datum-unresolved` | step 2 | the author's: choose the link's case again | none |
| `declared-property-type-conflict` | step 5 | the author's | none |
| `declared-property-has-stored-values` | step 5's orphan check | the operator's, with the app's members: confirm the old values should become readable again (then remove the orphan key's values through Data, or accept them), and scan again | none where the probe read; the dry run counts the rest |
| `old-reference-dangling` | the frozen printer meets a leaf with no target | a defect: the gate refuses it today | none |
| `target-parse`, `target-gate`, `target-export-readiness` | the target fails the schema, the gate or export readiness; the line carries the finding codes (the codes the dry run counts are below) | the author's where the finding is about the app (its message names the remedy); a defect of the stack where a step should have rewritten it | per code, below; every other code none |
| `case-schema-unplanned` | the target derives a schema change no step planned | a defect, or schema drift the prerequisite scan missed | none |
| `round-trip` | step 7 | a defect | none |

**Blockers by rule.** Every dry-run count that can block is a blocker by rule, with no decision left
for the window: each non-zero count is a blocker that the author resolves in the app before the
window, and the scan runs again. No step rewrites these and no notice line stands in for one,
because each needs a choice only the author can make. The person is the fleet's author during
dogfooding, so each is theirs to resolve in the builder. Parts 03 and 05 count the same codes
(part 03 §5.4, part 05 §6.2).

| Count | Blocker | The author's remedy | Expected at the snapshot |
|---|---|---|---|
| `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` (part 03 §4.3): a Hidden Value writes a value of another type into a typed property | `target-gate` | make the calculation give the property's type, or save the value to another property | none or few |
| `CYCLE` (part 07 §1.4): relative reads close a loop between calculations | `target-gate` | break the loop the finding names | none or few |
| a record verdict moved by inference (part 03 §5.3, class 3): a case list filter, column or condition whose type check changes once step 3's inference types a property | `target-gate`, with the record slot's code; the dry run reports each by `details.checkCode` and `details.checkReason` (part 03 §1.5) | correct the expression the finding names | none or few |
| `SELECT_PRELOAD_WRITE_NOT_AN_OPTION` (part 03 §4.3, in `SELECT_DEFAULT_NOT_AN_OPTION`'s family): a literal a Hidden Value or case operation writes into a property a static select preloads is none of the select's options (a Hidden Value with no calculation that itself preloads the property is exempt: the preload overwrites its starting value) | `target-gate` | write one of the select's options, or compute the value | none or few |
| `case-query-untyped` (part 02 §1.4): a query with no `@case_type` reads a property no case type or several declare | `expression-parse-refused` | add the query's case type, as the parser's sentence offers | few: among the reads several types declare (probe) |
| `selected-cases` as one value (`XPATH_MANY_VALUES`, part 05 §2.5): a batch form's selected cases read where one value is needed | `target-gate` | count or join the cases, or read the one the form needs | none: production holds no such read |
| a structural repeat read in a prose part used as one value (`XPATH_MANY_VALUES`, part 03 §3.4), which the `repeat-read-first-row` step cannot filter | `target-gate` | choose a row, or count or join the rows | none or few: the scans did not read prose |
| `day-only-on-device` (`XPATH_INCOMPATIBLE_VALUES`, part 03 §3.2, part 04 §3.4): a `casedb` system date compared with a moment | `target-gate` | compare the day with another day, or read a property that holds the moment | none or few |

Stops that are not an app's: a live holder (`holder`), a digest mismatch (`digest`), and in the census
`unexplained` (§7), a defect of the stack.

## 12. The notice

`lib/notices/migrationNotice.ts::MIGRATION_NOTICE_CUTOVERS` becomes
`["hq-round-trip-emission", "hq-round-trip-expressions"]`, and
`lib/notices/migrationNoticeCopy.ts::MIGRATION_NOTICE_LEADS` gains:

> "Nova changed how it stores and checks expressions on {day}. Here is what that means for this app."

`NOTICE_ENTITY_TYPES` is unchanged: a catalog line names entity `app` with `detail.caseType` and
`detail.property`, as `option-value-split` does. `lib/notices/store.ts` reads tolerantly, so step 2's
rows keep rendering. Every new reason joins `DOCUMENT_NOTICE_REASONS` or `DEPLOYMENT_NOTICE_REASONS` at
its place in the stated order, with exactly one renderer:

| Reason | Place | Copy (examples as rendered; `{…}` from `detail` or the entity's current name) |
|---|---|---|
| `case-property-rules-removed` | after `android-form-lists-setting-stored` (step reasons in step order) | "patient, age: Nova removed its required rule and its validation rule. No form checked them, and each question that saves age keeps its own rules. You can add rules to those questions." One rule reads "Nova removed its required rule"; a message alone reads "Nova removed its validation message". |
| `expressions-follow-choices` | next | "{n} expressions in this app now name a choice rather than its value as text. Changing that choice's value updates them, and Nova keeps the choice while an expression uses it." |
| `expressions-respelled` | next | "{n} expressions in this app now read in one standard spelling, with fewer brackets and single quotes. What each one does is unchanged." |
| `case-property-declared` | next | "household, village_code: added to the case type as text, because {form} reads it. Nothing saves it yet. You can choose a question to save it, or give it a type that fits better." |
| `repeat-read-takes-first-row` | next, then `lookup-tag-renamed` | "Visit, Summary: it read Child name from every row of Children where one value was needed, so the form stopped once there were two rows. It now reads the first row. You can choose another row, or count or join the rows instead." |
| `search-today-is-workers-day`, `search-date-time-equality-matches` | after `case-list-search-matches-hidden-fields`, in that order (part 06) | part 06 §3.4 and §3.13 |
| `date-time-comparison-compares-moments` | after `case-name-now-checked` (no-write reasons) | "Visit, Follow-up due: from the next publish or download, phones and Web Apps compare these dates and times by the moment, as Preview already does. Until now they didn't compare the time of day, so the answer could differ from Preview. CommCare HQ's form builder shows this comparison as a longer expression, and it keeps its meaning if you leave that expression as it is." |
| `case-property-type-now-known` | next, then `unsaved-assistant-work-discarded` | "visit, next_due: Nova now keeps it as a date, the type the calculation that saves it gives. {n} saved values that aren't dates are waiting in Data to review." The second sentence only where `detail.parked` is above 0. |
| `expressions-sent-at-next-publish` | deployment, after `data-paths-move-once` | "The next publish to {domain} sends these expression changes once, so CommCare HQ keeps a new version of each form and menu they touch. Data already collected stays as it is." |

The registry above is complete for the lifts: the repeat first-row lift is
`repeat-read-takes-first-row` (step 6, one line per read); the `choice` lift is
`expressions-follow-choices` (steps 3b and 4e, one line per app); an untyped query's binding gets no
reason (§6, "Bindings that print the same text"), and one that binds to no type or several is the
blocker `expression-parse-refused` with `case-query-untyped`, which the author resolves in the
builder before the window, as §11 gives it. The chosen case in record slots (from pull request 10, part 06)
has no step, no blocker and no reason: today's record dialect has no arm that reads a session datum
(`lib/domain/predicate/types.ts`), so no stored expression holds one and the cutover changes no
stored shape for it. No other part may name a reason this table does not hold.

Each line says what changed, what a worker or a person now sees, and what is theirs to do
(`design/readme.md`, "Say what an update changed"), in sentence case with no em dash and no ellipsis.
`migrationNoticeCopy.test.ts` renders every new reason with present and absent details and a removed
entity, and `migrationNotice.test.ts` holds each real entry and the lead for both cutovers.

Production at the snapshot: `case-property-rules-removed` in many apps, `expressions-follow-choices`
in most, `expressions-respelled` in a minority, `case-property-declared`,
`repeat-read-takes-first-row` and `date-time-comparison-compares-moments` in very few, and part 06's
two in none. Apps with no entry get no notice row.

**Public docs.** `content/docs/publishing.mdx` gains one paragraph: an existing app's next publish
sends each form's expressions in one standard spelling once, so CommCare HQ keeps a new version of
each form, and nothing a worker sees changes for it. It lands in pull request 14, contracts and
public docs, as a row no single pull request owns; its "Updates to review" sentence and
`content/docs/mcp/tools.mdx`'s `get_app` row land here, in pull request 13, whose notice they
describe (part 10, "Public docs that change").

## 13. Where it runs

**The Job.** `commcare-nova-historical-repair`, its contract unchanged in `config/deployment-jobs.json`
(`nova-migrate@`, 4 CPU, 8 Gi, `--max-old-space-size=7168`, 3000 s, `maxRetries: 0`,
`NOVA_DB_WORKLOAD=migration`, stored args `["language-identity-repair.cjs"]`). It holds no
`GOOGLE_CLOUD_PROJECT`, which the cutover does not need. It does not exist on production today, so the
runbook makes it with `scripts/infra/manage-deployment.py job --job commcare-nova-historical-repair
--image "$IMAGE" --apply` and deletes it after archiving. Reason against a new Job definition: step 2's
existed only for KMS and its own allowlist, and this one would duplicate an existing contract.

**The allowlist arm** (`scripts/rollout/deploy-cloud-run.py::_effective_execution_args`, the
`commcare-nova-historical-repair` branch): the tool `hq-round-trip-expressions.cjs` joins with exactly
`(tool,)`, `(tool, "--settle-holders")` and `(tool, "--execute", "--expect-plan-digest", <64 hex>)`;
`--rehearse` and any other shape are refused. `scripts/infra/tests/test_deployment_policy.py` gains the
three admitted shapes and refused ones (`--rehearse`, `--execute` without a digest, a digest of 63
characters, a trailing argument).

**The drift writer** runs on `commcare-nova-case-type-schema-retirement`, also absent on production,
made the same way from the same image, under its existing arm `("schema-drift.cjs", "--execute")`.

**The bundle.** One line in `Dockerfile` stage `maintenance-build`:
`RUN npx esbuild scripts/migrate-hq-round-trip-expressions.ts … --outfile=hq-round-trip-expressions.cjs`,
beside `schema-drift.cjs`, which the stage already builds. The build context drops `scripts/*` and
`scripts/lib/*` by default, so `.dockerignore` gains `!scripts/migrate-hq-round-trip-expressions.ts`,
`!scripts/lib/hqRoundTripExpressions/` and `scripts/lib/hqRoundTripExpressions/__tests__/`, the three
lines #750 added for step 2's tool. The writer sets `apps.mutation_seq`, so
`lib/db/__tests__/runHolderWriteGuard.test.ts`'s allowlist of files that write app tables gains
`scripts/lib/hqRoundTripExpressions/writer.ts`. By the time pull request 13 adds the tool, pull request
5 has removed the arm's two completed repairs whose input the cutover's shape removes,
`case-status-filter-repair.cjs` and `select-option-value-repair.cjs` (part 10, pull request 5), so the
arm holds `language-identity-repair.cjs` and this tool.

**The maintenance image** is built by hand (`docker build --platform=linux/amd64 --target=maintenance`)
from the head of pull request 14, contracts and public docs, the one beneath the removal; that commit
never reaches `main`, because the merge squashes. The operator manages both Jobs from a checkout of
that same commit.

## 14. The window

The runbook is `docs/plans/hq-round-trip/3-cutover-runbook.md`, written in pull request 13 from this
section and removed by pull request 15.

**Checks.**

1. Pull request 15, the removal, differs from pull request 14 beneath it only in tooling paths
   (`git diff --stat <14>..<15> -- lib app` names only `lib/db/designSessions.ts`, whose two exports
   the removal makes module-private again, §16), and pull request 2's head equals `main` there but
   for test files (`git diff --stat main..<2> -- lib app ':(exclude,glob)**/__tests__/**'` is empty;
   pull request 1 adds one test table under `lib`, §3).
2. `main` is frozen from the image build to the merge.
3. No deploy from `main` between the execute run and the merge (the ledger would name migrations
   `main` does not hold).
4. The advisory scan is at most three days old when the window opens, and the census's
   `fleetSeqDigest` is compared at the window (step 5).

**The order.**

| # | Step |
|---|---|
| 1 | **Before the window.** (a) From a checkout of `main`'s head: `scripts/scan-schema-drift.ts --prod` and `scripts/scan-case-type-schema-retirement.ts --prod` report zero, or the repair each names runs first as its own change; `scripts/scan-orphan-property-keys.ts --prod`, archived. (b) The census and the scan: `npx tsx --conditions=react-server <2>/scripts/emit-hq-round-trip-expressions-base.ts --prod > $EVIDENCE/base-digests.jsonl` from pull request 2's checkout, then `npx tsx --conditions=react-server scripts/scan-hq-round-trip-expressions.ts --prod --base-digests $EVIDENCE/base-digests.jsonl > $EVIDENCE/scan-<moment>.jsonl` from the image's commit. (c) Every blocker resolved by its remedy and the scan repeated; the census shows no `unexplained` app. The operator writes to the members of each blocked app (`--recipients --app <id>`). (d) The image built, pushed and its digest resolved; both Jobs made (`manage-deployment.py job --job <job> --image "$IMAGE"`, then `--apply`). (e) The announcement, at least 24 hours ahead, to `scan --prod --recipients`. |
| 2 | **Open.** Detach `nova-neg` from `nova-backend`; pause `commcare-nova-capture-cleanup`. |
| 3 | **Drain.** `scan --prod` until no live holder (at most `cloudRunRequestSeconds`, 3600 s); the Job with `--settle-holders`; `scan --prod` showing no holder. |
| 4 | **Restore point.** `gcloud sql backups create --instance=nova-cases --description=hq-round-trip-expressions-restore-point`; its id recorded. |
| 5 | **Census at the window.** When the scan's `fleetSeqDigest` differs from step 1(b)'s, repeat 1(b) and require no blocker and no `unexplained` app. |
| 6 | **Dry run.** The Job with no override (the tool's dry run); record `planDigest`; its outcome is `ok`. |
| 7 | **Migrate.** The Job with `--execute --expect-plan-digest <d>`. Before the commit any failure rolls back and the window can close: reattach, resume. |
| 8 | **Post-migration.** The Job's dry run prints `already-applied`; resume `commcare-nova-capture-cleanup` (the deploy's prerequisite check requires it enabled, and its authority is `form_attachments` only); `manage-deployment.py check` passes. |
| 9 | **Deploy.** `gh stack merge <top> --squash`; watch the deploy check-run on the merge commit, its name taken from a listing first. The build's `verify` step fails while the NEG is detached, as step 2's did (its build failed at `verify` and passed on the retry): wait for `deploy` to report the revision ready. |
| 10 | **Converge.** `schema-drift.cjs --execute` on `commcare-nova-case-type-schema-retirement` from `$IMAGE`; then `scripts/scan-schema-drift.ts --prod` from the merged `main` reports zero. |
| 11 | **Resume.** Reattach the NEG; retry the merge commit's build so `verify` passes; run the three public probes. |
| 12 | **Close.** Archive both Jobs' definitions and executions and every report to `gs://commcare-nova-cutover-evidence/hq-round-trip-expressions/`; delete both Jobs. |

**The window** is announced as two and a half hours from step 2: 5 minutes to open, up to 70 to drain,
10 for the restore point, up to 15 for the census when it reruns, about 10 for the dry run and the
execute run (step 2's execute run spent most of its time on HQ reads this cutover does not make),
5 for step 8, about 20 for the deploy and its retry (step 2's deploy failed `verify` while the NEG
was detached and passed on the retry), 10 for the drift writer and its scan, and 5 for the probes. A
stop closes the window with nothing written; past the announced end the operator closes it the same
way and announces another.

The announcement, with `<day>`, `<start>`, `<end>` in UTC:

> Subject: Nova will be unavailable on <day> from <start> to <end> UTC
>
> Nova will be unavailable on <day> from <start> to <end> UTC, up to two and a half hours, while we update how it stores and checks expressions. During that time the builder, the assistant and Nova's MCP connection won't respond.
>
> A few things won't carry over the update, so it's worth wrapping them up before then:
>
> - Changes the assistant is still working on and hasn't saved. Your saved apps stay exactly as they are, and you can ask again afterwards.
> - Edits in an open builder tab that haven't saved yet.
> - A build that hasn't saved its first app yet.
> - A question the assistant asked you and is still waiting on. You can ask it again afterwards, and it picks up from there.
>
> When you next open an app, Nova shows what changed in it.

**Rollback.** Until the merge, the restore point restores everything the execute run wrote, and the
old revision is reattached. After the new revision serves, the only way is forward.

**What the operator records** (each in the evidence prefix): the three prerequisite scans; the base
digests, the scans and the census verdicts, with the `fleetSeqDigest` of each; each blocked app told
and its blocker cleared; the image's commit and digest and checks 1 and 2; the announcement's date and
recipient count; the NEG before and after; the restore point's id; the dry run's `planDigest`; the
execute run's report (durations, WAL, growth); the drift writer's report and the zero drift scan.

**Local databases** go through the same script from a checkout of pull request 14's head:
`NOVA_DB_WORKLOAD=migration npx tsx --conditions=react-server scripts/migrate-hq-round-trip-expressions.ts --rehearse`,
then `--execute --expect-plan-digest <d>`, then `npx tsx --conditions=react-server scripts/migrate-schema-drift.ts --execute`.
After the merge a local database still holding pre-step data is made again from the migrations.

## 15. Tests

They run Nova's own code and prove what it does to Nova's database; none is offered as proof of what
a reader does with an app, which the lane holds (part 08).

**Frozen pre-step fixtures** (pull request 2, `scripts/lib/hqRoundTripExpressions/__tests__/fixtures/pre-step/`,
raw carriers as `blueprintScalars` and `decomposeBlueprint` write them, with `manifest.json` of digests
and the rows, codes and reasons each witnesses): one per step class of §5, per blocker code of §11 and
per row of its blockers by rule, and per reason of §12, and corpus documents taken from the lane's corpus at pull request 2's head
(`document.json` of each), chosen to hold: relative reads inside and across repeats, a `current()/..`
read in a query-bound repeat, a typed and an untyped `casedb` query and one typed by `@case_id`, a
session read, a static select's literal default and comparisons, a record comparison opposite a static
select, a structural many read in `concat`, an empty `relevant`, a catalog property with all three
retiring values, a form link with a manual datum, a Hidden Value whose writer inference types a
property, and a device datetime ordering (`targeted-datetime-ordering`). `fixtures.test.ts` holds the
digests at every head; its validity half (each fixture parses under the pre-step `blueprintDocSchema` and
passes the pre-step gate) runs at pull request 2 and leaves with pull request 5, the shape. A second test
requires every step id, blocker code and reason to name at least one fixture.

| Test | Boundary |
|---|---|
| The frozen printer equals `lib/domain/xpath/print.ts::projectXPath` over every fixture's expressions (pull request 2; leaves with pull request 5) | pure: `frozenPrinter.test.ts` |
| Every step over its fixtures: the stored document and each notice line; the whole transform's output parses, passes the gate and export readiness, and round-trips; a second application changes nothing; the lift of each corpus fixture equals the head corpus source's own build of that document, or differs only by a class of §5 listed per document in the test's expectations | pure: `steps.test.ts`, `liftOverCorpus.test.ts` |
| The slot walk visits exactly the head registry's slots; step 3's `choice` binder equals the record dialect's; step 5's least type over reads that order, add, compare and only print | pure: `equality.test.ts` |
| The normalizer: the head serializer's output is a fixed point over the corpus emission; for every corpus fixture, base and head emission differ after normalization only in files a named change explains; a hand-edited head file that no change names is `unexplained` | pure: `emissionNormal.test.ts`, `census.test.ts` |
| The digest is stable across runs and moves with a base sequence, a base digest, a target, a change, a blocker, a schema change or a deployment's entry points; the report holds no authored string from any fixture | pure: `plan.test.ts`, `report.test.ts` |
| `notice.ts` and `behavior.ts`: each reason's selection, `expressions-sent-at-next-publish` exactly for deployments of apps with a wire-reaching entry, `deep-links-need-republish` for apps with entry points | pure: `notice.test.ts`, `behavior.test.ts` |
| The fleet write, from `main`'s migration prefix then the stack's migrations: several apps including a soft-deleted one and one with NULL `case_types`; the admit trigger accepts the new identity and refuses an invented one; an app changed after the plan, a live holder and a wrong digest each stop it with nothing written; a failure injected after each statement group leaves the database byte-identical; `--rehearse` leaves the data unchanged and the DDL applied; `case_type_schemas` and `cases` byte-identical; after the commit every app loads, folds from its baseline, and `runCanonicalRuntimeDatabaseProbe` finds nothing; a second run in every mode is `already-applied`; a partly marked database is refused | real Postgres: `writer.postgres.test.ts` |
| A declared property over a type whose rows hold the key is `declared-property-has-stored-values`; an inferred `text` to `date` change counts the rows `conversionImpact` finds uncastable; after `migrate-schema-drift.ts --execute` over the committed target the drift scan finds nothing and the uncastable values are parked | real Postgres: `schemaPlan.postgres.test.ts` |
| The scan's counts per step, class, blocker and holder over a seeded pre-step database, run as a role that holds only `SELECT`, which proves it takes no lock | real Postgres: `scan.postgres.test.ts` |
| Holders settle through the production reapers; a live holder stops the write; private work is abandoned, a pre-app session with open work ends as a discarded one does, one without is byte-identical | real Postgres: `holders.postgres.test.ts`, `privateWork.postgres.test.ts` |
| A cursor between two horizons, and below both, answers `reload`; the finished-build branch and the genesis receipt behind the second horizon answer from the saved app | real Postgres: `lib/agent/change-set/__tests__/preHorizonReads.postgres.test.ts`, kept after the removal |
| The Job's admitted and refused argument shapes; the bundle's entrypoint runs a dry run with no database write | infra: `scripts/infra/tests/test_deployment_policy.py`, `scripts/infra/__tests__/containerArtifacts.test.ts` |
| The new reasons and the lead render; the dialog groups both cutovers' notices | pure: `lib/notices/__tests__/migrationNoticeCopy.test.ts`, `migrationNotice.test.ts`, `components/builder/notices/__tests__/appNoticeModel.test.ts` |

The cutover adds no lane group and moves no proof timing; `proof/identity-moves.json` gains no entry.
Three things are proven by the real system in the runbook and by no test: checks 1 and 2, the census
over production's documents, and the fleet transaction's duration over production's rows.

## 16. Removal and the cutover's trace

Pull request 15, the removal, at the top of the stack, removes: both scripts and the base emitter,
`scripts/lib/hqRoundTripExpressions/` with its tests and fixtures, the `Dockerfile` line and the three
`.dockerignore` lines, the writer's entry in `runHolderWriteGuard.test.ts`, the allowlist
tool and its infra test rows, the `scripts/README.md` entry, the `docs/architecture/deployment.md`
paragraph naming the tool, the runbook and this plan (`docs/plans/hq-round-trip/3-expressions.md` and
its part directory, as step 2's #767 removed its own plan); and it makes
`abandonPreAppDesignSessionInTransaction` and `reapStaleDesignSessionRun` module-private again. Both
Jobs are already deleted by runbook step 12. The squash merge leaves the tooling on `main`'s history and
none on its tip, in one deploy.

What stays, the cutover's trace: the fold-horizon migration (immutable); `lib/db/CLAUDE.md`'s five
identities; the cutover id, its lead and every reason with its renderer (stored rows render for good);
the two-horizon case of `preHorizonReads.postgres.test.ts` and the step 3 horizon of its fixture
`foldHorizonFixture.ts`; `RUNTIME_VERSION` 16; the publishing docs
paragraph; and the evidence prefix `hq-round-trip-expressions/` in the bucket, which keeps
content-free reports only and is never deleted from.

## 17. Files

- Storage: `lib/case-store/migrations/<timestamp>_hq_round_trip_expressions_fold_horizon.ts`,
  `lib/case-store/migrations/index.ts`, `lib/db/designSessions.ts` (two exports), `lib/db/appTests.ts`
  (`RUNTIME_VERSION` 16), `lib/db/CLAUDE.md`.
- Notice: `lib/notices/migrationNotice.ts`, `lib/notices/migrationNoticeCopy.ts`, their tests.
- Scripts and infrastructure (removed by the removal): `scripts/emit-hq-round-trip-expressions-base.ts`,
  `scripts/scan-hq-round-trip-expressions.ts`, `scripts/migrate-hq-round-trip-expressions.ts`,
  `scripts/lib/hqRoundTripExpressions/**`, `Dockerfile`, `.dockerignore` (three lines),
  `lib/db/__tests__/runHolderWriteGuard.test.ts` (the writer's allowlist entry), `scripts/rollout/deploy-cloud-run.py`,
  `scripts/infra/tests/test_deployment_policy.py`, `scripts/infra/__tests__/containerArtifacts.test.ts`,
  `scripts/README.md`, `docs/architecture/deployment.md` (one paragraph: "The HQ round-trip
  expressions cutover runs on `commcare-nova-historical-repair` from the maintenance image as
  `hq-round-trip-expressions.cjs`. Its stored-args form is the dry run, which writes nothing;
  `--settle-holders` and `--execute --expect-plan-digest <digest>` are its only other admitted shapes.
  Its runbook is `docs/plans/hq-round-trip/3-cutover-runbook.md`; the tool, the runbook and this
  paragraph leave together once the cutover has run."), `docs/plans/hq-round-trip/3-cutover-runbook.md`.
- Tests kept: `lib/agent/change-set/__tests__/preHorizonReads.postgres.test.ts` and its fixture
  `foldHorizonFixture.ts` (the step 3 horizon, written as the fleet transaction writes it).
- Docs kept: `content/docs/publishing.mdx`.
- Validator, emitters, Preview, builder, SA and MCP tools: none of this part's.

---

## Departures

- **One cutover pull request, not a step per owning pull request** (step 2 grew its step list across
  the stack). The lift's core is the head parser, so a step written at an intermediate head would be
  written against a parser that later moves; the cutover runs only from pull request 14, the one
  beneath the removal. What needs pre-step code rides pull request 2 instead.
- **The pre-step half in its own pull request 2, the cutover skeleton**, not in the lane mechanics
  pull request: its head is the lowest one with the half's files whose `lib` still equals
  production's but for pull request 1's test table (§3), and no proof pull request carries a cutover
  file.
- **No `--rehearse` in the window, no clone rehearsal**, sized from step 2's archived execution;
  step 2's own window ran dry run then execute (`executions.json` in the evidence: prove-decrypt,
  dry run, prove-decrypt, settle-holders, execute, dry run).
- **No line for scaffolding respelling or dropped declarations**, and **one app-level line** for
  authored respelling and for the `choice` lift, so a dialog never lists thousands of lines.

---

## Executed during planning

All production reads were read-only, under the person's standing permission for read-only
production reads (2026-10-17).

1. **Production Jobs** (Cloud Run Admin API `projects/commcare-nova/locations/us-central1/jobs`, ADC,
   2026-10-17): `commcare-nova-capture-cleanup` and `commcare-nova-migrate` only.
   `commcare-nova-historical-repair` and `commcare-nova-case-type-schema-retirement` are defined in
   `config/deployment-jobs.json` and absent on production.
2. **Step 2's archived evidence** (`gs://commcare-nova-cutover-evidence/hq-round-trip-emission/evidence/`):
   `record.txt` (pull request 15 head `f26d17ff`, merge `5cf6e327`, the restore point's id);
   `execute-report.json` (every app written with its notice, the event archive, each fleet step's
   duration as §9 describes, the WAL, the database growth inside the transaction and peak RSS, which
   show the transaction fits the window with a wide margin and the Job's memory well; no holder at
   execute; a few active candidates abandoned); `executions.json` (prove-decrypt, dry run,
   prove-decrypt, settle-holders, execute, already-applied, in that order). Step 2's deploy build
   failed at `verify` after `migrate` and `deploy` passed, and its retry passed.
3. **Cloud SQL** `nova-cases`: storage auto-resize on, point-in-time recovery on, with storage that
   holds the database many times over.
4. **A content-free probe** (a read-only script through `scripts/lib/prodDb.ts::targetProdDb`, one
   `REPEATABLE READ, READ ONLY` transaction, plain `SELECT`s, counts only, 2026-10-17): no `events`
   `mutation` row (step 2's archive and the conversation log remain); no `app_changes` row after the
   step 2 horizon; no open workspace, change set or active candidate; step 2's notice rows and the
   stored `case_type_schemas` rows present. Out-of-catalog reads: a few reads, in very few apps, of properties no catalog declares, in
   queries typed by a `@case_type` literal or by `@case_id` from a known source, all text use; the
   probe shows no collision for the reads typed by a literal (no case of that type is stored), and
   the dry run counts and checks them all. Reads in untyped queries (no `@case_type`, no
   known `@case_id`): standard properties; custom properties binding to one case type of the
   scanner's effective index, and some to several; none to no type. The binding split uses the shape
   scanner's index and attributes each read to its own query, so the dry run's production binder
   replaces it.
5. **Nova history read** at `f9218b7e`: step 2's `scripts/lib/hqRoundTripCutover/` (oldShape, holders,
   writer, report, steps), `Dockerfile` (`hq-round-trip-cutover.cjs` bundle line), and
   `scripts/infra/tests/test_deployment_policy.py`'s cutover cases, the templates §3 and §13 copy.
6. **Runbook check 1's pathspec**: no stack branch exists yet, so check 1 was not run. What it must
   tolerate was read from part 08 §7 (pull request 1 adds `lib/commcare/__tests__/instantOrderingTable.ts`
   and nothing else under `lib` or `app`), and the pathspec was tried read-only on this repository:
   `git diff --stat HEAD~3 HEAD -- lib app` names 199 files, and with
   `':(exclude,glob)**/__tests__/**'` added 121, none under a `__tests__` directory (`git status`
   clean after). This part relies on none of part 08's scratch-branch runs; the canonical spacing it
   names for the normalizer is part 01 §2.5's, from R2's run 39061476968 (part 08 §6.4).
