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

**The probe must always name a BUILD id.** `download_odk_profile` calls
`autogenerate_build(request.app, username)` whenever the app it resolved
has no `copy_of`, so pointing it at the working app — or letting
`?latest=true` fall back to one because nothing is released — makes
CommCare HQ start building. A read that quietly mutates the target is not
a probe. Naming a build id keeps `copy_of` set and the call side-effect
free by construction.

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
state, which is what produces the walk back. Anything else would leave a
durable link on screen that no longer works.

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
what it created (`nova-created`) or was explicitly told to adopt
(`adopted`). **There is no third arm for "matched by name"** — two project
spaces can hold unrelated apps called "Household Survey", and picking one
would silently attach a deployment to somebody else's work.

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

A refused publish answers **200 with the `incomplete` record**, not a 4xx:
the request succeeded, the record is the answer, and it names where to
retry from.

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
`refresh_deployment`, `adopt_hq_app`). **Deliberately not the Solutions
Architect** — the same standing decision that keeps
`get_app_hq_feature_flags` off that surface. A deployment is durable state
about somebody else's server, not authored vocabulary an agent designing
an app should reason about.

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
