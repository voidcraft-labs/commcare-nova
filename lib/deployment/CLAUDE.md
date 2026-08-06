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

So Nova **drives** `preflight` and `upload`, and **observes** `build`,
`release`, and `probe`. That is not a limitation to engineer around: it is
why the setup artifact's build-and-release section is a real instruction
rather than a placeholder.

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

`preflight → uploaded → built → released → runnable`, plus `incomplete`.

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

**Not reaching CommCare HQ writes nothing at all.** `observeDeployment`
answers `unavailable` rather than a phase failure when the question did not
get through — a network blip, a redirecting project space, a key without
the Access APIs permission — and `refreshDeployment` hands that to the
caller instead of persisting it. Otherwise one bad minute would walk a
`runnable` deployment down and tell every member of the Project their app
is refused while it is still released and in use. A 404 from
`current_app_version` IS an answer (the app is gone) and is recorded.

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

**A refused ATTEMPT never rewrites what the target holds.** The state
describes the project space, not the publish. An expired API key blocking
preflight against an already-released deployment records the failure and
leaves the state alone (`applyAttemptOutcome`), because the app really is
still released there. That guard reads `deploymentDisplaysAsReached`, NOT
the strict predicate — the strict one answers `false` at every rung while a
deployment is `incomplete`, so it would hand the worst case the worst
answer: an app uploaded, built and released on CommCare HQ whose probe
failed would be walked back to `preflight` by an expired key, losing its
resume phase and becoming unobservable, leaving a second publish (and a
duplicate app) as the only way forward. For the same reason
`deploymentIsObservable` stops
`refreshDeployment` observing a deployment refused at `preflight` or
`upload`: it may still hold an earlier publish's mapping, so observing
would fold three green outcomes over the refusal and destroy the phase a
retry resumes from. Every LATER refusal is observable, because asking
CommCare HQ again is exactly how a failed build, release, or probe is
retried.

`deploymentDisplaysAsReached` is the display-only counterpart to
`deploymentHasReached`, and the split is deliberate: the strict predicate
gates decisions and answers `false` for everything while refused, while the
display one fills the rungs up to the resume state, because a failed probe
did not undo the upload.

`built` means a build of what the project space currently holds, not
merely that some build exists. An older build with newer changes above it
is `pending` with the version gap named, because CommCare HQ will keep
serving the old one.

## Preflight is a graph with two kinds of edge

A **blocking** edge is a real prerequisite: no connection, or an app the
export boundary refuses. Failing one leaves the deployment `incomplete`
rather than succeeding with a warning attached, and nothing externally
visible has happened.

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

`app_deployment_resources` is the ledger. Nova repoints or updates only
what it created (`nova-created`), which is the only ownership there is.
**There is deliberately no arm for "matched by name"** — two project
spaces can hold unrelated apps called "Household Survey", and picking one
would silently attach a deployment to somebody else's work. Nova pushes to
CommCare HQ and never reads an app back, so it could not verify such a
guess even if it made one.

CommCare HQ has no atomic app update, so publishing again creates a NEW
app there and leaves the previous one in place. The old mapping is kept
with `superseded_at` set rather than deleted, because "report any old
remote resource left behind" is impossible if the row is thrown away. A
partial unique index makes two live mappings for one Nova resource
unrepresentable.

Republishing also CLEARS the build/release/probe outcomes: they described
the previous remote app and are not evidence about this one.

## One publish lifecycle

`service.ts::publishAppToHq` is the only thing that decides what a publish
is. The browser route and MCP's `upload_app_to_hq` both go through it. A
second path would be a second lifecycle, and the two would drift on the
first bug fix.

A refused publish answers **200 with the record**, not a 4xx: the request
succeeded, the record is the answer, and it names where to retry from.

**Success is read from `PublishOutcome.landed`, never from the record's
state.** They answer different questions. `landed` is "did the app reach
the project space on this call"; the state is "what does the project space
hold". Those diverge exactly when a publish is refused against an app that
is already released there, where the record stays `runnable` because it
still is. Both callers read `landed`.

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
Check status would be publishing again — which puts a SECOND app on the
project space, because CommCare HQ has no atomic app update — so the one
button that advances a deployment would cost a duplicate every time. The
read authorizes as a `view` and refresh as an `edit`, which is also why
`DeploymentStatus` takes `canRefresh`: offering a viewer a button that
would be refused is worse than not offering it.

The App setup workspace's Publishing section stays not-built-yet; it
belongs to the app-setup-UI unit.

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
