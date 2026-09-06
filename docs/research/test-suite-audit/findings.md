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
