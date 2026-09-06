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

### HQ reads: prove the service boundary and the test transport

Three MCP suites replaced SDK dispatch, ownership, stored settings, or the HQ
probe result. They now run through actual SDK clients and Postgres. Connection
metadata tests prove the complete caller-specific response, all server URLs,
incomplete settings, scope precedence over a native database failure, and safe
failure output. Compatibility tests use the real HQ HTTP client and public
projection; only the KMS service is substituted. The requests prove the selected
server, exact domain, authentication header, and private prerequisite URLs.
Results distinguish disabled support from malformed or failed probes, revoked
live membership, legacy discovery, Case Search account permissions, and a
missing performance optimization that must never become a blocker.

The native-fetch boundary initially exposed an Undici MockAgent problem:
`disableNetConnect()` did not cover the cache key used by Node's legacy fetch
wrapper. A documented Agent factory now supplies a mock transport for every
connection key. A dedicated test proves interception and an unmatched-request
error from the mock transport, rather than a DNS error. This matches the
[upstream report](https://github.com/nodejs/undici/issues/5036). Tests assert
pending replies and complete request history, because production may catch an
unmatched request and return a normal refusal.

The real path also exposed unnecessary KMS use for apps without capability
requirements. The handler now resolves the stored target first and decrypts the
key only when it will actually send a probe. The new no-probe test failed before
the change and passes after it. Search fixtures must pass the actual commit
gate, including a display column using Nova's canonical `case_name` property.

All 232 MCP and settings consumer tests passed across 27 files in 17.26 seconds;
type checking and strict formatting passed. This run does not claim a completed
method review of the remaining settings or HQ client suites.

### Deep links: actual evidence across the remote check

The old MCP and release-verification suites supplied empty documents and mocked
the publish manifest, endpoint inventory, signature, HQ responses, and final
observation write. The replacement starts with a valid persisted app, prepares
its export, compiles the published entry-point manifest, and records a real
deployment. An actual MCP client then receives controlled native HTTP responses
for the selected server's exact released build. The URL preserves external case
ID order and encoding; its release metadata matches the observation actually
stored in Postgres. Every recorded request is a check, never the claim-capable
URL itself.

Eleven database scenarios cover changed endpoint definitions, login XML,
transient resource failures with historical observation retention, release
withdrawal between reads, another publish invalidating the generation, an actual
guarded authoring commit, membership demotion, and a native observation UPDATE
trigger rejection followed by recovery. Admission and SDK schema refusals
perform no HTTP or decryption. Two small direct argument tests retain the
distinct single-selection and no-selection cases without service mocks.

The focused run passed 40 tests across five files in 9.18 seconds. The final
membership SQL check passed separately, and type checking passed. The compiler
and manifest consumer runs do not mark their own method review complete.

### Deployment status: response bytes must establish the claim

The install probe accepted every HTTP 200 response, including empty bytes and
login HTML, and swallowed body-read failures. Its old positive fixture was the
literal string `profile`. Native HTTP tests first reproduced the false success.
The probe now shares the bounded exact-build XML reader and validates the
profile's remote suite identity. Only a missing profile is a build verdict;
unreadable or unrelated content remains unconfirmed. The parser tests also
cover HQ's separate media suite, optional local fallback, and ambiguous main
resources. Local HQ `views/download.py::download_file` and the `profile.xml`
template supplied the resource and profile contracts.

Observation tests now interpret real HTTP responses instead of receiving
invented HQ client results. They cover unfinished and stale build/release
stages, permission versus transport failures, redirects, missing profiles, and
malformed JSON. JSON `null` exposed an uncaught property access in the version
reader; both version-envelope readers now reject malformed envelopes safely.
An unanswered build-resource test advances a controlled clock, observes the
actual abort, releases its pending peer response, and proves no timer remains.
The native HTTP helper now lives at `__tests__/helpers/httpPeer.ts` for reuse
across all service adapters.

The MCP deployment suite now starts from migrated Postgres and real stored
publication records. It verifies the viewer's full deployment projection,
target-specific setup links, no-write reads, persisted readiness, unavailable
checks retaining all rows, release withdrawal, missing-app restoration, a
publish winning during an HTTP request, late transactional rollback of remote
revision updates, and actual connection/scope/access/schema refusals. Empty
and login responses demonstrably leave the stored state at `released`.

A real mapping history A → B → A exposed a second false report: A appeared in
`left_behind` even while it was active. The shared selector now excludes active
remote identities and deduplicates unused objects using their latest mapping.
Both Builder and MCP use the same selector even when resource-name reads are
unavailable. The database test repeats the mapping history to prove both live
exclusion and deduplication, while pure tests cover identity kinds, fallback,
rename/recreation semantics, and immutable inputs.

The complete MCP/deployment consumer run and affected reader checks passed 542
tests across 44 files in 20.76 seconds. Type checking and formatting passed.
Consumers run here retain their pending review status until their own testing
method has been evaluated.

### Downloaded artifacts: inspect what the client receives

The old MCP compile suite replaced authorization, persistence, validation,
lookup preparation, media resolution, expansion and compilation. It could pass
with a buffer containing `ccz`, unrelated fake JSON, and invalid source apps.
The replacement sends actual SDK requests as a shared Project viewer against
migrated Postgres, makes a real guarded edit, and runs both export compilers.
It opens every returned archive and checks the committed version, form input,
HQ-source versus device metadata, media references and exact PNG bytes,
lookup workbook cells and embedded fixture rows, Unicode and escaped text,
and exclusion of unreferenced tables. Both lookup-only and combined bundles
are exercised. Expected wire values are authored independently of emitters.

Current duplicate lookup values block both downloads before media reads.
Missing and foreign media have identical refusals; pending media is actionable.
A failed storage read and a native failed lookup-snapshot SQL query return no
artifact, preserve stored state, and allow the next request to succeed. The
empty lookup target set still exercises the mandatory snapshot read.
Actual deployment records prove selected-server attachment writes, absence and
ambiguity advisories, and automatic reuse of one known destination. Search
requirements precede both artifacts without any destination HTTP request.

All nine replacement scenarios passed. The complete MCP/export/lookup and
multimedia consumer selection passed 337 tests across 37 files in 20.18
seconds; type checking passed. No export runtime change was needed. The tool's
description now correctly states Project view access and lookup companions.

### Media publication: actual locks, commits and lost responses

MCP upload formerly authorized once before waiting for its content lock and
object storage. A real storage callback committed a role demotion; the old
handler still inserted a ready asset and returned success. Publication now
proves current edit membership under the same transaction as the ready insert.
Deduplication after a lock wait and result reconciliation after response loss
also require current authority. Cleanup remains responsible for unclaimed
objects even after permission loss; committed objects remain intact.

The replacement uses actual PNG validation, migrated auth/media rows and
native advisory locks, replacing only the external object store. It checks
shared-member deduplication, personal-Project provisioning and isolation,
invalid bytes and input schema, native insert rejection, ambiguous storage
write cleanup, and role demotion/removal during lock waits and publication.
The old oversized-input test fabricated a string-shaped object to reach a
branch that real SDK schema validation made unreachable. That branch is
removed; the real published schema's length limit is checked directly.

A transparent local PostgreSQL protocol peer forwards real traffic until the
server acknowledges COMMIT after an INSERT. It then drops that acknowledgement
and disconnects. The row really committed, and the driver really fails. The
upload must recover that exact asset and preserve its bytes. A second case
commits a role demotion before delivering the disconnect, proving recovery
does not return the asset after access loss.

This exposed an independent session-owner defect: the recovery assertions
passed, but node-postgres emitted an unhandled connection error. Its pool
removes the idle error listener on checkout. The session-lock owner now owns
that event, records the operation failure and discards the connection; a
rejected query promise alone did not handle it. Native backend termination
between queries and a server-side advisory-lock reset exercise failure and
replacement-session behavior too.

The old lock suite's fake client and SQL substring assertions are replaced by
native contention, transaction PID identity, committed-row visibility, global
acquisition order, cross-extension serialization, two-owner admission with
spare pool capacity, body-failure cleanup and empty-input no-checkout checks.
Only the content-identity projection remains a pure test. The shared barrier
moved to `__tests__/helpers` and refreshes the controller's activity snapshot:
PostgreSQL otherwise caches it within the held transaction and may omit a new
waiter ([PostgreSQL monitoring contract](https://www.postgresql.org/docs/current/monitoring-stats.html)).

The complete MCP/media/storage and related metadata-consumer run passed 407
tests across 41 files in 22.00 seconds. Type checking passed. Broader pool
error ownership outside the session-lock owner remains a separate audit lead.
A negative control removed global lock sorting: the native order test failed
because the later identity was already held. Restoring the original source
restored the implementation previously validated by the complete run.

## Publishing: real protocol, ownership and partial completion

The old 1,494-line MCP upload suite replaced the SDK, app/permission loader,
export boundary, compiler, deployment ledger, media archive and event writer.
It could prove which mocked answers the orchestrator forwarded, but could not
prove the uploaded app, persisted target, ownership decisions or acknowledged
log drain. It is removed, along with the last fake SDK capture helper.

Its replacement uses real SDK dispatch, migrated auth/app/lookup/media and
ledger rows, the real export boundary and compiler, and a controlled HTTP peer.
The platform multipart parser reads transmitted bytes. XLSX and ZIP consumers
inspect actual workbook cells and multimedia entries. KMS and GCS remain the
external service substitutes. Twenty tests cover create/update, preservation of
target-owned profile data while removing a stale Nova-owned key, both deleted
app paths and next-call recovery, failed-import retry, scope and Project/target
admission, explicit lookup adoption, partial lookup upload and ownership retry,
finalized dependency manifests, progress, real event INSERT drain, compatibility
preflight, missing media, successful attachment, standalone-logo disclosure and
media disconnects after a committed import.

This method found production defects that the former mocks supplied away:

- A malformed lookup envelope or invalid remote row could become an empty
  inventory and authorize a workbook write. A native publishing regression
  observed the write. JSON null instead escaped as an internal exception.
  Inventory now requires all identities and an explicit page cursor, refuses
  incomplete answers and cross-space/resource cursors, and follows no redirect.
- An unrecognized workbook-upload verdict claimed nothing landed, although the
  write had been sent and its result was unknown. JSON null also threw. Only
  the source-verified 405 format verdict proves no change; unknown verdicts
  now preserve uncertainty and trigger the ownership re-read.
- A disconnect during media upload or its status read returned a whole-publish
  connection error after the app and its mapping already existed. The shared
  lifecycle now retains that success and reports a media warning with retry.
- App import accepted truthy non-boolean verdicts, absent or unrelated ids and
  malformed optional fields as success, and leaked transport/JSON exceptions.
  The client validates acknowledgements before they can become ownership
  mappings, keeps update identity exact, classifies unreadable responses and
  follows no redirects.

The lookup and import driver suites are also replaced by native HTTP tests;
there is no global fetch spy or fake four-byte workbook. Their request checks
cover encoded file bytes, selected installation, authentication, ordered padding
and explicit replacement/update fields. Current upstream evidence is
`app_manager/views/app_import_api.py::_handle_import_app`,
`fixtures/resources/v0_1.py::LookupTableResource` and
`fixtures/views.py::UploadFixtureAPIResponse` in the local HQ checkout.

Before-fix logs separately reproduce malformed inventory writes, both media
false failures, unknown upload-verdict certainty, import acknowledgement errors
and followed inventory redirects. The complete affected MCP/deployment/driver
run passed 536 tests across 44 files in 23.82 seconds. Request deadlines in the
other HQ readers and broader media-poll protocol behavior remain open audit
work; this replacement does not establish those properties.


## Organization inventory and uncertain publish results

The entire mocked publish lifecycle was removed. Its replacement runs the
actual MCP SDK, migrated PostgreSQL, organization writers, compilers, HTTP
serialization and durable ledger. The organization scenario sends 105 places
in groups of 2, 2, 100 and 1, proves parent IDs at the peer, observes all 105
location mappings before the app POST, then archives 103 places through the
store and proves their mappings become superseded on the next publish.

Actual HQ JSON exposed three reader/writer defects: malformed inventories were
accepted as empty, an unresolvable level parent became a root, and the place
reader silently dropped foreign metadata values unless they were strings.
Local HQ `locations/resources/v0_6.py::_update` validates modeled fields and
then replaces the full metadata object; `custom_data_fields/models.py` does
not reject arbitrary foreign JSON. The corrected readers require complete
inventories, unique identities, locally resolvable acyclic level parents and
same-target cursors. Foreign JSON survives the real read → plan → PATCH path
while Nova's modeled values overwrite or clear only their own fields. All
collection pages share one owned 30-second deadline; a controlled clock proves
a second page receives only the remaining time, with no live timer afterward.

Atomicity does not establish what happened when an acknowledgement is lost.
The place writer used to accept duplicate IDs and an unrelated ID for an
update, and the lifecycle said nothing in the stopped group was created even
after a network failure. HTTP 202 and unique positional identities are now
required. Known validation/permission refusals prove rollback; other answers
carry uncertainty. Only prior confirmed groups acquire mappings. A retry sees
an unrecorded place as a conflict and requires its exact Nova UUID for adoption.

The same native tests exposed two lookup-reporting defects: a lost workbook
response was described as confirmed partial acceptance, and MCP dropped HQ's
specific invalid-row message. The service now distinguishes body-code-402
partial acceptance from uncertainty, and the MCP error retains the service's
actionable details. Tests also cover format refusal with no readback, a partial
upload followed by an unreadable inventory, and success followed by an absent
table; none imports an app. An actually published and HTTP-confirmed runnable
deployment remains byte-for-byte unchanged when a later publish has missing
credentials or a stale target server.


## Native HQ request identity, discovery and read ownership

The old slug suite explicitly blessed `..` and described the resulting request
as at worst a same-server 404. Native URL construction disproved the assumption:
`/a/../apps/api/list_apps/` becomes `/apps/api/list_apps/`, and `.` also removes
the project segment. The shared guard now rejects those two segments while
retaining actual legacy spellings; endpoint-level tests inspect the full native
request path. Source reads also refuse path-shaped app IDs and redirects.

Replaced fake Response objects and zero-delay concurrency tests with actual
HTTP membership and access responses, matched to HQ `UserDomainsResource`,
`DoesNothingPaginator` and `app_manager/views/cli.py::list_apps`. The former
reader followed query-relative cursors against the host root, threw on malformed
URLs/JSON/network failures, accepted incomplete or duplicate memberships, and
could follow same-origin cursors that changed the private capability filter.
Discovery could reject early while sibling fetches were still running. The
replacement proves complete lists and exact targets, holds each eight-request
window at the peer, and proves a disconnected probe drains its seven siblings
without starting a ninth. An app-access probe now requires HQ's real success
envelope, rather than accepting an HTML login page with status 200.

The shared JSON reader owns an abortable 30-second deadline through body reads;
collections pass one signal through every page and compatibility keeps its
existing shorter signal. Source, membership, app-access, app-version and build
readers now use it. Native fake-clock cases prove abort and timer release at each
public read boundary. Version fields with the wrong type and malformed build
rows previously became absent/unreleased builds. Their decoders now refuse the
whole answer. A real runnable PostgreSQL deployment remains byte-for-byte
unchanged after malformed release JSON; only a subsequent explicit null release
moves it back to built. The actual SDK compatibility test also rejects a next
page that drops its private capability filter.


## Media upload transport and completion evidence

Replaced the bulk-media suite's fetch spies, fake ZIP/image bytes, and contradictory
WAF comment with native multipart serialization of a real content-hashed PNG ZIP.
The remote peer opens the archive, proves exact bytes and deduplication, and returns
HQ responses checked against app_import_api.py and BulkMultimediaStatusCache.
The original client threw on null/network/HTML answers, accepted truthy flags and
missing completion counts, used unguarded app and processing paths, and followed
redirects. Native before tests reproduced five failures. The decoder now requires
complete, internally consistent evidence from the acknowledged processing ID.

The old 45-second polling loop checked time only between unbounded requests.
A 60-second upload deadline and separate 45-second polling deadline now own fetch,
body reads and retry waits. Controlled-clock tests hold the first or later status
reply; actual local HTTP sockets send headers and partial JSON, then prove abort
closes the connection. All peer gates, connections and timers have explicit owners.
The first shared-clock test incorrectly advanced time before native response work
had established its retry timer; it now observes each peer response and drains one
native turn before advancing the next interval. No sleeps or timeouts were raised.

Publishing previously described a timeout as HQ still processing with media due to
appear shortly. It now distinguishes acceptance from unconfirmed processing.
The actual persisted SDK publish verifies malformed completion still returns the
published app and its ownership mapping with an actionable media warning.


## Worker credentials across HTTP, persistence and reporting

Replaced the worker driver's fetch spies and deleted both all-mocked provisioning
lifecycle/action suites. The actual SDK and Server Action now read persisted
personas, authorize real Project membership, use native HQ requests and commit
the real ownership ledger. A native before run reproduced six failures: malformed
search rows were treated as absence, null creates threw, HTML updates became
success, acknowledgement status/identity was unchecked, and dot-shaped worker IDs
left the intended endpoint. Strict decoders and 30-second owned deadlines now keep
all unconfirmed writes typed, including bodies that fail after headers. Redirects
are refused, update payloads exclude credentials, and password-echoing refusals
never reach logging. Upstream v0_5 serialize/Meta and v0_1 identity declarations
confirm the 201/new-ID and 200/exact-ID wire evidence.

Persisted cases verify two accounts' exact generated credentials, later updates
while Elasticsearch lags, partial acceptance, lost acknowledgement, malformed
create responses, exact adoption with actor attribution, actual separate place
assignment and retry, clearing places, and deleted-persona supersession without
a remote DELETE. Invalid requests, wrong targets, missing credentials, viewer and
outsider access all stop before an account write. A real table lock proves the
credential response waits for mapping persistence. A trigger rejects a worker
mapping while the credential still reaches the caller.

The initial failure test also found a dead progress-callback API that could throw
after account creation and discard the only password. No production caller used
it; removed the hook rather than retaining an unused post-write failure path.
Browser action cases preserve credentials on partial provisioning and a genuine
post-mapping organization read failure. The former mock tests forced artifact
helpers to throw even though their actual read paths already degrade locally; the
replacement asserts the actual degraded view and credential outcome.

Removed redundant fake-fetch logging tests from password generation. Its focused
test supplies only low accepted entropy bytes (with rejected 255 bytes interleaved),
so required character classes must be established by the generator rather than
passed by chance across hundreds of random samples. Native HTTP and persisted
lifecycle tests own the credential logging/persistence evidence.


## Retained worker credentials: target isolation and repeated uncertainty

A two-case negative run against the actual session store reproduced both losses:
a second unconfirmed password replaced the first, and a confirmed India account
erased a US candidate under the same persona and complete username. The global
uncertain dictionary also rendered in every destination card. Confirmed and
uncertain credentials now live together per server/project-space target. The pure
fold deduplicates identical replies but retains every distinct candidate; confirmed
creation clears only its exact account candidates, and dismissal targets one row.

Extracted the actual credential component and its programmatic row/clipboard
projection. Adoption proves account existence without asserting a candidate
password works. Display and clipboard use the same uncertainty labels and retain
all candidates. Chromium exercises the production component and production CSS
with native clipboard permissions: copy acknowledgement resets on added content,
all passwords survive remount, dismissal affects one row, and its native button
meets 44 pixels. The component fixture controls only supplied outcomes; real
backend provisioning remains independently proved through SDK/Postgres/native HTTP.

Read the full worker planner and its 527-line baseline suite. Retained pure
ownership and required-data rules; replaced partial Blueprint casts with complete
typed document containers and real UUIDs, removed failure-hiding early returns,
proved primary/additional-place order against reversed mappings, and added partial
adoption refusal. Session-store-wide review remains pending; these checks cover
its provisioning slice rather than claiming the whole 1,822-line suite.

### Same username is not confirmed credential identity

An actual session-store sequence (create, update, adopt a different remote ID
under the same name) reproduced the old password being attributed to the new
account. The fold now retains passwords as confirmed only when the remote ID
agrees; displaced credentials remain visible and copyable as unconfirmed. The
programmatic check spans session state through the real display/clipboard model.
The browser transport failure copy also acknowledges that creation may have
completed and explains recovery when the answer and password never arrived.

### HQ writes must own response bodies and destination

Native socket tests found app imports, lookup workbook uploads, and atomic
location batches could wait indefinitely for either headers or response bytes.
They now own 60/60/30-second abort deadlines respectively, preserving uncertain
write outcomes. Lookup POST also followed a 307 into a different project space;
it now refuses redirects before resending bytes. An operation-scoped deadline
helper serves complete reads and writes. Tests cover real socket closure for
headers, accepted bodies, and refusal bodies across all six write operations;
returning a body-reading promise without awaiting it would release the deadline
early and is detected by the refusal-body cases. The native harness drains and
closes its own request even when a negative control fails.

### Deployment transitions and replacement ownership

Replaced the overlapping lifecycle examples with complete historical records,
independently authored phase expectations, ordered transitions, retry restoration,
strict-versus-visible progress, attempt no-write identity, backward observations,
and input immutability. Target projection tests keep full server/domain identity
and same-server ambiguity; removed permissive casts and failure-hiding returns.
The entry-point selection regression remains at the real compiler boundary.

The lookup planner's former missing-table test exercised only a Nova-created
predecessor. A new actual SDK + Postgres sequence first adopts a table, observes
its complete absence, and publishes a replacement. It reproduced invented
adoption provenance on the new remote ID. HQ's `upload/run_upload.py::Mutation`
and `workbook.py::iter_tables` confirm absence creates a new object. The planner
now records that object as Nova-created, with no adoption actor/time, preserving
the previous adopted object in superseded history. Its pure suite uses complete
ownership scenarios and exact whole-plan results; the old other-kind example was
removed because its empty inventory and identical expected creation would pass
even if the kind filter were broken.

### Runtime and test database connection ownership

Two independent Node processes reproduced uncaught pg errors for killed idle and
checked-out connections. A query rejection does not own pg's separate client
error event. The shared runtime factory now observes both channels, deduplicates
terminal events per physical connection, and leaves query rejection/discard to
the driver. Three native-process cases verify idle, checked-out and active-query
loss, one diagnostic, a healthy new backend, and no remaining connections.

Additional actual singleton tests reproduced raw auth pool leakage before Kysely
initialized, shutdown missing initialization in flight, and a second close/open
racing an old checkout. Shutdown now awaits the full shared drain and closes the
raw pool when Kysely had no initialized driver. The old configuration-only suite
was reduced to independent environment/workload/config/budget contracts; its
never-opened shutdown example is replaced by these real lifecycle scenarios.

The per-test database helper's blanket idle error listener hid failures. The
helper now owns both channels and reports its retained failures after closing;
three actual pool scenarios verify this. Disabling the report makes the negative
control fail despite successful socket cleanup. The subsequent scan and stream ownership work below removes the separate
perTestAppDb polling workaround and awaits scan-side reapers.


### Request ownership of scan-side cleanup

All 16 native database scenarios failed before the fix: five admission entry
points across stale apps/design sessions and three listing scopes across stale
build/edit holders returned before reaching the held reaper lock. App/session
admissions now await sequential cleanup after COMMIT; listings and standalone
scans await it on their own path. The lock proof also observes the already
committed new debit while the stale refund is blocked, preventing a fix that
moves cleanup inside the claim transaction and deadlocks its actor gate.
Listing pagination keeps the original scan timestamp. The old listing suite's
post-response polling was removed; immediate persisted assertions now prove
production ownership. Earlier lifecycle, identity and contention tests remain.


### Stream reads finish before cancellation or EOF

The previous relays cleared timers/subscriptions but returned cancellation and
closed response bodies while database reads still ran. Fourteen actual-route
cases fail against those routes: seven SQL lanes (app mutation, presence, lookup,
deployment, app authorization, chat replay, chat authorization), each under
consumer cancellation and request abort. They use migrated auth/app state and
real LISTEN/NOTIFY, with only the trusted session boundary supplied by the test.
Actual table locks hold each read; a separate database round trip confirms the
end promise is still pending, then cancellation/EOF completes after release with
no active database work.

The shared pump now exposes drain and awaited close. Both routes use it for all
reads, including formerly independent roster and cadence loops. Cadences cannot
overlap; the chat dead-run fallback awaits the final coalesced replay, avoiding
its former early return when a pump was already active. Internal teardown stops
new work synchronously and awaits existing reads before closing; a read can
initiate teardown without awaiting itself. Programmatic deferred operations
cover successful/rejected close, repeated close, coalesced drains and reuse;
the actual default retry scheduler is also tested under a controlled clock.

The entire pool-idle polling workaround was removed from perTestAppDb. Its pool
now delegates to the same generic error-owning database fixture as ordinary
isolated databases. The existing app relay, chat replay, transport, chat POST
cancellation/build and native pool suites pass without that workaround (107
cases). No pool timeout or test timeout was raised.


### Chat event-log completion ownership

A real events-table lock strengthens the existing post-wait snapshot-failure
scenario: the newly adopted edit has a committed usage summary and released lock,
but its response cannot finish while its Waiting event INSERT is blocked. This
scenario already passed before the change; its ordinary failure finalizer
already awaited LogWriter. The remaining outer cleanup used a detached flush;
it now awaits the same writer in a finally after attempting the fallback lock
release. This is a cleanup-contract correction, not a reproduced event loss in
the ordinary snapshot-failure path.


### Qualified compatibility evidence at the native HTTP boundary

Replaced the full compatibility-probe suite's imitation Responses and fetch
spies with native HTTP peers. Two real misclassifications failed before repair:
a 200 HTML login/proxy page advertised Search as available, and a generic proxy
403 blamed Mobile App Access. Readiness now requires an XML media type; recognized
edge refusals carry no account-permission diagnosis. Local HQ `ota/views.py`
search/app_aware_search confirms XML success and the exact configured-off 404;
`ota/decorators.py::mobile_auth` wraps `require_mobile_access`, and the users
permission decorator supplies the origin 403. Its domain-migration guard uses
503, which remains unverified.

Twenty-two native HTTP scenarios cover required versus advisory evidence,
visibility-before-negative conclusions, malformed/foreign inventories, exact
statuses and disabled text, redirects, and no-I/O cases. Eight actual-socket
scenarios cover the five-second clocks for visibility, flags, runtime headers,
and refusal bodies, plus successful cancellation without reading case data.
Replacing cancellation with a body read fails that negative control and still
cleans up. The SDK publish suite adds HTML-success and proxy-refusal cases:
neither creates a deployment, imports an app, or falsely requests permission.

One shared socket peer now owns the native server and dispatcher used by these
checks and the writer/media deadlines. The duplicate media-upload body case was
removed because the shared writer suite already covers it; the distinct media
status response retains its 45-second socket proof.


### Delivered question structure and the definition/data boundary

Removed `bindTypes.test.ts` and `captureUpload.test.ts`: byte-fragment matches
pinned attribute order, the table checks repeated TypeScript guarantees, and
passing Nova's own oracle did not independently establish the emitted question
contract. One replacement parses strict XML from both HQ source and an actual
CCZ and joins all 14 scalar/capture controls to their answer types and decoded
labels. It checks order, unique binds, exact attributes, label ownership, and
nested data paths against independent expected types. It imports no emission
tables and does not claim to execute Core or HQ.

That broader fixture failed on two production defects. Decimal emitted
`xsd:decimal`; Core accepts it, but HQ `xform.py::VELLUM_TYPES` classifies
`xsd:double`, and Vellum `parser.js::buildControlNodeAdaptorMap` falls back to
Text for decimal. Emission now uses `xsd:double` (Vellum's Decimal wire type).
A question with ID `secret` also prevented actual CCZ export: the oracle's
whole-document name search mistook its instance-data node for a body control.

The shared XForm model now collects definition elements while stopping at
instance declarations, following Core `XFormParser::parseModel`'s separation
of saved instances from parsed markup. Both oracles use that inventory for
binds, controls, actions, output, and localization. Five new boundary scenarios
all fail with the original validators: actual CCZ compilation with colliding
question/group IDs; a fake nested instance declaration masking an unresolved
reference; missing-label references with empty or nonempty catalogs despite
decoy text in data; and exact malformed-markup findings beside identically
named valid answers. The empty-catalog early return also wrongly accepted
missing label definitions and is removed. Each synthetic refusal has a paired
accepted form. Namespace checks and repeat-template checks still inspect data
because those contracts apply there.

Validation: 300 tests across ten compiler, expander, capture, oracle, and fuzz
files pass; full TypeScript check passes. The full old oracle suites remain to
be reviewed as testing methods; running them here does not count as that audit.


### Structural path admission and focused reference tests

Removed the mixed `commcare.test.ts` suite. Its shell-factory checks mostly
asserted input echoes and isolated discriminator fields already exercised by
actual expansion and delivery. Identifier admission and reference projection
now have focused suites: exact retained names, denied syntax, reserved versus
ordinary spellings, literals versus parsed references, deduplication and
Search exclusion, full parent selectors with an explicit starting case,
attribute case IDs, and native regex matching for all metacharacters.

The previous answer-path regex admitted doubled/trailing slashes and segments
starting with digits. The replacement regression failed before repair;
`validateXFormPath` now delegates to the existing `FormPath` parser and narrows
its accepted values to non-root elements, preserving the previous refusal of
attributes and root-only paths. Removed the unused parallel regex. Corrected
the false claim that hyphens are invalid XML names: Nova deliberately supports
a narrower element-name vocabulary.

Rebuilt the full FormPath suite around independent expected segments and a
branching construction: original paths remain unchanged, attributes terminate
construction, parent paths can be extended, query-bound iteration projects the
real item step, and equality is symmetric across name/kind/length differences.
The prior parse/print-only cases could let both directions share the same bug.
Validation: 101 tests across seven path, projection, case, and capture suites
pass; full TypeScript check passes.

### Constructive compiler corpora and independent archive joins

Reviewed all four compiler fuzz suites and both complete generators. Removed
HQ-JSON's duplicate 400-sample expansion and binding resolution's duplicate
500-sample compilation. The remaining 500 field-tree and 400 workflow samples
each produce one expansion and archive, consumed by all five wire oracles plus
independent resource checks. Every sample now clears the strict persisted
BlueprintDoc schema as well as domain validation. The old semantic-only guard
accepted unsupported input slots on labels and hint/help media on captures.
Fixed those shapes at their constructive owner, removed all Field casts in
both generators, and added secret/barcode validation/default variation. No
counterexamples are filtered or parsed into a stripped replacement document.

Removed four fake manifests with empty buffers and repeated FNV hash text.
The shared evidence helper uses small real PNG, PCM WAV, and MP4 content with
actual SHA-256 hashes. Several asset IDs share content; archive checks assert
the exact deduplicated file set and bytes. A PNG fixture was verified by native
Sharp decoding during development; an initially invalid candidate was replaced
with Sharp-generated bytes before final validation.

The old binding harness paired entries and resources by index and did not
actually enforce the parent scope claimed in its parser comment. The new
strict-XML reader follows each xform resource's local location, reads that
archived form's main-instance namespace, and resolves the suite entry's form
namespace to it. Missing, duplicate, and orphaned identities fail. Optional
sessions on surveys remain legal. Markup words such as input/model/instance
now serve as question IDs, keeping instance-data versus definition scope in
the corpus. Sibling-pool exhaustion throws instead of modulo-wrapping into
silent duplicate IDs.

Every coverage floor lives in the same synchronous test as its census; no
shared counters, extra async wrapper, or separate order-dependent test remains.
Shrinking is enabled in both corpora. Temporary production corruptions proved
that emptying packaged media and changing entry form namespaces each fail both
corpora, with smaller counterexamples. Both corruptions were reverted. These
finite checks do not claim native CommCare execution or exhaustive validity.
Final validation: both corpora (900 samples total) plus independent question-wire and
scope regressions pass (four files, nine tests, 14.87 seconds); full TypeScript
check passes.

## HQ silently changed ordinary extension relationships

A strictly valid Nova registration exported an `OpenSubCaseAction` with
`relationship: extension`. Native HQ `Application.from_source` retained that
value, but `XForm._create_casexml` called `add_index_ref` without passing it and
emitted an ordinary child index. The local CCZ retained the extension index.
Existing tests asserted Nova's own output and missed this external transformation.

Extensions now use the existing source case-transaction emitter. Their HQ action
is retained with condition `never`: HQ still allocates its case ID and uses its
type for navigation, while the generated transaction receives `relevant=false()`.
The source transaction consumes that same ID. Removing the action entirely would
break links to the newly created extension. Repeated creates retain per-iteration
IDs and correct answer scope; source-created names become required, and property
writes retain presence guards. Scalar extension groups append after authored
operation/answer trees, preserving their position among submission effects.

The six strict-schema and semantic-validity export fixtures mix two extensions
with a child and cover registration, followup, ordinary repeats, query repeats,
multiple selected parents, and repeated entries under multiple selected parents. The native proof executes HQ import, case building,
datum allocation, and navigation matching at
`f391f622123f52c8943098d1228986f6999cddb8`, with network connections refused.
`scripts/fixtures/hq/README.md` contains the reproducible commands. This is native
HQ compilation evidence, not a claim of device or server submission execution.

The case-block unit suite was replaced with structurally scoped checks over
actual builder/meta output. It now checks byte-preserving no-op behavior,
selected-case identity and preload joins, unique merged name binds, guarded
writes, and exact child-close ownership/order. Repeated substring assertions,
apostrophe de-escaping, and fake hosts missing metadata or name questions were
removed. The rewrite also exposed the private owner preload reading an element
instead of `@owner_id`; this now matches native `XForm.add_case_preloads`.
Ordinary field-write admission does not currently produce an owner preload, so
this correction is not evidence of observed user data loss.

The native proof also fails under a negative control that re-enables HQ's
extension actions: registration has no disabled native transaction, so the proof
rejects the duplicate child path. The passing evidence records input and native
source hashes in `native-hq-case-emission.json`. The broader affected run passed
185 tests across 11 files, including both seeded corpora (900 documents); after
the private preload correction and case-block rewrite, the final focused run
passed 128 tests across five files after adding the combined repeat/selection case. Typecheck and strict Biome checks passed.

Adding captured files to the source-emission fixtures exposed an attribute-context
error: a repeated attachment's `@src` reused the expression anchored at its parent
element, so it stopped one level short of the answer. The shared emitter now
binds each expression from its actual target. The ordinary-repeat and query-repeat
examples failed before this correction, and the matrix now also covers repeated
entries under multiple selected parents. These are explicit wire-scope checks;
the native HQ proof preserves the source and does not evaluate JavaRosa XPath.

## Case-write tests use accepted documents and executable consumer evidence

The old question-path oracle checked a stored upstream fixture's byte count
and SHA-256 without invoking Nova. Its optional source searches depended on
a developer-specific checkout path. Those tests and the sole fixture are
removed. Their replacement exports accepted documents before and after real
question rename/move mutations, including identical cousin question names.

The old admission parity suite repeated the same shared tool body through a
mocked MCP writer. One module-less refusal started with an independently invalid
followup form (`NO_CASE_TYPE`). The replacement starts with valid documents,
checks the precise candidate refusal, asserts no persistence call, and compares
accepted committed state before driving real preview submissions. Nested query
iterations and two cousin repeat identities produce five distinct named child
effects; external IDs stay in scalar slots.

Worker-record tests now use strict, scoped XML and a separate valid browsing
module. The previous browse fixture placed forms on a `caseListOnly` module, a
shape authoring rejects. The new native HQ proof compiles the same accepted
survey/followup exports and compares all four worker-case binds, the lookup
datum and the entry assertion with the CCZ. A deliberately wrong local worker
ID fails the comparison. This establishes native emission, not device execution
or a persisted case submission. No production behavior changed in this batch.

## Capture evidence reaches native form entry and submission XML

The two old capture suites called case/meta helpers themselves and called that
output a CCZ form. Their child fixtures bypassed full admission; assertions
looked for global text fragments or compared Nova's own helper outputs. They are
replaced by one target/no-target matrix over accepted documents and real archive
output, plus native consumer execution of those same documents.

The producer supplies five capture scenarios: registration, followup, a user
repeat, a two-row query repeat and two selected cases. Native HQ imports and regenerates their case
and meta blocks. CommCare Core at
`8e9ba8d908e95f4dc71c9ade0467c6ebfbfbd305` opens both sets of forms, traverses
entry events, changes answers and relevance, and serializes the resulting form
instance. Native execution exposed four production defects:

- CCZ forms retained Vellum editor attributes. Core's null-namespace attribute
  lookup read `vellum:nodeset="#form/show"` before the executable `nodeset`,
  causing a parser failure. CCZ compilation now removes attributes by Vellum
  namespace identity, matching HQ's build transformation. Source editor
  metadata stays available to HQ.
- A hidden capture left its URL sibling relevant. Native calculation made it
  blank, so the case update cleared the old link. The sibling now follows the
  capture's relevance; the serialized hidden submission contains neither the
  URL update nor the file attachment. An active blank still serializes a clear.
- A followup preloaded a stored URL as the new upload's filename. Capture
  writers are now excluded from case preloads, matching Preview's existing
  projection. Scalar preloads remain intact.
- A followup creating children without parent updates omitted the parent case
  element, although every child index read its case ID. Native repeat entry
  failed while evaluating the missing parent reference. The local compiler now
  retains the empty primary transaction and selected case ID, as HQ does.

The native submission checks also prove that clearing the first query row leaves
the second row's URL intact and that every serialized child index names the
selected parent. They do not upload file bytes, send a submission or execute
server case transactions. `native-core-capture.json` records the passing report,
source hashes and exact input form hashes; the native HQ record includes these
capture transformations. Reproduction commands live with both proof harnesses.

The adjacent repeat suite also had a false clean-validation claim: its matrix
used the reserved case type `parent` and checked only two selected error codes.
Its rewrite uses accepted household/child documents, direct-child XML reads,
complete session datum lists and exact question-to-transaction binds. It covers
all three repeat modes, one/two child buckets, cousin question IDs and actual
noncontiguous action indices across root/repeat/root creates. It checks the
runtime repeat shape without requiring editor-only metadata in device output.


The final native run passes ten cases. The selected-case example additionally
proves shared filenames reach two distinct selected case IDs, blank shared values
preserve both records, and all-blank answers omit the entire ordinary transaction.
The batch-emission suite now reads strict source/archive trees, proving authored
operation/update/close ordering, scalar versus attachment routes, exact scoped
identity bindings, no scalar preload, and close preserving an earlier retype.
It verifies selection cardinality on actual expanded HQ details. Hand-decoding
entities, unscoped `indexOf` ordering and editor-shadow requirements are removed.

Validation: the final focused run passes 89 tests in five files; the native
Core run passes all ten cases, and native HQ checks all 13 exported scenarios.
Both wire corpora (900 documents total) and the other compiler consumers passed in the
broader run; its obsolete repeat/batch assertions were replaced and rerun.
Full typecheck, strict Biome checks and all recorded review hashes pass.

## Case-operation evidence reaches native case records

The old 1,063-line emitter suite used followup forms without case lists, wrote
undeclared properties on created cases, forced private selection options and
called Nova's own XPath evaluator to claim device parity. Its repeated keyed
create followed by updates is inadmissible: duplicate keys could interleave
Core's iteration order with HQ's per-case create ordering. The replacement
starts with an accepted generated-ID program before asserting that exact
admission refusal. Repeated keyed creates remain supported when no later
operation introduces the conflicting order.

The suite is replaced by scoped export checks for 12 strictly accepted documents.
Selection is authored through a real nested menu; the suite and form agree on
the child datum. Generated operations, create/update/index/close structure,
metadata paths, conditional dependencies, repeat-local identity and relation
bindings are checked in actual HQ source and CCZ artifacts. Duplicate ordinary
batch/capture tests move to their existing export suites; helper-produced XML is
no longer described as an exported app.

Native HQ imports and regenerates the same forms. Core opens both sets, uses its
native case instance over seeded `Case` records, finalizes and serializes the
forms, and applies them through `XmlFormRecordProcessor` and `CaseXmlParser`.
The 24 native cases check resulting records, including original snapshot reads
after an earlier submitted update, ordinary writes running last, inherited
create/retype conditions, candidate-relative relation filters with repeat-local
answers, distinct generated IDs and deliberate repeated authored-key merges.
Names, owners, external IDs and keys include nonbreaking whitespace, composed
and decomposed Unicode, and exact UTF-16 limits. Missing, wrong-type and self
links refuse in the native parser. A negative control disables the dynamic-link
guard; its missing-target test fails because the form becomes an accepted
unlink. No production behavior changed in this replacement.

Native in-memory application is not a rollback proof and does not execute HQ's
server case processor. The accompanying record captures the native source SHA,
all passing methods and form fingerprints. The ten capture cases also pass on
the regenerated corpus. No remote request or paid model call runs.

Validation: 21 focused tests in three files, all 34 native operation/capture
cases, full typecheck, strict Biome and recorded review hashes pass.

## XML evidence covers admission, decoding and native values

Native HQ rejected four source forms that Nova had accepted and exported: a
control character, NUL, an unpaired surrogate and U+FFFF. A separate accepted
Unicode document exposed two silent changes. Literal tab/LF/CR in XPath
attributes became spaces in native XML parsing. HTML parsing of C1 numeric
references changed their values to Windows-1252 display characters. Recovering
HTML parsers and the previous well-formedness check could not establish an XML
contract, even when both Nova's emitter and test helper agreed.

The wire boundary now uses namespace-aware SAXES parsing for both syntax and
DOM construction. The shared writer preserves XML attribute whitespace and
text carriage returns with character references, checks raw character values,
and leaves encoding to one boundary. The app validator refuses unsupported
characters in emitted definitions and translations through both shared mutation
gates. Purpose notes and other non-emitted metadata are outside that rule.
External lookup data remains editable; every export mode returns bounded,
column-specific findings before constructing either fixture XML or an HQ
workbook, including unsupported values in an unselected column. Profiles also
receive the strict XML check.

A 49-case syntax corpus covers character ranges, namespace scope, expanded
attribute duplicates and reference spellings in comments/CDATA. Native HQ's
libxml independently checks 47 cases; Nova's explicit DTD/XML 1.1 policy accounts
for the other two. Historical source artifacts reproduce the four native
refusals. The accepted document passes native HQ import/regeneration and two
Core runtime tests which inspect the initialized answer and worker prompt.
The native case corpus was regenerated after the writer change: all 25 HQ
scenarios and 34 Core case-operation/capture tests pass.

The gate suite also loses its source-regex union check, fixed classification
counts and code-prefix oracle imitation. Typed exhaustiveness remains a
compiler check. Its behavioral tests establish strict valid baselines, complete
candidate refusal, atomic complete-form acceptance, repair, cross-module writer
findings and the actual media boundary difference. A deliberate legacy shape
still exercises the defensive shape gate. The old 20-second timing test used
an invalid app and would pass a no-op validator. Its replacement validates an
admissible 3,000-field app, then requires the exact broken reference at the final
field. Runtime belongs in measured suite results, not a permissive wall-clock
assertion that says nothing about completed work.

Validation: 114 focused XML/gate/export cases pass; the large-app test passes in
one second. The broader compiler/parser consumers and both wire corpora (900 documents total) also pass after replacing the obsolete classification assertions.
Native evidence records source identities, actual exported bytes and the limits
of each proof. No remote submission or paid model call runs.

## Tile evidence uses native regenerated details

Two fragment-parser suites and a redundant partial HQ projection suite are
replaced by one set of admitted document
scenarios shared with real HQ regeneration and Core parsing. Eight documents
cover row and tile layouts, visible borders/shading, hidden retained geometry
and sort, grouping at two depths, Search, persistent details and a formless
case-list browser. The local test inspects the complete relevant fields and
session datum scopes from the archive and the actual HQ export; preview checks
use production state projections without a synthetic DOM. The redundant custom
HTML parser helpers and group-only suite are removed. A formerly positive
unplaced-visible-column fixture bypassed admissibility; it no longer serves as
evidence for a delivered app.

Native HQ imports the actual exported JSON and runs `DetailContributor`. Core's
real `SuiteParser` reads all eight local suites and eight HQ detail artifacts,
then assertions inspect native dimensions, inherited/explicit style, hidden
sorting, group header depth and local navigation datums. A formerly asserted
fact was false: native HQ can append its Search action after the group, whereas
Nova appends the group last. Core accepts both. Tests and contracts now describe
consumed values instead of pinning that incidental order. No production behavior
changed, and the evidence does not claim a full HQ build or rendered UI.

Validation: 11 focused tile checks, eight native HQ comparisons and 16 native
Core parser/model cases pass. Both generated-app corpora (900 documents) pass
with the shared independent namespace-aware XML reader. Full typecheck and
strict formatting pass. No production behavior changes in this batch.

## Compiler integration no longer skips its external contract

The 2,733-line compiler file is replaced with admitted archive/navigation
scenarios. Developer-specific HQ fixture directories, copied fixture self-hashes,
an empty-form scaffold presented as a deliverable, and an unavailable case
condition disappear. Existing native case/tile suites and the 900-document
resource corpus own their complete contracts instead of being duplicated here.
The new cases check profile resource resolution, distinct installation IDs and
sequence values, post-injection refusal, module/form condition scopes, owner
availability without Search, conditional form links, and complete prompt/query
joins across the two exports.

The same eight valid documents feed actual native HQ import and 11 regenerated
forms. Core initializes both form paths and proves that stored case values,
including blank, win over an authored starting value. Its real case processor
stores an ordinary registration external ID as the normalized scalar. The suite
parser's actual condition and frame models evaluate role/case conditions and
link/fallback selection. Native case nodes prove owner token normalization and
preservation of unassigned cases. Core also evaluates the exact Search data
expressions with supplied and absent prompt nodes, and writes ten actual CSQL
payloads. HQ's native CSQL compiler accepts those payloads and produces the
complete independently specified filters: seven days after leap day, one hour
after UTC midnight, and inclusive-start/exclusive-end date, custom datetime
and indexed creation-time ranges. A property wrapped in `date()` is the rejected
negative control. This proves query compilation, not Elasticsearch execution.

Validation: 10 focused compiler cases, six native execution methods, 11 native
HQ forms and ten native CSQL payloads pass. Typecheck passes. No production
behavior changed in this replacement.

## Session tests now state their actual boundary

The old 1,022-line session suite duplicated compiler, repeat, case and tile
coverage while supplying partial actions and impossible authoring states. Its
repeat-index test never emitted a later non-repeat action, so it could not
observe the index it claimed to prove. The accepted root/repeat/root export
case already checks that allocation and its actual XForm references.

The replacement isolates internal projection contracts: each instance-bearing
slot, combined form/browse dependencies, unanswered Search substitution,
projected query data, fallback destinations and explicit root-reset precedence.
It reads decoded XML values instead of serializer spelling. Two string-render
production adapters with no caller except the deleted test code are removed.
Navigation-condition tests now pair HQ and local expression projections and
exercise a nondefault selected datum. They no longer call a string comparison
a proof of absent-node runtime semantics; native navigation evidence owns the
existing runtime checks.

Validation: 42 focused session, condition, compiler and repeat cases pass.

## Search tests now exercise the consuming engines

The inline, claim and remote-request suites used partial HQ objects, invalid
case-type fixtures, serialized fragment goldens and a comparator that erased
all text and namespaces. They could pass without a deliverable app, and did not
prove that a claim or query evaluated correctly. They are replaced by twelve
complete admitted apps, artifact joins and actual native HQ regeneration of
entry/remote-request trees. The platform unit tests now cover the authored
Search-first choice and all visible/hidden/no-input combinations across both
platforms. The related-expression classifier remains a small private projection
test; native detail execution separately proves the consumer behavior.

The consumer proof found a production defect in an accepted explicit form link
from registration into Search. Both old exports emitted a hydration query that
read the destination's selected-case datum before the subsequent manual frame
assignment. Core evaluates every step against the source context, so both old
artifacts raise `XPathTypeMismatchException`. The projection now selects HQ's
automatic matching path when every non-query step is identical to the author's
explicit mapping. The authored document is unchanged, and both outputs fetch
the newly created case. A manual mapping that cannot hydrate that same intended
case is refused by both shared mutation gates with
`FORM_LINK_SEARCH_CASE_UNREPRESENTABLE`; ordinary list destinations still accept
manual selections. Public form-link guidance explains the supported paths.

Seven native Core methods now evaluate actual entity nodesets, supporting-parent
detail templates, case-claim parameter exclusion/relevance, query defaults,
answer changes/clearing and automatic/hidden searches on both exports. The query
manager itself creates virtual inputs. Parent and multiple claims include only
missing cases; inline selection excludes closed cases while remote Search
preserves HQ's different status behavior. Retained pre-fix suites are failing
native negative controls. The proof does not send HTTP requests, install app
resources, render Android/Web Apps or establish transaction rollback.

The full native HQ comparison passes for twelve scenarios. It records two exact
differences rather than hiding them: an explicit HQ unfiltered `match-all()` and
an unused Nova collection-instance declaration. Core consumes both original
versions. Reproduction commands and hashed records accompany the proof.

Validation: 89 focused checks across eight files, twelve native HQ comparisons
and seven native Core methods pass. Full typecheck and strict Biome checks pass.

## Search-session composition is tested as composition

The 1,572-line session test treated XML entity spelling and repeated string
fragments as acceptance. It reused the production XPath lowerer to manufacture
an expected owner filter, and one ordering test never asserted the first
position its title claimed. The complete Search export/native evidence now
owns session acceptance. The replacement keeps private contracts: typed filter
composition and identity, an intact OR clause, explicit matcher routing, one
related-case quantifier containing both date bounds, dependency collection,
locale joins, detail-confirm omission and explicit compiler-bypass refusals.
Every positive fixture passes the document schema and full validation before
its configuration reaches the private function. A test-only string adapter is
removed from production.

Validation: 36 session and full Search export checks pass; full typecheck passes.
No emitted behavior changes in this replacement.

## Search prompt acceptance uses real answer state

The 1,499-line prompt suite called adapted string fragments an HQ acceptance
proof. Several fixtures bypassed domain typing or lookup admission. The
1,322-line integration suite repeated private and XML checks, filtered out
validator findings, and mocked persistence although its useful tool path only
needed an in-memory workspace. Both suites are replaced. Private checks retain
complete widget metadata, stable translation sources, dependency routing and
internal refusal behavior; the integration sequence now edits both clusters in
both orders, compiles the admitted result and clears only the requested cluster.
The production string adapter and test-only quote-message export are removed.

Three fully admitted app fixtures cover all visible widget kinds, hidden values,
conditional required fields, combined author/CSQL validation, filtered lookup
choices, calendar/count/location guards, table-lookup query values and computed
text spanning two prompts. Native HQ regenerates complete entries and remote
requests with no differences. Four Core methods consume both original exports:
they prove error transitions, defaults, labels, repeated multi-select parameters,
removal of unavailable choices, independent location errors and joint errors
when otherwise valid answers combine both quote delimiters. The native query
manager owns the virtual input instance; no copied evaluator decides validity.

Validation: 47 focused checks across four files, three native HQ comparisons and
four native Core methods pass. Full typecheck passes. These are engine and
artifact checks, not rendered widgets, HTTP requests or server search results.

## Runtime dependency analyses retain their private boundary

The CSQL byte-flow tests now distinguish native function arguments from already
converted device outputs, exercise concat/coalesce/switch and conditional output
unions, and prove identity-based name resolution. Duplicate partial-config
composition checks move to the admitted prompt corpus. The dialect walk retains
its structural role, including unsupported device descendants that validation
must find; partial containment checks now assert the entire visit sequence.
Fourteen focused checks pass. Neither helper suite claims native execution.

## Nested CSQL expressions need a complete context and native parsing

The expression suite parsed handwritten sample strings instead of emitted
payloads and built expected runtime segments with the production quoting helper.
The predicate suite repeatedly pinned fragments from schema-invalid apps,
including unsupported property/function positions; its purported idempotence
check merely called the same emitter twice. Both methods are replaced by small
private composition checks, fully admitted positive predicate examples and a
native chain from complete app exports to real query values and HQ compilation.

A validated lookup value inside `date`, `datetime`, `double`, or date arithmetic
failed export because native function arguments dropped lookup naming while the
direct runtime-operand path preserved it. Both paths now share one runtime
emission context. The accepted regression failed before the fix at the actual
export boundary, not through an intentionally missing-context test.

Native HQ compilation then found a second defect: its pinned eulxml 1.1.3 lexer
omits COMMA from OPERATOR_FORCERS. A nested quantity function immediately after a
comma is tokenized as a path and rejected. Explicit argument grouping preserves
the authored expression and is shared by date quantities, matcher values and
relation/count filters. The ungrouped quantity remains a negative native control.

Two admitted apps pass native HQ entry regeneration and two Core methods on both
export paths. Twenty Core-evaluated lookup payloads produce complete expected HQ
filters, including the leap-day result and a session-dependent conditional.
Twelve additional payloads preserve the complete native argument AST, including
typed ancestor chains, child counts and a nested fuzzy-date value. Relation AST
checks do not execute Elasticsearch or resolve remote case IDs. Records are in
`native-hq-functions.json`, `native-core-functions.json`, and
`native-csql-functions.json`.

The broader related unit run passed 6,058 checks across 484 files and failed 20
checks in four pending suites: 19 use stale organization-hook mocks, and one
finds three validator codes missing user-facing messages. These remain audit
work; this batch does not claim a passing full suite.

## Validator findings must carry their repair into the Builder

The wider compiler dependency check found three findings added during this audit
without Builder messages. The optional renderer table let them reach its generic
internal-failure fallback. Classification now retains literal types and the
renderer requires every non-oracle code at compile time, forbidding oracle copy.
The test-only message-key export and its introspection tests are removed.

Text findings also lacked the display metadata their repair needs. App text now
carries its content label; lookup cells carry table and column labels. Existing
real gate/export tests render those findings and the refused Search handover,
while the copy suite exercises every code with missing and populated details,
internal fallbacks, ordered lists and withheld choices. All 130 checks across
four files and full typecheck pass. The 19 stale organization UI-mock failures
from the broader run remain part of the pending method redesign.

## Quoting evidence must execute the original program

The runtime suite replaced input-node expressions and their presence checks
with literals before calling Nova's preview evaluator. That simulated program
hid the difference between an absent node and an explicitly empty answer; its
injection checks only looked for the original string inside the output. The
whole suite is removed. A new fully admitted app supplies six query shapes to
Core's actual query manager, followed by native HQ compilation of the complete
resulting queries. Ordinary CI checks its complete export joins.

Twelve answer states on each export path produce 144 native queries. HQ compiles
130 to independently expected complete filters and refuses 14 unsafe whole
queries. The corpus includes negation, OR, nested presence, adversarial quote
text, Unicode/newlines, values combining both delimiters, clearing and an unused
conditional branch. Prompt-error ownership is checked separately from raw-query
refusal. No runtime quoting production defect was found by this replacement.

The lexical suite is reduced to explicit per-dialect examples and decimal
round-trip properties over finite IEEE values, including extremes and 2,000
seeded samples. The identifier identity helper, its export and tests are removed;
actual property-to-attribute mapping remains owned and tested by casePropertyWire.
Native source/artifact evidence is recorded in `native-{hq,core,csql}-quotes.json`.

Validation: 70 focused checks across six files, including the 2,000-sample
numeric property, and full typecheck pass. Native HQ regenerates the complete
entry and remote-request trees with no differences.

## Static search branches must use emitted runtime equality

The representability analyzer used JavaScript strict equality to select fixed
`if` and `switch` branches. Core receives null literals as empty text and compares
numbers with an absolute tolerance below 1e-12. Four conditions in a schema-valid
app were consequently judged to skip a fixed unquotable value even
though Core selected it. A fully validated four-query app exported at `06f097e1`
produced four `search-value-mixes-quote-marks()` refusal values through the actual
query manager. The retained suite is the native negative control.

Static equality now normalizes the emitted literal forms, uses Core's numeric
tolerance, and leaves mixed numeric/text conversion unknown. A switch cannot skip
an unknown earlier match in favor of a later known one. The full validator now
returns the four authored-path quote findings; the safe counterpart passes all
validation and produces four exact `first_name = "safe"` queries on both local
and HQ-regenerated suites. Native HQ compares the complete entry and remote
request with no differences. No server search or Android rendering is claimed.

The entire representability test method is replaced. Removed context-free
claims of whole-app acceptance, partial issue matches that could hide extra
findings, a large predicate inventory labeled as universal coverage, and
redundant runtime-value examples already covered by native corpora. The private
contract now asserts complete ordered diagnostic paths, distinct row scopes,
calendar/count bounds, reachable quote branches, conservative unknown equality,
and all six recursive comparison reversals without mutating the authored AST.
Full admission and native execution are established separately.

Validation: the new admission regression fails against the previous production
source, which returns no findings. All 116 related tests pass with the fix, as
does full typecheck. Two native Core methods and the complete native HQ comparison
pass; `native-{core,hq}-static-quotes.json` records sources and exact artifacts.

## Relation operators require instances even without property leaves

The dependency collector walked leaves and lookup nodes, so an unfiltered
related count or existence test contributed no `casedb` dependency. A fully
schema-valid, admitted followup form at `bffd10f7` wrote a related visit count
but declared only the session instance. Native Core raised
`XPathMissingInstanceException` for `casedb` during form initialization.

The collector now includes non-self count, exists and missing nodes through
both AST families, including predicates inside calculated values. Self-only
constant relations add no external instance. Lookup diagnostics also describe
all compile boundaries; their old text incorrectly claimed only CCZ could
carry tables. Four independently admitted forms each have one relation consumer,
so another property read cannot mask a missing dependency. Their complete
instance declarations are checked in source and local forms. Native HQ
regenerates them, and Core opens and submits all four on both carriers with
zero and two matching children, unrelated children and a wrong-type row. The
resulting case values agree; the retained pre-fix form still fails on opening.
This establishes native case processing, not server rollback or Android UI.

The whole collector test method is replaced with structural union contracts,
scoped lookup names, nested cross-family traversal, every term dependency,
property-free relation dependencies, self-only controls, and exact known/refused
source mappings. Branded identities and revisions go through their real parsers.
The suite explicitly separates structural collection from full admission and
native execution, recorded in `native-{core,hq}-relation-instances.json`.

Validation: 59 focused tests and full typecheck pass. Five native relation
methods pass, including 16 complete current form submissions. The existing
25-scenario HQ corpus and 34 Core capture/operation methods also pass on fresh
exports. The wider unit import graph completes 493 files in 176 seconds: 490
pass; 19 tests in three pending simulated-DOM suites fail because their
organization-hook mock lacks `useOrganizationRuleInputs`. Those suites remain
part of the method redesign; the broader run is not recorded as green.

## Organization owner and persona editor evidence

Removed both entire simulated-DOM owner/persona suites. Their broad hook mocks
had already drifted from production, and the persona removal test supplied its
own business verdict based on a fixture identity. The replacement uses the
actual production owner-mode transitions and persona assignment projection and
planner, with real organization footprint/refusal rules. It distinguishes
incomplete catalog reads from missing assignments, tracks staged ownership
against peer replacements, checks complete ordered assignment proposals and
page selection, and evaluates removal candidates only on the visible page.
The component applies page and main-row focus changes only after the document
mutation succeeds.

Seventeen state tests and full typecheck pass. The existing production-build
browser organization journey passes without retries in 15.3 seconds, including
assignment ordering, removal focus, fixed/reverse ownership, save and reload.
That browser result proves the exercised interactions, not an absence of server
faults: its log repeatedly reports usercase row synchronization attempted with
no materialized `commcare-user` schema. That newly observed ordering/materialization
issue remains under investigation. The broader Places suite still needs its
whole-method review; this batch does not claim all organization tests are green.

## Worker schemas were missing at birth and late during worker edits

The production organization browser journey passed its interaction assertions
but emitted repeated `usercase row sync failed` warnings. Tracing its canonical
blank-app birth found that genesis returned early when no authored case types
existed. Even case-bearing genesis iterated only authored types, omitting the
built-in worker schema that `buildCaseTypeMap` supplies. Separately,
`applyBlueprintChange` synchronized worker rows before its schema sweep, so a
batch that added worker information and a persona value attempted the value
against an absent or outdated schema.

The prior database tests installed their own schema and cast a partial,
invalid-identity fixture to `PersistableDoc`. That setup bypassed both defects.
The whole method now creates a canonical app, commits real persona/catalog
mutations with migrated auth constraints, and observes stored rows through the
production factories and authorization callbacks. Its six tests cover schema
sequence, same-batch values, rename/close, runtime-value preservation on
ensure-only reads, physical `xmin` idempotence, worker restore scope, exact
storage refusal without partial changes, and complete genesis rollback when a
Postgres trigger refuses worker-schema admission. These are stored lifecycle
claims, not HQ or form-submission execution claims.

All six tests failed at `0f5d6776`. Installing the built-in schema at genesis
made three pass while the same-batch row writes still failed. Moving schema
synchronization ahead of the worker sweep resolved that independent failure.
Genesis now iterates the complete storable map, including the built-in type on
survey-only apps. Worker-only commits still run their row sweep. The pure
worker-selection suite is also wholly replaced with typed collection snapshots,
complete write inputs, real default/override distinctions, catalog changes and
separate replacement identities; it makes no query-count claim.

App-state test setup now routes case-store connections to the same isolated
Postgres handle. The three independent streaming fixtures do the same, and the
privilege test routes each genesis to its actual migration/runtime role.
Production factories and authorization remain active. The design-genesis test
checks both authored and built-in schema rows at sequence one; its remaining
whole-method review is still pending.

Validation: six lifecycle and five projection tests pass, as does full
typecheck. The broad affected database run passed 99 suites and exposed only
three fixtures missing the new connection wiring; all 63 tests in those three
pass after correction. The affected unit graph passes 167 files / 2,019 tests.
The production-build organization journey passes without retries in 14.8 seconds
and emits no worker-schema warnings. No existing production database was changed.

## Organization queue evidence belongs to the production client

The whole three-test organization hook suite rendered React while replacing
all actions and the reconciler; it checked only failure-message fragments. It
could not establish the write serialization that Places recovery relies on.
The state now lives in `organizationClient.ts`, with a thin subscribed React
adapter. Twenty programmatic cases drive that actual client through complete
read outcomes, superseded successes and failures, all four queued writers,
revision strings beyond JavaScript's safe integer range, all Blueprint barrier
refusals, the single allowed retry, a conflict-held successor, transport errors,
and the complete archive result projection.

The client starts post-write refresh inside the queue and performs one conflict
refresh. View cleanup invalidates reads and suppresses notifications while
already-requested saves finish against their original app and captured
reconciler. Tests separately exercise a conflict refresh needed by queued work
after navigation, and effect cleanup/reactivation. Controlled action results
prove the client protocol only, not row validity or database atomicity.

The old three hook tests passed against the extracted adapter before removal.
The final 20 state cases pass in 5 ms with no DOM environment; full typecheck
and strict Biome pass. The real production-build organization journey passes
without retries in 17.8 seconds, including persisted place edits, assignments,
owner controls, and reloads, with no worker-schema warnings. The full Places
draft recovery method is still being redesigned; its unrelated mock failures
are not hidden or counted as passing.

## Place drafts use actual state and feasible write order

Removed the whole 647-line simulated-DOM Places suite. One test resolved a
second retype before an earlier custom-value write, although the production
organization writer serializes those requests. The component's repeated
scalar clocks, draft refs, response-chain handling, and peer recovery now live
in the actual `placeDraft` owner. Twenty-one state cases use that owner with
the real organization client queue; only typed Server Action replies are
controlled. The React component lost nearly 900 lines of duplicated state and
handlers. These tests prove editing and client request semantics, not server
admission of the controlled rows.

Coverage observes complete scalar/custom-value/placement drafts, exact patches,
queued reverts, server normalization, peer recovery, late old receipts,
per-field rebasing, scoped values, and explicit recovery of unavailable drafts.
Returning to an original level with a changed value bag keeps an apply action
and draft protection. The neighboring helper suite now tests real catalog,
identity, completeness, and branched reverse-owner projections; six redundant
state wrappers are gone. Tree tests inspect exact identities, deep traversal,
diagnostic disconnected/cyclic rows, and same-projection page selection rather
than claiming a pure slice calculation mounts anything.

A browser experiment holding an actual committed action response ruled out a
suspected stream-read-before-receipt sequence in this flow: Next's action queue
holds the read behind the pending action. That experiment's route cleanup was
also corrected to await fulfillment before removing the handler. The retained
browser scenario continues typing during the held response and verifies the
newer draft survives its receipt and refresh. It passes against both the prior
component and the extracted owner. The original 12 simulated tests also passed
against the extraction after a temporary mock repair, before their removal.

The affected unit graph passes eight files / 129 tests; the production-build
organization journey passes without retries in 15.6 seconds, including actual
peer edits, archive, ownership, persistence, focus and layout. Its server log
nevertheless records a reconciler reload GET failing as a document reload
starts. That report was missed by the browser event guard and remains an
explicit next investigation, not an error-free browser result.

### Document teardown, browser evidence, and reconciler response ownership

The organization journey's previously recorded reload error came from native
navigation: `pagehide` preceded rejection of an in-flight GET, while React effect
cleanup did not run. The resulting beacon reached the HTTP server but not
Playwright page/context request events, console events, or a separate CDP network
observer. A live-document routed beacon had therefore left a real guard gap.

Replaced that guard method with live-event detail plus a synchronous per-page
transport marker that survives document teardown. The observer forwards the
original native beacon/fetch call and preserves delivery. Assertions read the
context after page close and before context close. Multiplayer teardown now
settles every page guard and closes every context, including the revoked member.
Five native Chromium/local-HTTP tests prove beacon and keepalive-fetch delivery
and detection across reload/close, live exception/console/report/5xx channels,
origin scope, and isolation between pages sharing localStorage. The old guard,
with only its assertion signature adapted to async, fails all four teardown
negative controls while retaining the live-error test.

The runtime now cancels its owned reload on suspension, classifies only that
controller's cancellation as `interrupted`, and preserves the reload barrier and
queued edits. Restart waits for outstanding authorization before reopening the
stream. Native `pagehide` owns full-document suspension; a persisted `pageshow`
requests fresh authorization. An unrelated exception named `AbortError` remains
an observed failure. Browser/history effects are explicit adapters, so the whole
runtime suite now runs in Node without happy-dom; manifests, presence rows and
persisted documents are schema admitted instead of cast into existence.

Real loopback GET tests interrupt headers and partial bodies, restart both before
and after the rejection, retain the actual admitted edit queue through viewer
reauthorization, and open exactly one replacement stream at the new cursor.
They use the existing owned socket peer. A separate minimal native Node PUT
experiment showed an unresolved internal `ReadableStream.tee` promise even after
response consumption, dispatcher destruction, server closure, and a subsequent
event-loop turn. That was not an open connection; the retained Node transport
checks focus on GET lifetime, while production-browser journeys cover saves.

Whole-runtime review also reproduced two protocol defects. A 200 with a zero,
negative, fractional or unsafe cursor could be accepted as saved; low cursors
could retire an unsaved human batch. The adapter now requires a positive safe
integer and retains the batch for retry otherwise. A retired presence request's
404 could start a new reload after a Project handoff; every outcome now checks
its ownership generation and epoch before changing current state. Both defects
failed their state-based negative controls before the production corrections.

The focused state/transport run passes 97 tests with no reported async leaks.
The production organization journey plus both multiplayer suites and the five
native guard contracts pass 18 browser checks without retries or client error
reports. Full Chromium could retain a simple page, but the actual Builder
reported `MainResourceHasCacheControlNoStore`,
`JsNetworkRequestReceivedCacheControlNoStoreResource` and
`CacheControlNoStoreHTTPOnlyCookieModified`; it performed a fresh Back navigation.
No cache policy was changed to manufacture a retained-Builder proof. A native
Back-navigation role journey also passes in 2.1 seconds; actual Builder BFCache restoration
remains unproven for this artifact, distinct from the programmatic resumable-state
proof. Ordinary CI continues to use headless shell.

### Build XML consumption is bounded before buffering

The released-build reader previously called `response.text()` before checking
20,000,000 JavaScript characters. Native HTTP negative controls reproduced both
defects: a 20,000,001-byte multibyte XML document was accepted, and oversized plain
and gzip responses waited for the peer to end before refusing. The reader now
counts decompressed body bytes while consuming chunks, preserves streaming UTF-8
decoding, and cancels immediately above the byte limit. Its existing deadline
still owns the complete read. Callers retain semantic XML validation.

The exact-limit multibyte document survives unchanged; the extra byte refuses.
Both oversized streaming peers observe connection closure before sending their
terminal response, and an unfinished native XML body closes at the 30-second
deadline. The unchanged reader fails three of these controls. These are actual
HTTP socket proofs with a test-only hostname remap, without TLS or live HQ.

### Setup guidance follows the current document

Replaced the whole setup-artifact suite's cast documents and isolated phrase
checks with schema admission, full validation, immutable input assertions and
complete branch projections. Current local HQ source confirms the named controls,
hidden-column behavior, include-only precedence and whole-list save refusal.
The suite covers both automation routes, current worker/place field definitions,
live place counts and partial/adopted pushes, named destination presence, and
Preview's unambiguous Project-space projection.

Four negative controls reproduced ignored authored ordering in worker fields,
automations and organization branches, plus name-based place-summary identities
and row-arrival ordering. Those sections now use the canonical ordered selectors;
organization instructions and place totals share a parent-before-child order,
and a renamed level keeps its summary identity. Duplicate level names were a
discarded hypothesis: the full validator already rejects them, so no invalid
document is used to claim a reachable name collision. Regeneration is proven as
a document projection; neither HTTP execution nor manually applied HQ settings
are claimed by this suite.

### Deployment observations identify accepted pushes independently of time

The native store test reproduced a stale observation landing after two publishes
shared one millisecond. The former suite rewound the first timestamp with SQL,
which prevented the collision it needed to investigate. The store now compares
a UUID assigned by Postgres to every accepted mapping write. Identical source
revisions and remote ids do not collapse distinct acknowledgements. The trigger
covers old writers too; observation-only updates preserve the token.

The full store review replaced sequential uniqueness claims with blocked native
writers, added exact constraint identities and whole-batch rollback after a
second-resource failure, and proved fresh push identity and membership after
real lock contention. Those tests use the actual auth migration schema and
explicitly permit multiple connections. A first contention fixture mistakenly
queued a read behind its own sole blocked connection; it was corrected at the
fixture boundary, without timeout increases. Migration tests start before the
new migration, preserve both active and historical rows, and exercise same-value
legacy updates. Restricted runtime-role verification executes the trigger after
privilege convergence; the internal function is included in the exact routine
inventory. The timestamp remains an honest time, never an identity surrogate.

### Domain schemas are exercised as admission boundaries

Removed numeric source-string assertions and duplicate field metadata suites.
Number tests now execute every shared range, real JSON round trips and nested
literal/sort/tile/automation consumers. UUID tests execute the exported schema
patterns against accepted and rejected identities instead of matching a pattern
prefix. Catalog tests cover every icon's identity and family; actual PNG hashes
and sizes remain owned by the media bridge's complete shipped-asset test.

Field schema fixtures cover every field kind and all three repeat modes, with
admitted controls before single-property refusals. This exposed an inherited
property lookup in candidate projection: `constructor`, `__proto__`, and
`toString` selected prototype members as repeat key sets and threw before schema
admission. Three negative controls fail with `allowedKeys.has is not a function`.
The projection now requires own membership and carries an unknown mode through
to an ordinary schema refusal. This is a candidate-processing totality fix;
typed, admitted repeat modes retain their existing behavior.


### Source inspection proves source rules only

Removed the copied mutation-lifecycle inventory, retired-token and identity-text
scans, and Connect source-string checks. Replacing those scans with AST parsing
would still not prove admission, commit, or restoration. The Connect API
ownership assertions now run in TypeScript, and generic form helper tests apply
real mutations to prove extra Connect properties cannot install participation.
Existing builder and session execution tests own refusal and exact restoration;
those larger suites remain subject to their separate full review.

The shared mutation result type now preserves an admitted batch or permits a
statically empty no-change array. The archive service already returns an admitted
batch and now retains its type. The case-selection no-change branch exposes an
empty value explicitly. Compiler negative controls reject the old raw-array
return type; runtime admission tests remain the evidence for parsing and
immutability. This does not make the admission brand proof of persistence.

One architectural source rule remains: static imports cannot reach inside the
frozen migration package from ordinary runtime code. It now reads parsed module
specifiers, including relative imports, exports, import types, and loaders;
comments and quoted examples are not imports. Positive and negative fixtures
exercise the rule itself. Parsing uses one owned compiler process without the
application import/type graph, and malformed-source cleanup is exercised too.
