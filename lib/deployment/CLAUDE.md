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
| Read build ids + release flags | `api/resources/v0_4.py::ApplicationResource.dehydrate_versions` — read-only, `LoginAndDomainAuthentication` (whose decorator map carries an `API_KEY` entry). Also needs the account's `access_api` permission, so a failure here is "could not check", never "not built". Read through `lib/commcare/hq/application.ts::readHqApplication`. |
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

Lookup inventory must be a complete, well-formed list of one state of CommCare
HQ's: every row needs its remote identity, every page names the list's total
and its offset, and a list of several pages is read twice and taken only where
the passes agree (`lib/commcare/hq/readCollection.ts`). A malformed row cannot
be skipped, a malformed envelope cannot become an empty list, a list past its
bound is no answer, and pagination cannot switch project spaces, resource
types or selectors, since Nova asks every page by its own offset. Reads do not
follow redirects. An unknown workbook-upload verdict means data may have
landed; two answers prove that none did: HQ's explicit format-refusal verdict,
and an OK answer that is not JSON, which is the plan page HQ serves before its
upload view runs (`upgradeRequired`).

Once an app import and its ownership mapping have landed, a media transport or
status-read failure remains a media warning. Publishing still returns the app
and, to a publisher who may still read it, its deployment record, with a retry
step for the unconfirmed attachment.
A polling timeout confirms only that HQ accepted the ZIP, not that its task is
still running or will eventually attach the media. The warning preserves that
distinction.
Import acknowledgements must carry a literal success verdict and a routable
remote id; an update acknowledgement must name the app requested. Malformed
responses cannot become ownership mappings.

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

HTTP 200 alone does not confirm readiness. The bounded resource reader must
finish reading a valid profile whose remote suite names the exact selected
server, project space, and released build. Empty, malformed, unrelated, or
wrong-build content leaves the probe pending. A missing profile (404) remains a
build verdict; a transport or body-read failure means the check was unavailable.

The left-behind list describes unused remote objects, not historical ledger
rows. It excludes every currently active `(kind, remoteId)` and reports each
remaining object once, using its latest mapping. When current resource names
cannot be read, the same selector returns only unused apps. Builder and MCP
share this rule, including that fallback.

## The state machine

`preflight → resources → uploaded → built → released → runnable`, plus
`incomplete` and `ended`.

`resources` is what the app's content DEPENDS ON, put there before that
content: its lookup tables and its organization's places. The ordering is the
reason it is a rung rather than a step inside the upload: the app's selects read
those tables by name while somebody is using it, so content that arrived first
would install and misbehave. On a first publish the empty app is made and read
before any table or place is pushed: it holds no content, so nothing in it reads
a table or a place, and CommCare HQ makes no build of it. The empty app comes
first so that its CommCare version, which nothing can read before HQ makes the
app, is held to the floor before any Project data is written
(`lib/commcare/versionFloor.ts::compareToVersionFloor`, the refusal
`hq_app_version_below_floor`): every stop a person could decide differently
precedes that first write. The floor's stop folds at `resources` as well. A
publish refused at `resources` sent none of the app's content, so its retry re-pushes the data and
then sends the content once. A first publish refused there leaves the empty app,
mapped with a null `pushed_revision`, and the retry fills that app and makes no
second one. A create CommCare HQ refuses and a failed read after the create fold
at `resources` too, since no later rung is reached.

**Both halves can stop partway, and the reason is CommCare HQ's.** A
lookup-table push is one workbook, but `UploadFixtureAPIResponse.response_codes`
has three verdicts rather than two: `warning` means the workbook was processed
and part of it did not take. `_run_upload` is not one transaction either — only
`flush` is `@atomic`, and `process_table` calls it mid-pass past a thousand rows
— so a 5xx can leave tables behind too. A place push is a batch per level
(`v0_6.py::patch_list` is `@atomic` at 100), so a tree can genuinely stop partway
with three levels of places really sitting on somebody's project space.
A missing or unusable acknowledgement cannot prove an atomic place batch rolled
back. Only HQ's known 400/401/403 refusals establish that nothing in that batch
landed. Earlier confirmed batches stay recorded; an uncertain batch creates no
mapping, and a retry requires explicit adoption if its site codes now exist
without recorded ownership. Lookup warnings (body code 402) report partial
acceptance; transport and malformed-verdict failures report uncertainty. MCP
preserves the same row-level refusal details the browser receives.
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

`ended`: the person stopped publishing here, or a restored app found a live
Nova app on its HQ app. It holds no position; a publish that passes preflight
leaves it. A refused attempt leaves an ended deployment ended
(`applyAttemptOutcome`), as before a first publish, where a refused attempt
writes no row. "Ending a deployment" below holds the rest.

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
app is gone) and is recorded. The same fact is the active `app` mapping's
`remote_missing_at`, which a succeeded `upload` observation or
`recordRemoteResource` clears; conversely, ANY answered pass confirms the
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
draft), and a persisted one outlives its cause, so a stale upload
rejection would explain a later, unrelated refusal on every surface
that scans the phases for "the" failure. The guard reads
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
be checked" from "checked and passed" and would draw the first rung green
for the very check that failed.

`built` means a build of what the project space currently holds, not
merely that some build exists. An older build with newer changes above it
is `pending` with the version gap named, because CommCare HQ will keep
serving the old one.

## Preflight is a graph with two kinds of edge

A **blocking** edge is a real prerequisite: no connection, an app the export
boundary refuses, Project data Nova may not write over, or a change made in
CommCare HQ since Nova's last push that the person has not confirmed
discarding, an HQ app below CommCare 2.57, a build profile on HQ's app that
names a language the app no longer has (`build-profiles`, after `hq-changes`),
and a plan feature or project-space
setting the app needs that the person has not confirmed (`plan-features`, which
asks HQ nothing), and, on an update of an app that holds Nova's content, a Web
App setting on HQ that differs from where the app runs (`web-apps`, after
`hq-changes`). Failing one leaves
the deployment `incomplete` rather than succeeding with a warning attached, and
nothing externally visible has happened.

`plan-features`, titled "What this project space needs", asks CommCare HQ
nothing and comes before every edge that writes to CommCare HQ or asks a person
about a write. `managed-data` alone precedes it: it only reads CommCare HQ and
refreshes Nova's copy of the tables CommCare HQ manages, and the export boundary
must validate the refreshed generation. A publish refused later keeps that
refresh, which is CommCare HQ's current state and nothing of the publish. No API key reads a project
space's plan or its privileges, whether it still sends its flat location list
(`LocationFixtureConfiguration.sync_flat_fixture`), whether it holds a
forwarder to CommCare Connect, whether it syncs cases on form entry, or whether
it has CommCare Supply turned off, so a person confirms each one the app needs:
the plan features `lib/commcare/planPrivileges.ts::requiredPlanFeatures`
derives from the document and from what this publish sends (a lookup table
workbook, live places), the flat location list for an app that reads places,
a Connect forwarder for an app whose forms hold a Connect block, and sync on
form entry turned off for an Android app with a form that works on a case
chosen in a menu with Search (`planPrivileges.ts::formEntrySyncReasons`), and
CommCare Supply turned off for an app with an advanced menu whose case list is
its own menu item (`planPrivileges.ts::commtrackReasons`, whose form half is a
guard no admitted source meets)
(`confirmations.ts::requiredConfirmations`). The edge and the pre-publish
check (`service.ts::projectSpaceConfirmations`, which lists nothing until a
project space is chosen) read the needs through one helper,
`preflight.ts::publishConfirmationNeeds`, so the rows a person ticks first are
the ones the publish asks for. It mirrors adoption: the refusal,
`hq_confirmation_needed`, names each need with its label, plans, consequence
and reasons, and the caller comes back naming what the person confirmed in
`confirm`. Confirmations live in `app_deployment_confirmations`, six kinds
(`plan-feature`, `flat-location-fixture`, `connect-forwarder`,
`form-entry-sync-off`, `commtrack-off`, and `worker-level`, which provisioning
alone asks, "Provisioning workers is not a rung"); a publish's are written only by
the fold of a passed preflight (`foldDeploymentAttempt`'s `confirmations`), so
a refused publish stores none and the caller resends them; two other writers
touch them: the resources fold of `hq_plan_lacks_web_apps`, which withdraws the
`web-apps` answer HQ's create contradicted, and bringing an app in from
CommCare HQ, which records a `plan-feature` row for each feature the app's
source already uses (`recordAdoptedDeploymentInTransaction`,
`adoption.ts::adoptionPlanFeatureConfirmations`), since the first publish
changes nothing about them. One the app does
not need is dropped. A confirmation stands until someone withdraws it
(`withdrawDeploymentConfirmation`, from the deployment's card or MCP's
`withdraw_deployment_confirmation`), because Nova cannot see a plan change; a
withdrawn row is kept with who withdrew it and when. The `worker-record-access`
attention edge keeps only the device half of the worker's own record; its plan
half is the `worker-records` plan feature.

`managed-data`, `project-data`, `organization` and `target-app` are the four
edges that talk to CommCare HQ during preflight, and each appears only when the
app carries that thing: `managed-data` when a table the app reads is managed in
CommCare HQ, and `target-app` whenever `plannedInPlaceUpdate` names an app. It reads the
app's source (`lib/commcare/hq/appSource.ts::readHqAppSource`), and is the only
edge that does. It also compares the file at each path the app publishes with
the one Nova recorded, by id, and settles a path it holds no record for by the
file's content (`hqMedia.ts::hqMediaStandings`, `hqMediaSettle.ts::settleHqMedia`):
a file that is not this app's is one more part of the app's change, so it
stops the publish with `hq_changed` before the upload could write over it, and
a file Nova could not read stops it with `hq_app_state_unknown`
(`preflight.ts::hqMediaReadFailure`), never read as nothing changed. Only over
an app that holds Nova's content, since a shell holds no file. It is not the publish's only read of it: a first publish reads
the source after it creates the empty app, and a publish that pushed a lookup
table or a place reads it again before the import. Each of the three compares
what it read with its baseline and collects what changed, and preflight gives
one verdict over all of it, `hq_changed`, before any write. `target-app` also
holds the CommCare version that read carries to the floor
(`hq_app_version_below_floor`). The `build-profiles` edge holds that read's
build profiles to the languages this publish writes
(`lib/commcare/targetBuildProfiles.ts::buildProfileLanguageGaps`, the refusal
`hq_build_profile_language_missing`): no API key can change a profile, so a
publish that would leave one naming a language the app lacks stops before any
write, and the same check runs on the second read, where it stops at `upload`.
It comes after the `hq-changes` verdict, because a language a profile names
may have been added in CommCare HQ since Nova's last push: that is asked about
as the change it is, and a publish over it takes the language out. It stops
whatever the plan, since no API key reads whether the plan still includes
application profiles and HQ keeps a profile on a plan without them; so the
refusal names HQ's Languages tab, which takes a language out of every profile
on any plan, wherever the app there still lists every missing language
(`views/apps.py::edit_app_langs`), beside the Application Profiles tab, which
HQ shows only under the `build_profiles` privilege.

The floor is `lib/commcare/versionFloor.ts::compareToVersionFloor`, 2.57: the
refusal below it carries the app's address in `hqAppUrl`, and an unreadable
version is `hq_app_state_unknown`. The version floor reads the publish's first
read of the source, the `target-app` read or the read after the shell create,
and never the second read. A new app's
version can be known only once it exists, so on a first publish the empty app
is created, read, recorded and compared before any lookup table, place or
content is written: the new app's version check also precedes the Project
data. Below the floor that stops at `resources` with the mapping kept, so the
next publish fills the same app once the version is raised.

`project-data` reads the target's tables and plans the push
(`lookupResourcePlan.ts`), refusing on any tag the target already uses for a
table Nova cannot account for. The refusal is all-or-nothing, because the
workbook is one upload: a plan that pushed the unambiguous tables and skipped
the rest would leave the project space holding an app's data half-updated with
no state that describes it. Before that, and before the drift comparison, it
refuses (`hq_table_content_unsupported`) when a planned tag is held in HQ by a
table whose definition read shows what the push would remove: a field
property, a row attribute, or a table that is not global, whose rows go only
to their owners (`unsupportedLookupContent`). Whoever owns that table, neither
an adoption nor a discard keeps that content, so the one way out is a new
export tag. A description and a field's indexed flag are part of HQ's table
key too, but no API-key read returns either, so they are stated, never
detected: the adoption and discard confirmations carry `LOOKUP_DISCARD_NOTE`,
and a push of an unchanged definition that the re-list shows under a new id
lands with the made-again warning.

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

The location reader preserves the entire remote metadata object, including
foreign numbers, booleans, arrays and nested objects. HQ validates its modeled
fields and then replaces this whole object; filtering unknown JSON values to
strings would delete another editor's data. Nova overlays its applicable
modeled values, including empty strings for cleared values. Location inventories
require complete identities and resolvable, acyclic level parents; malformed
parents never become roots. All pages of one pass of an inventory share one
30-second deadline. A publish reads the whole place inventory, up to
`bounds.ts::HQ_LOCATION_INVENTORY_MAX_ROWS` places and
`HQ_LOCATION_LIST_MAX_BYTES`; past either it is `too-large`, never a short
list.

Project-space compatibility is derived from what the app actually uses. A
missing or unverified required capability blocks before Nova writes any remote
resource, because the imported app would not run as authored. The Search
performance capability is different: it is advisory and controls only whether
Nova adds its derived optimization, never whether the app may be published.
Public deployment surfaces name semantic app capabilities, not the private HQ
settings used to establish support. At publish only the publisher's key reads
a space's flags. A project space the connected account has left is the
`not-a-member` issue, and it stops every publish. The route to that state is a
stored project-space list that outlived the membership.

`managed-data`, titled "Data managed in CommCare HQ", comes right after the
connection and before the export boundary (`managedData.ts::reReadManagedTablesForPublish`).
It reads the tables managed in the target with the publisher's key, the list
once and each table's rows, each table at most `LOOKUP_MAX_ROWS` rows by its
first page's total and `HQ_LOOKUP_TABLE_ROWS_MAX_BYTES`, past which it is over a
cap with nothing more read, and where one changed in something the app reads
(the table gone, a column the app reads gone, no column at all, field
properties, row attributes, rows limited to certain users, a field with
several values, a cap, a field name outside the grammar, a character XML
cannot carry) it refuses
with `hq_managed_data_changed`, every change of every table listed in
`details`, before any write; otherwise it refreshes each table whose content
moved, each in its own short transaction, so the boundary validates and emits
the generation that results. A read that fails is `hq_resource_state_unknown`.
A table managed in another project space is read where the publisher's
connection reaches it and refreshed where nothing stops it; otherwise it goes
out from Nova's copy as it is, and never stops a publish. The export boundary
then leaves every table managed in the target out of the workbook
(`lookupTarget`), and `project-data` reuses the list `managed-data` read. The
passed check says Nova sends none of the tables only of those the target
manages: a table another project space manages goes in the workbook from the
copy, and its item says so. Every refresh dates its read before CommCare HQ is
asked, and passes that date as the refresh's own; one whose read began before
the copy's last refresh or hand-back writes nothing (`superseded`, which the
re-read leaves out of what it refreshed), so a slow read never replaces a
newer one (`lib/lookup/CLAUDE.md`, `lib/organization/CLAUDE.md`).

The `organization` edge, for places CommCare HQ manages in the target, plans
no place and pushes none: it reads that project space's places, holds the
owner rules that pick a place beneath the case owner to them, and refreshes
Nova's copy from that read (`managedData.ts::refreshManagedPlacesFromRead`); a
copy it cannot refresh stops nothing, and the passed check then says it was
not refreshed and carries the refresh's own refusal as its item. Another project space gets the copy as
places Nova made there, with every existing refusal.

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
those become `adopted` mappings of a table or a place. An `app` mapping is
`adopted` by one route only: a person brings that app in from CommCare HQ, and
its birth records the mapping with who and when. A publish keeps the ownership
of the app mapping it updates, and an app a publish creates is `nova-created`.
The ledger records who and when (`adopted_at`
/ `adopted_by`, set together and never alone, enforced by a CHECK and by
`store.ts::writeResourceMapping` so the failure names the call rather than the
constraint). Once recorded, the decision stands: later publishes read the
mapping rather than asking again.

A lookup table's standing is the Project's (`lookupResourcePlan.ts`), and
two arms beside the deployment's own mapping account for the table CommCare
HQ holds under a tag. A live mapping of another app of the Project for that
very table (`store.ts::readSiblingLookupMappings`, keyed by the Nova table id
and the HQ table's id) lets the push inherit its standing, `adopted` with the
earliest adoption's who and when where any sibling adopted it, and compares
with the baseline that sibling's push wrote, which the Project shares. A
person's Manage in Nova on the table, recorded on the table from this project
space, is the decision to publish Nova's copy over CommCare HQ's: the push is
`adopted`, attributed to that person and moment, and the drift check compares
with the table's own record of CommCare HQ's table at its last refresh
(`managedData.ts::baselineFromTableOrigin`). `recordPushedResources` writes
the inherited pair. A table CommCare HQ manages in the target has no mapping
and is in no workbook. A tag met when an app is brought in is bound by the
review's rule before any app exists, never by a publish.

`pushed_identity` is the external name a resource carries on CommCare HQ — a
lookup table's tag, a place's site code, a worker's complete username. What
makes it load-bearing is a resource the app stops carrying: whatever Nova pushed is still there under the
name it went out under, and per the contract Nova does not take it down, so that
name is the only way anybody will find it. `resources.ts::leftBehindResources`
therefore tests the NAME, not the supersession: a table deleted on CommCare HQ
and recreated by the next push supersedes its mapping and leaves nothing behind,
and reporting it would send somebody to tidy up a table that does not exist.
The recreated table is `nova-created`, even if its predecessor was adopted;
the old adoption remains on the superseded object, not the newly created one.

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
no active mapping (a first publish, or one after the deployment was ended) or
the active mapping's `remote_missing_at` is set. HQ
reports an app gone in two forms: a 404 from the source read, the update or
`current_app_version`; or a 200 source read whose `doc_type` ends
`-Deleted`, HQ's ordinary delete being soft, with the update answering 400
for it. Either sets `remote_missing_at` and folds `remote_app_missing`
(target information, not attempt information); that publish refuses and the
next creates an empty shell, then updates it, and supersedes the dead
mapping. The app a publish has just created is the exception: its second
read or its update reporting it gone refuses (`hq_app_state_unknown`,
`hq_rejected_upload`) and keeps the mapping, so the next publish reads that
app at `target-app` and records it gone there if it is. The recreated app
keeps the deployment's recorded ids and media paths.
`app_deployment_identities` holds the ids a target holds that are not the
derivation: every menu and form of an app brought in from CommCare HQ, on the
project space it came from, each menu and form a bring-in of changes made there
found under an id that is not its derivation, and the ids of a deployment first
published before ids were derived (a menu's id and a form's `xmlns` as the app
source held them, a form's id as the `ApplicationResource` read held it). Rows
are written when an app or changes made to it are brought in from CommCare HQ
(which first deletes a row the reading contradicts) and deleted when its
deployment is ended; no publish writes one, and no publish
reads form ids back. A deployment whose HQ app is gone stays the same
deployment: its live `app` mapping carries `remote_missing_at`, and its next
publish creates a new app in that project space. One that holds no identity
row gets derived ids there.

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
a push. What can: the document. `store.ts::recordProvisionedWorkers` takes
the personas the app still has and supersedes every worker mapping outside
that set, so a deleted persona's account starts being reported. It folds no rung either, because provisioning is not a rung.

A superseded row is kept with `superseded_at` set rather than deleted,
because "report any old remote resource left behind" is impossible if
the row is thrown away. A partial unique index makes two live mappings
for one Nova resource unrepresentable.

No baseline row is deleted when its resource is superseded. A publish reads a
baseline only through the HQ resource it is about to write, so a superseded
one is never read again, and a delete that asked whether another app still
names the id would race that app's writer. A discard of changes made in
CommCare HQ is recorded as an adoption is, with who and when.

Every publish still CLEARS the build/release/probe outcomes: they
described what the target held before it — a build of the previous
version is not evidence about this one — and the next observation
re-derives the honest story, version gap and all.

## Identities

A menu's and a form's HQ id is its UUID with the hyphens removed, and a form's
`xmlns` follows from its UUID (`lib/commcare/wireIdentity.ts`), and a create
keyed by an answer writes its cases under the prefix its app, form, operation
and type derive (`lib/domain/caseOperationIdentity.ts`), so every publish and
every `.ccz` of one deployment sends the same ids and nothing in the document
stores them. What a project space keeps otherwise is ONE record,
`targetIdentity.ts::TargetIdentity`: the menu and form ids that are not the
derivation (`app_deployment_identities`), the prefix each keyed create's cases
stand under where it is not the derivation (`app_deployment_keyed_case_ids`),
the path each media file is kept at (`app_deployment_media_paths`), and the
word each case list column's field names its property by on each screen where
it is not the word Nova writes (`app_deployment_column_field_words`: HQ's build
reads `case_name`, `date_opened` and `external-id` as Nova's `name`,
`date-opened` and `external_id`, `detail_screen.py::CASE_PROPERTY_MAP`, and
names the column's app strings by the word it stores,
`id_strings.py::detail_column_header_locale`). One
function per step, so a new kind of observation cannot be carried by one flow
and dropped by another:

- **Observed** by `targetIdentity.ts::observedTargetIdentity` alone: a
  reading's identities over CommCare HQ's application resource (each form's
  real id), every keyed create the reading holds, the paths of the files it
  names (`adoption.ts::assignMediaPaths`: one path per file, the first in
  code-unit order of the paths that can be held), every path HQ's media map
  holds, and the word each column the document holds stores on each screen
  (`ReadMenuAndFormIdentities.columnFieldWords`).
- **Resolved** by `resolveTargetIdentity(stored, observed, doc)`, the one rule:
  what the reading names takes the observed value, and a value equal to its
  derivation means no row, so a stored row of an entity the reading now holds
  under its derivation goes; a stored row of something the reading does not
  name stays (an undo in Nova that brings it back publishes it as CommCare HQ
  knew it) unless the observation takes its id, `xmlns`, prefix or path
  (matched as HQ's upload matches a path, `hqMedia.ts::wirePathKey`), tested
  against the whole observation, derived values included; a file keeps the
  path it is stored at while HQ's media map still holds that path and no other
  file of the reading stands there; a column's word takes nothing from another
  column, so a stored word of a column on a screen the reading does not name
  stays; only then is the result reduced to what differs from the derivation,
  a column's word equal to Nova's being no row. A birth resolves over the
  empty record.
- **Written** by `store.ts::writeTargetIdentityInTransaction` alone, under the
  deployment row: where the rows stored are still the record the caller
  resolved over, it writes the difference (a row the record keeps keeps its
  date), otherwise it throws `TargetIdentityMovedError` and writes nothing,
  which a take answers as the review as it stands now. The birth
  (`recordAdoptedDeploymentInTransaction`), a take
  (`recordHqChangesTaken`) and a save that reads as the same app
  (`recordRefreshedAppBaseline`'s `targetIdentity`) call it; an ending deletes
  the rows and a Project move writes the media rows again under the
  destination's asset ids (`lib/db/hqAppClaims.ts::remapDeploymentMediaPathsInTransaction`);
  deleting a file from the library removes its row. The runtime role inserts
  and deletes these rows and updates none.
- **Read** by `store.ts::readTargetIdentity` alone, each media row through
  `adoption.ts::heldMediaPathRows` (a row the rule refuses is logged and its
  file takes its derived path).
- **Projected** by `exportIdentityOf(doc, record)` alone: the identity (its
  column words in `WireIdentity.columnFieldWord`), the keyed prefixes (each
  while the operation still creates the row's case type,
  `adoption.ts::keyedCaseIdPrefixesFor`) and the held media paths a publish, a
  `.ccz` (`CompileOptions.identity`), preflight's export boundary and a take's
  ownership print under, so each file goes out at the path HQ keeps it under
  on that project space and at its content-hash path everywhere else, a key a
  worker enters again after a publish reaches the case it reached before, and
  each column's field, `invisible` field, sort element and app string ids are
  written in the word HQ keeps it under (`lib/commcare/suite/wire.ts::hqColumnFieldText`,
  Nova's word where the record holds none or the column's property no longer
  takes it). The HQ import file carries no target, so it prints derived ids
  and Nova's words.

A path is held only where `hqMedia.ts::isHoldableWirePath` holds it, which
refuses every name a `.ccz` gives its own files, or a name under one, in any
letter case (`lib/commcare/cczMembers.ts::isGeneratedMemberPath`:
`<dir>/app_strings.txt`, `modules-<n>/forms-<n>.xml`, the root files), by
shape, so a path held today never meets a member a language or a form added
later writes; such a file takes its derived path and the first publish
declares the move. The ledger's CHECK states the same shapes in ASCII letter
case as its floor. No writer matches rows by the database's folded index,
which folds ASCII letters alone.

A bring-in's review digest binds the record the birth writes (version 2 of
`reading/digest.ts::ReviewDigestInput`, each file named by its content), so a
prefix, an id or a column's word edited in CommCare HQ between the review and
the create answers `changed`. A bring-in of changes resolves the record over the stored
one (`hqChanges/review.ts::takenTargetIdentity`), computes the take's export
and ownership over it, and names in its review where it moved for something
the app already held (`hqChanges` lines, `lib/publish/hqChangesCopy.ts::whereHqKeepsLines`):
a keyed create's new prefix, a form's new id, a file at another path, a menu
whose case list keeps a column under another word. A save
in CommCare HQ that moves only a form's id normalizes to the same source, so
a review answers `unchanged` only where the application resource's form ids
are the ones the record resolves (`targetIdentity.ts::formIdsAgree`), and
otherwise reads the app and records it.

## Readings

A reading (`lib/deployment/reading`) is one request that reads one CommCare HQ
app for one person into one Project and stores nothing.
`gather.ts::gatherReading` is the one function that decides whether an app can
come in: it reads the app under the save counter's bracket, reads the Project
data through `reading/projectData` (the one surface for tables, places and
media), runs the reader, judges every referenced file, and runs acceptance over
every document a choice can make. Which Nova app already holds the HQ app (the
`already-in-nova` advice, with who to ask) is read only once CommCare HQ has
answered with the app in that request (`store.ts::readHqAppClaims` takes the
`HqAppsSeen` that answer or the app list makes, and nothing else), so a key HQ
no longer accepts gets HQ's own refusal whether or not a Nova app holds the
app; the advice still comes before any table, place or file is read. `read.ts` answers a stop, an account or a
review with its digest.

A reading's lookup rows are bounded per table (`HQ_LOOKUP_TABLE_ROWS_MAX_BYTES`,
past which the table is a caps finding, "more data than Nova reads for one
table") and per request (`HQ_LOOKUP_ROWS_REQUEST_MAX_BYTES`: each table is read
at most as far as what remains, and a request its tables pass answers
`lookup-data-too-large`). A create keeps one buffer per distinct content of the
files it holds, the very entry the media budget counts, and the read's own bytes
rather than a copy (`projectData/mediaStore.ts`); it publishes each content
once and records the asset under every file key that holds it. The process
meters what bring-ins hold at once (`reading/room.ts` over
`lib/commcare/hq/memoryMeter.ts`): each read, create, changes review and
changes bring-in runs under a lease, charged for what it keeps as it keeps it
(every body CommCare HQ sends as it is read, by what it is kept as; a source
taken into a reading, `room.ts::holdReading`, at the measured rate of what the
reading builds, and a changes review's two readings once per request, one reading of the
larger source and a measured second rate over the smaller, `room.ts::holdChangesReadings`), and given back what it lets go (a media file judged and not
kept, `mediaStore.ts`, `hqMediaSettle.ts`) and the rest when it settles,
however it settles. A charge that would take the process past its bound stops
that request partway: its signal aborts, its reads stop and no further request
goes out, it writes nothing, and it answers `nova-busy`. Every write comes after
`BringInRoom.beginWrites`, which throws where a charge was refused, and from
which no charge is refused, so no request is stopped between its writes. The
oldest lease is never refused, so a request past the bound by itself runs
alone. `create.ts` runs the same function again and goes on
only where the digest is the one the person reviewed and their answers are ones
the review offers; only then does it publish each file to the Project's
library, run the check once more over exactly what will be born, and create the
app. No answer the review offers changes the digested document. Every id is
derived from the reading's id, so both requests name the same app.
`birth.ts::adoptHqAppInTransaction` is the one transaction (the claim, the
genesis tail with the tables and places in its seam,
`recordAdoptedDeploymentInTransaction`). Before a create answers anything but
the app, it looks for the app once more, so a repeated create answers the same
app in every overlap. Both routes are under `/api/commcare/bring-in` and answer
a stream of NDJSON lines; the MCP tools call the same two functions
(`read.ts::readHqAppForReview`, `create.ts::createFromReview`). An app whose
source is over `HQ_BRING_IN_APP_MAX_BYTES` is refused, and so is one whose forms
hold more than one reading parses (`gather.ts::formsWithinReading`, every form
parsed once, a piece each, before anything reads it, against
`HQ_BRING_IN_READING_MAX_XML_NODES`): both answer the one `too-large` account.
The edit mode test runs after that count, and a throw from it is the reader's
own fault (`gather.ts::editModeTest`), answered as the reader's contract break. Client code imports the
reading's types from `lib/deployment`, and the client-safe values of
`reading/types.ts`, `reading/stream.ts` and `reading/answers.ts` from those
files, never from `lib/deployment/reading`, whose index is server-only.

### Accepting a reading

`reading/acceptance.ts::acceptReading` is the one judge of a reading:
complete accounting, the gate and the export readiness of a first publish
under every declaration the review will offer, the exact fixed point over
Nova's own emission of the document and of the split document a declaration
can make (each printed under its choice's declaration, the document under the
proposed one, since an export writes where the app runs and a list-first search
reads by it), identity agreement between CommCare HQ's source and that emission,
and agreement with CommCare HQ's own question summary. It is pure and runs on
the request, in pieces: `acceptReadingSteps` and the reader's
`readHqAppSteps` stop between checks and stages, and `gather.ts::Pieces` lets
the event loop turn between them, so an app at the byte cap holds the instance
for no piece longer than a few seconds. Every piece runs under the request's
work meter (`lib/commcare/workMeter.ts`), which each reading's own meter
charges as its parent: `GatherFacts.workUnits` and `longestPieceUnits` are the
count the cap tests hold, which no machine moves, and a reading past the work
limit of its source's size (`reader/work.ts::readWorkLimit`) is the account
of one `too-intricate` finding. The request's `cancel` reaches every piece:
once it aborts, the next piece, or the next charge inside a running one,
throws `WorkCancelled`, and the request answers as a read of CommCare HQ the
same signal cut off answers. A failure after a clean read is
`read-back-differs`, Nova's own.
It reads no expression's meaning: the reader's re-emission comparisons and
the proof lane hold that. `reading/firstPublishChanges.ts::FIRST_PUBLISH_CHANGES`
is the closed list of what a first publish over an adopted app may change;
what a person reviewed is kept on the read baseline and ends with the first
push. Each entry also says where its change stands on a reading (`at`): the
places of `reading/firstPublishPlaces.ts` (a form, a node of its data, a
part of its XForm, a menu's or the app's key, a case property) it builds from
what the reading records of the change, or app-wide with a reason, which one
entry alone may be (`forms-and-settings-rewritten`, which keeps what no other
change's place holds); the module refuses at load an entry that declares no
kind of place of its own (`firstPublishRegisterRefusals`), and
`firstPublishChangePlaces` throws for a change that applies and names no
place. A record names the value of CommCare HQ's stored app it was read
from, and its place is that value's: an expression rewrite's slot
(`ReadRewrite.pointer`), a media reference's map or column icon
(`ReadMediaReference.pointer`), each folded translation key
(`ReadFacts.foldedTranslationKeys`, with the text its key names: the slots
of its kind's row of `firstPublishPlaces.ts::FOLDED_TEXT_SLOTS`, whose paths
are the entry's own, so a place it gives always lies under a path it allows,
and a key no row spells throws); an entry
whose change writes elsewhere places that too (a sort rule's hidden column
at its index in Nova's projection, a date and time at the property it
saves). The register's Vitest holds each entry's places to what its pair's
first publish changes in the stored app. Only the proof lane reads the places (`proof/reader/laneReading.ts`,
over `AcceptedDeclaration.firstPublishFacts`): its judge holds each
difference to the change whose place stands there. `reading/readBack.ts::readBackDifferences` is the one comparison of a
document with its read back, made by tests, by the proof lane and where Nova
asks whether two readings of CommCare HQ's app are one document, and never by
acceptance.

## Baselines

A baseline is CommCare HQ's own read of what Nova publishes, never what Nova
sent, so the drift check compares one HQ read with another
(`hqSourceBaseline.ts`, `hqResourceBaseline.ts`, `remoteChanges.ts`). A
deployment holds one app baseline (`app_deployment_baselines`): the normalized
source HQ answered right after Nova's push (`push`), right after the empty app
was made (`create`), each only where HQ's save counter proves the read is what
that write left ("What the check cannot close"), at the cutover (`cutover`), when the app was brought
in (`read`), or when changes made there were brought in (`changes`), the last
two compared as a push is, with the ownership descriptor of the body it
describes. A `read` baseline's descriptor is the one
`importApplication.ts::hqImportApplication` gives for the document over that
read on an adopted mapping, with the Search advisory taken as unverified. It
holds no form ids: a source read re-mints them, so the normalization replaces
each by its position. A baseline also holds the revision of the Nova app its
source describes (`nova_revision`: the sequence a push sent, the birth's, or
the one a bring-in of changes committed or reviewed at),
and which CommCare HQ file stands at each path the app publishes there
(`media_files`, `hqMedia.ts::HqMediaRecord`, a path to the id of CommCare HQ's
document), written from CommCare HQ's own report of the upload, from the
source at a bring-in, and never from what Nova sent. A push's read-back keeps
it for the same HQ app, since it comes before the upload; a create writes
none. A baseline of origin `read` also
holds `first_publish_changes`: the first-publish changes the person reviewed
that do not depend on where the app runs, each change a worker meets on
Android alone that the reading gives whatever the app declared
(`FIRST_PUBLISH_ANDROID_ONLY`, shown only while the app runs on Android), and
the Web App setting CommCare HQ held. After changes made in CommCare HQ are brought in or recorded, a
baseline can hold a list of the other kind in the same column: what the next
publish changes there. The value's `of` says which kind it is. A `create` and
an `unread` baseline hold none, and the one upsert clears it when a push
replaces the baseline. `store.ts::readFirstPublishStates` returns it to a
viewer and never the source, and `resources.ts::firstPublishOf` is the one
rule that turns it into the list a surface shows.
`targetFacts.ts::targetFactsFromBaseline` projects the stored source to
`TargetFacts`, what the project space holds of the values Nova leaves to
CommCare HQ, and `keptListFor` names the kept settings it holds differently
from a new app. The projection (`lib/commcare/targetFacts.ts::targetFactsFromSource`)
is where every baseline is admitted on its way to an archive, whatever wrote
it (a bring-in, a bring-in of changes, a publish's read-back, Refresh): a
custom base URL is a host to show and never an address a file names, a text
is carried only where its line reads back as one record under its own key,
and a setting only where XML can carry it, each left-out value said by an
advisory. `store.ts::readTargetFacts` returns that projection to a
viewer and never the source, projecting an unchanged baseline once per
instance (a bounded map keyed by its digest). A read snapshot holds only the
baseline's bytes (`holdTargetFacts`), and the gunzip, digest check and parse
run once the snapshot has given its pooled connection back (`targetFactsOf`;
a caller holding a snapshot, as the download, Preview's answer, the
Publishing section and `get_deployment` do, projects after it): the bytes
were read in the snapshot, so the answer is still that one generation, and
the projection reads nothing more. A `.ccz`, Preview and the
Publishing card read it; an absent, unread or shell baseline, or one that
does not verify, gives none, and Nova's own values stand, but for Nova's
seeds on a deployment whose live app mapping is `adopted`: who seeds is the
mapping's, which `ReachedDeploymentTarget.adopted` carries to the archive
apart from the facts, so a `.ccz` there writes no seed and says its language
names may differ (`downloadTarget.ts::downloadKeptAdvisoryFacts`).
`service.ts::refreshKeptValues` replaces the baseline with a fresh read only
where the publish's own comparison finds no change, so it moves no later
drift verdict. That comparison (`compareWithHq`) reads the baseline only once
the live mapping is one it compares, so a released or missing mapping unzips
none. Its write (`store.ts::recordRefreshedAppBaseline`) lands only
while the stored baseline is still the one compared, and its date is taken
before CommCare HQ is asked, so a read that predates a publish never replaces
that publish's. A stored baseline that already holds the read's digest is
current, whoever wrote it, so two refreshes of an unchanged project space both
answer `refreshed`; `superseded` is a newer read that differs, a publish's or
another refresh's, and its sentence names neither. Whether a refresh changed
anything is `keptChanged` over the kept lists before and after, which compares
the labels and a digest of every kept value (`targetFacts.ts::deploymentKeptOf`),
so a value that moved under a label listed on both sides reads as an update.
The type and the reading of CommCare HQ's own keys are
`lib/commcare/targetFacts.ts`'s. Each HQ
table and place a Project maps on a project space holds one resource baseline
(`project_space_resource_baselines`), keyed by the HQ resource, so two apps of
a Project that map one table share it. A read that fails records `unread`,
which always stops the next publish and offers the discard, because nothing
says what Nova's last push left. A published deployment whose baseline Nova
could not read keeps the placement Nova's emission gave each case change and
query repeat when step 5's cutover ran, held, so a later publish moves no
published path (`placements-kept-unread`); a query repeat whose rule gives the
count placement is the one exception, and takes it. A deployment whose live
app mapping is marked remote-missing counts as published, since CommCare HQ's
submissions keep their `xmlns`.

One refusal, `hq_changed`, lists every change of every kind, and a discard
names each resource back with the digest of HQ's state as the refusal showed
it, so a state HQ has since left is asked about again. A save in an HQ editor
that changes no value can still be listed: HQ's pages write keys Nova does
not, and the form builder re-spells XML.

A shell is exempt except for its menus. While the app baseline's origin is
`create`, the app comparison reads only `modules`, so a menu added in HQ stops
with `hq_changed` and any other change to the shell, raising its CommCare
version among them, does not. A failed read after the create records origin
`unread`, which stops: the exemption belongs to a shell Nova read, never to
one it could not.

### What the check cannot close

HQ's import takes no expected version, so no publish can stop a save made in
HQ while it runs from being written over; HQ's save counter
(`views/releases.py::current_app_version`, which every save of a working app
raises by exactly one, `ApplicationBase.save`) lets the publish see that it
happened. What a save meets follows from the import's own rule: HQ replaces
every key the body carries, whole, and keeps every key the body leaves out.

A publish reads the counter just before its last read of the source ahead of
the import (`preflight.ts`'s `target-app` read, or the second read where
Project data went; on a first publish the empty app is bound to the 1 HQ's one
save of a new document leaves, `models/applications.py::_import_app`), and
binds the read after the import to the counter the import acknowledged
(`lib/commcare/hq/appSourceAtVersion.ts::readHqAppSourceAtVersion`: the source,
then the counter, which must stand at the acknowledged one). Only a read the
counter proves is a `push` or `create` baseline (`service.ts::appBaselineFor`
takes nothing else); every other read is stored `unread`. The three facts this
rests on (a create leaves 1, an update acknowledges the counter it leaves, one
past the one before it, and one save in HQ's editors adds one) are held to HQ's
own views by the proof lane
(`proof/hq/test_publish.py::test_hqs_save_counter_moves_as_a_publish_binds_its_baseline`). So:

- A save between the publish's last read and its import makes the import
  acknowledge more than one past the counter read before it
  (`importReplacedReadApp`). The import wrote over that save under every key
  its body carries, which no publish can prevent; the baseline is `unread`,
  and the landed publish carries `APP_CHANGED_DURING_PUBLISH_WARNING`, so the
  next publish stops and asks before it writes over what the save left.
- A save between the import and the read back makes the read `moved`: the
  baseline is `unread` with the same warning, never a `push` that would hide
  the save from the next publish's check.
- An update acknowledged with no counter, and a read back whose counter could
  not be read, give `unread` and `APP_READ_BACK_FAILED_WARNING`.
- The empty app read `moved` after the create (a save in HQ before Nova read
  it) stops the publish at `resources` with `hq_app_state_unknown`
  (`preflight.ts::hqAppMovedWhileReadFailure`), keeping the mapping with an
  `unread` baseline.

A media job of an earlier publish that HQ finished is settled before the
counter is read (`remoteWrites.ts::settleFinishedMediaJobs`), so its save is
not taken for a person's; one still running when the counter is read can
still land inside the window and reads as a change.

A crash between the import and `recordRemoteResource` leaves HQ updated and
the baseline old, and the next publish stops with `hq_changed` over Nova's own
push, in copy that does not claim a person made the change. A table's
description and indexed-field flags are invisible to the check, and so is a
table's or a place's save between its push and its read back: HQ's tables and
places carry no save counter. A change to a shell other than a menu is not
seen. A baseline whose origin is `cutover` holds whatever HQ held when it was
recorded, edits made in HQ before then included, so the first publish over it
writes over them. A profile saved in HQ between the publish's last read and its
import is not seen until the next publish, which stops. A file a person
replaces in CommCare HQ between the publish's last source read and its media
upload is written over, and the record then names Nova's file: HQ's upload
takes no expected id, so this window too stays one round trip wide.

## Bringing in what changed in CommCare HQ

`hqChanges/` brings a change a person made in CommCare HQ to an app Nova
publishes there in to Nova. **The change is the difference of two readings of
two of CommCare HQ's own answers**: the source the baseline stores
(`baselineSource.ts::sourceFromBaseline`, each form keyed by its position
token, every object's keys sorted) and the app as CommCare HQ serves it now,
read in that same key order (`baselineSource.ts::inStoredKeyOrder`, since the
reader reads an operation's writes in its map's key order), through one reader and one
identity map (`readings.ts::makeHqChangeReadings`: `externalIdentityMap` over
the reference document under the identity a publish to this deployment
sends), with every other input shared (the Project's tables, CommCare HQ's
levels, the reference's case types and language codes). Nova's own emission
is on neither side, so whatever CommCare HQ keeps of its own (a logo, a build
profile, the media map, a form re-spelled by its builder) and whatever the
reader does cancels, and the difference is ordinary mutations keyed by Nova's
UUIDs (`diffDocsToMutations` under `HQ_READING_DELTA`, a delta that moves no
saved case rows). Nothing is ever rebuilt from CommCare HQ's app.

It is offered only over a usable pair (`hqChanges/reference.ts::usablePair`):
a baseline that holds a source that verifies (origin `push`, `read` or
`changes`) and names a `nova_revision`, a `push` baseline's revision equal to
the live mapping's `pushed_revision`, at or after the app's greatest fold
baseline. The `target-app` edge sets that answer as the app change's
`canBringIn`; a table's and a place's change carry false. Changes in Nova
are measured against the reference document
(`reference.ts::loadReferenceDocument`): the document at that revision, with
what a server wrote after it (a publish's holds, a deploy's
`blueprint-migration` applied whole, a Project move that no person's change
preceded) and with what a publish never sends taken from the head (the kinds
no reading holds, the worker setup under the slugs the published document
gave it, where the app runs, the logo).

**Nova holds nothing unpublished exactly where what it would publish reads
the same as what it published**, `documentDifferences(canonK(reference),
canonK(head))` empty and no worker or location property's slug renamed since
(`plan.ts`: a slug nothing reads is in neither, and a read CommCare HQ adds of
the published slug means that property). Where a property renamed in Nova since the
publish left its old slug to a property made since, the reference holds that slug twice; every
reading of a document the plan compares binds it to the property the published document held
(`plan.ts::propertiesGivingWay`), and the gate then refuses the bring-in with the slug's own
finding. A note, a review mark, a persona or a worker
property's label changed since then is nothing CommCare HQ receives, so it
neither causes a choice nor is lost: the changes are applied to the head and
come in with no warning. Otherwise nothing is merged. The changes are applied
to the reference, the review lists by place every change in Nova that taking
them removes (`lib/doc/documentChanges.ts`), and the person chooses one side
whole: use CommCare HQ's version, publish over it, or stop publishing there. A
case property renamed in Nova since the reference holds the first choice back
until it is renamed back, since that rename moved saved case data.

**Two requests, and nothing stored between them**, as bringing an app in is.
`review.ts::reviewHqChanges` (`POST /api/commcare/changes/review`) authorizes
`edit`, reads CommCare HQ with the member's own key, writes nothing, and
answers a review with a digest (`digest.ts::hqChangesReviewDigest`: the
baseline's digest, CommCare HQ's source now, the head, the settled media
standings, the target with each file CommCare HQ holds named by its content,
and the tables the change newly reads). `bringIn.ts::bringInHqChanges`
(`POST /api/commcare/changes/bring-in`) computes all of it again and acts only
where its digest is the one sent. Any other answer takes nothing and answers
`changed` with the review as it now stands, and so do the kernel's
`AppHeadMovedError` and the record's `store.ts::HqChangesBaselineMovedError`.
Both routes answer 200 with a stage stream for every outcome. A bring-in
commits under `batchId.ts::hqChangesBatchId` (the deployment, the digest and
the member), so a double press converges on the kernel's batch latch and
another member's press meets its head test.

Both requests run their synchronous work as a read does, in pieces with the
event loop turning between them (`gather.ts::Pieces`): each reader pass by its
stages (`readings.ts::makeHqChangeReadingsSteps`), acceptance by its checks,
and the plan by its steps (`plan.ts::planHqChangesSteps`, whose diffs and
preparations stop between their parts), and the next publish's body by its
emission's parts. Both reader passes and acceptance's re-read share the
request's held emissions (`Pieces.expansions`), so the fixed point's re-read
of the reading now is answered with that reading's emissions. The readings made
to learn which files the sources name are the readings the check takes where
no judged file changes what the media index answers (none missing, none
published), so a review reads each source once. The files settling a
published path by content read are handed to the judge of the files the
sources name (`settleHqMedia`'s `retain`, `judgeReadingMedia`'s `fetched`),
so it asks CommCare HQ for each such file once. A bring-in counts its own
pieces (the check over the files it published, the next publish's body) with
the computation's in the one line it logs, and compresses the stored source
off the event loop.

**Three writes, and none of them is a push.** `pushed_revision`, `pushed_at`,
the deployment's state and its phase outcomes never change, since nothing was
sent:

- A change with a batch commits through `lib/db/applyBlueprintChange.ts` as
  kind `hq-changes` at the reviewed head. The lookup tables the change newly
  reads (a new copy, a refresh of one managed from this project space, an
  adoption answered `use-commcare-hq`) are written as its `projectDataWrite`
  (`reading/projectData/lookupTableStore.ts::writeBroughtInLookupTablesInTransaction`),
  in the commit's own transaction before its gate, each adoption held to the
  revisions and the reader apps the review listed: a change that is turned
  back (a moved head, a refused gate, a moved baseline) creates and changes no
  table, and a table that moved since the review answers the review as it now
  stands. `store.ts::recordHqChangesTaken`
  runs as its `inTransaction`, in the commit's own transaction with the
  sequence the commit takes. It fences on the baseline the plan read (its
  digest, its revision, its read date and the live HQ app), writes a baseline
  of origin `changes` whose `nova_revision` is that sequence, with the
  ownership the next publish's body gives over that source and the target
  (`importApplication.ts::hqImportApplication`, computed before the commit)
  and the media record; writes the target-identity record the reading
  resolved over the stored one (`writeTargetIdentityInTransaction`, "Identities"),
  the record the take's ownership was computed over; and keeps the next publish's list (a
  brought-in app's `first-publish` list from this reading's acceptance, else
  `next-publish` with the plan's `publishChanges` and each id of a stored
  `next-publish` list this reading still gives, since only a push ends it,
  else none).
- A change the app already holds (`nothing`, `already-here`) runs the same
  record in a short transaction of its own under `withDeploymentRow`, naming
  the reviewed head, with no app change.
- A save that reads as the same app (`nothing`, `reads-the-same`) is recorded
  by Refresh's own writer, `store.ts::recordRefreshedAppBaseline`, with the
  target-identity record the review resolved where it moved (a keyed create's
  prefix, a form's id, a file's path or a column's word changed in CommCare HQ
  and nothing else), which the review named: the source
  is replaced, origin, `nova_revision`, ownership and any discard stay, the
  next publish's list is kept by the same rule where the review ran its
  readings, and the media record is written wherever it moves
  (`hqMedia.ts::hqMediaRecordMoves`): an id the review learned by content is
  recorded, and an id whose file CommCare HQ no longer serves is forgotten
  (`nextHqMediaRecord`'s `settled`), so Refresh counts neither again. A take
  passes `settled` too.

After any of them the baseline is CommCare HQ's source as it stands, so the
next publish's comparison passes and its reference starts at that revision.

**Three narrowing rules keep a change set to what CommCare HQ's app can say**
(`plan.ts::narrowed`). No worker or location property is removed or
relabelled, and an add of one the document holds is left out: a reading holds
one per slug the app reads, labelled with its slug, and no definition. A
translation whose source CommCare HQ reworded keeps its text and provenance,
takes the new fingerprint and is marked for review. No declared case property
leaves the catalog, and a declaration CommCare HQ's change moves takes only
the keys the two readings' effective catalogs give apart, so saved case data
keeps its definition and the kernel's refusal to remove a property that holds
saved values is never met. A take check holds the rest: taking the change and
then reading the document as the reader would must give what reading first and
taking second gives. Where it fails, the menus and forms the change touches
take the reader's `one-wire` spelling, which prints the same bytes, and the
check runs once more; the batch is then replayed over the head and must give
the target exactly. Each canonical rewrite of an expression slot is taken only
where the slot prints the same with it (`reader/canon.ts::canonicalSlots`), so
"nothing unpublished" and the take check compare what the app prints, and the
respelled document is written only where CommCare HQ's import file of it is the
same bytes as the document's (`plan.ts::sameExport`; otherwise `differs`, check
`respell`). A rewrite a slot's print refused is logged once per plan at error,
by row and slot kind (`[hq-changes] canonical rewrites withheld`).

**Five places Nova's own content gives way**, because a mutation writes its
slot whole with the reader's value: a translation whose source was reworded
loses its reviewed mark; a translation whose own text CommCare HQ changed
reads as a person's, reviewed; a thing CommCare HQ removed goes with what
Nova held on it, a case property's declaration excepted; a `required`
condition on the question that names a new case becomes always required where
CommCare HQ moved the case name to another question; and a dormant spelling of
a menu or form CommCare HQ changed (one-screen groups at a form's root, a tile
cell on a list that was no tile, a formatting flag under a form whose
formatting was off, a registration form's place) takes the reader's spelling
where it no longer fits.

**What is held, and what is unavailable.** Two changes are named and not
taken (`held`): a new first language that would change the source language of
an app with several (`languages-reordered`: no mutation changes the source
language there), and a version that does not offer the app's own declaration
of where it runs (`runs-elsewhere`). A reading now that holds something Nova
cannot hold is an account, and nothing is taken. A review is `unavailable`
where nothing in the project space is this app's (`not-published`: no
deployment there, or none whose publish made the app; `publishing-stopped`:
its deployment is ended; `app-deleted`: the app went to recently deleted
after the request was authorized, which a deployment read or write tells its
member with `DeploymentAppDeletedError`, before the review reads CommCare HQ
or while it does, and a bring-in's write that meets it answers the review as
it now stands; `hq-app-taken`: a live app's mapping is
released, which a restore leaves while another app's write to that HQ app is
open, until the app's next publish there takes it back), with no usable pair (`no-reference`,
`baseline-unread`), where the base
reading needs Project data that has changed or does not read
(`base-needs-project-data`, `base-unreadable`), over a stored source larger
than `HQ_BRING_IN_APP_MAX_BYTES` or whose forms hold more than one reading parses
(`base-too-large`; a source now past either is the `too-large` account), where the
base reading or the plan passes the work Nova gives a reading of both sources
(`comparison-too-intricate`: the plan runs under an allowance of
`readWorkLimit` of both sources' sizes, `Pieces.steps`; a reading now past its
own limit is the `too-intricate` account), where a later
`blueprint-migration` does not apply to the reference (`nova-updated`) or a
Project move followed a person's change (`app-moved`), and where a check of
the plan's or acceptance's fails (`nova-defect`, Nova's own, logged at error
with its signature). A condition added in CommCare HQ to one of a root's
one-screen groups reads as groups where the base reads sections; no mutation
converts between the two, so the diff removes each page by name and adds it
again under its own UUID (`lib/doc/diffDocsToMutations.ts::rebornFields`), and
the change is taken. Something a publish never
sends and its comparison does not read (the logo, a build profile) stops no
publish and is not looked for, and something the reader reads as what Nova
writes (`FIRST_PUBLISH_CHANGES`' register) changes nothing in the document and
is listed as what the next publish changes there.

## One publish lifecycle

`service.ts::publishAppToHq` is the only thing that decides what a publish
is. The browser route and MCP's `upload_app_to_hq` both go through it. A
second path would be a second lifecycle, and the two would drift on the
first bug fix.

After preflight passes and before anything is sent, a publish records every
placement its emission derives that the document does not hold, as one
`publish-placement` change at the head it emitted; where the head moved it
reads the head again and runs preflight again, three times at most. The
pushed revision is that change's.

The application JSON a publish imports is assembled only by
`importApplication.ts::hqImportApplication`, which `publishAppToHq` and the
proof harness's publish capture (`proof/corpus/publish.ts`) both call, so the
bodies the harness applies to HQ are the ones Nova sends. Change what a
publish sends there.

`hqImportApplication` projects `profile`, `translations` and `add_ons` on the
publish's last read of the app's source before the import: the `target-app`
read, the read after the shell create on a first publish, or the second read
where this publish pushed a table or a place. On a deployment whose live app mapping
is `adopted` it asks the overlay to leave the target's language names and its
absent profile settings as they are (`languageNames: "target"`,
`seeds: "target"`), so the first publish over an app Nova brought in changes
neither. The drift check compares Nova's
part of the three keys, and nothing of them while the baseline's origin is
`create`. The overlays carry the rest, the target's own, from that read, the
same whether a comparison passed, none ran, or a person chose to publish over
what CommCare HQ held. A save in CommCare HQ after that read meets the body as
it was built: a key the body carries is replaced whole, with the target's part
as the read held it, and a key the body leaves out keeps what HQ holds. Every
publish also reads whether the target writes an empty-list text and stores
the answer as `app_deployments.target_empty_case_list_text` with the
`uploaded` fold; a read that fails leaves the column as it was. While the
baseline's origin is `create`, the fill is built over the shell's source with
its profile settings emptied: they are whatever HQ's settings page wrote, so
the filled app holds exactly Nova's own.

The `logo_refs` cleanup is built on the publish's last read before the
import, like the overlays. Publish writes no `logo_refs`; an update names the
key only to take out an entry whose only key is `path`, which HQ's own
uploader never stores (`lib/commcare/targetLogoRefs.ts`). The logo itself never
goes in the bulk media upload. The landed outcome offers it as `logoStep`, its
`changed` read against `app_deployments.offered_logo_content_hash`, a content
hash (a Project move remaps asset ids), written with the `uploaded` fold.

Every update writes the app's Web App setting from where it runs. The
`web-apps` preflight edge asks a person before an update changes the setting
HQ holds on an app that holds Nova's content (`hq_web_apps_change`), whoever
moved it, and the answer is that publish's alone; the drift check leaves the
setting to it. A first publish whose new app reads Web Apps off for an app that
runs in Web Apps stops at `resources` (`hq_plan_lacks_web_apps`), keeps the
mapping and withdraws the `web-apps` confirmation in that fold. The setup
artifact's Web Apps section reads the declaration.

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
anything at all, so a caller that reports progress can never announce a
publish that never left the building (the MCP tool also allocates its
LogWriter there, so a refusal decided locally records no phantom run). On a
first publish the empty app is made first, read and recorded
(`recordCreatedRemoteApp`, with no pushed revision); then the lookup tables
and the places go; then the app's content, as an update. For an app that is
already there nothing moves: the tables and places go first and the update
follows. A publish that pushed a table or a place reads the app's source
again before the update, which is built over that read; where nothing was
pushed it is built over the read the publish already holds. That second
read is compared with the one before it (`diffHqAppSource`), and a change in
anything Nova writes stops the publish at `upload` with `hq_changed`: it
reached CommCare HQ while the Project data went, so no check before the push
could hold it. After the update Nova reads the source back, before the media
upload, bound to the save counter the import acknowledged, and that read is
the new baseline; a read-back that fails, or that the counter shows is not
what the import left, records an `unread` baseline and a warning, since the
app landed. After the media upload
settles, the publish records the id CommCare HQ reported for each path
(`store.ts::recordDeploymentMediaFiles`, against the baseline this publish
wrote, so a later publish's is left alone), else the id preflight found by
content, else what the record held: an upload that failed, timed out or
reported errors earns no entry, and an app that publishes no file records
none. The second read, where Project data went, also compares the file ids at
the published paths (`hqMedia.ts::mediaMovedBetween`) and settles each one that
moved by its content, since Nova's own earlier upload may still be mapping its
file: a file that is not this app's stops at `upload` as a moved form does.
The record keeps no id whose file CommCare HQ no longer serves, and a `read`
baseline's holds only the paths the bulk upload carries, never the logo's, so
every file Refresh counts as moved is one a review settles. Everything a
person could have decided differently is settled by then, both ownership
conflicts and the whole organization shape included, so what remains after
it is CommCare HQ's own answer. On a first publish that answer can come
before any Project data goes: a create CommCare HQ refuses, or a read after
the create that fails, stops the publish at `resources`. One stop after it is
no answer to a write: a change made in CommCare HQ while the Project data is
pushed. That publish offers no discard, and the next one's preflight lists the
change and asks. A first publish has one more stop preflight cannot hold, the
CommCare version of an app HQ has not made yet. It is checked on the read after
the create, before any Project data is pushed, so a target below the floor
holds nothing of the publish but an empty app.

## Placements

Where CommCare HQ keeps a case change (a Case Management slot, an advanced
form's load or open action, or a Save to Case block) and a query repeat's rows
is where its answers sit in every project space the app is published to, and
whether a menu is an advanced menu decides where its forms' case blocks and
chosen cases sit, so once a publish has sent one, every later publish keeps it
there. The document holds that place (`holdPlacements`,
`lib/doc/placementHolds.ts`), and a publish is what records it.

**Which placements a publish records.**
`lib/commcare/placementHolds.ts::placementsToHold(doc)` is every placement the
emission derives and the document does not hold yet, in document order: each
menu emitted advanced whose kind is not held yet (`Module.heldKind`, from
`lib/commcare/moduleKind.ts::emittedModuleKind`), each case operation the plan
places unheld, a form's own close where it has a Save
to Case block of its own, and each query repeat with no placement. Holding
what the emission already derives changes no byte it sends
(`lib/commcare/__tests__/heldPlacementEmission.test.ts`).

**The writer.** `placements.ts::recordPublishPlacements` is the only writer of
the `publish-placement` kind. It commits one `holdPlacements` batch through the
canonical kernel at an expected head (`commitGuardedBatch`'s
`expectedHeadSeq`), so it records only while the head is the revision the
publish emitted; the kernel throws `AppHeadMovedError` otherwise, which it
answers `head-moved`. A gate refusal answers `refused` with the kernel's
sentence, logged to Sentry where it carries finding codes, since the holds are
the emitter's own derivation over a valid document. It never writes an empty
batch.

**Where the publish records them.** `publishAppToHq` records after preflight
passes, so a refused publish records nothing it did not need, and before the
shell create, so no HQ app ever holds content whose placements Nova did not
record. Where the head moved, it reads the head again through the caller's
`reloadHead` (under the caller's own access check) and runs preflight over
it; a third moved head refuses `app_changed_while_publishing` with nothing
sent. A record the kernel refuses (an initial build still running, for
instance) is `app_not_ready` with the kernel's sentence. The document the
change leaves is the one sent: `prepared` takes its `doc` and its sequence,
which is the deployment's `pushed_revision` and the entry-point manifest's
`sourceSequence`, so a deep link checked after the publish needs no second
publish. A stop after the record (the version floor, a refused push, a
refused import) keeps the holds, and the next publish carries them. Two
publishes to two project spaces at once record once: the second meets the
moved head, reads it, finds nothing to hold and sends the same placements.
`PublishOutcome.placements` says how many holds the attempt recorded and how
many of them an accepted offer moved.

**Moves a publish offers.** `placementMoves.ts::placementMoveOffer(doc,
reason)` derives an offer from the document alone, so accepting it asks
CommCare HQ nothing. The `save-to-case` offer moves every case change held in
a Save to Case block to the Case Management slot the planner gives it once its
hold is cleared, all of them or none: it is `null` where none is held there,
where one such change is not held (an unheld change already takes the
simplest place), where one would still take a Save to Case block, where the
result would change a menu's kind, or where it would put a new case of its
module's own type in a basic subcase. Its
holds are those moves followed by every hold the move planner
(`withIdentityMoves`) appends for them, each stated in words
(`describeCaseChange`), and its digest is the canonical JSON digest of the
reason and each hold's target, current hold and new hold, so an unrelated edit
keeps it and any change to what moves changes it. An own close moved into
Case Management shares the own case's block and holds no slot, so its entry
clears the hold. The offer rides `hq_confirmation_needed` where the needs hold
Save to Case unconfirmed (`DeploymentAttemptRefusal.placementMoves`), and the
pre-publish check while that row needs confirming
(`ProjectSpaceConfirmationChecks.placement_moves`); the need's `whereMissing`
says whether moving is offered (`lib/publish/placementMoves.ts::saveToCaseWhereMissing`).
The `same-type-child-links` offer moves each new case of its module's own type
that stands in a basic subcase
(`lib/commcare/sameTypeChildCases.ts::sameTypeBasicChildCases`) to the Save to
Case block the placement planner offers it, with every move that forces (a
later basic subcase renumbered down), replacing holds that still express
their targets; a Save to Case block keeps the link between cases of the same
type whatever the project space says, so the offer never asks for Child
Cases. It is `null` where no such case stands in a basic subcase, or where a
forced move would move a block within Save to Case. It rides
`project_space_incompatible` where the report holds links between cases of
the same type `missing` or `unverified` (`service.ts::refusalPlacementMoves`).
Accepted, it needs Save to Case, which the next refusal asks for where it is
not confirmed, with no `save-to-case` offer, since moving back would make the
case a same-type basic child again.
A caller accepting either offer sends `acceptPlacementMoves`, which the publish applies
before preflight, at the head it holds: an offer that is now `null` (an
earlier attempt recorded it) goes on, a different digest refuses
`hq_placement_moves_changed` with the offer as it stands, and the same digest
records the moves, after which preflight runs over the document that holds
them in the same request: for `save-to-case` the Save to Case need drops, and
for `same-type-child-links` the capability is no longer required. The offer's copy lives in
`lib/publish/placementMoves.ts`, which client surfaces read.

**What a deployment's baseline holds.**
`lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks` reads every case
block HQ's build of each form writes from a baseline's normalized source,
keyed by the form's `xmlns`: the basic blocks from each form's `actions` as
`xform.py::XForm._create_casexml` writes them, the advanced ones as
`_create_casexml_advanced` does, and each Save to Case block from the form's
XForm, walked as elements. A source that is not an application gives no
form. A form whose `xmlns` or blocks the source does not say is listed in
`unread` with the reason, never guessed and never passed over. Each block
carries its condition, its close condition, its links, whether it writes the
owner, and which writes save only a changed answer.

Downloads record nothing: only a publish writes a `publish-placement` change
(`lib/export/CLAUDE.md`).

## No lock spans the CommCare HQ round trips

Publishing and observing both spend seconds to minutes talking to
CommCare HQ. A lock held across that time pins a pooled Postgres
connection per publish: with three connections per instance, two
concurrent media-bearing publishes would hold two of them idle for
minutes and starve every other request on the instance.

So there is no cross-transaction lock at all. Every store write is one
short transaction that locks the app row, takes the deployment row
`FOR UPDATE`, applies the pure state-machine fold to the FRESH row, and
commits (`store.ts::withDeploymentRow`). Interleavings stay honest
because each fold states its precondition against that fresh row:

- `foldDeploymentAttempt` applies `applyAttemptOutcome`, which changes
  nothing once the target displays as reached — so an attempt outcome
  computed while another publish landed cannot rewrite the fresh record.
- `recordRemoteResource` records and folds in one transaction. Two
  interleaved updates of the mapped app record the same remote id in
  CommCare HQ's save order, not their commits': the mapping keeps the
  counter the import that wrote its push fields acknowledged
  (`pushed_remote_revision`), and a record whose import acknowledged a lower
  one writes nothing, since HQ holds the other's content over it. Two
  interleaved creates each record their own app and the ledger files whichever
  recorded first as superseded — the same answer two sequential creates
  produce.
- `applyDeploymentObservation` folds only while the active mapping still
  carries the remote id AND the `push_token` the observation read before
  asking, and is not released. Postgres assigns a fresh UUID on insertion and every update of
  push fields, even when the timestamp, source revision, and remote id stay
  equal. Observation-only updates and supersession retain that identity.
  Thus a refresh that spent five seconds asking
  about what a publish meanwhile replaced discards its answers instead
  of overwriting the fresh record. It also records the remote revision
  in that same transaction.
- Every write of a publish carries the count of endings its first read
  held, and refuses where the deployment has been ended since.
- Every write a publish sends to CommCare HQ is admitted first, immediately
  before it goes, and recorded in `hq_remote_writes` (below): the fence
  protects what Nova records afterwards, and the admission is what keeps a
  transition from letting another Nova app or a hand-back meet a write
  already sent.

### Writes Nova lets out to CommCare HQ

`hq_remote_writes` holds each write a publish sends: the empty app's create,
the import, the media bundle, the lookup table workbook and each batch of
places (one row per place). A write is open until its process settles it
(`settled_at`) or its hold ends (`held_until`), the one rule every reader asks
(`lib/db/openRemoteWrite.ts`). A settle is a state rather than a time, so a
transaction whose clock started before a settle committed (a Project move
waiting for the app row, a birth waiting for the HQ app's lock) reads it
settled; only a hold ends by the clock, so a process that dies holding one
needs no reaper. Each is admitted
in one short transaction under the locks the transitions that would end its
authority take too, for a live app whose caller may edit it
(`store.ts::admitAppWrite`, `admitAppCreate`, `admitWorkbookWrite`,
`admitPlacesWrite`):

- An import or a media bundle takes the HQ app's advisory lock
  (`lib/db/hqAppClaims.ts::lockHqApp`), the app row, then the deployment
  row `FOR UPDATE`, and is admitted only while the fence holds and the
  deployment's live, unreleased `app` mapping names that HQ app; an ending
  since throws `DeploymentEndedError`, and a mapping that moved answers
  `mapping-moved`, which stops the publish with `app_changed_while_publishing`
  having sent nothing. An ending takes the deployment row, so it commits
  wholly before an admission (which then sends nothing) or after it; a
  birth's claim takes the advisory lock, so it sees the write open.
- A create crosses no claim and holds only the fence. Until its record names
  the app HQ made, it keeps every HQ app on that project space from another
  Nova app (`hqAppClaims.ts::openWriteSettlesAt` counts an open create that
  names no app), since HQ may have made the very app a claim is for.
- A batch of places takes the app row and the deployment row and holds the
  fence; one the admission refuses is not sent, and what the earlier batches
  made is recorded first.
- A workbook takes the app row and the deployment row, then the Project's
  lookup state and each table it carries in the lookup writers' order
  (`lib/lookup/managed.ts::lockLookupTablesForPublishInTransaction`). A table
  handed back to CommCare HQ from this project space refuses it with
  `managed_table_handed_back`, nothing sent; a hand-back of a table an open
  workbook carries waits, refused with `handBackWhilePublishing`.

Each is settled by how it ended: a write CommCare HQ answered settles at
once; one whose answer never reached Nova (no answer, or the deadline, decided
over every cause a failure can carry by `remoteWrites.ts::hqAnsweredWrite`,
and for a batch of places any answer that leaves it uncertain) stays open for
five minutes, HQ applying an import inside its request after Nova stops
waiting; a media bundle HQ accepted stays open with its job id for the hour HQ
keeps the job's status (`hqmedia/cache.py`), and a bundle with no id that HQ
may have taken stays open for its admission's hold. A write that made
something is settled in the transaction that records what it made (the
create, the import, the workbook and the places, `store.ts::AdmittedRecord`'s
`settle`; a worker account the same way), so it stays open, holding off a
birth, a hand-back and a Project move, until the record has landed; one that
made nothing (refused before HQ took it) is settled on its own
(`settleRemoteWrites`), and one whose record never comes stays open until its
hold ends. A bring-in, and a publish before it reads the save counter, poll
each open media job of the HQ app by its id and settle one HQ reports done
(`remoteWrites.ts::settleFinishedMediaJobs`).

**What a write made is recorded on its admission.** Every record of a write
Nova let out (`recordCreatedRemoteApp`, `recordOrphanedRemoteApp`,
`recordPushedResources`, `markResourceBaselinesUnread`,
`recordRemoteResource`, `recordDeploymentMediaFiles`,
`finishDeploymentContentWrite`, `recordProvisionedWorkers`) rests on the
admissions of the writes it states (`store.ts::withRecordRow`,
`lockAppForAdmittedRecord`): each must be a write of the record's kinds this
caller admitted for this app, Project and project space, and the app must
still be in that Project, which a move cannot change while one is open.
Neither the app's deletion nor the caller's role since is asked, so an app
deleted, or a publisher who lost edit, between the admission and the record
still has what the write made recorded, and a restored app holds it. A record
with no admission behind it (an app that stopped carrying a kind, a seed)
needs a live app and `edit`, as every other deployment write does. The
deletion held off would not close it: the write's answer comes before its
record, and a publisher can lose edit at any moment.

**A record answers only what its caller may read now.** What a record rests
on and what it answers are two questions: the caller's present access is read
in the record's own transaction by the one authorization every deployment read
and write makes (`lockAppForAdmittedRecord` through `authorizeDeploymentApp`,
at `view`), and the record answers `store.ts::RecordAnswer`: `landed`, what the
writes it records put on CommCare HQ (the HQ app, the tables, the places, the
worker accounts), which is the caller's own work, and `deployment`, the record
as it stands, only to a caller who may still view a live app. A publisher
removed from the app's Project, or whose app was deleted, between the admission
and the record is answered `null`, never the record's other members' names,
confirmations or history; one made a viewer reads it whole. A publish whose
import landed answers such a publisher landed, with `deployment` null and
`sent` (what this publish put there) and the setup artifact of the document it
sent, and an import's record also answers the tables and places its content
stands on (`RecordedImport.dependencies`), which the entry-point manifest names
whoever may read it. A record mid-publish that answers no deployment stops the
publish there, as the next admission would. Provisioning answers no record
beside the accounts it made and their passwords.

For an app in recently deleted:

- **The claim.** A create's record writes the mapping live and unreleased, as
  if it had landed before the deletion: the app holds the new HQ app as an app
  in recently deleted holds every HQ app it published to, given up when
  another app takes it (`claimHqAppInTransaction`) and taken back, if nobody
  holds it then, by the restore. No other app could take it in between, since
  the open create held the project space. An import's record lands on a
  mapping no birth could release while its write was open.
- **The baseline.** Written as for a live app, since it is CommCare HQ's read
  of what the write left; the restored app's next publish compares with it.
- **The left-behind report.** A complete push still supersedes what it does
  not name, since that is the published document's statement; the empty app a
  create made as the deployment was ended is still recorded as a superseded
  mapping; the reconcile of a dropped kind, which no write stands behind, waits
  for the restored app's next publish.

A publish whose app is deleted, or whose publisher loses edit, after the
import landed sends no media (`admitAppWrite` refuses it) and answers landed
with `MEDIA_NOT_SENT_AFTER_ACCESS_WARNING`; before that, the next admission
or write refuses and the publish stops with what it made recorded. The
attempt is not folded, since the record belongs to an app in recently
deleted, and a member who may still edit the app is told it was deleted,
and whether anything had gone to CommCare HQ
(`errors.ts::appDeletedWhilePublishing`, through `DeploymentAppDeletedError`'s
`restated`); anyone else is told, once anything had gone, that it went and
was recorded (`errors.ts::accessLostWhilePublishing`, still a not-found), and
gets the plain not-found where nothing had. A read outside this store (the
app's places, its tables) answers a deleted app as missing, so a publish asks
a not-found once why (`store.ts::deploymentAppDeletion`).

While a write of one app to an HQ app is open, no other Nova app is granted
that HQ app: a birth refuses with `HqAppWriteInFlightError` (the bring-in's
`publish_in_flight`, "try again in a few minutes"), and a settle of a restored
app's released claim leaves it released (`SettledClaims.waiting`; the restore
goes on, and the app's next publish there settles it again, refusing with
`app_changed_while_publishing` while it still waits). A Project move of an app
with an open write is refused (`lib/db/apps.ts`). A stop is never held: it
commits at once, and only what follows it waits.

What no admission closes is CommCare HQ's: a write whose answer never reached
Nova can still be applied after its grace, a media job runs when HQ's queue
reaches it, and the former publisher's own key still writes to HQ directly;
the claim binds Nova's writes only. Each of those is a save, so the new
holder's next read sees it through the save counter and its drift check
(above), detected, never prevented. A serving revision from before this table
existed admits nothing for one deploy's drain.

## One HQ app, one Nova app

An HQ app is published to by one Nova app at a time, across Projects and both
ownerships. The partial unique index `app_deployment_resources_hq_app_claim`
(`lib/db/hqAppClaims.ts::HQ_APP_CLAIM_INDEX`) over
`app_deployment_resources (server, domain, remote_id)` for live, unreleased
`app` mappings makes a second one unrepresentable. `server` and `domain` reach
the mapping row through the `BEFORE INSERT` trigger
`app_deployment_resources_target` and a composite foreign key to
`app_deployments (id, server, domain)`, so no writer sets them. A mapping CommCare
HQ reported gone still holds its claim, since HQ's own undo brings that app
back.

**An app in recently deleted gives its HQ app up when another app takes it,
not when it is deleted.** Deleting an app writes no deployment row. A birth
from CommCare HQ claims the HQ app first
(`hqAppClaims.ts::claimHqAppInTransaction`): under the HQ app's transaction
advisory lock it reads the live, unreleased mapping of that HQ app, refuses
with `HqAppAlreadyClaimedError` where a live app holds it, refuses with
`HqAppWriteInFlightError` while a write another app let out to it is open, and
where the holder is in recently deleted, locks that app's row, reads it again
and sets the mapping's `released_at`. The index is the floor under the lock: an insert that
still meets it throws the same error with no holder. A live app whose mapping
is released publishes nowhere there until it is settled:
`resources.ts::plannedInPlaceUpdate` answers null for it, so it is no reached
target, and `readDeploymentPreviewRecords` leaves it out. Check status
(`refreshDeployment`) refuses it, asking CommCare HQ nothing and writing
nothing, since what HQ says of that app is about the other app's publishes,
and `applyDeploymentObservation` discards an observation of a mapping a birth
released while HQ was being asked.

**Restoring takes each given-up HQ app back unless a live Nova app holds it.**
`lib/db/apps.ts::restoreApp`, and `publishAppToHq` before it reads anything
of CommCare HQ (`store.ts::settleReleasedClaims`), settle the app's released
claims: a claim no one holds is taken back with its identity rows, media
paths and baseline as they were; one a holder in recently deleted took is
taken back from it, releasing that holder's mapping in turn, so of two
deleted apps the first one restored publishes there; and where a live app
holds it, that deployment is ended with reason `claimed-elsewhere` and its
project space is named in the answer (`stoppedPublishing`). A take-back waits
while a write another app let out to that HQ app is open, leaving the claim
released (`waiting`). The lock order is
the one protocol in `lib/db` that locks more than one app row
(`hqAppClaims.ts::lockReleasedClaimsInTransaction`): each HQ app's advisory
lock in key order, then the app rows in ascending app id, then the membership
gate. Where what it read before the locks no longer holds under them, the
transaction writes nothing and starts again, three times at most; after the
third, a restore throws `RestoreClaimsChangedError` and a publish stops with
`app_changed_while_publishing` (`lib/publish/stopPublishing.ts`'s
`RESTORE_CLAIMS_CHANGED` and `PUBLISH_CLAIMS_CHANGED` are the sentences).

## Ending a deployment

A person can stop publishing an app to one project space ("Stop publishing
here"). `store.ts::endDeployment` is the one way in: an admin or owner of the
app's Project may, the members who may delete its apps
(`lib/auth/projectRoles.ts`); an editor sees the deployment and may publish to
it, so the answer to an editor is `not_permitted` with a sentence that names
who can, and a viewer or a stranger finds nothing to stop. CommCare HQ is
asked nothing, so a person whose key no longer reaches the project space can
still stop, and the HQ app stays exactly as it is. A deployment whose live
mapping is a first publish's empty app can be stopped too. The Server Action
`actions.ts::stopPublishingAction` goes through `service.ts::stopPublishing`,
the one lifecycle a stop has, which also answers the setup artifact as a
refresh does. A stop whose ending committed answers as stopped whatever
faults after it: the artifact is then null, the action's record null and its
Preview answer null, each logged, and the surface reads its records again.
MCP's `stop_publishing` answers the ended deployment with what it could read:
`setup_artifact` null, the resource names null (only superseded apps listed
as left behind), the kept list `unread` and `nova_revision` left out, each
logged by class and code.

**A stop names the HQ app the person decided over** (the browser's
`stopPublishingSchema` carries `hqAppId`, the dialog's target the HQ app of
the card or refusal it opened from, and MCP's `stop_publishing` its required
`hq_app_id`), and ends that mapping or nothing, decided under the deployment
row's lock: a live mapping of that HQ app is ended; a mapping of it an ending
already superseded answers the deployment as it stands, writing nothing, so a
retry of a stop that landed answers as stopped, whatever a publish since made
there; a deployment that publishes to another HQ app now, or superseded that
one without an ending, refuses `stale` (MCP's `deployment_changed`), writing
nothing; and a deployment with no `app` mapping at all has nothing to stop.

**The transaction** (`lib/db/hqAppClaims.ts::endDeploymentInTransaction`),
under the app row and the deployment row: it supersedes the live `app` mapping
of the HQ app it names with who ended it and why (`ended_by`, `ended_reason`, `stopped` or
`claimed-elsewhere`) and clears its `released_at`; deletes the deployment's
identity, media-path, keyed-case-id and column-word rows; sets the state to `ended` with
no resume phase and every phase outcome null, adds one to `endings`, rotates
`content_generation`, and clears the entry-point manifest and observation,
the offered logo hash, the target's empty-list text and the last observation;
and pokes the deployment lane so every open tab re-resolves Preview's project
space. It keeps the baseline as history, every confirmation (they are about
the project space), and every table, place and worker mapping (what Nova put
there is still there, and a later publish updates it in place). The stop is
instant and asks CommCare HQ nothing; the HQ app is free to be brought in once
every write this app let out to it has settled ("Writes Nova lets out to
CommCare HQ").

**An ending is read from the mappings, never the state.**
`resources.ts::deploymentEnding` answers the ending a deployment still stands
at: where it has no live `app` mapping and its latest superseded `app` mapping
carries an `endedReason`. A publish to an ended deployment that passes
preflight moves the state to `preflight`, and one that then stops before it
makes the new app leaves the old HQ app there and no new one, so the state is
the wrong witness. Read from the mappings, the ending stands until a publish
records a new app.

**The fence.** No lock spans a publish's round trips, so an ending can land
in the middle of one. `publishAppToHq` reads `endings` once, from its first
read, and every store write of that publish carries it (`DeploymentFence`):
`foldDeploymentAttempt`, `beginDeploymentContentWrite`,
`recordCreatedRemoteApp`, `recordRemoteResource` and
`recordRefreshedAppBaseline` throw `DeploymentEndedError` and write nothing
where the row's count differs, `finishDeploymentContentWrite` answers false
and `recordDeploymentMediaFiles` writes nothing. The publish
answers `publishing_stopped`, the kept values' refresh answers that
publishing there stopped, and provisioning sends no further account (its
admissions carry the fence, `admitWorkerWrite`) and records the ones that
landed, since an ending keeps every worker mapping. The same holds for tables
and places: an ending keeps every table and place mapping, so a push's record
on its admissions (`recordPushedResources`, `markResourceBaselinesUnread`)
records what the push made after an ending as a `partial` push, superseding
nothing and folding no rung, and the publish meets the ending at its next
admission; with nothing admitted, they throw `DeploymentEndedError` as the
others do. Without the fence, an app mapping would land on a deployment whose
identity rows are gone, and the next publish would change every form's
`xmlns`. `applyDeploymentObservation` and
`recordEntryPointObservation` need no fence: an ended deployment has no live
mapping and a new generation, so neither writes. The admissions of a
publish's writes to CommCare HQ carry the fence too (`admitAppWrite`,
`admitAppCreate`, `admitWorkbookWrite`, `admitPlacesWrite`), so an ending
sends nothing after it
commits; an ending after the app landed leaves the publish landed with its
media not sent (`MEDIA_NOT_SENT_AFTER_STOP_WARNING`). The empty app a create
made while an ending committed, whose record the fence refuses, is recorded as
a superseded mapping dated the moment the publish began
(`store.ts::recordOrphanedRemoteApp`), so the ending stays the deployment's
latest and the left-behind report names that app beside it.

**What every reader does with an ended deployment.**

| Reader | What it does |
| --- | --- |
| Preview's project space (`readDeploymentPreviewRecords`) | `ended` does not display as `uploaded`, so the project space is not named; a released mapping on a live app is left out too |
| `.ccz` and the HQ import file's attachment links (`readReachedDeploymentTargets`) | no live mapping, so it is no reached target; a download in flight when the ending commits is made wholly from before it, in one snapshot, never the old HQ app with derived ids |
| deep links (`getEntryPointLink`) | no manifest and no published app, so it asks for a publish first |
| Check status (`refreshDeployment`) and the kept values' refresh (`refreshKeptValues`) | say that publishing there stopped and read nothing of CommCare HQ |
| provisioning workers (`provisionWorkers`) | refuses, saying publishing there stopped |
| the Publishing card, the dialog's row and MCP's `check_project_space_compatibility` (`nextPublishAction`) | `creates-beside` while `deploymentEnding` is not null; the check answers it as `new_app_beside`, the dialog's sentence |
| the left-behind report (`leftBehindResources`) | the `app` mapping a standing ending names is not left behind, since the ending's line names it, nor one ended `claimed-elsewhere`, since another Nova app publishes to it; once a publish records a new app, or a later ending names another, a `stopped` one is left behind, unless another Nova app now holds its HQ app: no superseded `app` mapping a live, unreleased mapping of another deployment holds is ever left behind (`heldByAnotherApp`, marked by `store.ts::loadResources`), since that app publishes to it |
| `earlierHqApps` (the `.ccz` version) | counts the ended mapping like any superseded `app` mapping |
| the setup artifact | no HQ app id, so no link into the app's pages |
| placements, migration notices, drift | unchanged: an ending changes no hold, and no mapping means nothing is compared |

**A later publish creates afresh.** A publish to an ended deployment is a
first publish in every step: no in-place update is planned, no identity row
and no media path exists, so the empty app and its fill carry derived ids and
paths, and the project space then holds two apps with no `xmlns` in common.
`recordCreatedRemoteApp` takes the claim for the new HQ app, and its `create`
baseline replaces the old one.

## The setup artifact regenerates, always

`setupArtifact.ts` derives from the document on every read and is never
stored. A stored copy goes stale the first time a worker property is
renamed, and somebody following stale instructions has no way to tell.

Worker fields and automations retain authored order. Organization levels and
their place summaries share a parent-before-child projection, preserving
authored order between available branches. Place summaries key by level UUID,
so names remain projections through renames; only live places count toward
current totals and adoption. This is generated guidance, not an assertion
that a manual HQ setup step has been completed.

The organization's sections read the app's places with their origin
(`SetupArtifactOrganization`, the organization snapshot's `locations` and
`hq`), and `setupArtifact.ts::placesManagedOn` decides, as preflight's
`placesManagedHere` does, whether CommCare HQ manages them on the target.
There the levels are that project space's own and no API says which take
workers, so the levels section is a record: each level, and whether a
person confirmed it takes workers (the deployment's `worker-level`
confirmations) or that Nova asks before it makes a worker who stands there,
never an instruction drawn from the document's default, then each
confirmation whose code no level holds now. Every surface names a
`worker-level` confirmation through one function,
`lib/publish/planFeatures.ts::workerLevelConfirmationLabel`: by the level's
name, as provisioning asked, with CommCare HQ's code beside it where the two
differ, and a code no level holds as the code with the words that the level
is no longer in the organization. The places section
says they live in CommCare HQ and a publish sends none, and there is no place
information section. Any other project space gets the instructions, since
the copy goes there as places Nova made. An organization that could not be
read leaves all three sections out.

The `distance-search` section names each `(case type, property)` a
`within-distance` in a CommCare HQ search reads
(`lib/commcare/distanceSearches.ts::distanceSearchProperties`, over the
clauses `composeXPathQueryClauses` sends for every module whose effective
Search lands; a relation read names the case type it lands on). HQ answers
the query on `case_properties.geopoint_value`, which its case search pillow
fills only for the project's geo case property (`GeoConfig`, `gps_point` by
default) and, under `DATA_DICTIONARY`, for the properties the Data Dictionary
types GPS (`corehq/pillows/case_search.py::_add_smart_types`). The Data
Dictionary is target-owned and takes edits only from a browser session
(`data_dictionary/views.py::update_case_property`), and no API key reads the
geo property, so every property stays listed, always. The plan requirement
(`DATA_DICTIONARY` and `DATA_DICT_TYPES`, both first in `advanced_v0`) is
said in the section's caveats, not asked as a plan-feature confirmation:
`confirm_plan_features` is a served MCP enum. Its copy lives once in
`lib/publish/distanceSearchSetup.ts`, which the HQ import file's guide reads
too.

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
never the body for that reason. Native HTTP failures, invalid JSON and timed-out
body reads return an uncertain write outcome; they cannot throw away a generated
credential. Creates require HTTP 201 and a routeable ID; updates require HTTP 200
and the exact requested ID. Both reads and writes own 30-second deadlines and
refuse redirects. An update never sends a password at all,
because an update is what an account somebody is already using gets.

**A refusal is not proof that nothing happened.** `obj_create` wraps its
whole creation in `except Exception:` and calls `bundle.obj.retire(...)`
plus `django_user.delete()` before re-raising, but that guard covers only
what is raised inside it, and the account is committed before tastypie
serializes the answer. A real project space answered 500 with the worker
live. So every refusal from `hq/workers.ts` carries `mayHaveLanded`, and
`lib/commcare/hq/http.ts::writeMayHaveLanded` is the ONE definition of it, shared with the
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
gathers the same errors into one 400. The places a persona stands in reach
CommCare HQ's ids through the deployment's `location` mappings and, for
places CommCare HQ manages in the target, through each place's
`hq_location_id` (`managedData.ts::readManagedPlaceIds`): such places were
never pushed, so no mapping names them. A managed place a refresh kept live
with `hq_gone_at` set is one CommCare HQ no longer has
(`api/user_updates.py::_verify_location_ids` reads `active_objects`); it keeps
its `hq_location_id`, so a later refresh that finds it listed again matches it
by that id and clears the mark. A persona standing in one is
refused up front (`place-gone-from-hq`) rather than made and then refused its
places on every retry. A refresh never moves a row to another CommCare HQ place
(`lib/organization/CLAUDE.md`), so a place CommCare HQ deleted and made again
under its code is a new place, and a persona standing in the old one is refused
the same way until a person moves them.

**A level of managed places takes workers only once a person says so.**
CommCare HQ's level API returns no `has_users`
(`locations/resources/v0_5.py::LocationTypeResource`), so a reading gives every
level the document's default, `workers: "assigned"`, which Preview and the
document read. HQ's worker API does not check the setting
(`api/user_updates.py::_verify_location_ids` checks only that the ids are active
places of the project space), while its own pages refuse such an assignment
(`users/validation.py::validate_assigned_locations_allow_users`). So a persona
standing in a managed place is refused before CommCare HQ is asked anything
(`level-unconfirmed`, and the refusal `worker_levels_unconfirmed` naming each
level with its code and the personas that would stand there) until a person
confirms the level takes workers there: the caller comes back naming the codes
in `confirmWorkerLevels` (MCP's `confirm_worker_levels`), which are recorded as
`worker-level` confirmations of the deployment once every problem Nova can
know of passes, before the username search
(`store.ts::recordWorkerLevelConfirmations`, under the fence). One stands until
someone withdraws it, like every confirmation. A place a publish pushed asks
nothing: its level is one a person authored, and the setup artifact asks them
to make CommCare HQ match.

**A write sends what Nova states, by who owns the account**
(`workerProvisionPlan.ts::workerWriteOf`). An account Nova made is Nova's
statement whole: every declared worker property, empty where the persona holds
no value (`users/user_data.py::UserData.update` touches only the keys it is
handed), and its places, cleared where the persona stands nowhere in an app with
an organization (`::_update_location` reads an empty list as "remove all"). An
account Nova took over is a person's, made and assigned by hand in CommCare HQ,
so a write sends only what its persona states: the properties the persona or
its role holds a value for (a blank override is a value) and its places only
where it stands somewhere. Taking an account over therefore never clears its
places or blanks its worker information; the conflict refusal says so. An app
with no organization sends no places for any account.

**An account made while someone stopped publishing is recorded.** Each worker
write is admitted immediately before it goes (`store.ts::admitWorkerWrite`,
`hq_remote_writes` kind `worker`, under the fence), so an ending since sends no
further account and answers `app_not_published`, and a Project move waits while
an account may still land. An app deleted, or a caller who can no longer edit
it, by the next admission sends no further account either: before any account
the call answers the deletion (or the not-found) as every write does, and
after one it answers `app_not_available` with the accounts made, their
passwords and the deletion's sentence (or the not-found's) beside them, since
those passwords exist only in that answer. What landed is recorded with no fence
(`store.ts::recordProvisionedWorkers`), since an ending keeps every worker
mapping, and the same transaction settles the call's admissions. What the call's
writes made is recorded on the authority of their admissions
(`store.ts::lockAppForAdmittedRecord`: each a worker write this caller
admitted for this app, Project and project space), so an app deleted, or a
caller who lost edit, between the admission and the record still has the
account recorded as Nova's, and a restored app holds it. Only the
reconciliation against the document's personas needs a caller who may edit a
live app, and otherwise waits for the next call. The call answers the record
only to a caller who may still read the deployment (`RecordAnswer`); one
removed from the Project, or whose app was deleted, gets the accounts and
their passwords and no record.

## Surfaces

Builder (the App setup Publishing section and the publish dialog) and MCP
(`check_project_space_compatibility`, `get_deployment`, `refresh_deployment`,
`withdraw_deployment_confirmation`, `provision_workers`, `stop_publishing`),
the three that bring an app in (`list_hq_apps`, `read_hq_app`,
`bring_in_hq_app`), and the two that bring in changes made in CommCare HQ
(`read_hq_changes`, `bring_in_hq_changes`, which call
`hqChanges/review.ts::reviewHqChanges` and `hqChanges/bringIn.ts::bringInHqChanges`
after the routes' own authorization); none is given to the Solutions Architect.
`bring_in_hq_changes` alone takes `discard_nova_changes`, the client's statement
that the person agreed to lose the changes made in Nova the review listed: a
bring-in refuses it, taking nothing, where it is not what the review holds
(`HqChangesDiscardMismatchError`). Every deployment the MCP tools project
carries `nova_revision` beside `pushed_revision`
(`store.ts::readDeploymentNovaRevisions`): the revision CommCare HQ's copy was
last known to match, which a bring-in of changes moves and no push makes.
A tool whose write has landed (an upload, a check, a kept refresh, a stop, a
withdrawn confirmation, whose setup artifact is read there too) reads it and
the resource names through `lib/mcp/tools/landedReads.ts`, which
answers a fault by leaving `nova_revision` out and the names null, logged by
class and code, never by failing a write that landed. `bring_in_hq_changes`
reads `nova_revision` there too; the record, the setup artifact, the
left-behind list, the kept list and the next publish's list come from the
bring-in's own read (`hqChanges/bringIn.ts::deploymentViewOf`), which answers
a fault in any of them with less, never an error: the record or the artifact
unread is no record (`deployment` null, and the builder reads its records
again), the resource names unread a left-behind list of superseded apps alone,
and the kept list or the next publish's list unread none.
**Deliberately not the Solutions Architect** — the same standing decision
that keeps project-space compatibility checks off that surface. A deployment is
durable state about somebody else's server, not authored vocabulary an
agent designing an app should reason about.

Data CommCare HQ manages is reached the same way: `managedData.ts` holds a
table's Refresh, Manage in Nova (the Project's `delete`, reading nothing of
CommCare HQ) and Let CommCare HQ manage it again, the places' Refresh, and
the two views the table page and Organization banner read;
`managedDataActions.ts` holds their Server Actions, each taking plain JSON and
resolving the Project freshly from the id it was given, and MCP's
`refresh_managed_data` and `set_lookup_table_management` call the same
services. Each table service reads the member's role again on the
transaction that writes (`lib/lookup/writerTransaction.ts`), after any read of
CommCare HQ, so a member demoted or removed during that read changes nothing
(`not-permitted` with the sentence naming who can, or `not-found`). The table's
view answers a `reviewDigest` (`lib/lookup/managed.ts::managedTableReviewDigest`
of who manages it, its two revisions and the apps that read it); Manage in
Nova and the hand-back take it back, refuse `review-moved`
(`MANAGEMENT_REVIEW_MOVED`) before reading anything where the table no longer
stands so, and hold the write to that review under the table's lock, so an
edit or a new reader that lands while CommCare HQ is read stops it. The
browser reads the view again and shows the change as it stands; MCP's
`set_lookup_table_management` answers the preview again with a new
`review_digest`. Every refusal of a refresh or a hand-back leaves the copy as it was,
and the builder and MCP say each outcome in one text
(`lib/publish/managedData.ts::managedTableOutcomeLines` and
`managedPlacesOutcomeLines`).

**The Builder splits the work: the dialog publishes, the section manages.**
App setup's Publishing section (`components/builder/app-setup/
PublishingSection.tsx`) is the durable home of the records — one full
`DeploymentStatus` card per project space the app has reached, with Check
status, the Workers panel, and a "Publish again", and the list of what stays
as it is in CommCare HQ with its date and Refresh from CommCare HQ
(`components/builder/keptListModel.ts`). "Publish again" reopens
the ONE publish dialog preseeded to that target through a one-shot
session-store request, so a retry never grows a second publish flow. The section's read
authorizes as a `view`, which is what gives a viewer the answer to "where
is this app" without any control that would be refused.

**The dialog opens on the records too, not only after a publish creates
one.** `readDeploymentsAction` loads every project space this app has
reached when the dialog opens. The records tell the form whether the
selected project space gets a fresh app, the empty app an earlier try made
filled in, or an in-place update (`nextPublishAction`, over
`plannedInPlaceUpdate`, the same predicate the publish applies), and
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
that switching the destination select causes. The two surfaces converge
through the builder session: every dialog upsert bumps
`deploymentRecordsRevision`, and the section reloads on it. Refreshes return
`preview` beside the record (a publish answers `preview_project_space` and
`preview_target_facts`) and the caller applies it, so the own tab updates
without waiting for the stream. A read that faults is no answer: a refresh
then returns `preview: null` and a publish leaves both keys out, the tab keeps
what it holds, and the stream brings the new answer. A publish, a Check
status or a kept refresh whose write landed answers as landed whatever faults
after it: a kept list it cannot read is `unread`
(`service.ts::landedDeploymentKept`, logged by the fault's class and code
alone), which a publish answer and MCP leave out and a card answers by keeping
the list it shows (`keptListModel.ts::refreshedViewToShow`), rather than
turning the answer into a failure someone repeats the write over. Every OTHER open tab
converges through the app stream's deployment lane — each store write
pokes it (`notifyAppDeployments`, in the write's own transaction), and the
relay re-resolves and emits the `preview-project-space` frame, and the
`preview-target-facts` frame when the facts changed
(`lib/preview/CLAUDE.md` § `commcare_project`).

**Changes made in CommCare HQ are one panel in three places.**
`components/builder/HqChangesPanel.tsx` draws a review and its choices over
the review and bring-in routes: in the publish dialog in place of the app's
item where an `hq_changed` refusal's app change has `canBringIn`, in the
Publishing card's dialog where Refresh from CommCare HQ answers
`changed-in-hq`, and from the builder header's See what changed in CommCare
HQ. That button is the answer of **the check when the builder opens**:
`hqChanges/check.ts::checkHqChangesForApp`, behind
`POST /api/commcare/changes/check`, which authorizes `edit` and asks, one
deployment at a time and stopping when the request is cancelled, for each
deployment with a usable pair that the member's own key reaches, whether
CommCare HQ's copy changed (`service.ts::peekReadDeploymentChanged`, Refresh's
comparison with no write over the deployment and baseline the check already
read, so each baseline is unzipped once, the moved recorded file ids counted). It writes
nothing and answers 200 with only the project spaces that changed; a failure
is logged at warn with the app's id and listed nowhere. It is a Route
Handler's `fetch`, never a Server Action, since a tab's Server Actions run one
at a time and the builder's deployment reads are Server Actions, and no
module that carries `"use server"` reaches it.

The Workers panel (`components/builder/DeploymentWorkers.tsx`) lives inside
each record's card in the Publishing section — and ONLY there:
`DeploymentStatus` takes it as a composed `workers` slot the section fills
and the dialog leaves empty, so a worker's password has exactly one surface
that can ever show it. What that surface shows is held in the builder
session per target (`provisioningOutcomes`, folded by
`workerProvisionPlan.ts::foldProvisioningOutcome`), never in the panel: it
unmounts on an ordinary App setup section switch, and a password shown once
must survive until the person leaves the page. The transient ceiling is the
same as the unconfirmed credentials' — nothing persists it, a page load
clears it. It sits inside the record's card for the same reason
the ledger keys a worker on `(persona, target)`: an account belongs to a
project space, and the same persona can hold a different username on each.
It stays quiet until the app is actually there, because the places a
persona stands in only exist over there once a publish has put them there.

## Two things the record answers besides publishing

`readDeploymentPreviewRecords` serves `previewSpace.ts` alone, from one read
of four columns (`state`, `resume_phase`, `server`, `domain`), and filters with
the DISPLAY predicate `deploymentDisplaysAsReached(record, "uploaded")`: a probe
that could not be checked did not undo the upload, and withdrawing either
answer over it would change the app for a reason that has nothing to do with
the app. It also leaves out a deployment whose live `app` mapping is released
("One HQ app, one Nova app"), which still displays as uploaded and is
published to by another app.

- `previewTarget.ts` names the project space Preview resolves
  `commcare_project` to. A slug is the whole answer, so it de-dupes on the
  domain alone.
- `attachmentTarget.ts` names where a capture's case-bound link resolves.
  An origin is part of that answer, so it de-dupes on `(server, domain)` —
  US, India, and EU can hold unrelated project spaces of the same name, and
  picking either origin would build links that open for one set of workers
  and nowhere for the other.
- `downloadTarget.ts::resolveDownloadTarget` names what a download is made
  for, over `store.ts::readReachedDeploymentTargets`: for a `.ccz`, the one
  published project space it signs workers in to, with that deployment's
  ids, or the refusal that lists the published spaces, or, for a project
  space whose app holds a custom base URL elsewhere, the refusal
  `workers-sent-elsewhere` naming its host, since a `.ccz` names only the
  server the app is published on; for the HQ import file, only where its
  attachment links resolve. Whether a published space can have a `.ccz` is one
  read, `downloadTarget.ts::readCczStanding`: the space's kept facts from its
  stored baseline (`readTargetFacts`, nothing asked of CommCare HQ) and the one
  decision over them (`runtimeTarget.ts::workersSentElsewhere`). The download
  turns it into its refusal (`cczUnavailableRefusal`) and the publish dialog's
  list (`actions.ts::readDownloadTargetsAction`) into each space's
  `unavailable`, so the list never offers a space the download refuses. A space
  whose baseline is absent or unread has no facts and is offered; its download
  reads the facts again when it is made. For a `.ccz` the target also
  carries `earlierHqApps`, the count of the deployment's superseded `app`
  mappings, which the compiler adds to the version it writes on the profile, both suite resources and `<suite>`: the file made
  after a deleted HQ app is made afresh is newer though the document did not
  change. Its read deliberately does NOT swallow a fault the way
  `previewSpace.ts` does: degrading to "no target" would silently drop a case
  write from the exported app.
- `previewSpace.ts::readPreviewDeploymentAnswer` names, from one read of the
  records, the project space and what Preview may read of its kept values,
  for the one reached `(server, domain)` or not at all. The facts are one
  deployment's, so `previewTarget.ts::resolvePreviewFactsTarget` de-dupes on
  `(server, domain)`: one domain on two servers gives none, and the facts
  come from `readTargetFacts`. It throws on a fault, so the stream's
  deployment lane retries rather than announcing a failed read as `null`;
  `previewDeploymentAnswerFor` gives `null` for one, which the builder page's
  seed and a landed write's answer treat as no answer.

Both are resolution, never authority. A PUBLISH consults neither: an upload
IS the act of putting the app on a project space, so `preflight.ts` passes
its own `(server, domain)` straight through.

## Tenancy

Keyed by `(app, Project, server, domain)`.

**Reads prove the Project as writes do, by one rule.** A deployment read and a
deployment write make the same authorization of the app row
(`store.ts::authorizeDeploymentApp`): the app is the scope's Project's and the
caller holds the capability there (else not-found), and only then that it is
not deleted (else `DeploymentAppDeletedError`, a not-found that names the
deletion in the read's or the write's words, so only a member allowed the act
learns of it). A write takes it on the locked app row
(`lockAppForDeploymentWrite`, and the settle of released claims on the rows
its lock protocol took). Every read of an app's deployments
runs in one read-only repeatable-read snapshot
(`store.ts::withDeploymentReadSnapshot`), whose first statements make it; the
readers take that snapshot (`DeploymentReadFrom`: a scope opens its own) and a
deployment's ledger, its names and its baseline bytes are loaded by deployment
id only inside one or inside a write that holds the app and deployment rows
(`loadResources`' `LedgerReader`). So one answer (a download's target, ids,
paths, prefixes and facts; the Publishing section's and `get_deployment`'s
records, ledgers, revisions and kept lists; Preview's project space and facts;
who moved a head a bring-in of changes met) is one generation, for a caller
allowed to see it then: a move or a stop that commits meanwhile is wholly before
it (not found) or wholly after it. The snapshot takes no lock and pins one
connection for a few statements; nothing inside it asks CommCare HQ anything,
and no CPU work over a stored source runs inside it: a baseline's bytes are
verified and projected after it is released (`targetFactsOf`). The server is part of the key
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
`projectMove.postgres.test.ts` asserts the row actually moved rather than
that the move merely succeeded.


## Deep links are freshly checked release observations

`entryPointManifest.ts` compiles the exact prepared upload snapshot and records
its entry-point UUID, destination UUIDs, external ID, required selections and
suite navigation signature. `content_generation` is invalidated before the
first remote dependency/app write. Completion binds a manifest only to the
same generation and active remote app; an obsolete completion invalidates
newer evidence because remote write order is then uncertain. These remain
short transactions, without locks across HQ requests.

`getEntryPointLink` is the shared Builder/MCP service. It authorizes a selected
server target, checks Deep links support, resolves an exact released build,
reads its profile and suite with redirects disabled, compares the endpoint's
reachable command/menu/selection definitions, checks required dependency
mappings and remote presence, and compares generation/mapping again before
recording the observation. Resource URL normalization accepts only the known
working/build IDs and preserves host/domain. A transient failure retains old
observations as history but never returns a newly verified URL.

Navigation signatures keep their canonical-JSON storage shape. At comparison,
`endpointSignaturesMatch` validates both stored and freshly read signatures and
parses their known XPath carriers with Lezer. Syntactic whitespace and quote
choice do not change identity; literal contents, operators, operand grouping,
URLs and the reachable definitions do. Unknown shapes and malformed XPath
provide no release evidence, including in an older stored manifest.

The returned HQ link names the working app. “Released build checked” describes
copy-time evidence, not a pinned build or an atomic remote snapshot. HQ controls
recipient authentication, available builds and claim/sync behavior. Never probe
the endpoint itself: opening it can claim cases. Multiple selections use HQ's
comma transport, with empty, duplicate, excessive and comma-containing IDs
refused before any request. These are external HQ IDs, never substituted Nova
case IDs.


A checked link names the current committed authoring snapshot. Its sequence
must equal the manifest's uploaded sequence before HQ reads begin and must
still match under the final app-row lock. This covers changed selection
cardinality, bypass, filters, topology and endpoint removal without a second
partial authoring fingerprint. Even unrelated committed edits require a new
publish before another checked copy; existing URLs retain HQ's behavior.


Worker credentials live together in `provisioningOutcomes`, keyed by server and
project space. The per-target fold retains every distinct unconfirmed password
for a persona/username; repeated uncertain creates cannot disprove earlier ones.
Only a confirmed create for that exact account clears its old candidates, and
explicit dismissal removes one candidate on one target. Hooks select that target
before rendering. Account adoption proves existence, not a candidate password;
`workerCredentialRows` shares the complete rows and uncertainty labels with the
clipboard. Nothing persists these values; reset/page teardown clears them.

A same-named replacement account cannot inherit a confirmed password: the held
fold checks the remote account ID and retains the displaced password as an
unconfirmed candidate. A lost browser response may follow a completed create;
the panel invites checking HQ and explains that undelivered passwords need reset.

`lib/commcare/planPrivileges.ts::formsUsingWorkerRecord` names the forms that
use the worker's own record, for preflight, setup and the `worker-records`
confirmation alike: `lib/domain/workerRecordRequirements.ts`'s form XPath/prose
reads and admitted writes, and each Connect deliver form whose entity the
emitter defaults to the worker's username. HQ requires the USERCASE privilege,
which the person confirms, and a restored record, which Nova cannot verify.
Read-only forms can silently get blank values; writers have a native entry
assertion. Record-scope session expressions are not worker-record reads.
