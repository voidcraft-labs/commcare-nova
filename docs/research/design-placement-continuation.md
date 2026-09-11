# Design placement and continuation cutover

Sentry event `857a1829eb134354b056c0fb52bc5f5d` on 11 September 2026
started with a reviewer transport reset. The review retry succeeded and recorded
nine blocking findings. Subsequent user scope changes and revisions reached a
menu-placement dead end: a late-created correction menu could not be moved into
canonical parent/child order, and sibling menu position imposed unrelated
construction-owner constraints. The designer exhausted a lifetime step budget;
a rejected finalizer was then reported as a terminal omission. The executor
had not started. Changing the selected models does not repair those contracts.

The runtime now has one placement grammar and one plan/brief schema. A saved
plan's explicit dependency graph remains valid data; newly derived plans omit
artificial sibling-order prerequisites. Sealed plans, revisions, reviews,
source packages, and their digests are not rewritten.

## Completed cutover

PR #584 deployed as commit `d2616815`, Cloud Build
`e3203c9b-9fd2-487b-9399-c903ca021ab9`, and serving revision
`commcare-nova-00517-h5n` on 11 September 2026. The prior revision retired
before the historical data conversion.

Both supported databases were scanned, dry-run, migrated, and rescanned:

| Database | Designs | Historical provider starts | Remaining candidates |
| --- | ---: | ---: | ---: |
| Local | 30 | 942 | 0 |
| Production | 12 | 329 | 0 |

Original model events, usage, sealed artifacts, and workspace operations were
preserved. No workspace needed appended menu conversion operations. Two local
starts required explicit attribution, verified against the last saved question
result preceding each start and its matching UI answer digest. One abandoned
local session from August was released through the standard exact-holder
refund path. Settled app receipts remained intact; the migrator used the shared
run-state reader to distinguish those receipts from occupying holders.

The temporary scanner, writer, conversion module, and their operator-only tests
are retired. A forward schema migration removes the temporary
`continuation_recovery` receipt column after verifying that every design start
has provenance. Normal turn IDs and their integrity digests remain required
for per-turn recovery and accounting. Historical schema migrations remain in
the immutable migration ledger and its separate deployment artifact; they are
not part of the serving application image.
