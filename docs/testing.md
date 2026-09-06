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

Authorization tests that cross app and Project storage use
`setupAppStateTestDb(prefix, { authSchema: "migrated" })`. It prepares the actual
Better Auth and Nova auth-app migrations once, clones them per test, and seeds
users, Projects and memberships that satisfy their constraints. Its auth
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
