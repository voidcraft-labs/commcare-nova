# Findings from the test-suite audit

This records behavior discovered by executing replacement tests. The audit is
still in progress; `manifest.json` tracks direct file review separately from
passing tests.

## Compiler defects corrected during review

- A blank check over numeric arithmetic tried to compare the numeric result
  directly with an empty string. Postgres rejected a domain-valid expression
  before it could filter rows. Computed and bound scalar blank checks now use
  their text projection; the tests include null, blank, number, boolean, and
  timestamp bindings.
- Ordinary numeric literals had no SQL type. A prepared `1 + 2` expression
  failed with `operator is not unique: unknown + unknown`. The old arithmetic
  tests added explicit literal types to avoid that failure. The compiler now
  supplies integer/numeric types and the replacement tests use ordinary
  authored literals, fractions, and values outside int4 range.
- Nested arithmetic did not preserve AST grouping: `(2 + 3) * 4` returned `14`,
  and `10 - (5 - 2)` was exposed to SQL's left associativity. Arithmetic nodes
  now retain parentheses. Real Postgres assertions require `20` and `7`.

## Unresolved arithmetic contract discrepancy

Nova's current domain checker resolves `int div int` to `int`, and its Postgres
runtime returns `3` for `10 div 3`. CommCare Core's `XPathArithExpr.evalRaw`
converts both operands to doubles and uses `aval / bval`; its result retains
the fraction. The on-device emitter currently emits the division directly.

Evidence inspected locally:

- `lib/domain/predicate/typeChecker.ts`, the `arith` result-type rule.
- `lib/commcare/expression/onDeviceEmitter.ts`, arithmetic emission.
- `commcare-core/src/main/java/org/javarosa/xpath/expr/XPathArithExpr.java`,
  `evalRaw` and `DIVIDE`.
- [Postgres mathematical operators](https://www.postgresql.org/docs/18/functions-math.html),
  which specify truncation for division of integral operands.

The literal/grouping fixes preserve the current Nova type contract. Changing
that contract needs a decision covering existing integer destinations and
saved expressions, followed by validation across SQL and wire consumers. This
is an open finding, not a claim of arithmetic parity across targets.

## Archive member normalization corrected during review

`sanitizeArchiveMemberName` removed leading dots before trimming whitespace.
Inputs such as `"  .. "` therefore survived as `".."`, violating the safe leaf
contract. It now removes the complete leading run of dots and whitespace
before the final trim and fallback. Five whitespace/dot cases failed before
the correction and pass afterward; Unicode names and all C0/DEL stripping
remain covered.

## Inline editing separates state from browser behavior

The editing rules formerly lived entirely in a React hook and were exercised
through synthetic hook renders and partial keyboard events. `commitField.ts`
now owns the actual production draft, commit/refusal, cancellation, and feedback
lifecycle; its tests drive that model directly. The hook binds it to React and
the real input. Shortcut routing likewise moved to a programmatic registry,
with the real document adapter retaining focus and event cancellation.

A second successful save during the existing checkmark window did not restart
that window because the hook's effect depended on the already-true `saved`
boolean. A focused reproduction against the previous hook failed after two
saves one second apart. The model restarts its sole timer on each successful
save and cancels it when the editor is disposed.

## Build execution and source-map cleanup

The production build CLI now runs against external executable fixtures that
require each predecessor's completed artifact. The suite covers every phase's
failure, release identity, credential isolation, and the no-token local build.
It no longer uses delayed child processes or relative indexes that can accept
a missing event. Maps remain present through release finalization and failures;
only the shipped application directories are cleaned afterward.

Generated files ending in a newline retained their terminal source-map comment
even after the corresponding map was deleted. The new real CLI scenario failed
on that content. The cleanup expression now accepts terminal line endings;
JS, MJS, CJS, and CSS pass while code containing a literal sourceMappingURL and
compiler-cache/dependency maps remain intact.

## Language editing and browser evidence

The language suites now exercise the production protected-prose draft, immutable
translation workspace and selector-row derivation directly. A real browser
journey uses the full registry and persisted app: add/copy, invalid-token refusal
and recovery, target edits, reload, Preview language switching with an existing
answer, and another tab changing an open draft and removing the selected copy
source. Three old fake-DOM suites and their registry/provider mocks were removed.

Two production defects emerged from these boundaries:

- Protected case references were matched by JSON insertion order. A target with
  the same identity but reordered object keys silently lost its displayed token.
  The regression failed before switching to canonical reference equality.
- Translation projection compared every edit with the pre-batch overlay. A
  second edit restoring the original value left the first edit in place; a
  clear after creating a missing target also retained the new value. Both
  regressions failed against the old projector. It now compares with preceding
  batch writes and honors clears of staged entries.

The browser guard also missed handled/native errors that Nova reported through
`/api/log/error` without a Playwright `pageerror` or console error. It now watches
that actual reporting channel; a real browser beacon proves the guard rejects
such a report even when the endpoint returns 204.

An intermittent native ResizeObserver undelivered-notifications event exposed
that gap during the language and inline-editing journeys. Subsequent instrumented
and ordinary runs did not reproduce it. No observer or reporter suppression was
added. The layout cause remains an open investigation, now covered by the guard
when Nova reports it.

## Static boundaries and model transport

A regex walk for OpenAI constructors has been replaced by Biome import rules,
exercised through the real CLI with aliased, default, namespace and re-exported
imports. This uncovered that later Biome overrides replace a rule's options:
the existing wire-boundary override had erased the component doc-store boundary.
The intersecting rules now preserve both restrictions. Existing violations were
moved behind named domain hooks with actual dependency sets; no waiver was added.

The transport tests use the production dispatcher/fetch factory against real
local sockets. They distinguish header and inter-chunk timeouts by Undici error
code and prove caller cancellation before and after response headers, including
server-observed disconnection. The delayed server fixture and constructor-shape
assertions are gone.

## Local calendar state

The midnight rule now belongs to a production clock with a stable day snapshot
and one timer while subscribed. Direct tests cover 23/25-hour days, forward and
backward clock changes, same-day stability, and subscription cleanup/resumption.
The React adapter retains focus/visible resync. The old fake calendar screen and
fake matchMedia suite were removed; responsive layout remains a browser claim.

## Deployment evidence crosses real process and HTTP boundaries

Source substring and source-index assertions were replaced with parsed release
configuration, execution of the actual Cloud Build/CI step shells, and real
bundled job entrypoints. The former cleanup order check could pass if the schema
probe was absent because indexOf returned -1; the replacement proves a failed
probe prevents all maintenance under the acquired lease. Operator bundles use
the Dockerfile's actual esbuild arguments. Docker context filtering remains the
responsibility of the required production-image CI build.

The Python request tests previously replaced the complete HTTP adapter.
Independent Job facts and real request serialization now cover etag fencing,
single POST/PATCH attempts, active migration joining, failed/pruned execution
recovery, authority drift, and final image/traffic verification. Infrastructure
plan/apply tests retain CLI parsing and the actual API/subprocess adapters.
Production-embedded policy self-tests were removed.

A local HTTP server reproduced another production defect: abrupt disconnects
and incomplete response bodies escaped the bounded read-retry classification.
The shared Cloud Run transport now classifies those failures consistently while
keeping uncertain writes terminal after one attempt. HTTP error responses are
closed, and an incomplete diagnostic body preserves the original HTTP status
rather than changing an authorization refusal into a retry.

## IAM evaluation and database bootstrap admission

The capture policy tests previously exercised a separate JavaScript predicate
that no production caller used. That imitation accepted a trailing slash that
the actual emitted IAM condition rejects. The unused predicate is removed;
tests now evaluate the actual condition with CEL, restrict it to the supported
IAM surface, and validate the `extract` extension against Google's published
examples. This was a defect in the test imitation, not a production access leak.
The real policy CLI also round-trips a policy file and rejects a widened grant.

Database bootstrap's SQL string snapshots are removed. Existing real ownership
transfer and rollback coverage is retained. A focused real-catalog test exposed
four admitted grants outside the promised one-way migration-to-runtime edge,
including indirect cleanup access and grants to/from audit. Bootstrap now
inventories every application's direct parent, with the same managed-role
exception as the later deployment privilege gate. The later gate already
refused these grants; the defect was premature bootstrap admission.

Actual CLI process tests also reproduced connector cleanup missing on option
discovery failure and network preparation before credential validation. Input
validation now precedes acquisition, and the connector's lifetime encloses
option discovery and database-client construction as well as execution.

## Filesystem, process, and bundle boundaries

The standalone launcher's fake filesystem was seeded from its own preparation
plan. Its replacement checks actual copied bytes, overwritten traced assets,
unchanged source files, and refusal before any placement when an artifact is
absent or has the wrong kind. Real children prove working directory, environment,
exit status, SIGINT/SIGTERM forwarding, and listener cleanup. Test-only filesystem
and signal-source interfaces were removed from the launcher.

Operator target resolution now runs through a real child and controlled gcloud
executable. This reproduced an eager fallback bug: an explicit `NOVA_DB_USER`
still performed account discovery and failed if gcloud had no account. The
fallback now runs only when no explicit database user is present.

Language-registry source substring checks and a recursive test-file scan are
replaced by esbuild's actual chunk graph. The full catalog must be present in
the dynamic search output, absent from synchronous registry/load output, and
the main domain barrel must keep the registry out of its static dependencies.

## Document extraction owns observation and request separately

The old hook had one viewer-no-request test. Its once-per-mount flag also
survived an asset-id change: the replacement document never started reading,
and the prior document's late result reached the replacement callback. A
before/after hook reproduction confirmed this, then the hook imitation test
was removed. Production now uses a direct state model with per-asset identity,
request generations, cancellation, bounded polling, and terminal notification.
A polling observer that exhausts its budget becomes retryable instead of
remaining in Reading forever. Build-owned reads retain their original signal
and progress after chip removal; local observers abort their own reads.

Native stream tests exposed another gap: releasing the extraction reader did
not cancel the still-open body after a terminal frame or parse error, and an
HTTP refusal left its body unread. Both paths now cancel the body. Tests also
split UTF-8 frames byte by byte and reject incomplete streams. The real file
manager proves retry, Reading-to-Ready, completed title reconciliation, the
information popover, and reopen without a second request, with controlled API
responses and no model spend. The old badge CSS/callback test is removed.

## Native media and real context boundaries

The media client suite no longer claims typechecking covers fetch. Native files
exercise the actual byte reader and SHA-256. Request tests cover initiation,
exact signed headers and bytes, confirmation, deduplication, aborts, refusals,
paged id resolution, deletion, and returned extract content. The unused hashing
adapter that existed to avoid the old leak detector is removed.

Library and upload orchestration now live in production state models. Tests
drive those models through fetch, retain native responses and signals, and join
all pending requests. They exercise failed-page retry without dropping earlier
rows, overlapping requests, retired searches, local row updates, overlapping
uploads, and live capability changes. The old hook mocks are removed.

A Chromium test runs the actual upload client against a temporary HTTP server.
Native progress, successful transfer, HTTP refusal and cancellation worked;
invalid XHR setup left an abort listener attached. Setup now cleans up on a
synchronous exception. The server and browser resources are closed after the
check, and no Google service or model is called.

The real Files journey found the header's account control outside the Builder
provider. Its fallback capability stayed editable for a viewer, and its library
requests lacked an app id. The old header test explicitly pinned that omission.
The account control now portals from the Builder tree, preserving session and
reset context, and supplies the app id to the file manager. The site retains
its active-Project menu. This was an incorrect UI capability and Project choice;
the server's media membership checks remained authoritative.

A second native-browser failure showed why a mock pause/load assertion was
insufficient: an audio preview could unmount before its reset callback read the
ref, retaining its source and decoded state. The browser had already paused the
detached player; this was not observed continued playback after revocation.
Each mounted element is now captured and retired both on reset and on cleanup.
Actual role changes prove image renewal and audio source/decoder retirement.

Whole picker, preview, chip, header and account mock suites are removed. Browser
journeys now cover touch actions, keyboard full-name disclosure, real geometry,
inline refusal and dismiss, cancellation before attach, extraction retry,
filename-preserving download intent and current Project authority. Chromium
bypasses Playwright routes for native downloads, verified with a separate local
server probe; the UI test cancels after asserting the download event and URL,
and does not claim to validate mocked storage bytes. Geometry assertions wait
for popup animation to settle before measuring the 44px floor.

### Schema drift and translation-evaluation fixtures

The old drift suite explicitly pinned a branch order using a schema that never
shipped. Its legacy-array assertion also never supplied the legacy enum it
claimed to cover. The entire helper-only file is replaced by four real-Postgres
scan tests, and the decoder is private. The tests read all nine current type
shapes, classify changed destinations, exercise JSONB key ordering, distinguish
legacy refinement from unknown formats, verify app scoping and unchanged rows,
and preserve prototype-shaped property names. Existing index-convergence tests
exercise actual versioned repair and retirement.

The current single-select annotation was ignored by the scanner, reporting
`text` as the source of a retype. A regression failed before recognizing the
annotation. Another regression showed `constructor` removal disappearing and
`toString` addition reported as an unresolvable inherited function. Owned-key
checks now report both changes correctly. Diagnostic recognition of a legacy
shape does not bypass the repair writer's canonical stored-schema admission.

Translation evaluation now runs all six available source/target directions
through production batching, prompt serialization, structured-output parsing,
and protected-prose validation, reconstructing the exact authored target fixture
values. Review metadata is checked against usable criteria and real formatting
signals; removing a protected reference must fail. These are offline fixture
and protocol checks, without model calls or a claim about translation quality.

### Inspection-script boundaries

Retained the artifact-producer evidence-union tests after checking both real
inspector consumers: interrupted summary writes and superseded artifacts must
remain visible. Preview input arbitration now preserves the actual question
payload and distinguishes accepted waits from incomplete or malformed results.
These are pure protocol checks; they do not claim to run the paid preview or
production stream arbiter.

The design-session inspector converted database `Date` values to strings before
sorting, losing milliseconds and selecting an older session within the same
second. A native-Date regression failed before the timestamp comparison was
corrected. Compact message and tool summaries now assert real UTF-8 byte sizes,
payload omission and fatal-error distinction. The bare SHA-256 repeat-input test
was removed: it did not exercise watch collection or suppression behavior.

### Diagnostic statistics and persisted verification

The XPath deployment-verification test previously checked only an exported
boolean expression. That file and helper export are removed. Four real-Postgres
journeys now run the verifier on stored apps, proving exact selection, duplicate
selection handling, deleted/restorable app inclusion, compatible expression
counts, missing selections, independently incompatible and unreadable state,
and absence of writes. Lifecycle-status repair tests already used real Postgres
and were retained after source review.

Log analytics now process a mixed current-mutation, archived-mutation and
conversation history through grouping, timeline, error, stage and kind views.
A fabricated `noop as never` fixture is replaced with a valid mutation. UTF-8
payload accounting failed before the fix: Unicode output could be ranked below
smaller ASCII output because the implementation counted UTF-16 code units.
The diagnostic now measures actual serialized bytes; it remains a size estimate,
not a tokenizer or billing calculation.

Blueprint statistics retain destination-based case-name diagnostics and now
exercise nested fields, full logic totals, module order and expression printing
after an identity-preserving rename. Generic JSON search tests were retained as
useful pure behavior checks. Related-case scan report tests now carry actual
validator findings from authored fixtures through rendering, with deterministic
multi-app ordering and independent refusal for unreadable and incompatible apps.

### Historical repair writers and complete retry

The case-status helper suite is replaced by real guarded writes for all three
reviewed filters across both affected apps. Whole-document comparison, attributed
history, idempotence, unreviewed-app exclusion, later user correction and an
app-wide pre-write refusal now exercise the actual repair lifecycle.

The choice-value writer suite formerly replaced both its fluent database and
its writer. Five Postgres journeys replace that entire file. Actual gate and
history-write failures prove per-app continuation; an unreadable snapshot is
terminal. Ordered multi-select rows retain other values and timestamps, with
another app untouched. The pure planner suite now projects complete expressions
and renames the referenced field after repair to prove its UUID identity survives.

A PostgreSQL trigger refusing a case-row update exposed a real partial commit:
the document and history had already committed, while the case retained the old
choice value. A later scan would see a clean document and skip the remaining row
repair. `appendSyntheticBatchInTransaction` now shares the standalone writer's
exact preparation and guarded commit implementation. The repair composes its
case updates in that same transaction, with counters updated only after commit.
The regression proves rollback and complete retry. No production repair was run.
The obsolete claim that this historical repair runs on every ordinary deployment
was also removed after checking its actual CLI consumer.


### Real membership and authentication migration admission

The guarded writer suite no longer mocks its membership module or duplicates
app persistence in its fixtures. Each revocation scenario first commits as a real
Project member, then removes that membership or downgrades it to viewer. The next
commit must refuse without changing the full stored app or history, including
when the removed actor created the app.

The account identity migration accepted a partial unique index as complete
because it searched the printed index definition for column names. A real
partial index reproduces that false admission. Catalog inspection now requires
a valid, ready, unconditional unique index on exactly the two identity columns.
Credential fixtures also prove normalization, separate provider namespaces,
rolling inserts, duplicate refusal and an unchanged retry against real Postgres.

OAuth migration tests prepare the provider schema once, then clone it for each
journey. They verify complete retry preservation, nonempty scope preservation,
IPv6 loopback classification and independent ambiguous redirect refusals. An
actual backfill trigger failure proves resource registration, client links and
rolling bridge installation roll back together before a successful retry.

The XPath scan suite retains actual carrier analysis and now checks the complete
fixture profile inventory and aggregate counts, including separate runtime-owner
findings. Connect expressions use the current typed representation. Its scope is
the scanner; exhaustive domain slot traversal remains a separate contract.


### Parent-edge repairs and persisted lookup inspection

Parent repair tests keep real receipt provenance and the large native parameter
boundary. Fixtures now name their actual parent type. Added cases prove scope
and type refusals, preserved case rows/timestamps and rejection of receipt-proven
but missing, deep or mismatched edges.

The lookup audit's pure report tests were insufficient to establish database
inspection. The existing CLI scan is extracted into `scanPersistedLookupReferences`
without changing its transaction or read paths. New Postgres journeys run exact
JSONB assembly and the production extractor against independently seeded nonempty
reference rows, including trashed apps. They distinguish missing columns from
shared parent tables, report extra tables, continue after malformed persisted
entities and fail on an actual missing edge table. Whole-state comparisons show
that successful and mismatched scans leave their inputs unchanged. The report
suite remains pure and adds an overlapping nonempty set comparison.


### Language registry source interpretation

The fixture now distinguishes predominant macrolanguage ordering from ordinary
alphabetical order and proves row-order/CRLF invariance. Two redundant region
exclusions were removed because the complete region-list assertion already
covers them. Changed ISO and macrolanguage column headers previously passed
silently; both readers now verify their actual positional schema before deriving
catalogs. Sixteen pure cases pass. No generated catalog was regenerated.


### Historical language writes and canonical English-only storage

The pure planner tests formerly blessed an English-only materialized root. A
real repair transaction failed its own fold proof: replay removes that root,
while the writer persisted it. The ordinary reducer and repair now share the
same English-only predicate. A repair explicitly clears the SQL root, removes
the baseline property and still counts as a rewrite when no history row needs
changing. The root action distinguishes clearing from an unchanged SQL NULL.

Six Postgres journeys cover French and English roots/history, baseline digest
rewrites with the immutable guard restored, and all four stores including
translation attempts and batch columns. A real head-versus-history mismatch
rolls every write back; correcting the head then allows complete retry. Full
translation record comparison proves only the intended identities and digest
change. Undecidable identities refuse before writes, and a subsequent run is
unchanged. These are historical storage-repair tests, not a paid translator run
or a claim about old production data. The stale documentation saying this repair
runs on every deployment was corrected to its explicit maintenance CLI.


### Routing state and real browser history

Routing decisions now run as production state functions: navigation reads the
current path/document at action time, location snapshots share one store cache,
recovery advances prior topology with its decision, and breadcrumbs consume
already-localized names. The history policy owns query retention and stale
Project-generation case links. Undo/redo tests execute real store history,
write admission, commit verdicts, peer edits, and persistence queues. The old
mounted-hook tests replaced URL readers and browser history, so they did not
establish native browser behavior; those files were removed.

The replacement cases exposed three routing defects:

- A legacy form/field URL accepted a field owned by another form. It now leaves
  the named form open without that foreign selection.
- A Preview selection containing one unnamed case said `1 cases`. It says
  `1 case`.
- Deleting a container selected its first descendant, which the same deletion
  had removed. Selection now uses the old visual order and surviving fields.

The production browser journey verifies selection does not grow history,
Back/Forward restores field and language, and delete/Undo/Redo retains the
neighbor selection and persists through reload. It also runs the existing
conditional reference, input refusal/retry, rename, move, and Preview workflow.
The full routing suite has 120 cases across 14 files with no DOM environment;
its measured local run was 1.75 seconds. This is one suite's result, not a timing
claim about the full audit.

### Nested floating surfaces keep stable anchor geometry

The real browser guard captured native ResizeObserver errors while a dropdown
opened inside the entering Form settings popover. Native observer captures
showed the child's width stepping from 284 to 290 pixels while the parent's
scale changed its anchor's measured rectangle. A controlled CSS intervention
on the actual parent removed the errors; the initial intervention on shared
wrapper markers missed this raw Base UI caller and was inconclusive.

Shared menu and popover motion now fades at the final size. This removes the
feedback between an animated anchor width and its observing child without
turning off observation, delaying input, adding retries, or filtering errors.
The design contract records stable geometry for immediately usable nested
controls. A fresh production build passed the uninstrumented browser journey
and strict error guard. Temporary observer/input instrumentation and CSS
interventions were removed.


### Event logging uses separate scheduling and persistence evidence

The batcher suite now verifies exact event batches, the actual 450-event bound,
non-sliding timer deadline, overlapping finalization, in-flight serialization,
and recovery after both synchronous throws and asynchronous rejection. Tests
own pending promises and assert that draining leaves no timers.

The database suites independently seed app/run neighbors and timestamp/sequence
inversions, compare complete persisted envelopes and JSONB, exercise concurrent
writers with identical ordering keys, and use a real rejecting trigger to prove
that a failed INSERT leaves no partial batch before a later batch succeeds.
Schema vectors now enumerate all conversation payload families, including usage,
validation and attachment preparation. Invalid discriminator tests retain every
other required field so an unrelated missing source cannot make them pass.
Thirty-two cases across four files passed locally in 5.76 seconds, including
Postgres setup. No logging behavior was changed by this slice.


### MCP protocol and prompt delivery use actual clients and stored authorization

MCP tests now have a real SDK client/server helper that closes both endpoints
on setup, assertion, or transport failure. Progress tests observe notifications
through real request contexts, including token zero and a disconnected client.
Removing the production notification rejection handler in a temporary negative
control caused Vitest to fail with an unhandled `NOT_CONNECTED` error. The
handler was restored; no test-side catch masks that failure.

Prompt tests no longer fabricate authorization or renderer results. Real SDK
calls verify schema refusal and build bootstrap. Real Postgres cases verify
Project viewer access, non-disclosing foreign/missing app refusals, unchanged
storage after reads, full large-app reconstruction, stale-cursor refusal after
a guarded app edit, and refusal after the viewer's membership is removed.
Pure pagination cases cover independent byte limits, escaping, Unicode offsets,
content digests, progress, malformed cursors and marker placement. Duplicate
renderer fixtures and editorial substring checklists were removed.

The two run-attribution callers now use their actual database `Date` values;
production support for fabricated `toMillis()` test objects was removed. Scope
checks cover every independent grant and both credential remediation paths.
Registration metadata and user-tool names are verified through `tools/list`.
The focused validation passed 110 cases in ten files in 7.88 seconds, including
the two existing caller suites and real Postgres. Type checking passed. This is
a bounded slice of the continuing audit, not full-suite completion.


### Persisted access checks exposed deleted-app reads

The callback-mocked ownership suite was replaced with pure error translation
and real Postgres reads through the actual MCP blueprint loader and Project
gate. An unused `requireOwnedApp` wrapper existed only for its tests; it was
removed. Authorization fixtures now optionally clone real Better Auth plus
Nova auth-app migrations and seed their required users, Projects and members.
The prompt authorization suite uses that migrated schema too.

The new tests reproduced deleted-app access through both full blueprint reads
and lightweight route scope reads: after a real soft delete, both still returned
authorized data. `resolveAppAccess` now rejects the deletion marker and
`loadAppProjectId` filters it, matching the existing transaction scope guard.
Both paths allow reads again after an authorized restore. Ordinary Project
access remains available while an individual app is deleted.

Deletion and restore assertions now cover the complete root row, preserved
blueprint entities, the exact 30-day deadline, co-admin authority, denied writes
with unchanged storage, and absent-row refusals. Error projection checks cover
all expected typed categories, deployment tags, commit-time revocation,
credential-specific scope metadata, and safe handling of arbitrary throws.
Known rejections do not become operational error reports.

The consumer run passed 322 cases across 41 files in 12.02 seconds. After the
final deletion-test consolidation, the focused run passed 35 cases across five
files in 7.89 seconds. Type checking passed. These checks validate this slice;
the full testing-method audit remains in progress.


### App MCP tools now exercise protocol, persistence and authorization together

Five callback-capture suites were removed. Their SDK imitation never ran the
registered input schemas, and several foreign-access tests actually failed on a
missing mocked app before their permission check could execute. The replacements
use real SDK client/server dispatch and migrated Postgres/Better Auth tables.
They prove shared/personal creation, exact persisted starter identities, real
Project/viewer/foreign restrictions, deletion visibility, native transaction
rollback and retry, four stable sort orders, and bounded fuzzy-search paging.
Compile-time genesis option checks moved to the database owner.

Malformed listing cursors reproduced an actual `internal` error. Cursor decoding
now admits the emitted composite shape, canonical encoding and real timestamp
before SQL, and rejects a different sort through `AppPaginationError`. MCP maps
that typed refusal to `invalid_input` with a restart instruction. A pure decoder
suite covers malformed payloads and impossible calendar dates; protocol tests
prove malformed/date/sort failures through real handlers.

The MCP and pagination validation passed 252 tests across 33 files in 12.54
seconds. This is the current slice's evidence; the full audit is still active.

### Shared MCP writes are proved against real commits and blocked connections

The old context and staged-transaction suites mocked the guarded database write.
The shared-adapter suite also bypassed SDK dispatch and replaced access, logging
and host methods. Those tests could not prove their transaction and await claims.
The replacement uses native SDK calls, real migrated Project authorization,
canonical commits, schema services, case rows and stored event envelopes.

A two-stage conversion/patch commits one history row. A native trigger rejecting
only a patch-bearing INSERT proves the failed call leaves no earlier conversion
behind. Another call supplies the calculation its new hidden field requires in
the same batch. Actual conversion impact prompts before changing stored values;
a confirmed conversion preserves the original decimal in Data to review and
keeps the consequence in the MCP success text. Pure result projection now owns
summary stripping and note placement without a fabricated context.

Native app and event-table locks prove the response waits for its database work.
The lock controller observes `pg_blocking_pids` on its own connection and always
releases and drains the operation. Temporarily removing the adapter's final
`await logWriter.flush()` made both success/error response tests fail because
the response resolved while INSERT was blocked. The production await is restored.

The real failure test exposed raw PostgreSQL diagnostics in the ordinary shared
tool error payload. `DatabaseError` now escapes that catch to the existing safe
operational classifier. A real rejecting trigger verifies the complete safe MCP
envelope and unchanged storage. Case-service testing also exposed an unowned
cached application pool: fixtures granting a local database URL now close that
pool before dropping the database, including on failure.

The final MCP and shared-error consumer run passed 271 tests across 33 files in
14.62 seconds. Type checking passed. The full audit remains in progress.

### Project tools: membership and session interoperability

Six suites were consolidated into ten actual SDK/database journeys. Five used
captured callbacks and replaced membership checks and writes with mocks; the
sixth independently migrated a partial auth schema. The replacement uses the
production-migrated template and exercises actual Better Auth invitation
acceptance with Nova's organization configuration.

The tests prove atomic Project/owner creation with a native rejecting trigger,
current membership enumeration, complete member and invitation projections,
48-hour stored expiry, discoverability and acceptance, cancellation releasing
one of 100 live invitation slots, scope and role refusals, owner protection,
foreign member handles, and matching session/MCP privacy and domain policy.
A native UPDATE-rejecting trigger proves repeating a role assignment performs
no write. A membership transaction demoting the actor blocks an MCP role change;
after commit, the waiting request must refuse. Removing the explicit membership
lock temporarily made that test fail with a successful unauthorized response.
The production lock is restored. No Project runtime behavior changed.

### App moves: return the locked outcome

The MCP move suite fabricated both authorization and the entire move; the
orchestration suite replaced every stateful operation. Eight actual SDK and
migrated-Postgres cases replace both. They prove tenant/case/history changes,
conversation retention, presence removal, late transactional rollback and retry,
source/destination refusal context, owner retention, capture refusal, and
same-Project recovery. A real claimed edit blocks moving; an expired holder with
a native refund failure leaves both credit and tenant unchanged, while a retry
refunds exactly once before the move.

An actual concurrent transaction exposed a response bug: MCP preflight read
Project A, another move committed Project B, and case recovery correctly followed
the fresh row but returned a response naming A. The shared orchestration now
returns the committed move or locked repair result. MCP projects its actual
Project and operation kind; the browser action uses that operation kind too.
Native lock tests cover requests originally targeting either A or B when the
other move wins. Neither adds a second history row. The reproduction failed
before the change and passes after it.

The complete MCP run plus the existing atomic-move and Server Action consumers
passed 237 tests across 28 files in 15.33 seconds; type checking passed. Those
consumer runs do not mark their remaining testing-method review complete.
