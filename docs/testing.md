# Testing Nova

A test earns its cost by catching a plausible defect. Name the behavior and the
failure it prevents before writing it. Existing tests are examples to evaluate,
not templates to copy blindly.

## Choose the boundary

- Pure domain rules, reducers, parsers, and state transitions: call the real
  function with representative valid, invalid, and boundary inputs.
- SQL semantics, tenancy, transactions, locks, constraints, migrations: use real
  Postgres. Mocking the query builder cannot prove these contracts.
- User interactions, focus, layout, browser APIs, and hydration: use Playwright
  against the production build. Prefer focused state tests for component logic.
- External services: replace the network boundary with a controlled response;
  retain the real code that interprets it. Never spend on model calls by default.

Do not pin incidental strings, source formatting, CSS class lists, or mock call
sequences unless that exact value or order is the external contract. A test that
restates its fixture, snapshots an implementation, or mocks away the behavior
should be removed or rewritten. Do not duplicate a full workflow for each minor
input variation when a focused test can prove the varying rule.

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
the migrations they are testing. Templates are never test targets. They contain
no application fixture rows. This preserves real commits and test isolation
without repeatedly installing PostGIS. Do not replace transaction tests with
nested transactions or shared mutable tables to gain speed. Tests using the
module-scoped database handle must stay sequential within their file.

For an expensive historical migration precondition, `prepareTemplate(db, pool)`
runs once per suite and closes that database to connections. Each test receives
its own clone; the migration under test still executes in the test body. Do not
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
