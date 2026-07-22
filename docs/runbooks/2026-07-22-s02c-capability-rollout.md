# S02c runtime-capability rollout

**Status:** S02c1 foundation only. This document records the checked-in
contract and its safe verification commands. It is not yet a manual traffic-
cutover procedure; S02c2 must add and exercise the guarded no-traffic deploy,
cutover, exact rollback, and drain controller before any operator raises a
floor or enables a feature flag.

## Source of truth

`config/runtime-capabilities.json` is the only authored capability manifest:

| Declaration | S02c1 value |
| --- | ---: |
| Schema | 1 |
| Lookup-reference writer | 0 |
| Stream receiver | 1 |
| Runtime reader | 0 |
| Stream registry | 1 |
| Cloud Run request cap | 3,600 seconds |
| Stream lease grace | 300 seconds |
| Derived stream lease TTL | 3,900 seconds |
| Renewable edit-run lease | 900 seconds |
| Renewable build-staleness horizon | 600 seconds |

Only request cap plus grace derives the 3,900-second stream lease. The edit and
build liveness clocks are separate authored manifest fields: neither derives
from the stream lease nor bounds a detached SA run's total lifetime.
`lib/db/constants.ts` projects them to its legacy minute-valued names without
owning another duration literal.

`lib/runtimeCapabilities/core.mts` owns strict parsing, canonical
serialization, generated environment/label shapes, and the fail-closed parser
for deployed declarations. `lib/runtimeCapabilities.ts` is the validated,
browser-safe accessor. Node hashing is quarantined in
`lib/runtimeCapabilities/serverHash.mts`, with `server.ts` as the marked Next
server entry. A missing, padded, signed, fractional, overflowing, or otherwise
malformed version declaration is v0. The transaction-local lookup writer
declaration derives from `writerVersion`.

## Stream receiver admission

Every browser EventSource URL must carry exactly one `receiverVersion` from the
capability manifest compiled into that browser bundle. Missing, duplicate,
padded, signed, fractional, overflowing, or otherwise malformed declarations
are v0. A serving revision supports the minimum of its compiled receiver and
its strictly parsed deployed-environment receiver, and supports only v0 unless
both its compiled and deployed stream-registry declarations are at least 1.
The admitted lease version is the minimum of browser and serving support. This
keeps a newly deployed server from attributing v1 support to an already-open old
browser bundle.

Each lease uses a database-minted connection UUID. The server never accepts a
client-asserted connection identity.

`lib/db/streamReceiverCapabilities.ts` implements this calculation as a pure
server-side boundary. The stream route now authenticates first, then registers
the admitted receiver and a database-minted UUID in one app + serialized fresh
membership + compatibility transaction. PostgreSQL statement time authors the
lease after lock waits and expiry is exactly 3,900 seconds later. A below-floor
request creates no lease or subscription and receives only a seq-less
`client-upgrade-required` revocation. Teardown disowns the stream first and then
best-effort deletes that exact app/connection lease; expiry covers a crash or
failed cleanup. Cadence reauthorizes the captured Project/role/canEdit tuple but
does not re-read the floor, so a floor raise affects new connections only.

Browser EventSource URL emission remains separate client wiring. Until that
lands, existing browser bundles omit the parameter and therefore declare v0;
all compatibility floors remain 0, so this is intentionally non-activating.

## Build behavior in S02c1

Before Docker runs, Cloud Build executes:

```bash
node scripts/rollout/render-build-config.mjs \
  --check \
  --output /workspace/rollout.env
```

The renderer validates the exact manifest schema and canonical formatting,
then emits shell-quoted values. The Docker build sources that file and bakes
the declarations into the runner image. Its structural check also proves:

- both long-lived Next route `maxDuration` literals equal the request cap;
- Cloud Build passes every generated declaration exactly once;
- Docker declares and persists every value exactly once; and
- the database writer version and both legacy run-liveness constants derive
  from the manifest instead of duplicate literals.

The current deploy step still sends traffic by the pre-S02c pipeline and does
not apply capability labels. Do not infer rollout safety from the image
environment alone. S02c2 will reserve the revision labels `nova_writer`,
`nova_stream_receiver`, `nova_runtime_reader`, `nova_stream_registry`,
`nova_manifest`, and `nova_build`, verify them against the canonical manifest,
pin the service timeout from the generated value, and gate traffic under the
deployment-cutover lock.

## Safe verification

These commands are read-only and require no Cloud access:

```bash
node scripts/rollout/render-build-config.mjs --check
npx vitest run \
  lib/runtimeCapabilities/__tests__/runtimeCapabilities.test.ts \
  --maxWorkers=1
npm run typecheck
```

All compatibility floors remain `0`, and carrier-commit, schema-action, and
Project-move flags remain false. Changing the manifest alone never raises a
database floor or activates vocabulary.
