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
| Read the levels | `locations/resources/v0_5.py::LocationTypeResource` — GET only, so Nova can never create one |
| Read / write places | `locations/resources/v0_6.py::LocationResource` — `patch_list` is `@atomic` at `patch_limit = 100` |

That asymmetry is load-bearing rather than trivia: a project space can accept
the push while refusing to say what it already holds, so the read's failure is
a BLOCKING preflight edge. Treating "could not ask" as "there are none" is the
one reading that turns a permissions problem into somebody's data being
overwritten.

Both location resources sit behind FOUR gates and Nova cannot tell them apart
from the answer: the project space's `LOCATIONS` privilege (a bodyless 403 from
`v0_5.py::BaseLocationsResource.dispatch`), its `API_ACCESS` privilege (401,
from `HqBaseResource.dispatch`), and the account's Edit Locations AND Access
APIs permissions, which `RequirePermissionAuthentication` checks together
(`users/decorators.py::require_api_permission` unions the named permission with
`access_api`) and refuses with another bodyless 403. Two of the four are
indistinguishable, so the refusal names all of them rather than picking one and
being confidently wrong half the time.

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

`resources` is what the app DEPENDS ON, put there before the app itself: its
lookup tables and its organization's places. The ordering is the reason it is a
rung rather than a step inside the upload — the app's selects read those tables
by name while somebody is using it, so an app that arrived first would install
and misbehave. A publish refused at `resources` sent nothing of the app, which
is what makes its retry cheap: it re-pushes the data and never re-imports the
app.

**Both halves can stop partway, and the reason is CommCare HQ's.** A
lookup-table push is one workbook, but `UploadFixtureAPIResponse.response_codes`
has three verdicts rather than two: `warning` means the workbook was processed
and part of it did not take. `_run_upload` is not one transaction either — only
`flush` is `@atomic`, and `process_table` calls it mid-pass past a thousand rows
— so a 5xx can leave tables behind too. A place push is a batch per level
(`v0_6.py::patch_list` is `@atomic` at 100), so a tree can genuinely stop partway
with three levels of places really sitting on somebody's project space.
`recordPushedResources`
therefore takes a `ResourcePushOutcome`: a `complete` push names the kinds it
speaks for and supersedes every live mapping of those kinds it did not name; a
`partial` one records what landed and supersedes nothing, because a resource it
did not name may simply not have been reached yet. Only a `complete` push folds
the rung.

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

`project-data` and `organization` are the two edges that TALK to CommCare HQ
during preflight, and each appears only when the app carries that thing.

`project-data` reads the target's tables and plans the push
(`lookupResourcePlan.ts`), refusing on any tag the target already uses for a
table Nova cannot account for. The refusal is all-or-nothing, because the
workbook is one upload: a plan that pushed the unambiguous tables and skipped
the rest would leave the project space holding an app's data half-updated with
no state that describes it.

`organization` reads the target's levels and places and plans the push
(`locationResourcePlan.ts`). It carries the same ownership refusal keyed on site
code, and a SECOND refusal that is peculiar to places: CommCare HQ will not hold
shapes Nova admits. Four are decided here, before the first batch, because a
batch that fails on the fourth level has already left three levels of places
over there — a level the target does not have; a place whose level is not the
immediate child of its parent's, which is exactly the skipped rung Nova models
on purpose (`forms.py::LocationForm.get_allowed_types` filters
`parent_type=parent.location_type`); two live siblings sharing a name, which
Nova permits and `util.py::has_siblings_with_name` refuses; and a place Nova
moved to the top that the target holds under a parent, which no push can undo
because `_update` reads `parent_location_id` only to look one UP. The two
refusals are reported one at a time and structure first, because a tree
CommCare HQ cannot hold has to change whoever owns the places over there.

Two refusals are deliberately NOT predicted, because Nova cannot see them: a
site code an ARCHIVED place still holds (`util.py::validate_site_code` queries
`SQLLocation.objects` while the v0.6 list is `active_objects`), and a level
change on a place that has children over there. Both surface as the push's own
refusal, carrying CommCare HQ's sentence and the site code it names, which is
more specific than anything Nova could say about a rule it did not predict.

An **attention** edge is something the target needs that Nova cannot do
from here, so it becomes a line in the setup artifact. Required worker
information is deliberately one of these on the PUBLISH: refusing to publish
because a persona has no value for a required property would refuse a publish
that would have worked, since a publish creates no workers. The step that does
create them carries the block instead — provisioning refuses up front on
exactly those gaps (`workerProvisionPlan.ts`), naming the persona and the
property, before any account exists.

Organization LEVELS and place-information FIELDS are attention edges for a
different reason: neither has a writable resource at all, so their setup
artifact sections stay instructions however much else Nova drives. The
consequence differs, though, and the artifact says which. A missing level is a
blocking `organization` refusal the moment a place stands at it, because
CommCare HQ will not take the place. A missing place-information field is not:
`custom_data_fields/models.py::CustomDataFieldsDefinition.get_validator`
iterates the project space's OWN fields and never rejects an unknown key, so an
undefined slug arrives as loose data — real, unvalidated, and unfilterable. What
it DOES refuse is a field it marks required with no value in Nova's bag, which
takes the whole batch down.

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
lookup table's tag, a place's site code, a worker's complete username. What
makes it load-bearing is a resource the app stops carrying: whatever Nova pushed is still there under the
name it went out under, and per the contract Nova does not take it down, so that
name is the only way anybody will find it. `resources.ts::leftBehindResources`
therefore tests the NAME, not the supersession: a table deleted on CommCare HQ
and recreated by the next push supersedes its mapping and leaves nothing behind,
and reporting it would send somebody to tidy up a table that does not exist.

The three kinds reach it differently. A tag is mutable, so a RENAME is the
common route for a table. A site code is create-once in Nova, so a place never
renames; its route is ARCHIVING, which stops the push naming it — and CommCare
HQ's v0.6 resource exposes neither archive nor delete, so Nova could not have
taken it down even if the contract allowed it. Its code stays reserved over
there either way. A worker's route is a DELETED PERSONA, reconciled from the
document rather than from a call (below); its username is create-once on
CommCare HQ, so asking for a different one makes a second account and supersedes
the first.

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
APP row is superseded. The pushed kinds have more routes, all of which
leave something real on the project space. Renaming a tag makes a new
table over there, so the old mapping is superseded and the old table
stays where it is. Dropping the last select that read a table, or
archiving a place, supersedes its mapping too — a COMPLETE push is the
authoritative statement of which resources of its kinds the app still
uses, so `recordPushedResources` supersedes every live row of those kinds
it does not name. An app that stops carrying a kind entirely gets the
same treatment without a push: `publishAppToHq` reconciles the dropped
kinds against the ledger, because otherwise the mappings would stay live
forever and nothing would ever report them. Nova deletes nothing on
CommCare HQ in any of these; it stops CLAIMING the resource, which is what
lets the report name it.

Only a `complete` push says that, though. CommCare HQ answers a workbook
it half took with `warning`, and those tables are on the project space:
the push records them as `partial`, which writes the mappings, supersedes
nothing, and folds no rung. Recording is not optional on a refusal — a
table Nova made and never wrote a mapping for reads as a stranger's on
the next publish, which would stop and ask somebody to adopt Nova's own
work.

Workers supersede on a THIRD rule, because provisioning is not a publish.
Somebody naming three personas says nothing about the other twelve, so
"not named by this call" cannot mean "no longer used" the way it does for
a push. What can: the document. `recordPushedResources`'s `reconciled`
outcome takes the personas the app still has and supersedes every worker
mapping outside that set, so a deleted persona's account starts being
reported. It folds no rung either, because provisioning is not a rung.

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
anything at all — the lookup tables and the places go first, then the app — so a caller
that reports progress can never announce a publish that never left the
building (the MCP tool also allocates its LogWriter there, so a refusal
decided locally records no phantom run). Everything a person could have
decided differently is settled by then, both ownership conflicts and the
whole organization shape included, so what remains after it is CommCare
HQ's own answer.

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

## Provisioning workers is not a rung

`workers.ts::provisionWorkers` is the one worker lifecycle, shared by the
Publish dialog's Workers panel and MCP's `provision_workers`. It is
deliberately outside the publish: making somebody an account hands out a
credential and is aimed at named people, which is not something a publish
should do on the way past. So it folds no phase, leaves the deployment's
states where it found them, and writes only the ledger.

**A password exists in exactly one place: the answer.**
`workerCredentials.ts` generates it, the create sends it, and the outcome
carries it back once. Nothing writes it to Postgres, hands it to `log.*`
or a `LogWriter`, or logs a request body that contains it — the refusal
path in `lib/commcare/hq/workers.ts` deliberately logs the status and
never the body for that reason. An update never sends a password at all,
because an update is what an account somebody is already using gets.

**A refusal is not proof that nothing happened.** `obj_create` wraps its
whole creation in `except Exception:` and calls `bundle.obj.retire(...)`
plus `django_user.delete()` before re-raising, but that guard covers only
what is raised inside it, and the account is committed before tastypie
serializes the answer. A real project space answered 500 with the worker
live. So every refusal from `hq/workers.ts` carries `mayHaveLanded`, and
`http.ts::writeMayHaveLanded` is the ONE definition of it, shared with the
lookup-table driver. It is false only for the statuses CommCare HQ
produces before the view runs — 400, 401, 403, 405, 413, 429, 501 — and
for an edge answering a 4xx, which means the edge refused and CommCare HQ
never saw the request. An edge answering 502 or 504 is the opposite and
counts as landed: it forwarded the request and then gave up waiting.
Anything else counts as landed too, a 404 included, because
`always_return_data` makes `post_list` dehydrate after the commit. An
ambiguous create returns its password to the caller as an
`UnconfirmedWorker` instead of dropping it. **Do not reintroduce a blanket
4xx rule or an `edgeRefusal` exclusion on 5xx** — both were there, both
lost credentials, and both read as obviously correct. **Nova does not go looking to
settle it.** Every username-shaped read CommCare HQ offers runs on
Elasticsearch (`query_adapters.py::UserQuerySetAdapter` for the user
resource, `v0_5.py::user_es_call` for `bulk-user`) and trails a create by
seconds, so an empty answer would be read as proof of the one thing it
cannot prove. The person looks, and the next call makes the account
if it was never made. If it WAS, the conflict-and-adopt path only opens
once Elasticsearch catches up — until then a retry plans a create and
meets CommCare HQ's own "already taken", so every message about this
names the wait rather than offering an affordance that is not there yet.

**Nova never issues the resource's DELETE.** It is
`users/models.py::CommCareUser.retire`, a soft delete that reaches
`tag_cases_as_deleted_and_remove_indices` and takes down every case that
worker owns. The same fact is why a worker Nova already owns is UPDATED
by its `user_id` rather than remade when the search does not find it:
retire leaves the Couch document and its username behind, so remaking
would either be refused or hand a second account to somebody meant to be
gone.

**Everything knowable is refused before the first account exists**, which
is stricter than the other two drivers because CommCare HQ is quieter
here: `api/resources/v0_5.py::CommCareUserResource.obj_create` calls
`_update` and DISCARDS its errors, so a create whose location ids do not
resolve answers 201 with the worker standing nowhere. Hence
`workerProvisionPlan.ts` refuses up front on an unusable username, on
required worker information a persona has no value for, and on a persona
standing in a place the project space does not hold — and hence a create
that DOES carry places sends them as a second call, because `obj_update`
gathers the same errors into one 400.

Nova speaks about a worker's places only when the app HAS an organization.
`::_update_location` reads an empty list as "remove all", so an app with
no places would strip a hand-made assignment off an adopted account on
the strength of Nova having nothing to say.

## Surfaces

Builder (the App setup Publishing section and the publish dialog) and MCP
(`get_deployment`, `refresh_deployment`, `provision_workers`).
**Deliberately not the Solutions Architect** — the same standing decision
that keeps `get_app_hq_feature_flags` off that surface. A deployment is
durable state about somebody else's server, not authored vocabulary an
agent designing an app should reason about.

**The Builder splits the work: the dialog publishes, the section manages.**
App setup's Publishing section (`components/builder/app-setup/
PublishingSection.tsx`) is the durable home of the records — one full
`DeploymentStatus` card per project space the app has reached, with Check
status, the Workers panel, and a "Publish again" that reopens the ONE
publish dialog preseeded to that target through a one-shot session-store
request, so a retry never grows a second publish flow. The section's read
authorizes as a `view`, which is what gives a viewer the answer to "where
is this app" without any control that would be refused.

**The dialog opens on the records too, not only after a publish creates
one.** `readDeploymentsAction` loads every project space this app has
reached when the dialog opens. The records tell the form whether the
selected project space gets an in-place update or a fresh app
(`plannedInPlaceUpdate`, the same predicate the publish applies), and
above the form they render as compact per-target rows linking to the
Publishing section rather than a second set of full cards that would have
to be kept honest. Refresh authorizes as an `edit`, which is also why
`DeploymentStatus` takes `canRefresh`: offering a viewer a button that
would be refused is worse than not offering it. The same reasoning hides
Check status entirely on a record checking cannot answer — one that is
not observable, or has no active mapping — since its every press could
only error.

**Each surface keeps ONE copy of each record.** The record fold is the
shared pure model (`components/builder/app-setup/publishingSectionModel.ts`
`upsertDeploymentViews`, keyed on `(server, domain)`): an open-time read
seeds a store; a publish response and every Check status upsert into that
same store. The dialog's landed hero looks its record up there rather
than holding its own copy, so a record can never render twice with
disagreeing contents, and a fresh deployment survives the status resets
that switching the destination select causes. Refreshes return
`previewProjectSpace` beside the record and the caller applies it, so the
own tab updates without waiting for the stream; every OTHER open tab
converges through the app stream's deployment lane — each store write
pokes it (`notifyAppDeployments`, in the write's own transaction), and the
relay re-resolves and emits the `preview-project-space` frame
(`lib/preview/CLAUDE.md` § `commcare_project`).

The Workers panel (`components/builder/DeploymentWorkers.tsx`) lives inside
each record's card in the Publishing section — and ONLY there:
`DeploymentStatus` takes it as a composed `workers` slot the section fills
and the dialog leaves empty, so a worker's password has exactly one surface
that can ever show it. It sits inside the record's card for the same reason
the ledger keys a worker on `(persona, target)`: an account belongs to a
project space, and the same persona can hold a different username on each.
It stays quiet until the app is actually there, because the places a
persona stands in only exist over there once a publish has put them there.

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
