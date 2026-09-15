# Authoring format cutover

Current sessions use `authoring_version = 1`: a Markdown plan and the unified
architect conversation. Older sessions are version 0. Serving authority refuses
version 0; it never interprets an old design graph as a current plan.

The one-time operator migration preserves useful prose from the latest old
design as an unreviewed Markdown revision, attributed to `migration`. It does
not infer missing requirements or import the old workflow graph. Full original
artifacts and transcripts remain immutable historical evidence.

It abandons obsolete open change sets, supersedes old private work and attempts,
releases temporary lookup protections, and clears old execution pointers.
Canonical apps, collected cases, Project resources, conversation messages, and
billing are preserved. Threads for complete apps return to ordinary app editing.
Incomplete apps and pre-app sessions can continue from their original request,
imported plan when available, and actual saved app. The architect must review
that material before resuming construction.

## Deployment order

This is a coordinated cutover. Keep old writers stopped until the current
revision is ready. New schema alone does not make old readers compatible.

1. Stop admitting old design work and drain its runs. Apply the registered schema
   migrations through the normal migration job. The new column defaults to 0 so
   a surviving old writer cannot accidentally create a current-format session.
2. Run the read-only scanner:
   `node --conditions=react-server --import tsx scripts/scan-design-formats.ts`.
   `--prod` uses the existing operator inspector connection. Nonzero exit means
   old sessions remain; each JSON row identifies the session and its status.
3. Resolve blockers through their owning lifecycle. `busy` includes any present
   holder or settleable reservation, even an expired holder. `unaccounted-usage`
   means a completed model or old translation response still needs durable
   accounting. The migration refuses both; it never discards a lease or bill to
   force progress. An incomplete canonical app alone is not a blocker.
4. Run `node --conditions=react-server --import tsx scripts/migrate-design-formats.ts`
   against the explicitly configured database. The default is read-only. Add
   `--execute` to migrate eligible sessions, each in its own actor/app/session
   transaction. Production writes need a write-capable operator environment;
   the scanner's `--prod` flag grants no write access.
5. Scan again. `retry` means the app mapping changed while a transaction waited;
   rerun so it can follow the correct lock order. Completed migrations are
   idempotent. An empty scan is the admission condition for current readers.
6. Run `node --conditions=react-server --import tsx scripts/scan-authoring-baselines.ts`.
   Older SQL snapshots can omit section membership, localization, or newer
   document collections even when canonical content is intact. For each affected
   app, run `scripts/migrate-authoring-baselines.ts` with the same Node conditions;
   it is read-only unless `--execute` is supplied. `--app <id>` limits either
   command to one app. The writer requires the complete projection migration and
   write-capable operator credentials. It refuses active or unsettled holders,
   appends a complete baseline at a new sequence, and abandons private work that
   depends on the old base. It preserves canonical content, cases, resources,
   plans, messages, billing, and all old history. Rescan until empty.
7. Freeze legacy parent selectors with `scripts/scan-case-selection.ts --out
   <private-manifest> --source-revision <old-serving-sha>`. It records the exact
   projected selector, app sequence, Project, source and target digests. Resolve
   every refusal before continuing; synthetic, extension or inert old routes
   need an intentional repair. Keep this manifest. The scanner creates it
   exclusively so an old plan cannot be overwritten accidentally.
8. Run `scripts/migrate-case-selection.ts --plan <private-manifest> --execute`
   in the same write-capable environment. Each app is checked under its run and
   document locks, receives a system-attributed replayable edit, and must fold
   to the planned target. Open private work is abandoned; unfinished app status
   and existing history remain. Retry this original manifest after a failure.
   Never rescan the new runtime for migration candidates: new flat lists are
   intentional. This adds no SQL format, dual reader or new fold horizon.
9. Serve the new revision. Verify a complete app's thread opens for ordinary
   editing, an incomplete session resumes from its current state, and a new
   request starts with the Markdown tools.

The old runtime cannot safely resume after this migration. A rollback must keep
current-format authority and data readable; restarting a retired writer is not
a rollback procedure.

The native Postgres tests start from the previous migration prefix and exercise
the full registered upgrade, preserved historical snapshots, imported-plan
attribution, idempotence, app-mapping races, holders, and unaccounted usage. The
snapshot migration fixes the SQL projection for future complete fold baselines.
The separate operator repair starts a new baseline for affected existing apps;
it never rewrites an immutable historical row or changes the authored app.
