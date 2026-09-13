# Design format cutover

Design contract version 3 records menu intent once, in module compositions,
and derives selection consumers from their forms. One record is the default;
authors specify several-record selection only when the workflow needs it.
Workspace storage version 4 uses that shape and the current authoring boundary.
Serving code reads only these current formats. Older private design sessions
are retired once; they are not translated into new designs during reads.

Retirement preserves canonical apps and their collected data, Project resources,
conversation messages, sealed design artifacts, model transcripts and usage
records. It closes open private work, releases temporary design lookup
protections, clears execution pointers and marks the session `retired`.
Conversations for an existing app are retargeted to that app so ordinary editing
can continue. Pre-app conversations remain historical; a new build starts a
new design. No old artifact is made current or accepted by this operation.

This replaces the earlier choice-workspace repair: all obsolete workspace
operations, including caller-authored evidence, leave the current authoring path.
Historical diagnostic readers may still display their raw recorded bytes.

## Deployment order

This is a coordinated cutover, not a rolling mixed-format deployment. Stop new
design work and drain the old serving revision before retiring sessions. The
database migration adds the retired state; it does not retire data or make old
readers understand that state. Keep old writers stopped until the new serving
revision is ready.

1. Scan with `node --conditions=react-server --import tsx scripts/scan-design-formats.ts`.
   `--prod` uses the existing read-only production inspector connection. A
   nonzero exit means obsolete metadata remains; each JSON result names its
   session and retirement status.
2. Resolve blockers while the old runtime is still available. `busy` includes
   stale or paused holders and unsettled credit markers. Finish or recover those
   runs through their existing lifecycle. `incomplete-app` requires completion
   or repair of the actual app. `unaccounted-usage` requires normal durable
   accounting. Retirement never clears these conditions to force progress.
3. Drain old writers, apply the registered schema migration, and run
   `node --conditions=react-server --import tsx scripts/migrate-design-formats.ts`
   against the explicitly configured database. This is a dry run. With
   `--execute`, it retires eligible sessions individually under the existing
   actor, app and session locks. Production writes require a write-capable
   environment; the scanner's `--prod` mode does not grant that access.
4. Scan again. Investigate any remaining result before serving the new code.
   `retry` means materialization changed the app mapping while the operation
   waited; a new invocation follows the correct app-first lock order. Repeating
   a completed retirement is harmless. An empty scan is the cutover condition.
5. Start the current revision and resume design work. Verify an existing app
   conversation opens for editing and a fresh build starts with current tools.

Never start strict current readers over unretired old artifacts. Rolling back
the application after retirement also requires code that understands retired
sessions; restarting the old writer is not a valid rollback.

The Postgres retirement tests exercise real stored version-1 and version-2 contracts, obsolete
workspace operations, current workspace preservation, app and session lock
races, billing blockers, retained history and new app-edit authority.
