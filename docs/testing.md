# Testing Nova

A test earns its cost by catching a plausible defect. Name the behavior and the
failure it prevents before writing it. Existing tests are examples to evaluate,
not templates to copy blindly.

## Design the evidence before the test

Start from the production contract and a plausible failure, not from an existing
test file. Decide which observation would distinguish correct behavior from that
failure, then choose the smallest boundary that can provide it. A passing mock,
a title that matches its assertions, and a coverage percentage do not establish
that the chosen boundary proves anything useful.

Apply that reasoning to every testing method. Database isolation needs competing
transactions and committed rows in Postgres; emitted wire needs independent
consumers or format oracles; service integration needs the real adapter reading
a controlled external response; state transitions need actual production state
logic; browser interaction needs the application running in a browser. A test
must not supply the implementation's answer through its own fixture or mock.

Reconsider the surrounding test design as well: repeated scenarios, shared
fixtures, setup cost, dependency substitution, missing failure paths, and cleanup.
Remove an entire suite when it has no independent purpose. Replace a helper or
library when it forces misleading tests. Extract production state logic when
rendering a component is currently the only way to exercise a domain rule; do not
build a separate test-only imitation of that logic. Retaining fewer, decisive
tests is preferable to preserving the shape or count of the previous suite.

## Choose the boundary

- Pure domain rules, reducers, parsers, and state transitions: call the real
  function with representative valid, invalid, and boundary inputs.
- SQL semantics, tenancy, transactions, locks, constraints, migrations: use real
  Postgres. Mocking the query builder cannot prove these contracts.
- User interactions, focus, layout, browser APIs, and hydration: use Playwright
  against the production build. Test component logic through its production state model.
- Build and deployment configuration: parse its format and inspect the execution
  graph or artifact declarations. Execute authored scripts with controlled
  external executables to prove arguments, failure stops, and cleanup; source
  substring checks cannot establish those behaviors.
- External services: replace the network boundary with a controlled response;
  retain the real code that interprets it. Never spend on model calls by default.

For native Node `fetch`, the controlled peer must cover the dispatch path that
Node actually uses. `__tests__/helpers/httpPeer.ts` supplies an Undici Agent factory
that resolves every connection key to a mock transport. Its regression test
proves both interception and refusal of unmatched destinations without DNS.
Assert consumed replies and request history, since a production client may
catch an unexpected request failure and turn it into a normal refusal result.

For XML wire structure, validate syntax before reading a parsed tree, then
assert the relationships the consumer follows: control to answer bind, label to
translation, and archive entry to emitted form. Expected wire types come from
upstream consumer contracts, not Nova's emitter tables. `questionWire.test.ts`
checks HQ source and unpacked CCZ; `xformDefinitionScope.test.ts` distinguishes
form markup from answer data and pairs each refusal with an accepted form.
These structural checks do not claim to execute CommCare itself.

For transformations performed by an external compiler, exercise that compiler
against actual exported artifacts when its behavior matters. The read-only proof
in `scripts/fixtures/hq/` caught HQ accepting an extension relationship and then
silently compiling it as a child. It checks the corrected import/build and
navigation paths using native HQ classes with all socket connections refused.
The accompanying export tests run in ordinary CI; the native proof requires an
installed HQ environment. It also reads
accepted worker-write exports through native HQ case, datum and assertion
builders. Fixture hashes and optional source searches in developer checkouts
are not substitutes for running a consumer against Nova output.

Runtime claims need runtime execution. The capture proof in
`scripts/fixtures/javarosa/` opens actual CCZ and HQ-regenerated forms in the
pinned CommCare Core checkout, traverses native form-entry events, enters
answers, changes relevance and clears one repeat member. It inspects both XPath
results and serialized submission XML. This exposed editor-shadow parsing,
hidden URL overwrites, capture preloads and missing parent IDs that structural
checks had accepted. No remote submission or attachment upload runs.

The case-operation proof also reads native `CaseInstanceTreeElement` data and
applies finalized submissions through Core's `CaseXmlParser` to indexed
in-memory storage. It checks stored records, repeat correlation, snapshot reads,
conditional dependencies, link rejection and scalar/identity bounds. A disabled
link guard makes the negative control fail by accepting a missing target.
Evaluating an emitted XPath with Nova's own evaluator does not establish device
parity. Native in-memory application is also not a transaction rollback test;
Postgres atomicity and HQ server processing require their own evidence.

Case-write admission tests start with a fully accepted document and prove that
a refusal reaches no persistence host. The shared tool body is tested once;
invoking it twice behind different stubs does not establish SA/MCP transport
parity. Accepted results feed the real preview engine and export paths, with
query iterations, cousin repeats, scalar routing and actual gated identity
edits. Persistence and transport contracts remain separate tests.

Generated corpora must pass the actual strict schema as well as semantic
validation; TypeScript casts and a domain-rule pass cannot establish schema
validity. Construct admissible values at the generator, without filtering or
parse-and-strip repairs. Share expensive compilation when multiple properties
consume the same samples. Keep coverage thresholds in the test that gathers
them and enable counterexample shrinking. The two compiler corpora share one
expansion/archive per sample, then check all wire surfaces, form identity joins,
and the complete bundled media bytes. Finite samples establish regressions,
not exhaustive validity or native consumer acceptance.

Do not pin incidental strings, source formatting, CSS class lists, or mock call
sequences unless that exact value or order is the external contract. A test that
restates its fixture, snapshots an implementation, or mocks away the behavior
should be removed or rewritten. Do not duplicate a full workflow for each minor
input variation when a focused test can prove the varying rule.

A transport test must retain the real request and response adapter. Test
disconnects and partial responses at a local HTTP server when exception classes
or streaming behavior matter; replacing the entire request helper hides those
failures. Native-language suites belong in that language's test runner, with
positive discovery and a bounded process lifetime when invoked from Vitest.

MCP handler tests use a real SDK client and server over the linked transport
(`lib/mcp/__tests__/client.ts`). A captured registration callback bypasses input
validation, request context, notifications, and response projection. Put stored
app authorization and continuation reauthorization in Postgres tests. Keep
pagination byte limits, Unicode boundaries, and malformed cursors in pure tests;
compare complete reconstructed results through the same consumer checks.

For emitted policy languages, evaluate the actual output with an independent
language implementation. `captureCondition.test.ts` uses CEL and checks its
Google IAM-specific `extract` extension against Google's published examples.
A hand-written predicate beside an emitter does not prove the emitted policy.
Role-admission tests must query real PostgreSQL catalogs: fabricated booleans
can exercise a refusal rule while hiding a broken membership query.
For asset placement and process supervision, use temporary files and actual
children. Signal tests run in an isolated process group with bounded cleanup;
they must join children and prove parent listeners are removed. For lazy
dependencies, inspect a real bundler's static and dynamic output graph instead
of searching import text.

Organization editor state tests use the real ownership rules and complete
assignment proposals. A fake verdict keyed to a fixture name only proves that
the component displays its own mock. Test incomplete reads, peer replacements,
permission changes and page selection in the production state model; use the
actual browser workflow for focus, picker interaction and persisted reload.

A rejection test must begin with an otherwise admissible input. Prove the valid
case succeeds before introducing the fault, or pair it with an accepted case
that uses the same fixture. Matching a generic error cannot establish why the
operation was rejected. Seed nonempty data before testing deletion or clearing;
asserting that an already empty table remains empty proves nothing.

## Local test projects

Ordinary `*.test.ts` / `*.test.tsx` files run in the `unit` project, including
component tests and integrations whose external boundaries are mocked. Tests
that actually read or write Postgres use `*.postgres.test.ts` (or `.tsx`) and
run in the `postgres` project. Only that project boots Docker and migrates the
database. Both projects share the existing worker pool and file isolation.

`npm test -- path/to/file.test.ts` selects the appropriate project automatically.
`npm test -- --project=unit` runs without Docker. `npm test -- --project=postgres`
selects the database suite. CI runs both projects. A misplaced database fixture
fails before connecting rather than falling back to local database credentials.

Worker-record lifecycle tests begin with canonical app creation and real
guarded persona/catalog edits. Installing the expected schema directly in a
fixture hides omissions at genesis and writes that run before schema changes.
Assert persisted rows, schema sequences and physical row versions; inject a
Postgres failure at schema admission to verify app birth rolls back.

Authorization tests that cross app and Project storage use
`setupAppStateTestDb(prefix, { authSchema: "migrated" })`. It prepares the actual
Better Auth and Nova auth-app migrations once, clones them per test, and seeds
users, Projects and memberships that satisfy their constraints. App-state
fixtures redirect the case-store connection to the same isolated database, so
production store factories and their authorization callbacks remain active. Its auth
migration imports are lazy, so suites using only app-state storage do not load
the auth migration graph.

Separate tests by their dependencies. A file-wide database hook makes even a
pure formatting assertion pay for a database. Keep pure projections, mocked
boundary contracts, and real database acceptance in sibling files. The
`caseDataBindingClient`, `caseDataBindingActions`, and
`caseDataBinding.postgres` suites illustrate those three boundaries.

Do not test a convenience fixture as though it were production behavior. Call
the real function with independently chosen inputs and a counterexample that
would distinguish the intended behavior from a plausible wrong implementation.
For example, submission authority tests give the client and committed form
conflicting destinations, then verify which one production code honors.

## Own asynchronous work

Every operation started by a test must finish or be cancelled and joined before
teardown ends. Register teardown when acquiring the resource, so a failing
assertion cannot skip cleanup. Await asynchronous assertions and interactions.
`void promise` suppresses lint; it does not provide ownership.

For background streams, test both completion and cancellation. Hold the running
promise, abort in `finally`, and await it; release readers, listeners, and timers
in the owning implementation. For database clients, release checked-out clients
before destroying the pool. Never use force-exit or catch-and-ignore to make a
run appear finished. An intentionally rejected promise needs an explicit awaited
rejection assertion.

Use fake time for debounce, lease expiry, retry, or heartbeat behavior. Advance
only the interval under test, stop/unmount the owner, verify no further work is
scheduled when cancellation is the behavior, and restore real time in teardown.
Do not sleep to wait for behavior: await the specific promise, observable state,
or UI condition. RTL interactions must commit inside `act`; use `findBy*` or
`waitFor` for asynchronous UI. The shared setup fails escaped React updates.

Biome's floating/misused-promise rules and Vitest's unhandled-error failures run
in the ordinary checks. They are guardrails, not a proof that arbitrary async
work cannot leak; resource-owning code needs explicit lifecycle assertions.
There is no duplicate async-hooks test run.

## Database fixtures

Use `sql/__tests__/setup.ts` for SQL that fits a rollback transaction. Code that
opens its own transactions uses `setupPerTestDatabase({ databaseNamePrefix,
schema: "migrated" })` or `setupAppStateTestDb()`. Each test gets a separate
database cloned from a closed, immutable template built by the real migrations
once per run. Do not replay the whole migration history in behavior-test hooks.

Migration tests omit `schema` to clone an extensions-only database, then execute
the migrations they are testing. Templates are never test targets. The shared
base templates contain no application fixture rows. This preserves real commits and test isolation
without repeatedly installing PostGIS. Do not replace transaction tests with
nested transactions or shared mutable tables to gain speed. Tests using the
module-scoped database handle must stay sequential within their file.

The default fixture pool has one connection. A contention test must open a
separate client for each competing transaction and an observer when needed.
Prove blocking with `pg_blocking_pids` or an equivalent database signal; two
operations queued for one pool connection do not exercise database concurrency.
Close those clients in `finally` after releasing and joining the operations.

For expensive shared preconditions, `prepareTemplate(db, pool)` runs once per
suite and closes that database to connections. It can build a historical migration
prefix or seed the apps and schemas needed by a submission suite. Each test
receives its own clone; the behavior under test still executes in the test body. Do not
move the behavior being asserted into template preparation or share a writable
database across tests. `preparedTemplate.postgres.test.ts` verifies committed
write isolation and cleanup, including the prepared template.

## Performance and verification

Start with the latest CI job timings and the `test-timings-*` artifacts. The
report includes file import/setup costs as well as test and hook execution.
Reproduce the slow files locally before running a broad graph. Run one broad
suite at a time on a 16 GB machine, including across agents/worktrees.

Use `npm test -- path/to/test.ts` for focused work and `npm run test:changed` for
an import-graph check. Configuration, dependency, and shared database-preparation/migration changes
force a full changed run: those dependencies sit outside the test imports.
Vitest exposes that trigger only at the root, so use explicit file selection
for the first local check. CI runs all tests, independent of changed-file selection. Preserve file
isolation and unhandled-error reporting; increasing timeouts, adding retries,
skipping tests, or reducing assertions is not a performance fix.

The CI wall-time target is five minutes from workflow start to completion,
including setup and fan-in jobs. Compare actual hosted runs; local timings and
runner CPU totals do not establish that target. Smoke shards use separate
Postgres instances so destructive browser scenarios cannot race across shards.

CI installs only the headless shell used by its smoke projects. Full Chromium
is required for local headed/profiling workflows, but downloading it for a
headless CI job adds setup time without exercising another browser.

Media lifecycle tests drive production state models with native File, Response,
and stream objects, replacing only fetch. Native upload progress and setup
failure cleanup run in Chromium against a temporary HTTP server. The Files
journeys use the actual production UI and controlled media endpoints; live role
changes update the isolated smoke database and restore membership in `finally`.
Retain actual media element handles across access changes to verify sources and
playback were retired. A disappearing role locator alone cannot prove closure:
a parent dialog becomes hidden to role queries while its child confirmation is
open. Wait for the topmost dialog to be removed.

The migrated app-state fixture can exercise the production schema-service
factories through its isolated local database URL. That fixture owns both its
explicit pool and any application singleton pool opened through the URL; it
closes both before dropping the database. Database contention probes use a
separate controller connection, observe `pg_blocking_pids`, and release the
lock and drain the operation in `finally`. Observing through a blocked
single-connection application pool would deadlock the test itself.

Project management is tested through real MCP SDK requests and the migrated auth
tables in `lib/mcp/__tests__/projects.postgres.test.ts`. Invitation acceptance
uses Better Auth with Nova's actual organization configuration. Native database
triggers prove creation rollback and write-free repeated role assignments;
concurrent membership DML proves authorization is read after acquiring the gate.

MCP export tests use the real SDK, persisted apps, Project data and deployment
records, and the actual export boundary and compilers. They open the returned
ZIPs, decode workbook cells, and inspect XML and media bytes. A mocked compiler
returning an arbitrary buffer cannot prove a usable download. Replace only the
external object store; keep metadata selection and Project authorization real.

Commit-response loss uses a transparent local PostgreSQL protocol peer. It
forwards real traffic and drops the server's COMMIT acknowledgement after an
actual INSERT transaction commits. Recovery therefore encounters real durable
rows and a real driver disconnection, without replacing SQL or transaction
methods. The peer, connections, requests and optional post-commit action are
owned and drained. A transaction-held contention observer calls
`pg_stat_clear_snapshot()` before each `pg_stat_activity` read so it can see a
newly connected waiter; it also fails immediately if the operation finishes
without reaching the expected lock.

## Publishing across boundaries

MCP publishing uses the actual SDK, migrated Postgres, export validation and
compilers, with only KMS/object storage and the remote HTTP peer controlled.
Inspect the peer's actual multipart bytes with the platform parser, then read
the workbook or ZIP using its consumer. Observe persisted ownership and phase
records at the point the next remote write arrives. A called-spy assertion
cannot establish those ordering or recovery properties.

Malformed inventory and upload replies must exercise the real decoders. A
malformed inventory cannot authorize replacement, and an unknown upload verdict
cannot establish that nothing landed. Native table locks prove that upload
responses wait for event persistence. Fake SDK handler capture is removed;
registration, input validation, progress and results use linked SDK transports.

Organization publishing follows the same actual-boundary method: create places
through the production store, send their real JSON payloads to the controlled
peer, and inspect ownership before app import. Cover a tree that crosses the
100-place batch boundary, archived subtrees, exact adoption, preservation of
foreign JSON, and refused versus unacknowledged writes. Test a shared inventory
deadline by advancing a controlled clock between real HTTP pages; own and drain
the peer's blocked response promises. Do not imitate the deployment ledger in
an in-memory mock.

HQ project-space discovery uses actual upstream-shaped JSON and native HTTP.
Its concurrency test holds complete groups of eight responses on explicit owned
promises, then releases each group; it proves a failed request drains its
siblings and prevents a ninth request. Do not substitute zero-delay timers or
Response-shaped objects. URL tests assert the request the peer actually saw,
including legacy domain spellings, dot-segment refusal, pagination and redirects.
A recorded runnable deployment supplies the before/after proof that malformed
version JSON cannot become an authoritative release withdrawal.

Media upload tests serialize a real deduplicated PNG ZIP through native multipart
and decode HQ's acknowledgement and completion reports. Controlled timers prove
the upload and whole-poll deadlines. For partial JSON, use an actual local HTTP
socket and confirm abort closes it: an in-memory whole-body response cannot prove
ownership after headers arrive. Persisted SDK publishing covers malformed media
status alongside disconnections and verifies the app mapping survives.

Worker provisioning runs through the actual SDK and browser action over persisted
personas, actual guarded persona changes and the production ownership ledger.
Native HTTP checks compare returned passwords with the bytes HQ received, cover
partial/unconfirmed creates and separate place assignment, then retry by recorded
identity without passwords. Use real PostgreSQL locks and trigger failures to prove
answer ordering and credential survival. Reporting-read failures run against an
actual failed database read rather than a mocked setup-artifact function. Password
generation tests control only the entropy boundary to force missing character
classes and biased-byte rejection; transport log checks belong at the native peer.

Provisioning credential retention is tested through the real session store with
no React renderer: repeated uncertain attempts, identical replies, same-named
targets on different servers, exact confirmed creation, dismissal and reset.
The production credential component also runs in Chromium with production CSS
and the platform clipboard, proving copy labels, candidate accumulation, remount,
single-row dismissal and the touch target. This component check is separate from
the actual SDK/Postgres/HQ provisioning lifecycle.

HQ transport cancellation uses actual loopback sockets with the selected HQ host
mapped only inside the test dispatcher. Stalled headers and partial accepted or
refused response bodies must settle at the owned deadline and close the socket.
An in-memory response fixture cannot prove body cancellation; a global timer count
can also include Undici's unrelated scheduler, so native checks assert request
settlement and socket ownership directly.

Database process failure tests run the actual runtime factory in separate Node
processes. The parent terminates the exact idle, checked-out, or querying backend
and verifies process survival, rejected work, one connection diagnostic, a healthy
replacement and no remaining connections. This avoids Vitest's own error handlers
accidentally supplying an owner absent in production. Pool shutdown tests also
exercise direct auth use, initialization in flight and concurrent close/reopen.
Per-test database pools retain connection failures and fail their owning teardown
after closure; `DROP DATABASE ... FORCE` cannot excuse a blanket error listener.


Admission and listing cleanup is part of its caller's lifetime. The native
`scanCleanup.postgres.test.ts` holds the stale authority row, proves the caller
has not returned and any new admission has already committed, then verifies the
refund immediately after release. Do not add test-side polling after the API
returns to compensate for a detached production reaper.


`streamReadOwnership.postgres.test.ts` opens the actual app and chat relay routes
with real membership, migrated Postgres and LISTEN/NOTIFY. It blocks each read
lane or authorization cadence in SQL, then proves both consumer cancellation
and abort-to-EOF wait for the read. The app-state contention helper uses the
same owned pool teardown as the ordinary isolated database fixture; it has no
pool-idle polling loop. Finish or cancel each response before closing its fixture.


HQ transport tests share `withSocketHttpPeer` for actual request/body/socket
lifetimes. The named HQ host alone maps to loopback; it exercises native HTTP,
not TLS. Controlled peer tests cover exact acknowledgement and classification;
streaming peers cover incomplete headers/bodies and prove cancellation. The
compatibility success fixture never finishes its body, so an implementation
that reads case data fails its available verdict at the owned virtual deadline.

XML checks must distinguish syntax from value preservation. `xmlBoundary.test.ts`
shares a malformedness corpus with the native HQ/libxml proof, exercises the
actual mutation gates, and checks exact decoded whitespace and Unicode. The
native proof parses actual HQ source and local CCZ forms; Core separately
initializes both forms and reads their answer and question text. A successful
HTML-parser round trip or an emitter paired with its own oracle is insufficient.

Case tiles use the same admitted document corpus in ordinary CI and the native
proof: actual archive fields and session datums, HQ export, and programmatic
preview projections. HQ's real detail contributor regenerates the export;
Core's suite parser reads both paths and inspects native tile dimensions, style,
hidden sorting and grouping. These are parser/model checks, not rendered UI
acceptance. Reproduction commands and external-domain controls are documented
in `scripts/fixtures/hq/README.md` and `scripts/fixtures/javarosa/README.md`.

The compiler's navigation corpus has a second native chain: HQ regenerates the
forms, Core checks ordinary case writes and navigation values, and Core's actual
Search query strings pass through HQ's CSQL compiler. The record distinguishes
native model/value execution from a full session or server query. Ordinary CI
checks the admitted artifacts and their cross-export joins; native reproduction
requires the documented external checkouts and does not silently skip tests.

Search evidence likewise uses twelve admitted apps and native HQ suite
contributors, followed by Core's actual query manager, selection nodesets,
claim parameters/relevance and detail templates on both export paths. Retained
pre-fix manual-link suites are native negative controls for source-context
binding. These checks establish engine values and declared request behavior;
they do not claim an HTTP request or Android screen. See the fixture READMEs
and `docs/research/test-suite-audit/native-{hq,core}-search.json`.

Search prompt acceptance adds three fully admitted fixtures. The native query
manager consumes both generated suites and the emitted lookup rows, then checks
required and validation errors as answers change, filtered choices and removal
of unavailable selections, numeric/location guards and shared computed values.
Ordinary CI retains the small metadata/dependency contracts and complete export
joins. See `native-{hq,core}-prompts.json` and the native fixture READMEs for the
exact source hashes, artifacts, commands and limits.

The CSQL function corpus closes the nested-emission boundary: two admitted apps,
HQ-regenerated entry trees, Core's real query manager, and twenty resulting
lookup queries compiled by native HQ into independently specified complete
filters. Twelve further payloads assert native argument ASTs, including matcher
functions and typed relation chains; they do not execute relation queries.
The pre-grouping quantity is a negative parser control. Private emitter tests
cover composition and admission without claiming that a string assertion or
Nova's own XPath parser proves native CSQL acceptance.

Validator message coverage is a TypeScript obligation: every classified
user-reachable code needs a renderer. Copy tests cover missing and populated
details, internal fallbacks, ordered collections, choice refusals and specific
repair reasons. Boundary tests carry real findings through that renderer so
missing location details cannot be hidden by a synthetic rich finding.

Runtime quote safety uses a single admitted app with six complete query shapes.
Core owns input presence, computed values and prompt-error transitions; native
HQ consumes all 144 resulting query strings and compares full filters or exact
refusals. The former tests that replaced XPath nodes with literal strings before
calling Nova's evaluator are gone. Ordinary CI checks artifact assembly only.
Lexical helper tests retain explicit per-dialect examples and a deterministic
finite-double decimal round-trip property, without claiming native acceptance.

Static quote reachability has a separate native counterexample. The retained
pre-fix suite produces four refused queries under Core's real equality rules;
the opposite branches in a currently admitted document produce four safe values
on both export paths. The ordinary test checks the full admission findings and
their authored paths. Private representability tests assert complete diagnostic
sequences and recursive normalization, without presenting a context-free check
as proof of document admission or native execution.

Instance collection is checked against isolated consumers, not merely its own
current set of leaves. Four admitted forms independently use a related count,
a count condition, existence, or absence inside a value. Native Core opens and
submits each local and HQ-regenerated form with zero or two matching children,
plus unrelated rows and a wrong-type row. The retained pre-fix form raises the
actual missing-instance exception during initialization. Ordinary CI checks the
complete declared instance set; structural collector tests cover union across
both AST families, scoped naming and source refusal without claiming execution.
