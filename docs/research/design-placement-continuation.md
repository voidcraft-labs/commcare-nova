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

## One-time data migration

The schema migration adds turn provenance and its digest to provider starts,
and a migration receipt to design sessions. The application requires exact
turn provenance before resuming old design contexts. There is no legacy budget
fallback or placement-version reader in the application.

After the schema is installed and the old serving revision has drained, run
the read-only scan. Migrate the returned sessions before resuming their designs.
The new runtime cannot append design work to a context whose historical starts
still lack provenance. New sessions already use the current contract.

```bash
mise exec -- npx tsx --conditions=react-server scripts/scan-design-continuations.ts --prod
```

For each returned session, configure the intended write-capable database
connection explicitly. The writer deliberately has no `--prod` shortcut. Use
its exact owner and `updated_at` from the scan:

```bash
mise exec -- npx tsx --conditions=react-server scripts/migrate-design-continuations.ts \
  --session SESSION_ID --actor OWNER_ID --expected-updated-at TIMESTAMP
```

The command defaults to dry-run. It reports the number of provider starts and
workspaces to convert, plus any unresolved turn identities. Completed provider
response receipts bind turns exactly; interrupted starts use verified preceding
input evidence. Ambiguous history stops the entire transaction. An inspected
JSON map from `contextId/stepKey` to the original logical turn can be supplied
with `--turn-assignments PATH`; an assignment conflicting with durable evidence
is rejected. Keep that operator artifact outside the repository.

Repeat the reviewed command with `--execute`. It locks the actor gate, any
materialized app, the session, and its workspaces in the established order;
requires current owner Project edit access; and refuses any session/app holder,
reservation, scope change, or changed timestamp. It preserves original model
events and usage, adding only the provenance fields and their separate digest.
Where current replay would change saved sibling order, it appends ordinary
placement operations. Original workspace operations remain available unchanged.
An idempotent receipt records the conversion; no model runs, credit settlements,
error clearing, or accepted artifact rewrites occur.

Rerun the scan and resolve remaining rows before calling the cutover complete.
A new user message or answered question then continues the saved design with
its own 64-step allowance. Reconnecting the same logical input retains its
existing count, including starts from before the deployment.
