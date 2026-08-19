# lib/deployment

Durable target state: what a CommCare HQ project space currently holds of
one Nova app, and what somebody still has to set up there by hand.

A deployment is **not** a second Blueprint, a draft, a release flag, or a
version of the app. The app is always exactly one valid document; this
records what happened to a copy of it on somebody else's server.

## The line CommCare HQ draws, which shapes everything here

An API key can import an app. It cannot make a build or release one.

| Operation | CommCare HQ authority |
| --- | --- |
| Import | `app_import_api.py::import_app_api` — `require_permission(edit_apps, login_decorator=api_auth())` |
| Media upload + status | same decorator set |
| **Make a build** | `views/releases.py::save_copy` — `require_can_edit_apps`, which is `require_permission(HqPermissions.edit_apps)` with the default `login_and_domain_required`. Browser session only. |
| **Release a build** | `views/releases.py::release_build` — same. |
| Read the versions | `views/releases.py::current_app_version` — `@login_or_api_key` |
| Read build ids + release flags | `api/resources/v0_4.py::ApplicationResource.dehydrate_versions` — read-only, `LoginAndDomainAuthentication` (whose decorator map carries an `API_KEY` entry). Also needs the account's `access_api` permission, so a failure here is "could not check", never "not built". |
| Install a build | `views/download.py::download_odk_profile` — no login decorator |
| Web Apps | `cloudcare/views.py::FormplayerMain` — session only, plus the `CLOUDCARE` privilege |

So Nova **drives** `preflight`, `resources`, and `upload`, and **observes**
`build`, `release`, and `probe`. That is not a limitation to engineer around:
it is why the setup artifact's build-and-release section is a real instruction
rather than a placeholder.

| Operation | CommCare HQ authority |
| --- | --- |
| Read the lookup tables | `fixtures/resources/v0_1.py::LookupTableResource` — tastypie, so the domain's paid API_ACCESS privilege AND the account's `access_api` permission |
| Upload lookup tables | `fixtures/views.py::upload_fixture_api` — `@api_auth()` + `@require_can_edit_fixtures`, needing neither of the above |

That asymmetry is load-bearing rather than trivia: a project space can accept
the push while refusing to say what it already holds, so the read's failure is
a BLOCKING preflight edge. Treating "could not ask" as "there are none" is the
one reading that turns a permissions problem into somebody's data being
overwritten.

**The probe is a device install request, not a pure read.** Despite the
URL, it does NOT reach `views/download.py::download_odk_profile`:
`app_manager/urls.py` registers the catch-all
`^download/(?P<app_id>[\w-]+)/(?P<path>.*)$` → `download_file` BEFORE the
`download_urls` include, and its own comment says the order matters. So
`download_file` handles it, and that view generates a build's files and
calls `request.app.save()` when they are missing. That is CommCare HQ
repairing a build on a device's behalf, exactly as it does for every real
install, and it cannot change the version or what is released
(`ApplicationBase::save` increments a version only when `copy_of` is
unset, and a build has it set).

**It must still always name a BUILD id.** With one, `download_file`'s
`assert request.app.copy_of` holds and the request stays on that build.
With the working app's id the assert fails, the except arm falls through
to `resolve_path` → `download_odk_profile` → `autogenerate_build`, and
CommCare HQ starts a whole new version. Never the working app id, and
never `?latest=true`, which resolves to one whenever nothing is released.
A 3xx is "could not check", never "not installable":
`check_access_and_redirect` answers 302 for any domain carrying a
`redirect_url`.

## The state machine

`preflight → resources → uploaded → built → released → runnable`, plus
`incomplete`.

`resources` is what the app DEPENDS ON, put there before the app itself. Its
first inhabitant is the app's lookup tables, and the ordering is the reason it
is a rung rather than a step inside the upload: the app's selects read those
tables by name while somebody is using it, so an app that arrived first would
install and misbehave. A publish refused at `resources` sent nothing of the
app, which is what makes its retry cheap — it re-pushes the data and never
re-imports the app.

`incomplete` is a refusal, not a rung: it has no position on the ladder,
and `deploymentHasReached` answers `false` for every target while a
deployment sits there. It carries `resumePhase`, and the state a retry
resumes from is DERIVED from it (`deploymentResumeState`) so the two can
never disagree. A retry never requires re-importing the app, because the
resource mapping already holds the remote id.

**Observation may move a deployment backward.** If a build stops being
released on CommCare HQ, a `runnable` deployment is not runnable any more;
`applyPhaseOutcome` settles a `pending` answer on that phase's own ENTRY
state, which is what produces the walk back.

**Not reaching CommCare HQ at all writes nothing at all.** When the
versions read (the pass's first question) gets no answer,
`observeDeployment` returns `unavailable` rather than a phase failure, and
`refreshDeployment` hands that to the caller instead of persisting it.
Otherwise one bad minute would walk a `runnable` deployment down and tell
every member of the Project their app is refused while it is still
released and in use. A 404 from `current_app_version` IS an answer (the
app is gone) and is recorded; conversely, ANY answered pass confirms the
upload rung, which is what heals a `remote_app_missing` record after the
app is restored through CommCare HQ's own undo.

**A later read failing keeps the rungs the pass already confirmed.** The
builds list needs the Access APIs permission and the profile probe can be
permanently unreachable on a project space with a `redirect_url`, so
discarding the whole pass over either one would strand such deployments at
`uploaded` forever while CommCare HQ confirmed built and released on every
click. Instead the confirmed rungs fold and the probe records a `pending`
outcome whose reason is chosen by STATUS: 401/403 names the permission,
anything else says CommCare HQ did not answer and to check again. The
resting state for a deployment whose probe cannot be made is therefore
`released` with the reason printed beside the last rung, which is exactly
what Nova can honestly confirm.

**Nor does a check the CALLER could not make.** A missing CommCare HQ
connection, or a key that no longer reaches the project space, belongs to
the person who clicked — `refreshDeployment` raises it and writes nothing.
Persisting it would knock a live app to `incomplete` for every member of
the Project because one editor never connected their account. Refresh also
SAYS SO when there is nothing to check (no app there yet, or a publish that
stopped before it got there) rather than returning the record unchanged: a
silent no-op is indistinguishable from a check that found nothing new, and
somebody would press Check status forever waiting for a rung Nova was never
going to ask about.

**A SUCCEEDED resource push folds through `applyAttemptOutcome` too.** It is
the only driven phase whose success is not the app landing, and folding it
plainly would set a `runnable` deployment's state to `resources` — reporting a
live app as not yet sent, from a republish that was going fine. The MAPPINGS
are written either way, because those are target information: the tables really
are there now.

**A refused ATTEMPT writes nothing on a reached target.** The state
describes the project space, not the publish. An expired API key blocking
preflight against an already-released deployment changes NOTHING durable:
`applyAttemptOutcome` returns the record unchanged, by reference, and the
store skips the write. The refusal is reported on the attempt itself
(`PublishOutcome.refusal`), never persisted into the phase history — the
failure usually belongs to the person who clicked (their key, their
draft), and a persisted one lingered, so a stale upload rejection from
last week ended up explaining today's unrelated refusal on every surface
that scanned the phases for "the" failure. The guard reads
`deploymentDisplaysAsReached`, NOT the strict predicate — the strict one
answers `false` at every rung while a deployment is `incomplete`, so it
would hand the worst case the worst answer: an app uploaded, built and
released on CommCare HQ whose probe failed would be walked back to
`preflight` by an expired key, losing its resume phase, leaving a whole
re-publish as the only way forward.

For a related reason `deploymentIsObservable` stops `refreshDeployment`
observing a deployment refused at `preflight`, `resources`, or `upload`: it may still
hold an earlier publish's mapping, so observing would fold green outcomes
over the refusal and destroy the phase a retry resumes from. The one
`upload` exception is `remote_app_missing`, which observation itself
wrote about the CURRENT mapping — re-asking re-confirms the deletion or
notices the app restored, and every LATER refusal is observable, because
asking CommCare HQ again is exactly how a failed build, release, or probe
is retried.

`deploymentDisplaysAsReached` is the display-only counterpart to
`deploymentHasReached`, and the split is deliberate: the strict predicate
gates decisions and answers `false` for everything while refused, while
the display one fills exactly the rungs whose producing phase succeeded
BEFORE the failed one, because a failed probe did not undo the upload.
The comparison is by PHASE, not by state: preflight's entry and success
states are both `preflight`, so a state comparison cannot tell "about to
be checked" from "checked and passed" and drew the first rung green for
the very check that failed.

`built` means a build of what the project space currently holds, not
merely that some build exists. An older build with newer changes above it
is `pending` with the version gap named, because CommCare HQ will keep
serving the old one.

## Preflight is a graph with two kinds of edge

A **blocking** edge is a real prerequisite: no connection, an app the export
boundary refuses, or Project data Nova may not write over. Failing one leaves
the deployment `incomplete` rather than succeeding with a warning attached, and
nothing externally visible has happened.

`project-data` is the one edge that TALKS to CommCare HQ during preflight, and
it appears only when the app reads a lookup table. It reads the target's tables
and plans the push (`lookupResourcePlan.ts`), refusing on any tag the target
already uses for a table Nova cannot account for. The refusal is
all-or-nothing, because the workbook is one upload: a plan that pushed the
unambiguous tables and skipped the rest would leave the project space holding an
app's data half-updated with no state that describes it.

An **attention** edge is something the target needs that Nova cannot do
from here, so it becomes a line in the setup artifact. Required worker
information is deliberately one of these: refusing to publish because a
persona has no value for a required property would refuse a publish that
would have worked, since Nova creates no workers yet. It becomes blocking
when the provisioning driver ships, which is that unit's job.

Feature flags are never blocking, by standing product contract. A flag
report is deployment information; refusing to publish over one would let a
target's configuration edit the app.

## Ownership, and why superseded rows are kept

`app_deployment_resources` is the ledger. Nova repoints or updates what it
created (`nova-created`) and what somebody explicitly handed it (`adopted`).
**There is deliberately no arm for "matched by name"** — two project spaces can
hold unrelated apps called "Household Survey", or unrelated tables tagged
`districts`, and picking one would silently attach a deployment to somebody
else's work.

`adopted` is never inferred. A publish that meets a name it cannot account for
REFUSES and names the resource; the caller comes back with
`adoptResourceIds` carrying the exact Nova ids a person confirmed, and only
those become `adopted` mappings. The ledger records who and when (`adopted_at`
/ `adopted_by`, set together and never alone, enforced by a CHECK and by
`store.ts::writeResourceMapping` so the failure names the call rather than the
constraint). Once recorded, the decision stands: later publishes read the
mapping rather than asking again.

`pushed_identity` is the external name a resource carries on CommCare HQ — a
lookup table's tag. A rename is what makes it load-bearing: Nova pushes the new
name as a NEW resource, supersedes the mapping, and the old table is still
sitting on the project space under the old name, which is the only way anybody
will find it there. `resources.ts::leftBehindResources` therefore tests the
NAME, not the supersession: a table deleted on CommCare HQ and recreated by the
next push supersedes its mapping and leaves nothing behind, and reporting it
would send somebody to tidy up a table that does not exist.

An ordinary republish updates the mapped app in place: the import
carries the active mapping's remote id (`plannedInPlaceUpdate`,
`resources.ts`), CommCare HQ overwrites that app, and the live row
updates without supersession. A publish creates afresh only when there is
no active mapping, or when a persisted upload failure says the mapped app
is gone — the 404 CommCare HQ answers an update with folds through
`applyDeploymentObservation` as a `remote_app_missing` upload failure
(target information, not attempt information), the publish refuses, and
the NEXT publish creates and supersedes the dead mapping.

That recreate, plus rows from before in-place updates existed, is how an
APP row is superseded. A lookup table has two more routes, both of which
leave something real on the project space. Renaming a tag makes a new
table over there, so the old mapping is superseded and the old table
stays where it is. And dropping the last select that read a table
supersedes its mapping too — a push is the authoritative statement of
which tables the app still uses, so `recordPushedResources` supersedes
every live table row it does not name. Nova deletes nothing either way;
it stops CLAIMING the table, which is what lets the report name it.

Only a `complete` push says that, though. CommCare HQ answers a workbook
it half took with `warning`, and those tables are on the project space:
the push records them as `partial`, which writes the mappings, supersedes
nothing, and folds no rung. Recording is not optional on a refusal — a
table Nova made and never wrote a mapping for reads as a stranger's on
the next publish, which would stop and ask somebody to adopt Nova's own
work.

A superseded row is kept with `superseded_at` set rather than deleted,
because "report any old remote resource left behind" is impossible if
the row is thrown away. A partial unique index makes two live mappings
for one Nova resource unrepresentable.

Every publish still CLEARS the build/release/probe outcomes: they
described what the target held before it — a build of the previous
version is not evidence about this one — and the next observation
re-derives the honest story, version gap and all.

## One publish lifecycle

`service.ts::publishAppToHq` is the only thing that decides what a publish
is. The browser route and MCP's `upload_app_to_hq` both go through it. A
second path would be a second lifecycle, and the two would drift on the
first bug fix.

A refused publish answers **200 with the refusal and whatever record the
target has**, not a 4xx: the request succeeded and the answer names where
to retry from. A refused FIRST publish carries `deployment: null` — there
is nothing on that project space to remember, and a record row is never
deleted, so creating one would list a typo'd slug in the dialog forever.

**Success is read from `PublishOutcome.landed`, never from the record's
state, and the refusal from `PublishOutcome.refusal`, never from the
record's phases.** The record answers "what does the project space hold";
`landed` answers "did the app reach it on this call"; `refusal` answers
"why not, this time". Those diverge exactly when a publish is refused
against an app that is already released there, where the record stays
`runnable` because it still is — and carries no failure at all, because
the refusal was the attempt's. `onUploadStarted` fires once, after every
blocking preflight edge passes and before Nova sends CommCare HQ
anything at all — the lookup tables go first, then the app — so a caller
that reports progress can never announce a publish that never left the
building (the MCP tool also allocates its LogWriter there, so a refusal
decided locally records no phantom run). Everything a person could have
decided differently is settled by then, the table-ownership conflict
included, so what remains after it is CommCare HQ's own answer.

## No lock spans the CommCare HQ round trips

Publishing and observing both spend seconds to minutes talking to
CommCare HQ. An earlier design serialized each target with a
session-scoped advisory lock held across that time, which pinned a pooled
Postgres connection per publish — two concurrent media-bearing publishes
held 2 of an instance's 3 connections idle for minutes and starved every
other request on the instance.

So there is no cross-transaction lock at all. Every store write is one
short transaction that locks the app row, takes the deployment row
`FOR UPDATE`, applies the pure state-machine fold to the FRESH row, and
commits (`store.ts::withDeploymentRow`). Interleavings stay honest
because each fold states its precondition against that fresh row:

- `foldDeploymentAttempt` applies `applyAttemptOutcome`, which changes
  nothing once the target displays as reached — so an attempt outcome
  computed while another publish landed cannot rewrite the fresh record.
- `recordRemoteResource` records and folds in one transaction. Two
  interleaved updates of the mapped app record the same remote id and
  the live row simply takes the later write; two interleaved creates
  each record their own app and the ledger files whichever recorded
  first as superseded — the same answer two sequential creates produce.
- `applyDeploymentObservation` folds only while the active mapping still
  carries the remote id AND the `pushed_at` the observation read before
  asking — the per-publish staleness token, needed because an in-place
  republish keeps the id — so a refresh that spent five seconds asking
  about what a publish meanwhile replaced discards its answers instead
  of overwriting the fresh record. It also records the remote revision
  in that same transaction.

## The setup artifact regenerates, always

`setupArtifact.ts` derives from the document on every read and is never
stored. A stored copy goes stale the first time a worker property is
renamed, and somebody following stale instructions has no way to tell.

Every section is target-aware — the project space slug is in each URL —
and no section claims Nova installed anything. When a push driver ships
for one of them, that section becomes a record of what Nova did: the same
artifact, one section rewritten, never a second document and never a
capability flag.

## Surfaces

Builder (the publish dialog) and MCP (`get_deployment`,
`refresh_deployment`). **Deliberately not the Solutions Architect** — the same standing decision that keeps
`get_app_hq_feature_flags` off that surface. A deployment is durable state
about somebody else's server, not authored vocabulary an agent designing
an app should reason about.

**The dialog opens on the record, not only after a publish creates one.**
`readDeploymentsAction` loads every project space this app has reached when
the dialog opens, above the publish form. Without it the only route to
Check status would be publishing the app all over again just to see the
record. The records are also what tells the form whether the selected
project space gets an in-place update or a fresh app
(`plannedInPlaceUpdate`, the same predicate the publish applies). The
read authorizes as a `view` and refresh as an `edit`, which is also why
`DeploymentStatus` takes `canRefresh`: offering a viewer a button that
would be refused is worse than not offering it. The same reasoning hides
Check status entirely on a record checking cannot answer — one that is
not observable, or has no active mapping — since its every press could
only error.

**The dialog keeps ONE copy of each record.** The open-time read seeds a
store keyed by target; a publish response and every Check status upsert
into that same store. The landed hero looks its record up there rather
than holding its own copy, so a record can never render twice with
disagreeing contents, and a fresh deployment survives the status resets
that switching the destination select causes. Refreshes return
`previewProjectSpace` beside the record and the dialog applies it, so the
own tab updates without waiting for the stream; every OTHER open tab
converges through the app stream's deployment lane — each store write
pokes it (`notifyAppDeployments`, in the write's own transaction), and the
relay re-resolves and emits the `preview-project-space` frame
(`lib/preview/CLAUDE.md` § `commcare_project`).

The App setup workspace's Publishing section stays not-built-yet; it
belongs to the app-setup-UI unit.

## Two things the record answers besides publishing

`readDeploymentPreviewRecords` serves both from one read of four columns
(`state`, `resume_phase`, `server`, `domain`), and both filter with the
DISPLAY predicate `deploymentDisplaysAsReached(record, "uploaded")`: a probe
that could not be checked did not undo the upload, and withdrawing either
answer over it would change the app for a reason that has nothing to do with
the app.

- `previewTarget.ts` names the project space Preview resolves
  `commcare_project` to. A slug is the whole answer, so it de-dupes on the
  domain alone.
- `attachmentTarget.ts` names where a capture's case-bound link resolves.
  An origin is part of that answer, so it de-dupes on `(server, domain)` —
  US, India, and EU can hold unrelated project spaces of the same name, and
  picking either origin would build links that open for one set of workers
  and nowhere for the other. Its `attachmentSpace.ts` read deliberately does
  NOT swallow a fault the way `previewSpace.ts` does: degrading to "no
  target" would silently drop a case write from the exported app.

Both are resolution, never authority. A PUBLISH consults neither: an upload
IS the act of putting the app on a project space, so `preflight.ts` passes
its own `(server, domain)` straight through.

## Tenancy

Keyed by `(app, Project, server, domain)`. The server is part of the key
because CommCare HQ's US, India, and EU installations share no account
database, so a key issued by one authenticates nowhere else.

`app_deployments` carries `app_id` and `project_id` but deliberately NOT the
composite `(project_id, app_id)` foreign key `cases` uses: the auth-app tenancy
migration (`lib/auth/migrations/20260728010000_apps_project_tenancy.ts`) keeps
an exact catalog of everything referencing `apps.project_id` and blocks any
addition to it, so a second composite key there would fail every deploy's
migration job.

What that key would have bought is proved where every write already happens:
`lockAppForDeploymentWrite` takes the app row and compares its Project before
touching a deployment row, so a mismatched row cannot be written through the
store. A Project move re-tenants these rows in the same transaction that flips
`apps.project_id` (`lib/db/apps.ts::commitAppProjectMoveInTransaction`), and
`projectMove.integration.test.ts` asserts the row actually moved rather than
that the move merely succeeded.
