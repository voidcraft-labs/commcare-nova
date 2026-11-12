# Step 6, part 05: Reading CommCare HQ

This part plans everything Nova's HQ client gains so that an app can be brought in: the app list a
picker shows, one reader of HQ's application resource (builds, real form ids and HQ's question
summary), the wider source read, the bracketed read that ties those two to one saved version, the
alignment of real form ids to the source, the media byte reader, the lookup table and place reads a
reading reuses, API access checked first, one retry rule for throttled reads, deadlines and byte
bounds, and one classification of every failed HQ answer, which the four hand-written status ladders
move to. It plans pull request B1 in full. It adds no document slot, no table, no migration, no
route and no MCP tool.

Citations are `path::symbol`: Nova at `main` `15a00a97`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`.
Every HQ fact below was read at `d6c6e16d8ae1` for this part; HQ paths are under `corehq/apps/`
unless they start elsewhere. A fact that was read and not run is settled by a run of section
"Written and not yet run", which names every such fact in its question; "(inferred)" marks the two
that "Claims corrected" states. Part 01 (`01-the-bar-and-the-manifest.md`, A2) is cited by its
sections 8.3 and 9.3: it owns `READ_CIRCUMSTANCES`, the standings and the binding copy, and this
part uses its codes by name. Every other part is cited by its number, its file name, its section
and its pull request.

| Section | Owns | Pull request |
|---|---|---|
| 2 | `readHqJson`'s contract: distinct causes, the refused body, the bounded body reader, a cause on every synthesized failure | B1 |
| 3 | throttling and the retry rule; deadlines, the budget of a reading's first step and byte bounds | B1 |
| 4 | the one failure classification, `classifyHqFailure`, and `hqReadCircumstance`, which names part 01's code | B1 |
| 5 | `listHqApps` and `probeHqApiAccess` | B1 |
| 6 | `readHqApplication` and `hqApplicationModules` | B1 |
| 7 | the source read, widened | B1 |
| 8 | the bracketed read `readHqAppForReading`, `alignHqForms` and `notSummarizedMenus` | B1 |
| 9 | `readHqMediaFile` | B1 |
| 10 | lookup table definitions and rows; places and levels; the flag probe | B1 |
| 11 | credentials by a name that fits a read | B1 |
| 12 | the four ladders | B1 |
| 13 | MCP scopes | none (part 13, `13-the-experience.md`, section 14, builds the tools in B12) |
| 14 | retained reads and the surface manifest's `hq-api` family | B1 |

---

## Decisions in brief

1. **Every JSON read keeps one reader, `lib/commcare/hq/readJson.ts::readHqJson`, and from step 6 it
   tells five failed answers apart** (section 2): no answer (`network`), the deadline (`timeout`), a
   body over the bound (`too-large`), a page for a browser where JSON was asked (`browser-page`), and
   JSON or text Nova cannot read (`malformed`). Today the last three are one `malformed`.
2. **A refused body reaches the client only where a read asks for it** (section 2):
   `keepRefusedBody` returns at most 2,048 characters as `CommCareApiError.refusedBody`, and only
   `lib/commcare/hq/http.ts` reads it, to match two sentences of
   `api/resources/__init__.py::HqBaseResource.dispatch`.
3. **Every read waits out a short throttle, by one rule** (section 3): at most three sends; a
   `Retry-After` of at most 2 seconds is waited; a 429 with no `Retry-After`, which is what a tastypie
   resource sends, waits 1 second; a longer `Retry-After` is the refusal. The wait runs inside the
   read's own deadline, which a caller that owns one hands the reader as an instant beside its signal.
4. **One pure classification, `lib/commcare/hq/failure.ts::classifyHqFailure`, maps every failed
   answer to one of fourteen kinds** (section 4), and `hqReadCircumstance` maps a kind and what was
   asked to a `READ_CIRCUMSTANCES` code of part 01, so a failed table read is never worded as a
   missing app. Part 01 owns that list; B1 adds the seven members these reads need, which part 01
   holds with their standings (its section 8.3) and their copy blocks (its section 9.3):
   `hq-gateway-refused`, `api-cut-off`, `browser-only`, `remote-app`, `cannot-read-organization`,
   `app-unreadable-in-hq` and `table-rows-unreadable`.
5. **The picker reads `views/cli.py::list_apps` and nothing heavier** (section 5):
   `listHqApps` returns each working app's id, name and save counter. HQ's row carries no kind, so a
   linked app and a remote app look like any other until one is picked.
6. **API access is checked when the project space is chosen** (section 5):
   `probeHqApiAccess` asks the lookup table resource for one row and answers `available`,
   `plan-lacks-api-access`, `account-lacks-access-apis` or a failure. The application resource read
   classifies the same refusals again, so a plan that changed since the probe is still told
   truthfully.
7. **One reader serves the application resource** (section 6):
   `lib/commcare/hq/application.ts::readHqApplication` checks the envelope and the builds and keeps
   the modules unread; `hqApplicationModules` types them (real form ids, `xmlns`, HQ's question
   summary, or HQ's error in place). `lib/commcare/client.ts::listAppBuilds` is removed and its two
   callers read `builds` from the one reader, which bounds the body at 64 MiB.
8. **The source read gains `name`, `lastModified` and a checked `multimediaMap`, each nullable, and
   each menu's and form's `docType`** (section 7), so no publish read can newly fail on them; `gone`
   says whether HQ deleted the app. A mirror menu stores a null `case_type` and a shadow form a null
   `xmlns`, and a menu may store no `unique_id`: a reading reads all three (`admit: "any"`), so each
   is one finding at its place, and a publish read refuses them exactly as today (`admit: "plain"`,
   the default).
9. **A reading's app read is one bracketed attempt under one 120 second deadline** (section 8):
   `lib/commcare/hq/appReading.ts::readHqAppForReading` reads the application resource (version V),
   the source, then `views/releases.py::current_app_version`, and answers `changed` when the counter
   is not V. It never retries the bracket itself: the reading (part 12,
   `12-the-reading-and-the-birth.md`, section 3.3, B10) runs the attempt again on its next step,
   once, and a second `changed` is the circumstance `changed-while-reading`. The table, level and
   place reads of the same step share one further 60 second deadline
   (`HQ_PROJECT_DATA_READING_DEADLINE_MS`), which leaves 90 seconds of the 270 second step for the
   reader, acceptance and the write.
10. **What marks a linked or a remote app is an answer, never a guess** (section 8): the source's
    `doc_type` `LinkedApplication` is `linked`; an app the list holds that the application resource
    answers 404 for is `remote`, because the list's view emits three document kinds and the resource
    admits two of them.
11. **Real form ids align to the source by position, held by `unique_id` and `xmlns`** (section 8):
    `alignHqForms` pairs module i with entry i and form j with form j, and refuses the read as kind
    `answer-unreadable` on any disagreement of module id, form count or `xmlns`. A shadow form is
    held by its parent's `xmlns`, which is what the application resource reports for it. A menu
    that stores no `unique_id` is read with a null one and aligned by position alone. A module HQ
    returns as an error is one finding at that menu, and the other menus still align; where HQ
    returns every menu it would summarize as an error, the finding is one, at the app.
12. **Media bytes are read by `lib/commcare/hq/media.ts::readHqMediaFile`** (section 9), from the URL
    `hqmedia/models.py::HQMediaMapItem.url` gives each map entry, bounded by the caller's limit for
    that kind, with a 60 second deadline a file, four files at a time. The adapter returns bytes and
    the declared type as a hint; `lib/media` is what says what a file is.
13. **Lookup rows are read through `fixtures/resources/v0_1.py::FixtureResource`, as today**
    (section 10). `LookupTableItemResource` is not read: its list has no table filter. What Nova's
    table model cannot hold is detected from the definition read (field properties, row attributes, a
    table that is not global) and from the rows (a field holding other than one value), and is
    `not-yet`.
14. **`lib/db/settings.ts::resolveUploadTarget` and `getCredentialsForUpload` become
    `resolveHqTarget` and `getHqCredentials`** (section 11): a reading does not resolve an upload.
15. **The four ladders choose their sentences by failure kind** (section 12), in B1. Settings and
    the import print every sentence they print today for every answer; the source read and the table
    list each change one sentence for an edge's 401 or 403, and the table list refuses a malformed
    definition it skips today (Changes 1 to 3 under Contracts).
16. **The reading's answers of HQ are retained** (section 14): a new group `proof/hq-reads/reading/`
    that `proof/hq/test_retained_reads.py` makes and holds byte for byte, through requests B1 keeps
    in `proof/views/reading_reads.py`, and seven gated runs settle each inferred claim there.
17. **The `hq-api` family records `FixtureResource`, which Nova calls today and the family does not
    hold, and drops `LookupTableItemResource`, which Nova calls nowhere** (section 14). The media
    read gets no generated item and no retained answer (Departure 3).

---

## Executed during planning

Nothing was run. Read in full or by enclosing function, for this part:

- **Nova's client.** `lib/commcare/client.ts` (`listDomains`, `listDomainsMatching`,
  `probeHqProjectSpaceCompatibility`, `probePrivateFeatureFlag`, `probeCaseSearchRuntime`,
  `testDomainAccess`, `discoverAccessibleDomains`, `importRetryWaitMs`, `importApp`,
  `uploadAppMediaBundle`, `readAppVersions`, `listAppBuilds`, `probeBuildProfile`, `readBuildXml`);
  `lib/commcare/hq/http.ts`, `readJson.ts`, `readCollection.ts`, `deadline.ts`, `appSource.ts`,
  `lookupTables.ts`, `locations.ts` (`listHqLocationTypes`, `listHqLocations`,
  `malformedInventory`); `lib/db/settings.ts` (`resolveUploadTarget`, `getCredentialsForUpload`,
  `refreshApprovedDomains`, `RefreshDomainsResult`); `lib/media/validate.ts` (`validateMediaBytes`,
  `classifyStoredMediaBytes`); `lib/deployment/hqSourceBaseline.ts::normalizeHqAppSource` and
  `lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks`, for what a publish reads of a
  source's menus and forms.
- **The ladders.** `app/(app)/(site)/settings/actions.ts` (`invalidKeyMessage`,
  `settingsErrorMessage`, both callers); `lib/deployment/service.ts::importRejectionMessage`;
  `lib/deployment/preflight.ts::hqAppSourceReadFailure` and the `project-data` edge of
  `runDeploymentPreflight`; `lib/deployment/observe.ts` and `entryPointLinks.ts` where they call
  `listAppBuilds`.
- **The tests the changes reach.** `lib/commcare/__tests__/client.test.ts`,
  `discoverAccessibleDomains.test.ts`, `appReadings.test.ts`, `appSource.test.ts`,
  `hqLookupTables.test.ts`; `lib/deployment/__tests__/observe.test.ts`;
  `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`, `deploymentTools.postgres.test.ts`,
  `entryPointLink.postgres.test.ts`; `app/(app)/(site)/settings/__tests__/commcare-actions.test.ts`,
  each where it serves or expects an answer this part changes.
- **The lane.** `proof/hq/test_retained_reads.py` (its contract, the `Retained` holder,
  `_keep_raised`, and the `hq-built` state, whose retained source
  `proof/hq-reads/hq-built/app-source.json` holds a shadow form and a report menu),
  `proof/hq/operations.py` (`api_request`, `HqAnswer`, `seed_api_user`, `seed_api_key`, the read
  helpers, `link_app_through_hq`), `proof/hq/boot.py` (an exception a view raises is answered by
  HQ's `handler500`), `proof/hq/configuration.py::Configuration`,
  `proof/observe/partition.py::OBSERVATION_DIRECTORIES` (which holds `proof/hq/` and not
  `proof/views/`),
  `proof/surface/families/hq_api.py` (`VIEWS`, `RESOURCES`, `_view`, `_routes`),
  `proof/surface/test_hq_api.py::NOVA_PATHS`, `__tests__/helpers/retainedHqReads.ts`, and the
  `hq-api:` items of `lib/commcare/surface/surface.json`.
- **HQ.** `app_manager/views/cli.py::list_apps`; `domain/models.py::Domain.applications`;
  `app_manager/dbaccessors.py` (`get_brief_app_docs_in_domain`, `get_apps_in_domain`,
  `get_current_app_version`, `get_app`); `app_manager/_design/views/applications_brief/map.js`;
  `app_manager/views/apps.py::app_source`; `app_manager/models/applications.py`
  (`Application.export_json`, `scrub_source`, the class list); `app_manager/views/releases.py::
  current_app_version`; `api/resources/__init__.py::HqBaseResource.dispatch`;
  `api/resources/v0_4.py` (`BaseApplicationResource`, `ApplicationResource.dehydrate_versions`,
  `dehydrate_module`, `dehydrate_modules`, `dehydrate`); `api/util.py::get_object_or_not_exist`;
  `app_manager/xform.py::XForm.get_questions`, `_get_label_translations`;
  `app_manager/models/modules.py` (`ModuleBase.wrap`, `ModuleBase.get_forms`,
  `ModuleBase.get_or_create_unique_id`, `ShadowModule`,
  `ReportModule.new_module`, `AdvancedModule.new_shadow_form`); `app_manager/models/forms.py`
  (`FormBase.wrap`, `ShadowForm`); `app_manager/util.py` (`update_form_unique_ids`,
  `update_report_module_ids`); `app_manager/tests/data/suite/shadow_module.json`;
  `app_manager/models/case_list.py::DetailColumn.endpoint_action_id` and
  `app_manager/helpers/validators.py::ModuleBaseValidator.validate_case_list_field_actions`;
  `app_manager/models/delete_records.py::DeleteApplicationRecord.undo` and
  `app_manager/views/utils.py::_update_forms`; `api/resources/v0_5.py::UserDomainsResource`;
  `toggles/__init__.py::API_BLACKLIST` (under `corehq/`);
  `api/resources/auth.py` (`LoginAndDomainAuthentication`, `RequirePermissionAuthentication`,
  `wrap_4xx_errors_for_apis`, `get_rate_limit_identifier`); `api/resources/meta.py`
  (`api_rate_limiter`, `HQThrottle`, `CustomResourceMeta`); `api/decorators.py::api_throttle`;
  tastypie 0.15.1 `resources.py::Resource.throttle_check` (the version `uv.lock` pins);
  `domain/decorators.py` (`_login_or_challenge`, `api_auth`, `login_or_api_key`);
  `users/decorators.py::require_api_permission`; `fixtures/resources/v0_1.py` (`FixtureResource`,
  `LookupTableResource`, `LookupTableItemResource`), `v0_6.py`; `fixtures/models.py::
  LookupTableRow.fields_without_attributes`; `hqmedia/models.py` (`HQMediaMapItem`,
  `CommCareMultimedia.get_doc_class`), `hqmedia/urls.py`, `urls.py`;
  `locations/resources/v0_5.py::LocationTypeResource`; `settings.py::MIDDLEWARE`.

**Claims corrected.**

- *Read at source (why the source view fails for a `RemoteApp`).* `export_json` and `scrub_source`
  are defined on `Application` alone (`models/applications.py::Application.export_json`,
  `Application.scrub_source`); `models/applications.py::RemoteApp` extends `ApplicationBase` and has
  neither. `views/apps.py::app_source` calls `app.export_json(...)`, so a remote app fails on the
  missing method before any source is built, and never on a key of the source. The status is still
  (inferred); section 8 does not depend on it.
- *Claim corrected (research, "Reads": lookup rows through `v0_6.py::LookupTableItemResource`).* Nova
  reads rows through `FixtureResource` (`lib/commcare/hq/lookupTables.ts::readHqLookupTableRows`), and
  `LookupTableItemResource`'s list is every row of the project space
  (`FixtureResource.obj_get_list` is the one that takes `fixture_type_id`). Section 10 decides.
- *Claim corrected (research, "Source: HQ's API, only": a superuser's credential passes the plan
  check).* `HqBaseResource.dispatch` tests `request.user.is_superuser` before tastypie
  authenticates, and no entry of `settings.py::MIDDLEWARE` authenticates an API key, so a key's
  request reaches that test with the anonymous user (inferred; run G1).
- *Claim corrected (outline item 1, "the stored app source and form JSON" as one reading).* They are
  two requests with no shared revision: the source strips `version`
  (`ApplicationBase._meta_fields`, removed by `export_json`). Section 8's bracket is what makes them
  one reading.
- *Claim corrected (`lib/commcare/hq/appSource.ts`, the comment on `unsupported`: "the one HQ's
  source view serves is `LinkedApplication`").* True of app ids; a build's id is served too, as
  `Application` (`dbaccessors.py::get_app` does not test `copy_of`). A reading takes ids only from
  `listHqApps`, which holds working apps alone, and section 6 refuses an application answer that
  names a build.
- *Claim corrected (`proof/surface/families/hq_api.py`, its docstring: `LookupTableItemResource`
  "which the plan names for reading an HQ table's rows, is recorded beside them").* The resource Nova
  calls for rows is unrecorded and the one recorded is uncalled. Section 14 swaps them.
- *Read at source (the page size of `FixtureResource`).* `fixtures/resources/v0_1.py::
  FixtureResource.Meta.limit` is `0`, which tastypie reads as its `max_limit`; the page size Nova
  sees is whatever HQ serves, and no reader assumes a number of rows a page: `readHqLookupTableRows`
  follows `meta.next` and holds the pages to `meta.total_count` either way.
- *Claim corrected (`lib/commcare/hq/appSource.ts::HqAppSourceModule.caseType`, "`case_type`; the
  empty string for a menu with none", and the reader's check that every form holds a string
  `xmlns`).* A mirror menu stores `"case_type": null`: `models/modules.py::ShadowModule.case_type` is
  a property over its source menu and `ShadowModule.new_module` sets none
  (`app_manager/tests/data/suite/shadow_module.json`). A shadow form stores `"xmlns": null`:
  `models/forms.py::ShadowForm.xmlns` is a property that returns its parent's
  (`proof/hq-reads/hq-built/app-source.json`, the third form of the second menu, with its
  `shadow_parent_form_id`). Today's reader answers `malformed` for both. A report menu stores `""`
  (`ReportModule.new_module`), which today's reader takes. Section 7 decides.
- *Claim corrected (what the declaration of `models/case_list.py::DetailColumn.endpoint_action_id`
  as a `FormIdProperty` suggests: "`endpoint_action_id` keeps a real form id").* It is declared
  with `FormIdProperty` and no path, and what it holds is a form's session endpoint id:
  `helpers/validators.py::ModuleBaseValidator.validate_case_list_field_actions` compares it with
  `form.session_endpoint_id`. No source read rewrites it and no form id resolves it.
- *Claim corrected (the short reading of `models/applications.py::ApplicationBase.save`:
  "`ApplicationBase.save` raises `version` on every save").* Two saves of a working app pass
  `increment_version=False`: HQ's restore of a deleted app
  (`models/delete_records.py::DeleteApplicationRecord.undo`) and a linked app's pull
  (`views/utils.py::_update_forms`). Section 8.2 names both and why neither opens the bracket.

---

## Written and not yet run

Each run is a part of the new retained group (section 14), made by
`proof/hq/test_retained_reads.py::test_the_reading_reads_nova_is_served_are_hqs_own` in the proof
lane's image. It is run by hand on hosted runners through `.github/workflows/proof-slice.yml` over
`proof/hq/test_retained_reads.py`, on B1's branch before B1 is opened, never on a laptop. Each
outcome lands in B1. The code of sections 2 to 12 is written for each run's outcome A, which is what
the source read at the pin says. Any other outcome fixes a retained file, a test's expectation and
the sentence named, and four of them (G2's B and C, G3's B, G4's C) also move the one branch their
row names, in B1, before it is opened.

Where a view raises in place of answering, the lane keeps the exception's class through
`proof/hq/test_retained_reads.py::_keep_raised`, as `{"exception": "<class>"}`
(`proof/hq-reads/lookups/fixture-rows-plain-after-column-added.json` is one today). A deployed HQ
answers such a request with a status 500 through its `handler500`
(`hqwebapp/views.py::server_error`), so `retainedReadingRead` gives every such file to a test as
`{ status: 500, headers: {} }` with no body (section 14.1), and no test of Nova's ever serves an
exception's name. "A raised X" below means that file and that 500.

| Run | Question | Outcomes, and what lands for each |
|---|---|---|
| G1 | Does a superuser's key pass the plan check on a project space without API access? The key is `reading_reads.seed_api_superuser`'s (`proof/views/reading_reads.py`, section 14.1). Made through Django's test `Client` with `raise_request_exception=False`, so `settings.py::MIDDLEWARE` runs and an exception is answered by `handler500` (`reading_reads.client_request`, section 14.1). | **A**, 401 with the subscription sentence: `reading/application-no-api-access-superuser.json` holds it; `lib/commcare/CLAUDE.md` gains "A superuser's key does not pass the plan check." **B**, 200: the file holds the 200; the sentence reads "A superuser's key passes the plan check, so Dimagi staff may read a project space whose plan has no API access." **C**, the test `Client` cannot run in the lane's boot (a middleware asks for a service the lane does not hold): the read is made through `operations.api_request`, the file holds its 401, and the sentence reads "Read, not run: no middleware authenticates an API key before the plan check, so a superuser's key does not pass it." Under **B** alone B1 also rewrites the bullet on a superuser's key under "Found while planning step 6" in `harness-findings.md`, which that outcome withdraws ("Contracts and docs these changes make false", "The harness findings"). |
| G2 | What do the application resource and the source read answer for a `RemoteApp` the list holds? | **A**, resource 404, source a raised `AttributeError`: `reading/application-remote.json` is `{status: 404}`, `reading/source-remote.json` is the kept exception; nothing else. **B**, the resource answers 200: `readHqAppForReading`'s `remote` arm is unreachable through the 404, so B1 instead reads `doc_type` from the source when it answers JSON, and where the source raises, lands the `remote` arm on "the list holds the app and the source read answered a status of 500 or more that is not the edge's"; `hqAppReading.test.ts`'s remote case serves the retained pair. **C**, the list does not hold a remote app: the `remote` arm and the code `remote-app` are removed from B1, which then adds six codes to part 01's list, and such an id is `gone`. Under any outcome, where the retained source read answers a source and not the failure, B1 rewrites the sentence on a `RemoteApp` under "Found while planning step 6" in `harness-findings.md` to what the read answered ("The harness findings"). |
| G3 | What does the application resource answer when one form's XML is refused by `XForm.get_questions`? | **A**, 200 with `{"error": <text>}` at that module's position and the other modules whole: `reading/application-error-module.json`; `hqApplication.test.ts` and `hqAppReading.test.ts` serve it. **B**, a status of 500 or more: the file holds it; `HqApplicationModule`'s `error` arm stays (a mirror menu with no source still reaches it, by reading), and `HqAppReading` gains the arm `{ kind: "not-summarized" }`, reached in step 1 of section 8.2: a failure of the application resource with a status of 500 or more that is not the edge's, where `readHqAppSource` then answers a source. Part 12 (`12-the-reading-and-the-birth.md`, section 3.3 step 3, B10) maps it to the circumstance `app-unreadable-in-hq` (Copy), the same code its step 4 gives where every menu's entry is an error (section 8.3). |
| G4 | What do the two reads answer for a mirror menu, a mirror menu whose source menu is gone, a report menu and a shadow form (section 14.1's `shadow` state)? | **A**, as read: the source holds `case_type: null` on both mirror menus, `""` on the report menu and `xmlns: null` with `shadow_parent_form_id` on the shadow form; the resource holds the mirror menu and the report menu each as a summarized entry with no forms (the mirror menu with its source's case type, the report menu with `""`, which `ModuleBase.get_case_types` gives the property map as a key), the shadow form with its parent's `xmlns`, and the sourceless mirror menu as an `error` entry (its case type is `None`, which the map does not hold). `reading/source-shadow.json` and `application-shadow.json` hold them; `hqAppReading.test.ts` expects `read`, three menus `aligned` and one `not-summarized`, and `notSummarizedMenus` naming no menu (section 8.3). **B**, the resource summarizes the sourceless mirror menu, or returns the report menu as an error: the file holds it; the test expects that entry as the file gives it, and nothing else moves, because section 8.3 judges a menu by the source's `docType` either way. **C**, the resource answers a status of 500 or more for the whole app: the file holds it, and G3's outcome B arm is what reads it, landed here if G3 answered A. Under **B** or **C** B1 also writes the answer CommCare HQ gave into the bullet "HQ's source read serves more than the reader's comments say" under "Found while planning step 6" in `harness-findings.md` ("The harness findings"). |
| G5 | Does a throttled tastypie read carry `Retry-After`? Made at the limiter's floor, as `publish/import-429-second.json` is. | **A**, 429 with no `Retry-After`: `reading/application-429.json`; `hqReadJson.test.ts` serves it for the one second wait. **B**, 429 with `Retry-After`: the file holds the header; the test expects the header's wait; `HQ_THROTTLE_ABSENT_WAIT_MS` stays for an edge's 429. |
| G6 | What do the source read and the application resource answer for an id that is an app of another project space? | **A**, source a raised `AppInDifferentDomainException`, resource 404: `reading/source-other-space.json` (the kept exception), `application-other-space.json`. **B**, the source answers 404: the file holds it. Either way the reading answers `gone`: `readHqAppForReading` reads the resource first, the list does not hold the id, and section 8.2 reads every answer of the source read but "deleted" and "a source" as `gone`. `hqAppReading.test.ts` serves the retained pair and expects it. |
| G7 | What does `FixtureResource` answer for a table one of whose rows holds a field with no value? | **A**, a raised `IndexError` or a status of 500 or more: `reading/fixture-rows-empty-field.json`; `classifyHqFailure` keeps a non-edge 500 on `lookup-rows` as `hq-unavailable`, and part 11 (`11-project-data.md`, sections 5.1 and 5.3, B9) reads that answer as `rows-unreadable` before any classification and gives the circumstance `table-rows-unreadable` (Copy) at that table, where the table list answered moments before. **B**, 200 with the row: the file holds it; `toFixtureRowFields` already reads a `field_list` of no items as an empty list, `rowsHoldOtherThanOneValue` (section 10) is true for it, the table is `not-yet`, and `table-rows-unreadable` is not added: B1 then adds six codes to part 01's list, or five where G2 also answered C. |

---

## 1. What Nova does today

**One JSON reader.** `lib/commcare/hq/readJson.ts::readHqJson(creds, url, label, { signal, maxBytes })`
sends `Authorization: ApiKey <username>:<key>` (`hq/http.ts::authHeader`) with `redirect: "manual"`
and `cache: "no-store"`, under a deadline it owns through the body (`hq/deadline.ts::
withHqRequestDeadline`, 30 seconds unless the caller passes a signal). A status outside 2xx is
returned through `hq/http.ts::warnAndReturnError`, which logs the first 200 characters of the body
and returns the status, whether the edge refused it (`isEdgeRefusal`) and a `Retry-After` in seconds
(`retryAfterMs`). No caller can read HQ's refusal text. A body over `maxBytes` and a 2xx that is not
JSON both come back `{ status: 502, cause: "malformed" }`. JSON of the wrong shape is each caller's
to refuse, and they differ: `hq/appSource.ts`, `hq/readCollection.ts` and
`hq/lookupTables.ts::readHqLookupTableRows` name the cause, while `client.ts::listDomainsMatching`,
`testDomainAccess`, `readAppVersions`, `listAppBuilds` and `importApp`,
`hq/lookupTables.ts::listHqLookupTables` and `hq/locations.ts::malformedInventory` return a bare
`{ success: false, status: 502 }`, and a cursor that never ends is a bare 508
(`hq/readCollection.ts::readHqCollection`, `listDomainsMatching`). It never sends twice. No
production code branches on `CommCareApiError.cause`; callers read `status` and `edgeRefusal`. A
caller that owns a deadline across several reads passes its signal alone: the instant the deadline
falls at (`hq/deadline.ts::withHqRequestDeadline` hands it to `run`) never reaches the reader.

**The reads that exist.** `hq/appSource.ts::readHqAppSource` (`/a/<domain>/apps/source/<id>/`, 64 MiB,
30 seconds) returns `source` with a checked subset (`buildSpecVersion`, `cloudcareEnabled`,
`logoRefs`, `profile`, `langs`, `translations`, `addOns`, each module's `uniqueId` and `caseType`,
each form's `xmlns`, this read's minted id and its XForm) and `raw`, or `gone`, `unsupported`, or an
error; its callers are publish's (`lib/deployment/preflight.ts`, three reads in
`lib/deployment/service.ts`) and the lane's capture (`proof/corpus/publish.ts`). It answers
`malformed` unless every menu's `unique_id` and `case_type` and every form's `xmlns` is a string,
so it refuses a source that holds a mirror menu, a shadow form or a menu whose `unique_id` is
absent or null. No production code reads the typed `uniqueId`, `caseType` or `xmlns`: publish
reads menus and forms from `raw` (`lib/deployment/hqSourceBaseline.ts::
normalizeHqAppSource`, `hq/publishedCaseBlocks.ts::publishedCaseBlocks`).
`client.ts::readAppVersions` reads `current_version`. `client.ts::listAppBuilds` reads the
application resource with no byte bound and keeps `versions` only. `client.ts::testDomainAccess`
reads `list_apps`, checks the `{status: "success", applications: [...]}` envelope and discards the
rows. `hq/lookupTables.ts::listHqLookupTables` and `readHqLookupTableRows`
(`LOOKUP_ROWS_READ_CONCURRENCY` 4), `hq/locations.ts::listHqLocationTypes` and `listHqLocations`, and
`client.ts::probeHqProjectSpaceCompatibility` complete the set. Nothing reads a media file from HQ,
and nothing reads a form's real id.

**Throttling.** Only `client.ts::importApp` waits out a 429: at most three sends, a `Retry-After` of at
most `IMPORT_RETRY_MAX_WAIT_MS` (2 seconds), inside its own deadline.

**Credentials.** One `user_settings` row per person holds the username, the server, the KMS
ciphertext of the key (`lib/commcare/encryption.ts`) and `approved_domains`, every project space
where `testDomainAccess` passed when the key was saved or refreshed. `lib/db/settings.ts::
resolveUploadTarget` resolves a requested project space against that set and
`getCredentialsForUpload` decrypts on success. The connection is per person;
`lib/deployment/service.ts::assertCredentialsMatchServer` refuses a key on another server.

**Failures become words in four places**, each private to its caller: `settings/actions.ts::
settingsErrorMessage` (429, 500 and over, other; its two callers own their 401);
`service.ts::importRejectionMessage` (edge, 401, 403, 429, 500 and over, other);
`preflight.ts::hqAppSourceReadFailure` (a linked app; 401 or 403 as "needs permission to edit apps";
everything else "couldn't safely read"); and the `project-data` edge's inline choice on 401 or 403 in
`preflight.ts::runDeploymentPreflight`. Only the import's ladder reads `edgeRefusal`; the other three
choose by status alone, so an edge's 401 reads as a bad key in Settings and as a missing permission
in both preflight sentences. The refresh in Settings has no error to read at all:
`lib/db/settings.ts::refreshApprovedDomains` returns `{ ok: false, kind: "hq_error", status }` and
drops the rest of the `CommCareApiError`.

**The lane.** `proof/hq/test_retained_reads.py` makes HQ's answers through `operations.api_request`
(HQ's URLconf, key authentication, permission and privilege checks and limiter) and holds
`proof/hq-reads/` to them byte for byte; Nova's tests serve those files
(`__tests__/helpers/retainedHqReads.ts`). `proof/surface/families/hq_api.py` records the views and
resources Nova calls as `hq-api:` items of the generated surface.

---

## 2. `readHqJson`'s contract

### 2.1 The error

`lib/commcare/hq/http.ts::CommCareApiError` becomes:

```ts
export interface CommCareApiError {
	success: false;
	status: number;
	edgeRefusal?: boolean;
	/**
	 * Why a read synthesized its status: no answer reached Nova (`network`, 503), the deadline ran
	 * out (`timeout`, 503), the body was longer than the read's bound (`too-large`, 502), the answer
	 * was a page for a browser where JSON was asked (`browser-page`, 502), or it could not be read as
	 * what was asked for (`malformed`, 502, or 508 for a list whose cursor never ends).
	 */
	cause?: "network" | "timeout" | "malformed" | "too-large" | "browser-page";
	retryAfterMs?: number;
	/**
	 * The first `HQ_REFUSED_BODY_MAX_CHARS` characters of a refused answer's body, present only
	 * where the read asked for it (`ReadHqJsonOptions.keepRefusedBody`). Read only inside
	 * `lib/commcare/hq/http.ts`, never shown and never logged beyond the 200 characters
	 * `warnAndReturnError` already logs.
	 */
	refusedBody?: string;
}
export const HQ_REFUSED_BODY_MAX_CHARS = 2_048;
/** The most bytes of a refused answer's body a read takes in before it cuts `refusedBody`. */
export const HQ_REFUSED_BODY_READ_MAX_BYTES = 64 * 1024;
```

Every synthesized status stays what it is today (502, 503, and the 508 of section 2.4), so every
caller that reads `status` behaves as today.

### 2.2 The two sentences

```ts
/** `api/resources/__init__.py::HqBaseResource.dispatch`, the plan refusal. */
export const HQ_API_ACCESS_REFUSAL = "Your current subscription does not have access to this feature";
/** The same method's refusal while `API_BLACKLIST` is on for the request. Two spaces after "requests.". */
export const HQ_API_CUT_OFF_REFUSAL =
	"API access has been temporarily cut off due to too many requests.  To re-enable, please contact support.";
/** `plan` or `cut-off` where a 401 HQ itself answered holds exactly one of the two sentences. */
export function apiRefusalSentence(error: CommCareApiError): "plan" | "cut-off" | null;
```

`apiRefusalSentence` answers `null` unless `status === 401`, `edgeRefusal !== true` and
`refusedBody` parses as a JSON object whose `error` is exactly one of the two constants. Any other 401
is the honest "the key was not accepted", never a guess at the plan. Both are literals of one HQ
method that every `HqBaseResource` inherits. Lifecycle: the plan check is alive; `API_BLACKLIST` is
a toggle (flag-gated) and its arm is reached only while HQ's operators turn it on.

### 2.3 The reader

`lib/commcare/hq/readBody.ts` (new) exports `readBoundedBody` and its `BoundedBody` type, moved
from `readJson.ts` with their bodies unchanged and the `export` added, so the media reader shares
them:

```ts
export type BoundedBody =
	| { readonly kind: "read"; readonly bytes: Uint8Array }
	/** The body passed `maxBytes`; `bytes` is how many had arrived when the read was cancelled. */
	| { readonly kind: "too-long"; readonly bytes: number }
	/** The stream failed or the deadline's signal aborted it. */
	| { readonly kind: "unavailable" };
export function readBoundedBody(
	response: Response, maxBytes: number | undefined,
): Promise<BoundedBody>;
```

```ts
/**
 * A deadline a caller owns across several reads: its signal and the `Date.now()` instant it falls
 * at, the pair `hq/deadline.ts::withHqRequestDeadline` hands `run`. Always passed together.
 */
export interface HqReadDeadline {
	readonly signal: AbortSignal;
	readonly deadline: number;
}

export type ReadHqJsonOptions = {
	readonly maxBytes?: number;
	/** Return a bounded prefix of a refused body as `refusedBody`. */
	readonly keepRefusedBody?: boolean;
} & (HqReadDeadline | { readonly signal?: undefined; readonly deadline?: undefined });
```

`HqReadDeadline` is exported from `hq/deadline.ts`. A signal with no instant no longer compiles,
because the retry rule of section 3.2 must know whether a wait would outlast the deadline. With
neither, `readHqJson` owns a 30 second deadline as today and knows its own instant. The callers
that own a deadline and now pass the pair: `hq/readCollection.ts::readHqCollection` in its `whole`
mode (its `withHqRequestDeadline((signal, deadline) => ...)`), `client.ts::listDomainsMatching`
(whose parameter `signal?: AbortSignal` becomes `within?: HqReadDeadline`, and whose owner
`client.ts::runBoundedCompatibilityProbe` computes `Date.now() +
HQ_PROJECT_SPACE_COMPATIBILITY_PROBE_TIMEOUT_MS` beside its controller and hands both to `probe`),
and the readers this part adds or widens, each of which takes `options?: HqReadDeadline` or holds
the pair among its options: `readHqApplication`, `readHqAppSource`, `client.ts::readAppVersions`,
`listHqApps`, `listHqLookupTables`, `readHqLookupTableRows`, `listHqLocationTypes` and
`listHqLocations` (sections 5 to 10). `probeHqApiAccess` takes none: its one caller, the picker's
`listHqAppsForPicker`, shares no deadline across its two reads (section 5.2), so the probe's read
owns the default.

Changes to `readHqJson`:

- A status outside 2xx: where `keepRefusedBody`, the body is read once, bounded at
  `HQ_REFUSED_BODY_READ_MAX_BYTES` (64 KiB, section 2.1), the error is `warnAndReturnError`'s with
  `refusedBody` its first `HQ_REFUSED_BODY_MAX_CHARS` (2,048) characters. `warnAndReturnError` gains
  the synchronous overload `warnAndReturnError(context: string, res: Response, bodyAlreadyRead:
  string): CommCareApiError`, which logs and builds the error from the text it is handed and never
  touches `res.body`, so the body is consumed once. The `keepRefusedBody` path is its only caller.
- A body over `maxBytes`: `{ status: 502, cause: "too-large" }`, logged at error as today.
- A 2xx body that fails `JSON.parse`: `cause: "browser-page"` where its first non-whitespace
  character is `<`, else `cause: "malformed"`. HQ serves its plan page, its sign-in page and an
  inactive project space's page as HTML (`domain/decorators.py::login_and_domain_required`); a 3xx
  keeps its status, since redirects are never followed.
- A 429 is sent again by section 3's rule before it is returned.

### 2.4 A cause on every synthesized failure

Section 4 classifies by `cause` first and by status after, so a failure Nova synthesizes with no
cause would be read by its status: a bare 502 for an answer of the wrong shape would classify as
`hq-unavailable` ("CommCare HQ didn't answer"), when it is Nova's to understand and to log at error.
B1 therefore adds `cause: "malformed"` to every status a read synthesizes for an answer it cannot
use, keeping each status as it is:

| Where | Today | From B1 |
|---|---|---|
| `client.ts::listDomainsMatching`: a wrong envelope, a count that moves, a name twice, a cursor that leaves its path, a list shorter than its count | `{ status: 502 }` | `{ status: 502, cause: "malformed" }` |
| `client.ts::listDomainsMatching` and `hq/readCollection.ts::readHqCollection`: a cursor that never ends | `{ status: 508 }` | `{ status: 508, cause: "malformed" }` |
| `client.ts::testDomainAccess`: a wrong envelope | `{ status: 502 }` | the error of `readHqAppListEnvelope` (section 5.1), which names the cause |
| `client.ts::readAppVersions`: a body that is no object, a version that is no integer | `{ status: 502 }` | `{ status: 502, cause: "malformed" }` |
| `client.ts::importApp`: an acknowledgement that is no JSON object, or names no verdict or app Nova can record | `{ status: 502 }` | `{ status: 502, cause: "malformed" }` (the 503 it gives when its deadline ran out gains `cause: "timeout"`) |
| `hq/lookupTables.ts::listHqLookupTables`: a table with no id or tag | `{ status: 502 }` | `{ status: 502, cause: "malformed" }` |
| `hq/locations.ts::malformedInventory` | `{ status: 502 }` | `{ status: 502, cause: "malformed" }` |

The calls B1 does not classify (`uploadAppMediaBundle`, the lookup workbook upload, the place
patch, the worker calls, `probeBuildProfile`, `readBuildXml`) keep their synthesized statuses as
they are: section 12 says why their callers do not move. Every existing test that expects one of the rows
above with `toEqual` gains the cause (Tests).

---

## 3. Throttling, deadlines and bounds

### 3.1 Which reads HQ throttles

HQ's limiter is `api/resources/meta.py::HQThrottle` over `api_rate_limiter`, counted by project space
and allowed while either the project space's scope or its billing account's has room. A function view
under `api/decorators.py::api_throttle` answers 429 with `Retry-After` in decimal seconds
(`HQThrottle.retry_after`). A tastypie resource whose `Meta` extends `CustomResourceMeta` answers 429
with no `Retry-After`: `should_be_throttled` returns a bool, and tastypie's
`Resource.throttle_check` writes the header only for an int or a datetime (run G5).

| Read | Throttled | `Retry-After` on 429 |
|---|---|---|
| `list_apps` | yes (`api_throttle`) | yes |
| `ApplicationResource`, `LookupTableResource`, `FixtureResource` | yes (`CustomResourceMeta`) | no |
| `LocationTypeResource`, `LocationResource` (their `Meta` extends `object`) | no | none |
| `app_source`, `current_app_version`, `UserDomainsResource` | no | none |

The plan check of `HqBaseResource.dispatch` runs before tastypie's own dispatch, so a project space
without API access is refused before the limiter counts the request.

### 3.2 The retry rule

`lib/commcare/hq/throttle.ts` (new):

```ts
/** The most a read or an import waits on one 429 before sending again. */
export const HQ_THROTTLE_MAX_WAIT_MS = 2_000;
/** The wait for a 429 that names none: a tastypie resource's, or an edge's. */
export const HQ_THROTTLE_ABSENT_WAIT_MS = 1_000;
/** How many times one read is sent at most: the first and two resends. */
export const HQ_READ_SENDS = 3;
/** The wait before a read is sent again, or null when its 429 is the answer. */
export function readRetryWaitMs(retryAfter: number | undefined): number | null;
```

`readRetryWaitMs(undefined)` is 1,000; a wait of at most 2,000 is itself; a longer one is `null`
(HQ's minute, hour and day windows are the project space's whole budget, and a wait cannot widen it).
`readHqJson` sends at most `HQ_READ_SENDS` times, waits with `hq/http.ts::delay(wait, signal)`,
and logs each resend at warn with the label. It begins no wait that would outlast its deadline: where
`Date.now() + wait >= deadline` the 429 is the answer, the comparison `client.ts::importApp` makes
today with the instant it owns. `deadline` is the instant of `ReadHqJsonOptions` (section 2.3), or
the reader's own where it owns the deadline. Every read is idempotent, so the rule is on for every
caller, the publish reads included: a 429 that stops a preflight today is retried from step 6.
`client.ts::IMPORT_RETRY_MAX_WAIT_MS` becomes `HQ_THROTTLE_MAX_WAIT_MS` under its old name
(`export const IMPORT_RETRY_MAX_WAIT_MS = HQ_THROTTLE_MAX_WAIT_MS`), and `importRetryWaitMs` is
unchanged: an import with no `Retry-After` is still refused, because an import is a write and its
429 always names its wait.

**The throttled reads of one reading run one at a time** (`HQ_THROTTLED_READ_CONCURRENCY = 1`,
exported from `throttle.ts` for the project data reads of part 11, `11-project-data.md`, section
5.1, B9, and the read step of part 12, `12-the-reading-and-the-birth.md`, section 3.3, B10): the
application resource, the app list where a 403 or a 404 asks for it (section 8.2), the table list,
then each table's row pages. Each costs at most three sends and four seconds of waiting. The level
list and the place list are not throttled and are read one after the other; media takes its own
window in its own step (section 9). A reading never calls the probe: its first read, the
application resource, is the API access check (section 8.2). The picker's two reads, the app list
and then the probe (part 13, `13-the-experience.md`, section 4.2, B11), run in turn under the same
rule, each under its own 30 second deadline.

### 3.3 Deadlines, the step's budget and byte bounds

A reading keeps no HQ source at rest (part 12, `12-the-reading-and-the-birth.md`, section 2.3, B10),
so its first step reads the app, the tables, the levels and the places, runs the reader and writes
the account inside one request. A step has 270 seconds, whoever calls it (part 12's
`HQ_READING_STEP_MS`, its section 3.6), which leaves the route 30 of the 300 seconds an MCP call is
capped at (`app/api/mcp/route.ts::maxDuration`) and a browser step's route exports. A read step's
budget is three constants, exported from `hq/appReading.ts`:

```ts
/** The application resource, the source and the save counter of one attempt, together. */
export const HQ_APP_READING_DEADLINE_MS = 120_000;
/** The table list, every row page, the level list and the place list of one reading, together. */
export const HQ_PROJECT_DATA_READING_DEADLINE_MS = 60_000;
/** What the step keeps for the reader, acceptance and its one write. */
export const HQ_READING_STEP_REMAINDER_MS = 90_000;
```

`lib/commcare/__tests__/hqAppReading.test.ts` holds their sum to 270,000 (Tests). The project data
deadline is one `withHqRequestDeadline(run, HQ_PROJECT_DATA_READING_DEADLINE_MS)` that the read
step of part 12 (`12-the-reading-and-the-birth.md`, section 3.3 step 5, B10) opens around part
11's project data read (`11-project-data.md`, section 14.1, B9), which passes its `HqReadDeadline`
to every read named above; `readHqCollection` then owns no
deadline of its own, in either mode, and a page that would start after the instant is not sent. A
read cut off by either deadline is `cause: "timeout"`, kind `timed-out`, and the reading stops with
`hq-unavailable`, whose copy says CommCare HQ didn't answer in time (part 01, section 9.3). An app
HQ cannot serve inside 120 seconds cannot be brought in by step 6, and the log line names which
read ran out (`[commcare] <label> unavailable`, whose label is the read's).

| Read | Deadline | Byte bound | Past it |
|---|---|---|---|
| `listHqApps`, `probeHqApiAccess` | 30 s (the default) | 4 MiB, `HQ_APP_LIST_MAX_BYTES`; 1 MiB for the probe, `HQ_API_ACCESS_PROBE_MAX_BYTES` | `too-large` |
| `readHqApplication` from observation and deep links | 30 s | 64 MiB, `HQ_APPLICATION_MAX_BYTES` | could not check, as a 502 is today |
| `readHqAppForReading`: the resource, the source and the version together | 120 s, `HQ_APP_READING_DEADLINE_MS` | 64 MiB each (`HQ_APPLICATION_MAX_BYTES`, `HQ_APP_SOURCE_MAX_BYTES`) | `timed-out`, `too-large` |
| a reading's table list, row pages, level list and place list together | 60 s, `HQ_PROJECT_DATA_READING_DEADLINE_MS` | unchanged (none) | `timed-out` |
| `readHqMediaFile`, in the media step | 60 s a file, `HQ_MEDIA_FILE_DEADLINE_MS` | the caller's `maxBytes` | `too-large` |
| a publish's table list, one page of rows, level list, place list | unchanged (30 s each, a row page its own) | unchanged | unchanged |

---

## 4. One failure classification

### 4.1 Types

`lib/commcare/hq/failure.ts` (new, server-only, pure):

```ts
export const HQ_FAILURE_KINDS = [
	"gateway-refused", "key-not-accepted", "plan-lacks-api-access", "api-cut-off", "not-a-member",
	"permission", "not-found", "rate-limited", "hq-unavailable", "timed-out", "too-large",
	"browser-only", "answer-unreadable", "refused",
] as const;
export type HqFailureKind = (typeof HQ_FAILURE_KINDS)[number];

/** What was asked of HQ. `app-import` is the one write, for the publish ladder. */
export const HQ_REQUEST_KINDS = [
	"project-spaces", "app-list", "api-access", "application", "app-source", "app-version",
	"lookup-tables", "lookup-rows", "location-types", "locations", "media-file", "app-import",
] as const;
export type HqRequestKind = (typeof HQ_REQUEST_KINDS)[number];

/** What the account lacks, where a 403 says so. */
export type HqPermissionNeed =
	| "edit-apps" | "access-apis" | "edit-apps-and-access-apis" | "locations";

export interface HqFailure {
	readonly kind: HqFailureKind;
	readonly request: HqRequestKind;
	/** The status HQ, its edge or the reader gave. */
	readonly status: number;
	/** Present exactly where `kind` is `permission`. */
	readonly permission?: HqPermissionNeed;
}

export function classifyHqFailure(
	error: CommCareApiError,
	request: HqRequestKind,
	options?: { readonly member?: boolean },
): HqFailure;
```

### 4.2 The rules, first match

| # | The answer | Kind |
|---|---|---|
| 1 | `edgeRefusal === true` | `gateway-refused` |
| 2 | `cause: "timeout"` | `timed-out` |
| 3 | `cause: "network"` | `hq-unavailable` |
| 4 | `cause: "too-large"` | `too-large` |
| 5 | `cause: "browser-page"`, or a status from 300 to 399 | `browser-only` |
| 6 | `cause: "malformed"` | `answer-unreadable` |
| 7 | 401 and `apiRefusalSentence` is `plan` | `plan-lacks-api-access` |
| 8 | 401 and `apiRefusalSentence` is `cut-off` | `api-cut-off` |
| 9 | any other 401 | `key-not-accepted` |
| 10 | 403 | by request, below |
| 11 | 404 | `not-found` |
| 12 | 429 | `rate-limited` |
| 13 | a status of 500 or more | `hq-unavailable` |
| 14 | anything else | `refused` |

A 401 is one status for five causes HQ does not tell apart: an unknown user, an inactive one, a wrong
key, a key limited to another project space, and a caller outside the key's address list
(`domain/auth.py::HQApiKeyAuthentication.is_authenticated`). Part 01's block for `key-not-accepted`
says the key "may have been removed or replaced" and offers Settings, which is the next step for
all five: the person checks the key they saved.

**Rule 10, a 403 by request.** `member` is whether the same credential's `list_apps` answered for this
project space moments before; a caller that has not asked leaves it out.

| Request | `member: false` | `member: true` or absent | Why |
|---|---|---|---|
| `project-spaces` | `refused` | `refused` | `api/resources/v0_5.py::UserDomainsResource` names no project space (`LoginAuthentication`), and the branch of `_login_or_challenge` for a request with none answers 403 for an account that is no web user, never for a non-member |
| `app-list`, `app-version` | `not-a-member` | `not-a-member` | `domain/decorators.py::_login_or_challenge` answers a bodyless 403 for a non-member, and these views ask no permission |
| `app-source`, `app-import` | `not-a-member` | `permission`, `edit-apps` | the same membership test, then `require_can_edit_apps` |
| `api-access`, `application`, `lookup-tables` | `not-a-member` | `permission`, `access-apis` | `LoginAndDomainAuthentication` runs `require_api_permission('access_api')` |
| `lookup-rows` | `not-a-member` | `permission`, `edit-apps-and-access-apis` | `FixtureResource.Meta.authentication` is `RequirePermissionAuthentication(edit_apps)`, which adds `access_api` |
| `location-types`, `locations` | `not-a-member` | `permission`, `locations` | four gates Nova cannot tell apart (`lib/deployment/CLAUDE.md`), so the copy names all four |
| `media-file` | `refused` | `refused` | `readHqMediaFile` reads nothing into a refusal: it holds a status and bytes (section 9) |

No rule reads a refused body's shape to tell membership from permission: the lane's
`operations.api_request` returns a bare status for both, so a body rule could not be held to HQ.

`project-spaces` is the request of `client.ts::listDomains`, and no caller in B1 classifies with
it. The one caller that reads that list, `client.ts::discoverAccessibleDomains`, returns one error
for both of its reads without saying which failed, so Settings classifies what it returns with
`app-list` (section 12, which says what a 403 of the list then prints). The member is in the
tuple, and its row is in the table above, so that the classification and `hqReadCircumstance` are
total over every read the client makes and the first caller that reads the list alone has its row.

This table is also what part 01 asks of this part (which of `cannot-edit-apps` and
`cannot-access-apis` each read can report): the source read reports Edit Apps; the probe, the
application resource and the table list report Access APIs; the row read cannot tell the two apart;
the level and place reads cannot tell four gates apart. Section 4.3 gives each its code.

### 4.3 The circumstance a failure is

A circumstance is worded for what was asked: part 01's `app-gone` says the app is not there and its
`too-large` says the app's source is over the bound, and both are false of a table read or of the
app list. So the mapping is a pure function of the kind and the request, never of the kind alone:

```ts
import type { ReadCircumstance } from "@/lib/publish/hqFindings";

/** The `READ_CIRCUMSTANCES` code a failed read of HQ is, by its kind and by what was asked. */
export function hqReadCircumstance(failure: HqFailure): ReadCircumstance;
```

| Kind | Request | Code | Lands in |
|---|---|---|---|
| `gateway-refused` | any | `hq-gateway-refused` | B1 |
| `key-not-accepted` | any | `key-not-accepted` | A2 |
| `plan-lacks-api-access` | any | `plan-lacks-api-access` | A2 |
| `api-cut-off` | any | `api-cut-off` | B1 |
| `not-a-member` | any | `not-a-member` | A2 |
| `permission`, `edit-apps` | `app-source`, `app-import` | `cannot-edit-apps` | A2 |
| `permission`, `access-apis` | `api-access`, `application`, `lookup-tables` | `cannot-access-apis` | A2 |
| `permission`, `edit-apps-and-access-apis` | `lookup-rows` | `cannot-edit-apps` | A2 |
| `permission`, `locations` | `location-types`, `locations` | `cannot-read-organization` | B1 |
| `not-found` | `application`, `app-source`, `app-version` | `app-gone` | A2 |
| `not-found` | any other | `hq-unavailable` | A2 |
| `rate-limited` | any | `rate-limited` | A2 |
| `hq-unavailable`, `timed-out` | any | `hq-unavailable` | A2 |
| `too-large` | `application`, `app-source` | `too-large` | A2 |
| `too-large` | any other | `hq-unavailable` | A2 |
| `browser-only` | any | `browser-only` | B1 |
| `answer-unreadable`, `refused` | any | `hq-unavailable` | A2 |

Why each row that is not its kind's own name:

- **The row read's 403** reports `cannot-edit-apps`: `FixtureResource` names Edit Apps as its
  permission and adds Access APIs to it, and a reading reaches the rows only after the application
  resource answered with Access APIs moments before, so Edit Apps is the one that can have gone.
- **A 404 on a table, row, level or place read** is `hq-unavailable`, whose body says CommCare HQ
  "sent something Nova couldn't read" and whose next step is to check again. That is true and it is
  the right step: the list answered moments before, so what is gone changed during the read, and the
  next reading reads the lists afresh. It is never `app-gone`.
- **A body over the bound on the app list or the probe** is `hq-unavailable`, logged at error with
  the request kind. `too-large` is part 01's word for the app's own source and carries the standing
  `not-yet`; a project space whose app list passes 4 MiB holds tens of thousands of apps, and no
  code is added for a bound no project space has reached.
- **`answer-unreadable` and `refused`** share `hq-unavailable`, whose body covers an answer Nova
  could not read. They are Nova's to understand, so a reading that meets one logs at error with the
  request kind and the status, never the body. `timed-out` shares it too: the body says "didn't
  answer in time".

A caller that knows more than the failure says so itself: section 8 turns an application 404 into
the answers `deleted`, `remote` or `gone`, which part 12 (`12-the-reading-and-the-birth.md`,
section 3.3 step 3, B10) gives as `app-deleted`, `remote-app` or `app-gone`, and part 11
(`11-project-data.md`, section 3.2, B9) turns `readHqMediaFile`'s `missing` into part 01's
`media-file-unreadable` where a platform the app runs on draws the slot. The reading's
`not-connected` circumstance is not an HQ answer: part 12 (section 3.3 step 1, B10) gives it where
`getHqCredentials` answers `not_configured` or the key's server differs.

**The seven codes B1 adds.** Part 01 defines `READ_CIRCUMSTANCES`, `CIRCUMSTANCE_STANDINGS` and
`CIRCUMSTANCE_COPY` in A2 with twenty codes (`lib/publish/hqFindings.ts`,
`lib/publish/hqFindingCopy.ts`). B1 adds seven members to all three, with the blocks of "Copy";
part 01 holds the same seven rows in its section 8.3 and the same seven blocks in its section 9.3,
and its completeness test (`lib/publish/__tests__/hqFindingCopy.test.ts`) then holds each to its
block. Each is an answer HQ gives that no member of part 01's twenty words truthfully:

| Code | Standing | Place | When | Why no listed code holds it |
|---|---|---|---|---|
| `hq-gateway-refused` | stop | app | the edge in front of HQ refused the request | an edge's 401 or 403 is no fact about the key or the account, which `key-not-accepted` and the two permission codes assert |
| `api-cut-off` | stop | app | HQ's 401 holds the cut-off sentence of section 2.2 | the key is good and the plan has API access; a new key or a plan change fixes nothing |
| `browser-only` | stop | app | HQ answered a redirect or a page where data was asked | HQ did answer, and what it asks for (signing in another way, an inactive project space) is something the person can see in HQ |
| `remote-app` | stop | app | the list holds the app and the application resource has none (section 8.2) | part 01 words a linked app as one "CommCare HQ rewrites from another app"; a remote app holds no content to rewrite |
| `cannot-read-organization` | stop | organization | a 403 on the level or the place read | the read needs two plan features and two permissions Nova cannot tell apart, and neither permission code names them |
| `app-unreadable-in-hq` | fix-in-hq | app | HQ's summary is an error for every menu it would summarize (section 8.3), or for the app whole (run G3, outcome B) | `menu-unreadable-in-hq` names one menu, and the cause is in no one menu |
| `table-rows-unreadable` | fix-in-hq | lookup-table | run G7's outcome A: the rows of one table answer a status of 500 or more that is not the edge's, where the table list answered; `detail.name` is the table's tag | the fault is in one table's rows, which the person can open in HQ, and `hq-unavailable` would send them to wait |

`remote-app` and `table-rows-unreadable` are withdrawn by the outcomes named in "Written and not yet
run" (G2's C, G7's B). With `remote-app` its own code, part 01's `linked-app` keeps its block for a
linked app alone, which is what its body already says.

---

## 5. The app list and the API access check

### 5.1 `listHqApps`

`lib/commcare/hq/apps.ts` (new):

```ts
export interface HqAppListing {
	/** HQ's id of the working app. */
	readonly appId: string;
	readonly name: string;
	/** The working app's save counter, the one `current_app_version` and the resource report. */
	readonly version: number;
}
export const HQ_APP_LIST_MAX_BYTES = 4 * 1024 * 1024;
/**
 * The list's envelope, checked and no further: `{status: "success", applications: [...]}`, with the
 * rows unread. What proves a key reaches a project space's apps.
 */
export function readHqAppListEnvelope(
	creds: CommCareCredentials, domain: string, options?: HqReadDeadline,
): Promise<{ readonly applications: readonly unknown[] } | CommCareApiError>;
/** Every working app of the project space, in HQ's order (by name). */
export function listHqApps(
	creds: CommCareCredentials, domain: string, options?: HqReadDeadline,
): Promise<readonly HqAppListing[] | CommCareApiError>;
```

Both read `GET /a/<domain>/apps/api/list_apps/` (`views/cli.py::list_apps`: `@json_error`,
`@api_auth()`, `@api_throttle`; membership alone, no Edit Apps, no API access), bounded at
`HQ_APP_LIST_MAX_BYTES`. `readHqAppListEnvelope` requires the envelope
`{status: "success", applications: [...]}`. `listHqApps` calls it and then requires of each row a
string `app_id` matching `^[\w-]+$`, a string `name` and a non-negative safe integer `version`, with
no `app_id` twice. Any other shape is `{ status: 502, cause: "malformed" }`, logged at error with
the row's index and never its content. `download_url` is dropped unread. An invalid domain slug is
`INVALID_DOMAIN_SLUG` from both.

What the list holds, by `domain/models.py::Domain.applications` over the view
`applications_brief/map.js`: documents whose `doc_type` is `Application`, `RemoteApp` or
`LinkedApplication` and whose `copy_of` is null. So it holds working apps only, no build and no
deleted app (HQ's delete changes the `doc_type`), sorted by name. The view's value holds `doc_type`,
`upstream_app_id` and more, and `list_apps` returns four keys of it: a row cannot say that an app is
linked or remote, when it was edited, or whether it is built. The picker therefore shows name alone
from HQ, and what marks a row is Nova's own ledger: `lib/deployment/store.ts::readHqAppClaims` of
part 10 (`10-identity-and-the-ledger.md`, section 5.5, B8) says which apps Nova already holds, and
part 13 (`13-the-experience.md`, sections 4.2 and 4.3, B11) reads it for the picker and draws it.
Lifecycle: `list_apps` and each of its four keys are alive.

`client.ts::testDomainAccess` keeps its signature, its verdicts and its check. It keeps
`if (!isValidDomainSlug(domain)) return false;` as its first line, so a slug Nova cannot put in a
URL is a project space the key does not reach and never an error that stops
`discoverAccessibleDomains` for every other project space. It then calls `readHqAppListEnvelope`,
answers `false` for a 401 or 403 HQ itself gave, the error for any other failure, and `true` for an
envelope. It does not check the rows: `list_apps` passes each app's `name` and `version` through as
stored (`views/cli.py::list_apps`, its `app_to_json`), `discoverAccessibleDomains` stops on the
first error of any project space, and one app Nova cannot type in one project space must not fail
the save or the refresh of a key that reaches hundreds. A row Nova cannot read is the picker's to
report, for the one project space the person chose.

### 5.2 `probeHqApiAccess`

```ts
export type HqApiAccess =
	| { readonly kind: "available" }
	| { readonly kind: "plan-lacks-api-access" }
	| { readonly kind: "account-lacks-access-apis" }
	| { readonly kind: "failed"; readonly failure: HqFailure };
/** The most bytes of the probe's one-row answer Nova reads: 1 MiB. */
export const HQ_API_ACCESS_PROBE_MAX_BYTES = 1024 * 1024;
export function probeHqApiAccess(creds: CommCareCredentials, domain: string): Promise<HqApiAccess>;
```

It reads `GET /a/<domain>/api/lookup_table/v1/?limit=1` with `keepRefusedBody` and
`maxBytes: HQ_API_ACCESS_PROBE_MAX_BYTES`, under the reader's own 30 second deadline, and
classifies with request `api-access` and `member: true`: 2xx with a tastypie envelope is `available`;
kind `plan-lacks-api-access` and kind `permission` are the two named answers; anything else is
`failed`. It is called after `listHqApps` answered, never beside it, so `member: true` is true. Its
one caller is `listHqAppsForPicker` (part 13, `13-the-experience.md`, section 4.2, B11), which the
picker's route and, from B12, the `list_hq_apps` tool call. The
limiter allows one request a second at its floor (`api/resources/meta.py::api_rate_limiter`), and
calling in turn does not keep the two a second apart: a 429 between them is waited out by section
3.2's rule. The lookup table list is the cheapest resource behind the plan check: one indexed query
by project space (`fixtures/resources/v0_1.py::LookupTableResource.obj_get_list`), where the
application resource's list parses every form of every app. `HqBaseResource.dispatch` makes the
plan check for every resource alike, so its answer stands for the application resource.

---

## 6. The application resource

`lib/commcare/hq/application.ts` (new) holds the one reader of
`GET /a/<domain>/api/application/v1/<app_id>/` (`api/resources/v0_4.py::ApplicationResource`; API
access on the plan, Access APIs on the account, throttled). `extras=true` is never sent: it returns
the raw stored document, which doubles the largest read for nothing the source read does not give.

```ts
export const HQ_APPLICATION_MAX_BYTES = 64 * 1024 * 1024;

/** One build CommCare HQ holds for an app. Moved from `client.ts` as it stands there. */
export interface HqAppBuild {
	readonly id: string;
	readonly version: number;
	readonly isReleased: boolean;
	readonly builtOn: string | null;
	readonly buildComment: string | null;
}

export interface HqApplication {
	readonly appId: string;
	readonly name: string;
	/** The save counter of the document the answer describes. */
	readonly version: number;
	/** `built_from_app_id`: null for a working app, the working app's id for a build. */
	readonly builtFromAppId: string | null;
	readonly builds: readonly HqAppBuild[];
	/** `modules` as HQ sent it, unread. `hqApplicationModules` types it. */
	readonly rawModules: readonly unknown[];
}

export function readHqApplication(
	creds: CommCareCredentials, domain: string, appId: string, options?: HqReadDeadline,
): Promise<HqApplication | CommCareApiError>;

export interface HqQuestionSummary {
	/** `value`: the question's path. */
	readonly path: string;
	/** `tag`: the control's element name, or `hidden`. */
	readonly tag: string;
	/** `type`: HQ's name for the question's kind, null where HQ inferred none. */
	readonly type: string | null;
	readonly repeat: string | null;
	readonly group: string | null;
	readonly isGroup: boolean;
	/** Null on a node with no control, where HQ sends no `required`. */
	readonly required: boolean | null;
	readonly relevant: string | null;
	readonly constraint: string | null;
	/** HQ sends `calculate` for a node with no control only. */
	readonly calculate: string | null;
	readonly setvalue: string | null;
	/** `translations`: the label per language code, where HQ found one. */
	readonly labelTranslations: Readonly<Record<string, string>>;
	/** `options`, for a select with inline choices; null otherwise. */
	readonly options:
		| readonly { readonly value: string; readonly labelTranslations: Readonly<Record<string, string>> }[]
		| null;
}
export interface HqApplicationForm {
	/** The form's real `unique_id`, the one HQ stores. */
	readonly uniqueId: string;
	/**
	 * `xmlns` as the resource reports it. For a shadow form that is its parent's, and null where
	 * the parent is gone (`models/forms.py::ShadowForm.xmlns`).
	 */
	readonly xmlns: string | null;
	readonly questions: readonly HqQuestionSummary[];
}
export type HqApplicationModule =
	| { readonly kind: "summarized";
	    /** `unique_id` as stored; null where the menu stores none (absent, null or `""`). */
	    readonly uniqueId: string | null;
	    readonly caseType: string | null;
	    readonly forms: readonly HqApplicationForm[] }
	/** HQ could not summarize this menu; `message` is its own text. */
	| { readonly kind: "error"; readonly message: string };

/** The typed modules, in HQ's order, or where the answer stopped being readable. */
export function hqApplicationModules(
	application: HqApplication,
): readonly HqApplicationModule[] | { readonly malformedAt: string };
```

**`readHqApplication`.** It sends `keepRefusedBody` and `maxBytes: HQ_APPLICATION_MAX_BYTES`. It checks
that the body is an object whose `id` equals `appId`, whose `name` is a string, whose `version` is a
non-negative safe integer, whose `built_from_app_id` is null or a string, whose `modules` is an array
and whose `versions` is an array of build rows, each read exactly as `client.ts::listAppBuilds` reads
one today (`id` matching `^[\w-]+$` and unique, `version`, a boolean `is_released`, `built_on`,
`build_comment`). Anything else is `{ status: 502, cause: "malformed" }`. `HqAppBuild` moves with it
from `client.ts` (which re-exports the type). `listAppBuilds` is deleted;
`lib/deployment/observe.ts` and `lib/deployment/entryPointLinks.ts` call `readHqApplication` and read
`.builds`, with their sentences unchanged. They never call `hqApplicationModules`, so a question
summary Nova cannot read can never stop Check status.

The envelope is stricter than `listAppBuilds`'s, which reads `versions` and nothing else. Every key
it now requires (`id`, `name`, `version`, `built_from_app_id`, `modules`, `versions`) is a declared
field of `api/resources/v0_4.py::ApplicationResource` that HQ dehydrates on every answer, so no
answer of HQ's that passes today fails. What does fail is a test peer that serves
`{ versions: [...] }` alone. Five suites do: four serve it to a status check and take the helper
`applicationAnswer` (section 14.1), and the fifth, `appReadings.test.ts`, holds the build inventory
cases, which move to `hqApplication.test.ts`. "Tests" lists each with what it serves from B1.

**`hqApplicationModules`.** One entry of `modules` is, by `ApplicationResource.dehydrate_module`,
either an object with exactly the key `error` (the method wraps its whole body in `try/except
Exception` and returns `{'error': str(e)}`), read as `{ kind: "error", message }`, or an object with
a `unique_id` that is a string, null or absent, a `case_type` that is a string or null, and `forms`,
an array of objects with a string `unique_id`, an `xmlns` that is a string or null and an array
`questions`. The method writes `module.unique_id` as stored, so a menu that stores none is
summarized with a null one: an absent, null or `""` `unique_id` reads `uniqueId: null`, and any
other type is malformed (section 8.3 says how such a menu aligns). A mirror menu is
summarized with its source menu's case type and no forms (`ShadowModule.forms` is empty, and
`ShadowModule.case_type` is its source's); a shadow form is summarized with its parent's `xmlns` and
its parent's questions (`ShadowForm.xmlns`, `ShadowForm.source`).

A question must be an object with string `value` and `tag`; `type`, `repeat`, `group`, `relevant`,
`constraint`, `calculate` and `setvalue` are each a string or null or absent (absent reads null);
`is_group` absent reads false; `required` must be a boolean or absent; `translations` must be an
object of strings or absent; `options` must be absent or an array of objects with a string `value`
and an object of strings `translations`. Keys this list does not name (`label`, `label_ref`,
`comment`, `hashtagValue`, `data_source`, `constraintMsg_ref`, the stock keys) are not read. The
first entry that fails gives `{ malformedAt: "modules[i]" }` or
`{ malformedAt: "modules[i].forms[j].questions[k]" }`, logged at error with that path and nothing of
the content.

What the summary holds and omits is acceptance check 5's to reason over (part 09,
`09-acceptance-and-the-first-publish.md`, section 7, B7); the facts it rests on, read at
`app_manager/xform.py::XForm.get_questions`: one entry per control node in
document order, then one per data leaf with no control (`tag: "hidden"`, `type: "DataBindOnly"`),
then up to three attribute entries per Save to Case block, one for each of `case_id`, `user_id` and
`date_modified` that the block's `<case>` element carries; `required` is
`cnode.required == "true()"`; option values are stripped of surrounding whitespace; a visible
question carries no `calculate`.
Lifecycle: `ApplicationResource`, `dehydrate_module` and every key above are alive.

---

## 7. The source read, widened

`lib/commcare/hq/appSource.ts`:

```ts
export const HQ_MEDIA_TYPES = [
	"CommCareImage", "CommCareAudio", "CommCareVideo", "CommCareMultimedia",
] as const;
export type HqMediaType = (typeof HQ_MEDIA_TYPES)[number];

/** One entry of `multimedia_map`. */
export interface HqMediaMapItem {
	/** The map's key: the path the app's content names, `jr://file/...`. */
	readonly path: string;
	/** HQ's id of the file, or null where the entry names none Nova can ask for. */
	readonly multimediaId: string | null;
	readonly mediaType: HqMediaType | null;
	/** True where the entry names a file by an id or a type Nova cannot read. Both are then null. */
	readonly unreadable: boolean;
}

export interface HqAppSourceForm {
	/** `doc_type`: `Form`, `AdvancedForm` or `ShadowForm` (`models/forms.py::FormBase.wrap`). */
	readonly docType: string;
	/** `xmlns` as stored. Null on a shadow form, which stores none and takes its parent's. */
	readonly xmlns: string | null;
	/** This read's minted id: a key into this read only, never an identity. */
	readonly readUniqueId: string;
	/**
	 * `shadow_parent_form_id`: this read's id of the form a shadow form mirrors, rewritten with the
	 * form ids of the same read. Null where the key is absent, null or empty.
	 */
	readonly shadowParentReadId: string | null;
	/** The XForm under this read's `<form id>.xml`, or null when absent. */
	readonly attachment: string | null;
}

export interface HqAppSourceModule {
	/**
	 * `unique_id` as stored. Under `admit: "any"`, null where the menu stores none (absent, null or
	 * `""`). Under `admit: "plain"` always a string, as today.
	 */
	readonly uniqueId: string | null;
	/**
	 * `doc_type`: `Module`, `AdvancedModule`, `ReportModule` or `ShadowModule`
	 * (`models/modules.py::ModuleBase.wrap`).
	 */
	readonly docType: string;
	/** `case_type` as stored: `""` for a menu with none, null on a mirror menu, which stores none. */
	readonly caseType: string | null;
	readonly forms: readonly HqAppSourceForm[];
}

export interface HqAppSource {
	// The ten members it holds today, each with today's comment and today's check:
	readonly docType: "Application";
	readonly buildSpecVersion: string;
	readonly cloudcareEnabled: boolean;
	readonly logoRefs: Readonly<Record<string, unknown>>;
	readonly profile: HqApplicationProfile;
	readonly langs: readonly string[];
	readonly translations: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly addOns: Readonly<Record<string, boolean>>;
	readonly modules: readonly HqAppSourceModule[];
	readonly raw: Readonly<Record<string, unknown>>;
	// The three B1 adds:
	/** `name`, or null where HQ sent no string. */
	readonly name: string | null;
	/** `last_modified` as HQ wrote it, or null where HQ sent no string. */
	readonly lastModified: string | null;
	/** `multimedia_map` in HQ's key order, or null where the key is absent or holds no object. */
	readonly multimediaMap: readonly HqMediaMapItem[] | null;
}

export type HqAppSourceRead =
	| { readonly kind: "source"; readonly source: HqAppSource }
	/** HQ reports the app gone: a 404 (`deleted: false`) or HQ's own soft delete (`deleted: true`). */
	| { readonly kind: "gone"; readonly deleted: boolean }
	| { readonly kind: "unsupported"; readonly docType: string }
	| CommCareApiError;

export type ReadHqAppSourceOptions = {
	readonly maxBytes?: number;
	/**
	 * `plain`, the default: every menu holds a string `unique_id` and a string `case_type` and
	 * every form a string `xmlns`, and anything else is `malformed`. This is today's check, and a
	 * publish's.
	 * `any`: a null `case_type` and a null `xmlns` are read as null, and a menu's absent, null or
	 * `""` `unique_id` is read as null. This is a reading's.
	 */
	readonly admit?: "plain" | "any";
} & (HqReadDeadline | { readonly signal?: undefined; readonly deadline?: undefined });

export function readHqAppSource(
	creds: CommCareCredentials, domain: string, appId: string, options?: ReadHqAppSourceOptions,
): Promise<HqAppSourceRead>;
```

- **Mirror menus and shadow forms.** A mirror menu stores `"case_type": null` and no forms, and a
  shadow form stores `"xmlns": null` with `shadow_parent_form_id` ("Claims corrected"). A mirror
  menu is `not-yet` (part 06, `06-the-reader-forms.md`, section 7.1, B2, gives it its finding),
  which is one finding at that menu beside every other finding of the app, so a reading must read
  the source that holds one: `readHqAppForReading` passes
  `admit: "any"`. Under it a `case_type` must be a string or null, an `xmlns` a string or null, and
  every menu's and form's `doc_type` a string (HQ cannot load one without it: `ModuleBase.wrap`,
  `FormBase.wrap`); anything else is `malformed` as today. `shadowParentReadId` is the stored key:
  it is one of the four paths `models/base.py::FormIdProperty` registers, so
  `util.py::update_form_unique_ids` rewrites it with the forms' ids on every read
  (`proof/hq-reads/hq-built/app-source.json` holds one equal to its parent's `unique_id`).
- **A menu with no `unique_id`.** HQ gives a menu its id lazily
  (`models/modules.py::ModuleBase.get_or_create_unique_id`), so a stored menu may hold none. Under
  `admit: "any"` a menu's `unique_id` that is absent, null or `""` reads `uniqueId: null`, and a
  `unique_id` of any other type (a number, a list, an object) stays `malformed`. The reader then
  raises `menus-and-case-lists/module-unique-id-missing` at that menu and gives it no draft (part 06,
  `06-the-reader-forms.md`, section 7.2, B2), a finding with a next step, where a stop has none.
  Such a menu reaches no identity row: `ReadMenuAndFormIdentities.modules[].uniqueId`, which part
  06 declares (its section 2.2, B2) and `adoptedIdentityRows` of part 10
  (`10-identity-and-the-ledger.md`, section 3.1, B8) reads, stays `string`. Under `admit: "plain"`
  nothing moves: a `unique_id` that is no string is `malformed`, and `""` reads `""`, as today.
- **Publish does not move.** `admit` defaults to `plain`, and none of today's five callers
  (`lib/deployment/preflight.ts`, three in `lib/deployment/service.ts`, `proof/corpus/publish.ts`)
  passes it, so each refuses exactly the sources it refuses today, with the same
  `hq_app_state_unknown` sentence. Under `plain` a `doc_type` that is no string reads `docType: ""`
  and `shadowParentReadId` is read as under `any`; no publish reader reads either, and the mode's
  contract is today's check and nothing more. `uniqueId`, `caseType` and `xmlns` widen to
  `string | null` in the type for both modes; no production code reads any of the three today
  (`rg "HqAppSourceModule|HqAppSourceForm"` finds the reader and its tests alone). What a publish does
  over an HQ app that gained a mirror menu after Nova last read it stays today's refusal in step 6;
  bringing such a change in is step 7's group `changes-made-in-hq`.
- **`multimediaMap`.** `multimedia_map` is `hqmedia/models.py::ApplicationMediaMixin.multimedia_map`,
  a dict of path to `HQMediaMapItem` (`multimedia_id`, `media_type`, `version`, `unique_id`,
  `upstream_media_id`); an update never writes it, and HQ prunes it only when
  `remove_unused_mappings` runs, so an entry no content references any more is ordinary. An entry
  reads `multimediaId: null, mediaType: null, unreadable: false` where its `multimedia_id` is null or
  empty (`HQMediaMapItem.url` is empty for such an entry). An entry with an id whose id matches
  `^[\w-]+$` and whose `media_type` is in `HQ_MEDIA_TYPES` (the four keys of
  `CommCareMultimedia.get_doc_class`) reads both, `unreadable: false`. Any other entry (no object,
  an id outside the pattern, a type outside the four) reads `multimediaId: null, mediaType: null,
  unreadable: true` and is logged at warn with its index; the map is kept. One entry Nova cannot
  read never fails a reading by itself: a file comes in only where the read document references
  it, so part 11 (`11-project-data.md`, sections 2.1 and 3.2, B9) gives a finding for an
  unreadable entry only where the app's content references its path and a platform the app runs
  on draws the slot. The map is `null` only where the key is absent or holds no object. `version`,
  `unique_id` and `upstream_media_id` (set on a linked app's entries) are not read; `raw` keeps
  them. Lifecycle: all alive.
- **`name`, `lastModified`.** Kept as stored by the source view (retained:
  `proof/hq-reads/case-list-inline/app-source-after-media.json` holds both and a media map entry).
  `lastModified` is recorded with a reading for the review's date and is never compared: the bracket
  is the save counter.
- **Nullable, so publish cannot regress.** None of the three can make `readHqAppSource` answer
  `malformed`; publish's four reads ignore them. A reading treats `name === null` or
  `multimediaMap === null` as a failure of kind `answer-unreadable` (section 8): `multimedia_map`
  is a `SchemaDictProperty`, which HQ serializes on every app, and an app with no name has nothing
  the review can call it by.
- **`deleted`.** `gone` gains the boolean; every caller today reads `kind` alone.
- **Distinct causes.** A source over the bound is `cause: "too-large"`, a page is `browser-page`, and
  a body that is JSON of the wrong shape stays `malformed` (the reader's own `malformed(...)`
  helper), all with status 502, so `hqAppSourceReadFailure` chooses the same sentence as today.
- The file's header comment gains: the source serves `name`, `last_modified` and `multimedia_map` as
  stored, a mirror menu with a null `case_type`, a shadow form with a null `xmlns` and a menu HQ
  never gave an id with no `unique_id` (the sentence is under Contracts); and the
  `unsupported` arm's comment reads "the one HQ's source view serves for a working app is
  `LinkedApplication`; a build's id is served as `Application`, and no caller passes one."

---

## 8. The bracketed read and the alignment

### 8.1 Types

`lib/commcare/hq/appReading.ts` (new):

```ts
// The three budget constants of section 3.3 are exported from this file.

export interface HqAlignedForm {
	/** The form's real `unique_id`, from the application resource. */
	readonly uniqueId: string;
	/**
	 * The `xmlns` both reads agree on: the form's own, or for a shadow form its parent's. Null
	 * where neither read holds one.
	 */
	readonly xmlns: string | null;
	/** The source read's form at the same position. */
	readonly source: HqAppSourceForm;
	readonly questions: readonly HqQuestionSummary[];
}
export type HqAlignedModule =
	| { readonly kind: "aligned";
	    /** The source menu's `unique_id`; null where the menu stores none (section 7). */
	    readonly uniqueId: string | null;
	    /** The source menu's `doc_type`. */
	    readonly docType: string;
	    readonly forms: readonly HqAlignedForm[] }
	/**
	 * HQ could not summarize the menu at this position; its forms have no real ids. `message` is
	 * HQ's own text, the `str()` of whatever exception it met: for the log, never for a person.
	 */
	| { readonly kind: "not-summarized"; readonly uniqueId: string | null; readonly docType: string;
	    readonly message: string };

export type HqFormAlignment =
	| { readonly kind: "aligned"; readonly modules: readonly HqAlignedModule[] }
	| { readonly kind: "misaligned"; readonly at: string };

export function alignHqForms(
	source: HqAppSource, modules: readonly HqApplicationModule[],
): HqFormAlignment;

/**
 * Which findings HQ's failed summaries are: none, one at each named menu, or one at the app.
 * `indexes` are positions in `modules`.
 */
export function notSummarizedMenus(modules: readonly HqAlignedModule[]):
	| { readonly kind: "none" }
	| { readonly kind: "menus"; readonly indexes: readonly number[] }
	| { readonly kind: "app" };

export type HqAppReading =
	| { readonly kind: "read"; readonly version: number; readonly application: HqApplication;
	    readonly source: HqAppSource; readonly modules: readonly HqAlignedModule[] }
	/** The app was saved between the first read and the last. */
	| { readonly kind: "changed" }
	| { readonly kind: "linked" }
	| { readonly kind: "remote" }
	| { readonly kind: "deleted" }
	| { readonly kind: "gone" }
	| { readonly kind: "failed"; readonly failure: HqFailure };

export function readHqAppForReading(
	creds: CommCareCredentials, domain: string, appId: string,
): Promise<HqAppReading>;
```

The `read` arm carries `application` as written here unless part 12's run M1 gives its outcome C
(`12-the-reading-and-the-birth.md`, "Written and not yet run", B10). Under that outcome B10
removes the member, and `readHqAppForReading` keeps the resource's `version` and its typed menus
and no reference to the `HqApplication`, so the server holds the resource's menus once and not
twice while it reads the source.

### 8.2 `readHqAppForReading`, in order, under one deadline

One `withHqRequestDeadline(run, HQ_APP_READING_DEADLINE_MS)` owns every request below, and each is
passed its signal and its instant as one `HqReadDeadline`, so no throttle wait of section 3.2
begins that would outlast it. `client.ts::readAppVersions` gains `options?: HqReadDeadline` for it.

1. **The application resource**, `readHqApplication`. This is the API access check, made first.
   - A failure of status 403 that is not the edge's: `listHqApps` once, under the same deadline, to
     prove membership. The list answering makes the failure
     `classifyHqFailure(error, "application", { member: true })`; the list answering a 403 that is
     not the edge's makes it `classifyHqFailure(error, "application", { member: false })`; the list
     failing otherwise is `failed` with the list's own failure,
     `classifyHqFailure(listError, "app-list")`. An edge's 403 asks nothing more: rule 1 already
     makes it `gateway-refused`, and a throttled request would be spent to learn nothing.
   - A failure of status 404 that is not the edge's: `listHqApps` once, under the same deadline.
     Where the list holds `appId`, the answer is `remote`: the list's view emits `Application`,
     `RemoteApp` and
     `LinkedApplication` with no `copy_of`, and `BaseApplicationResource.obj_get` admits the first
     and the last through `api/util.py::get_object_or_not_exist`, which also refuses a document of
     another project space (run G2). Where the list does not hold it, the id is no working app of
     this project space, and `readHqAppSource` is asked only whether HQ holds it as deleted: `gone`
     with `deleted: true` is `deleted`; a source is `changed` (the app came back between two
     reads); `gone` with `deleted: false`, `unsupported` and every failure are `gone`, because the
     resource and the list have already answered and the source read adds nothing to them (an app
     of another project space makes that read raise, run G6). The list failing is `failed` with
     the list's own failure, `classifyHqFailure(listError, "app-list")`.
   - Any other failure: `failed`, classified with request `application`.
   - `builtFromAppId !== null`: `failed`, kind `answer-unreadable` (a build's id was asked for).
   - `hqApplicationModules` answering `malformedAt`: `failed`, kind `answer-unreadable`.
2. **The source**, `readHqAppSource` with the deadline and `admit: "any"`. `unsupported` with
   `docType` `LinkedApplication` is `linked`; any other `docType` is `failed`, kind
   `answer-unreadable`. `gone` is `deleted` or `gone` by its flag. A failure of status 403 is
   classified with request `app-source` and `member: true` when step 1 or its list proved
   membership (a 200 from the resource proves it). `name === null` or `multimediaMap === null` is
   `failed`, kind `answer-unreadable`.
3. **The save counter**, `readAppVersions`. A failure is `failed`, request `app-version`.
   `currentVersion !== application.version` is `changed`. The comparison is for equality only: one
   save can raise the counter by more than one, and nothing here assumes a step.
4. **The alignment**, `alignHqForms`. `misaligned` is `failed`, kind `answer-unreadable`, logged at
   error with `at`. `aligned` is `read`, whatever `notSummarizedMenus` says of its menus.

**What the bracket covers.** `models/applications.py::ApplicationBase.save` raises `version` on a
save of a document with no `copy_of` unless the caller passes `increment_version=False`, form saves
and media mapping included, and `dbaccessors.py::get_current_app_version` reads the same counter
from `applications_brief`. Two saves of a working app pass `False`, and neither opens the bracket:

- HQ's restore of a deleted app (`models/delete_records.py::DeleteApplicationRecord.undo`). A
  deleted app is one the application resource answers 404 for, so a reading of it never reaches the
  counter, and a restore between the first read and the last changes no content.
- A linked app's pull from its upstream (`views/utils.py::_update_forms`). A linked app is `linked`
  at step 2 and is never read further.

So for the apps a reading reads, equal counters before and after mean the source read lies between
two moments at which the app document and its media map were the same. The counter is not a total
record of every write to every app, and nothing here reads it as one. Lookup tables, levels and
places are rows outside that document; the re-read at creation covers them (part 12,
`12-the-reading-and-the-birth.md`, section 5.3, B10).

**`changed` is one attempt's answer.** The function never loops: one attempt is bounded at 120
seconds, and two do not fit the step beside the project data reads and the reader (section 3.3).
Part 12 (sections 2.4 and 3.3, B10) runs the attempt again on the reading's next step and gives
`changed-while-reading` on the second `changed` in a row.

**Why the list is asked on a 404 and a 403 and never on success.** It is the one membership-only
read, so it settles both questions without reading a body's shape, and it costs a throttled request
only on a path that already ends the reading.

### 8.3 `alignHqForms` and `notSummarizedMenus`

Both reads serve modules and forms in stored order (`Application.get_modules` and
`ModuleBase.get_forms` are `IndexedSchema.Getter`s over the stored lists; the source is the stored
document). For each position i:

- The counts of modules must be equal, else `misaligned` at `modules`.
- An `error` entry gives `{ kind: "not-summarized", uniqueId: source.modules[i].uniqueId, docType:
  source.modules[i].docType, message }`. HQ's error entry holds no `unique_id`, so the menu is known
  by its position alone, which is why the bracket must hold before this is trusted.
- A `summarized` entry, where `source.modules[i].uniqueId` is a string, must hold a `uniqueId`
  equal to it, else `misaligned` at `modules[i].unique_id` (a null from the resource beside a
  string from the source is such a disagreement). Where the source's is null the menu stores no
  id, the two are not compared, and the menu is aligned by position alone, whatever the resource
  reports for it; no run settles a branch here, because nothing is read from that value.
- A `summarized` entry must also hold the same number of forms, else `misaligned` at
  `modules[i].forms`; and for each j an `xmlns` equal to the source form's expected one, else
  `misaligned` at `modules[i].forms[j].xmlns`. It gives `aligned` with the source menu's `uniqueId`
  (a string or null) and `docType`, and each form's real `uniqueId`, the agreed `xmlns`, the source
  form and HQ's questions.

**A form's expected `xmlns`.** The source stores a form's own `xmlns`; the resource reports
`form.xmlns`, which for a shadow form is its parent's (`models/forms.py::ShadowForm.xmlns`). So the
expected value of a source form is its stored `xmlns` where that is a string. Where it is null and
`shadowParentReadId` names a form of the same read, it is that form's expected value, followed for
at most as many steps as the app has forms. It is null where the stored value is null and there is
no parent, the parent is not among the read's forms, or the steps run out (a loop). Equality
includes null with null: a shadow form whose parent is gone is null on both sides and aligns, and a
null on one side alone is `misaligned`. The comparison never resolves the resource's side: HQ has
already done so.

Two forms of one app may share an `xmlns` (a shadow form and its parent do); the pairing is by
position and `xmlns` only confirms it, so duplicates align. A mirror menu aligns as a `summarized`
entry with no forms, since both reads hold none for it. The reader (part 06,
`06-the-reader-forms.md`, section 7.1, B2) gives a mirror menu, a report menu and a shadow form
their `not-yet` findings from the source's `docType`, which is why both arms carry it, and a menu
with a null `uniqueId` its finding (its section 7.2, B2).

**Which findings failed summaries are: `notSummarizedMenus`.** Only a menu whose source `docType` is
`Module` or `AdvancedModule` is one HQ's summary is expected to hold; a `not-summarized` entry at a
mirror menu or a report menu is no finding of its own, because that menu already has its `not-yet`
finding and nothing in it is the person's to fix. Over the expected menus:

- none `not-summarized`: `{ kind: "none" }`;
- every one `not-summarized`, and there are at least two: `{ kind: "app" }`;
- otherwise: `{ kind: "menus", indexes }`, the positions that are.

`dehydrate_module`'s `try` covers `get_all_case_properties_local(app)`, which is computed for the
whole app before any form is read, so when it fails every menu's entry is an error and no one menu
holds the cause. Part 12 (`12-the-reading-and-the-birth.md`, section 3.3 step 4, B10) gives `menus`
as part 01's `menu-unreadable-in-hq` at each named menu, beside the reader's other findings, and
`app` as an account of the one circumstance `app-unreadable-in-hq` at the app, with no finding at
any menu. Either way the answer of this read is `read`, so under `menus` the reader still reports
every other finding of the app in the same pass. HQ's `message` goes to the log at error with the
menu's position (`[commcare] application module not summarized`) and to no person: it is `str(e)`
of any Python exception (a missing dictionary key reads as the key alone).

`models/case_list.py::DetailColumn.endpoint_action_id` is not a form id, though it is declared with
`FormIdProperty`. It names a form's session endpoint id, which the source holds as stored: no read
rewrites it and no aligned id resolves it. The reader of case lists (part 07,
`07-the-reader-cases-menus-lists.md`, section 11.2, B5) reads it against each form's
`session_endpoint_id`.

---

## 9. Media bytes

`lib/commcare/hq/media.ts` (new):

```ts
export const HQ_MEDIA_FILE_DEADLINE_MS = 60_000;
/** How many media files a reading asks CommCare HQ for at once. */
export const HQ_MEDIA_READ_CONCURRENCY = 4;
/**
 * How many files one media step asks for: what fits 180 seconds when every file runs to its
 * deadline (4 at a time, 60 seconds each). With the step's 30 second reserve that is a 210 second
 * step, which leaves a 270 second call a minute in which to start another (part 12, sections 3.6
 * and 4.5). The reading resumes with the rest.
 */
export const HQ_MEDIA_FILES_PER_STEP = 12;

export type HqMediaFileRead =
	| { readonly kind: "read"; readonly bytes: Uint8Array;
	    /** The response's `Content-Type` media type, lowercased, or null. A hint, never trusted. */
	    readonly declaredContentType: string | null }
	/** A 404 that is not the edge's: CommCare HQ holds no file there. */
	| { readonly kind: "missing" }
	/** The file is longer than `maxBytes`; nothing of it is kept. */
	| { readonly kind: "too-large"; readonly maxBytes: number }
	| CommCareApiError;

export function readHqMediaFile(
	creds: CommCareCredentials, mediaType: HqMediaType, multimediaId: string,
	options: { readonly maxBytes: number; readonly signal?: AbortSignal },
): Promise<HqMediaFileRead>;
```

- **The URL** is the one HQ gives each media map item from its type and id
  (`hqmedia/models.py::HQMediaMapItem.url`, a `reverse` of the route named `hqmedia_download`), the
  URL HQ's own app pages use for the file: `<base>/hq/multimedia/file/<mediaType>/<multimediaId>/`,
  with its trailing slash and no query. Nova reads it with the credential it already stores, as for
  the app source: `Authorization` from `authHeader`, `Accept: */*`, `redirect: "manual"`,
  `cache: "no-store"`. An id outside `^[\w-]+$` is `{ success: false, status: 400 }` before any
  request, with no `cause`: it is a request Nova will not send, as `hq/http.ts::
  INVALID_DOMAIN_SLUG` is for a slug, and not an answer Nova could not use (section 2.4). It is a
  guard no reading reaches, since section 7 reads an id outside the pattern as an `unreadable` map
  entry with a null id; it classifies as `refused`. `mediaType` is one of `HQ_MEDIA_TYPES` by its
  type. This section says nothing else of that route: the reader holds a status and bytes, and
  matches no sentence, key or shape of HQ's.
- **Bounded.** The body is read through `readBoundedBody(response, options.maxBytes)`; a longer body
  cancels the stream and answers `too-large`. No `Content-Length` is trusted. HQ's map carries no
  size, so the bound is the only limit; the caller passes Nova's limit for the kind the reference
  needs (`lib/domain/multimedia.ts::ASSET_SIZE_CAPS_BYTES[file.kind]`, passed by
  `fetchAndStageHqMediaFile` of part 11, `11-project-data.md`, section 2.2, B9), which makes a file
  over Nova's limit a finding without ever holding it.
- **Typed by `lib/media`, never here.** A 2xx whose `Content-Type` media type is `text/html` is
  `{ status: 502, cause: "browser-page" }`: a page is not a file, and judging it as media would blame
  the app. Every other 2xx body is returned as bytes with the declared type as a hint. Neither the
  declared type nor the extension of the path the app names says what a file is, and this plan
  sniffs the bytes before any name is trusted. `lib/media/validate.ts::
  validateMediaBytes` does the reverse today: it refuses a filename whose extension is off its list
  before it sniffs, and it has no entry point that starts from the bytes
  (`classifyStoredMediaBytes` builds its filename from a stored row's extension, which a file from
  HQ does not have). So this part hands the bytes, the hint and nothing more to part 11
  (`11-project-data.md`, section 2.3, B9), which adds the sniff-first entry point
  `lib/media/validate.ts::validateSniffedMediaBytes` and calls it with the bytes alone: its
  Departure 9 passes no declared type to `lib/media`, so `declaredContentType` is read by no
  verdict and stays what this reader reports of the answer.
- **Statuses.** A 404 that is not the edge's is `missing`. Every other failure is the
  `CommCareApiError`, classified with request `media-file`.
- **One resend.** Where the answer is `cause: "network"`, or a status of 502, 503 or 504, the file
  is asked for once more after 1 second, inside the same 60 second deadline. No other answer is
  resent.
- **The deadline is the file's own.** Each call owns one `withHqRequestDeadline(run,
  HQ_MEDIA_FILE_DEADLINE_MS)` through the last byte. `options.signal` is the caller's way to stop
  early (the step ending), joined to it with `AbortSignal.any`; it carries no instant because no
  rule of section 3.2 runs here.
- **Concurrency and order.** The caller dedupes by `(mediaType, multimediaId)`, asks only for files
  the app's content references, and runs `HQ_MEDIA_READ_CONCURRENCY` at a time. The window bounds
  Nova's own memory (four files of at most the largest limit) and the load Nova puts on HQ. Section
  3.2's one-at-a-time rule is for the reads HQ's limiter counts, and this read is not among the
  rows of section 3.1.
- **What each answer is to a reading** (part 11, `11-project-data.md`, sections 2.2, 2.4 and 3.2,
  B9, turns each answer into a verdict and each verdict into a finding): `missing` is part 01's
  `media-file-unreadable` at that file, where a platform the app runs on draws the slot;
  `too-large` is the finding of the manifest entry part 01 names for a file over Nova's limit
  (`expressions-and-data/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`), never a
  circumstance; a failure after the resend stops the media step of part 12
  (`12-the-reading-and-the-birth.md`, section 3.4, B10) with `hqReadCircumstance`'s code, since a
  file HQ could not send this minute is no fact about the app; bytes `lib/media` refuses are part
  11's verdict `refused` (its section 2.4).

---

## 10. Project data and the flag probe

### 10.1 Lookup table definitions

`hq/lookupTables.ts::listHqLookupTables` is the definition read, unchanged in shape:
`fixtures/resources/v0_1.py::LookupTableResource` serves `id`, `is_global`, `tag`, `fields` as
`[{field_name, properties}]` and `item_attributes`. It serves no description and no `is_indexed`.
It asks for the refused body so its plan refusal classifies, and that needs a way through the page
reader, which today passes `readHqJson` a signal and nothing else. `hq/readCollection.ts` gains:

```ts
export interface ReadHqCollectionOptions {
	readonly onMeta?: (meta: Readonly<Record<string, unknown>>) => void;
	readonly deadline?: "whole" | "page";
	/** Passed to every page's `readHqJson`, so a refused page keeps its bounded body. */
	readonly keepRefusedBody?: boolean;
	/**
	 * A deadline the caller owns across this list and others. With it the reader opens none of its
	 * own in either mode, and every page is read under the caller's.
	 */
	readonly within?: HqReadDeadline;
}
```

`listHqLookupTables`, `readHqLookupTableRows`, `hq/locations.ts::listHqLocationTypes` and
`listHqLocations` each gain a last parameter `options?: HqReadDeadline`, handed on as `within`. A
publish passes none and keeps each read's deadline as it is; a reading passes the one deadline of
`HQ_PROJECT_DATA_READING_DEADLINE_MS` to all four (section 3.3). `listHqLookupTables` always passes
`keepRefusedBody: true`.

Its silent defaults become refusals, because a reading must not read a malformed definition as a
plain one: an entry of `fields` that is neither a string nor an object with a string name, a
`properties` or `item_attributes` that is present and not an array of strings, and an `is_global`
that is not a boolean each make the read `{ status: 502, cause: "malformed" }`, where today
`toHqLookupTable` skips the entry, drops the value or reads `false`. `listHqLookupTables` is also
the `project-data` read of a publish's preflight, so this stops a publish that passes today over a
table list HQ serves malformed: Change 3 under Contracts. It follows `lib/deployment/CLAUDE.md`'s
rule that a malformed row is never skipped, and the sentence it prints is that preflight check's
existing "couldn't ask" (section 12, ladder 4).

### 10.2 Rows: `FixtureResource`, decided

`readHqLookupTableRows` keeps reading `GET /a/<domain>/api/fixture/v1/?fixture_type_id=<id>`.

| | `FixtureResource` | `LookupTableItemResource` |
|---|---|---|
| One table's rows | `fixture_type_id` filter, in `sort_key` order (`LookupTableRowManager.iter_rows`) | no filter: every row of the project space |
| A field's value | a string where every field of the row holds one value; else `field_list` with properties | always `field_list` with properties |
| Row attributes, `sort_key` | not served | served |
| Needs | API access, Edit Apps and Access APIs | API access and Access APIs |

Nova's table model holds one value a field and no attributes, so everything `FixtureResource` omits
is something Nova cannot hold anyway, and the read that costs one table is the right one. Reading a
project space's every row to learn one table's attributes is step 7's question
(`project-data-at-hq-size`), with the model that could hold them.

### 10.3 What Nova's model cannot hold, and how it is detected

A table is `not-yet` when any of these holds; the detection is pure, over the two reads:

| What | Detected from | By |
|---|---|---|
| a field property | the definition: some field's `fieldProperties` is not empty | `lib/deployment/lookupResourcePlan.ts::unsupportedLookupContent`, as publish does today |
| a row attribute | the definition: `itemAttributes` is not empty | the same |
| rows that go only to their owners | the definition: `isGlobal === false` | the same |
| a field holding other than one value | the rows: some row's field is a list whose length is not 1 | `hq/lookupTables.ts::rowsHoldOtherThanOneValue(rows: readonly HqFixtureRow[]): boolean`, new |

`FixtureResource.dehydrate_fields` falls back to the `field_list` form for a whole row as soon as one
field holds more than one value (`fields_without_attributes` raises `FixtureVersionError`), so the
row detector reads exactly that fallback. A row attribute the definition does not declare is not
visible to either read; an app is affected by one only where an expression reads it, and that read is
a finding of the reader's own (part 08, `08-the-reader-expressions.md`, section 9.2, B6), since no
Nova table has attributes. Row owners, a table's description and a field's indexed flag are served
by no API-key read: a managed table is never pushed, so none is erased, and part 11
(`11-project-data.md`, section 5.4, B9) states them where they matter.

Only the tables the app reads are read: the table list once, then rows for those tags, one table at a
time (section 3.2). Which tags those are is part 11's to say (`11-project-data.md`, section 5.1,
B9).

### 10.4 Levels and places

`hq/locations.ts::listHqLocationTypes` and `listHqLocations` are reused, each with the deadline
parameter of section 10.1 and `cause: "malformed"` on `malformedInventory` (section 2.4). They need
the four gates `lib/deployment/CLAUDE.md` names and are not throttled. What they return bounds what
a reading can know: a level's `name`, `code`, parent, `administrative`, `shares_cases` and
`view_descendants` (`locations/resources/v0_5.py::LocationTypeResource.Meta.fields`), with no
`has_users` and none of the expand settings; active places only, with their custom fields whole
(`values`). Part 11 (`11-project-data.md`, section 11, B9) decides what comes in and what is
stated: places come in only where the app reads them, and the settings no API returns take Nova's
defaults and are said in Organization and in the review (its sections 11.1 and 11.3).

### 10.5 The flag probe

`client.ts::probeHqProjectSpaceCompatibility` is reused unchanged and a reading does not call it: its
plan is built from a document, and this plan asks no confirmation of a person that the source
project space already answers (`../6-bring-in.md`, "The experience in brief"). The first publish
of an adopted app runs it as every publish does, with the publisher's key. Its `not-a-member` issue
and `classifyHqFailure`'s `not-a-member` name the same fact from two reads.

---

## 11. Credentials

`lib/db/settings.ts`: `resolveUploadTarget` becomes `resolveHqTarget`, `getCredentialsForUpload`
becomes `getHqCredentials`, `UploadTargetResult` becomes `HqTargetResult`,
`CredentialsForUploadResult` becomes `HqCredentialsResult`, and the private `UploadTargetRefusal`
becomes `HqTargetRefusal`; the pure `lib/db/domainResolution.ts::resolveUploadDomain` (which they
call) becomes `resolveHqDomain`. No alias is kept. The bodies do not change. The call sites, each
renamed in B1:
`lib/mcp/tools/checkProjectSpaceCompatibility.ts`, `lib/mcp/tools/uploadAppToHq.ts`,
`app/api/commcare/project-space-compatibility/route.ts`, `lib/deployment/service.ts`,
`lib/deployment/preflight.ts`, `lib/deployment/entryPointLinks.ts`, `lib/deployment/workers.ts`; the
tests `lib/db/__tests__/domainResolution.test.ts`, `lib/db/__tests__/settings.postgres.test.ts` and
`app/api/commcare/project-space-compatibility/__tests__/route.test.ts`; the comment in
`lib/deployment/previewTarget.ts` that names `resolveUploadDomain`; and `lib/commcare/CLAUDE.md`'s
paragraph "A key is not one-project-per-user", which names `resolveUploadDomain` as what chooses the
upload target. That is every file `rg -l "resolveUploadTarget|getCredentialsForUpload|
resolveUploadDomain|UploadTargetResult|CredentialsForUploadResult"` finds outside `docs/plans/`, and
B1 leaves the search empty.

A reading uses the reading person's own key, as every HQ operation does. Its project spaces are the
stored `approved_domains`, which prove membership when the key was last saved or refreshed and
nothing more: a reading needs Edit Apps, API access on the plan and Access APIs on the account
besides, which sections 5 and 8 check and name.

---

## 12. The four ladders

Each ladder chooses its sentence by `classifyHqFailure(...).kind`, and each becomes a pure exported
function so a test can hold it total. Settings and the import print, for every answer, the sentence
they print today, byte for byte. That takes one rule beyond the kind: today both choose by status
(Settings by status alone, the import after its gateway sentence), so the two kinds that cut across
statuses, `gateway-refused` in Settings and `browser-only` in both, are chosen by `failure.status`,
by the same status rows as today. The source read and the table list each change one sentence, for
an edge's 401 or 403, on purpose (Changes 1 and 2 under Contracts).

**1. Settings.** `app/(app)/(site)/settings/hqFailureMessage.ts` (new) exports
`settingsFailureMessage(failure: HqFailure, context: { readonly server: CommCareServer; readonly
moment: "verify" | "refresh" }): string`; `settings/actions.ts` calls it with
`classifyHqFailure(error, "app-list")` and loses `invalidKeyMessage` and `settingsErrorMessage`.

The refresh has no error to classify today, so `lib/db/settings.ts::RefreshDomainsResult`'s
`hq_error` arm changes from `{ ok: false; kind: "hq_error"; status: number }` to
`{ ok: false; kind: "hq_error"; error: CommCareApiError }`, `refreshApprovedDomains` returns the
error `discoverAccessibleDomains` gave it whole, and `refreshDomainsAction` classifies
`result.error`. `commcare-actions.test.ts`'s two refresh mocks serve the new shape.

| Kind | `verify` | `refresh` |
|---|---|---|
| `key-not-accepted`, `plan-lacks-api-access`, `api-cut-off` | today's `invalidKeyMessage(server)` sentence, moved here with the function's body: `` `CommCare HQ (${label}: ${host}) rejected this API key. Check that you copied it correctly, and that ${label} is the server where your account lives, a key only works on the server that issued it.` ``, `label` and `host` from `COMMCARE_SERVERS[context.server]` | "CommCare HQ no longer accepts your stored API key, it may have been revoked or expired. Disconnect and reconnect with a new key." |
| `rate-limited` | "Rate limited by CommCare HQ. Wait a moment and try again." | the same |
| `hq-unavailable`, `timed-out`, `too-large`, `answer-unreadable` | "CommCare HQ is unavailable. Try again later." | the same |
| `gateway-refused`, `browser-only` | by `failure.status`: 401 is the first row's sentence, 429 the second's, 500 or more the third's, anything else the last row's | the same rule |
| every other kind | `CommCare HQ returned an error (HTTP ${failure.status}).` | the same |

Held to today's ladder answer by answer: a status of 401 is the key sentence whoever answered
(kinds `key-not-accepted`, `plan-lacks-api-access`, `api-cut-off`, and an edge's 401 by the status
rule); 429 is the rate sentence (HQ's or an edge's); 500 or more is the unavailable sentence, which
holds every synthesized cause (502, 503, the 508 of section 2.4) and an edge's 502 or 504; a 3xx,
an edge's 403, a 404 and every other status print the status. A 403 HQ itself gives never reaches
this ladder from `list_apps` (`testDomainAccess` answers `false` for it); one from the project
space list is kind `not-a-member` under the request this ladder classifies with, which is in the
last row, and prints its status as today.

**2. The import.** `lib/deployment/service.ts::importRejectionMessage` takes
`classifyHqFailure(error, "app-import")` and prints one of today's six sentences, each unchanged:

| Kind | Sentence |
|---|---|
| `gateway-refused`, at any status, as today | "A security gateway in front of CommCare HQ turned this upload away before CommCare HQ received it, so it doesn't reflect your permissions or anything in your app. Nova can't clear this one from here. Dimagi support (support@dimagi.com) can exclude the app import endpoint from the rule that matched." |
| `key-not-accepted`, `plan-lacks-api-access`, `api-cut-off` | "CommCare HQ didn't accept your API key. Update it in Settings, then publish again." |
| `permission`, `not-a-member` | "Your CommCare HQ account can't create apps in this project space. Ask an administrator there for the Edit Apps permission." |
| `rate-limited` | "CommCare HQ is rate limiting requests right now. Wait a moment and publish again." |
| `hq-unavailable`, `timed-out`, `too-large`, `answer-unreadable`; `browser-only` where `failure.status` is 500 or more | "CommCare HQ is unavailable right now. Try publishing again in a few minutes." |
| `not-found`, `refused`; `browser-only` at any other status, which is what a 3xx prints today | `` `CommCare HQ refused the app (HTTP ${failure.status}).` `` |

**3. The source read.** `lib/deployment/preflight.ts::hqAppSourceReadFailure` keeps its `unsupported`
arm and sets `permissions` to "the read is an error whose kind, classified with request
`app-source`, is `key-not-accepted`, `plan-lacks-api-access`, `api-cut-off`, `not-a-member` or
`permission`", which is every 401 and 403 HQ itself gave, as today. An edge's 401 or 403 is
`gateway-refused` and moves to the "couldn't safely read" sentence, which is the truthful one:
Change 1 under Contracts.

**4. The table list.** The `project-data` edge of `preflight.ts::runDeploymentPreflight` chooses its
"needs API access ... and the Access APIs permission" sentence where the kind, classified with
request `lookup-tables`, is one of the same five, and its "couldn't ask" sentence otherwise. Today
it chooses by status alone, so an edge's 401 or 403 asks the person for a plan feature and a
permission they may already hold; from B1 it is `gateway-refused` and prints "couldn't ask ... Try
publishing again in a moment.": Change 2 under Contracts. A definition HQ serves malformed, which
today's reader takes with a default, prints the same "couldn't ask" sentence: Change 3.

**What does not move in B1, and why.** `lib/deployment/observe.ts` (the probe's pending reason),
`service.ts`'s resource pushes, `preflight.ts`'s `organization` edge, `lib/deployment/workers.ts` and
`hq/locations.ts`'s patch each test `401 || 403` once to choose between two sentences. They are not
ladders, they classify writes or name one permission, and moving them changes no behavior. They stay.

---

## 13. MCP and scopes

B1 adds no tool, so `lib/mcp/__tests__/servedSchemas.test.ts`, `scripts/test-schema.ts`,
`MODEL_CONTEXT_VERSION` and `RUNTIME_VERSION` do not move. Part 13 (`13-the-experience.md`,
section 14.1, B12) registers six MCP tools, and three of them rest on these reads. What the reads
imply for those three, which part 13 takes as written: `list_hq_apps` (`listHqApps` and
`probeHqApiAccess`, through its `listHqAppsForPicker`) and `read_hq_app` (which writes Nova's own
`hq_app_readings` row, the table of part 12, `12-the-reading-and-the-birth.md`, section 2, B10,
and nothing at HQ) declare `oauthScopeChallenge(ctx, SCOPES.hqRead)`; `bring_in_hq_app` records an
adopted deployment that authorizes later writes to that HQ app, so it declares `SCOPES.hqWrite`, as
`refresh_deployment` does for a ledger write. Each calls `assertScope` before `getHqCredentials`. A
tool answers a failed read with `hqReadCircumstance`'s code and the words part 01 holds for that
code (part 13, section 14.8), never a status. The other three tools (`stop_publishing`,
`refresh_managed_data`, `set_lookup_table_management`) call no reader of this part directly, and
their scopes are part 13's to state.

---

## 14. Proof: retained reads and the surface manifest

### 14.1 The group `proof/hq-reads/reading/`

`proof/hq/test_retained_reads.py` gains `READING_FILES` and
`test_the_reading_reads_nova_is_served_are_hqs_own`, in the publish group's form: each state made by
HQ's own models and pages, each read in a determinism operation of its own, each answer written to
`$PROOF_OUT/hq-reads/reading/` and the committed directory held to it byte for byte. Its project
space is `navigation-base`'s configuration with `API_ACCESS` beside it, except where a file says
otherwise. Its module docstring gains the group's paragraph, a fourth item of its list:

```text
- ``reading``: the reads that bring an app in, over ``navigation-base`` as
  Nova's first publish leaves it with a linked app, a remote app, a
  soft-deleted app and a build beside it: the app list, and the app list at
  the limiter's floor; the API access probe with the privilege, without it
  and under a role lacking ``access_api``; the application resource of the
  live app, of an app one of whose forms HQ cannot summarize, without the
  privilege (for a member's key and for a superuser's, the second through
  HQ's middleware), with ``API_BLACKLIST`` on, under a role lacking
  ``access_api``, of the linked, the deleted and the remote app, of an app of
  another project space, of a build, and at the limiter's floor; the source
  read of the remote app and of the other project space's app; the source
  read and the application resource of the ``hq-built`` app with two mirror
  menus added; the current version before and after a save; and the rows of
  a table one of whose rows holds a field with no value. Its requests are
  ``proof/views/reading_reads.py``'s.
```

| File | State and read | Settles |
|---|---|---|
| `list-apps` | `navigation-base` as Nova's first publish leaves it, a linked app (`operations.link_app_through_hq`), a remote app, a soft-deleted app and a build; `list_apps` | the list holds the first three alone |
| `list-apps-429` | `list_apps` at the limiter's floor | `Retry-After` on a function view |
| `api-access`, `api-access-no-plan`, `api-access-no-permission` | the probe's read; without `API_ACCESS`; with a role lacking `access_api` | section 5.2's three answers |
| `application` | the application resource of `navigation-base` | real form ids, the summary's shape |
| `application-error-module` | one form's XML replaced by text `XForm.get_questions` refuses | G3 |
| `application-no-api-access` | without `API_ACCESS` | the plan sentence, byte for byte |
| `application-no-api-access-superuser` | the same, a superuser's key, through the middleware | G1 |
| `application-api-cut-off` | the configuration's `flags` with `API_BLACKLIST` | the cut-off sentence |
| `application-no-permission` | a member whose role lacks `access_api` | a bodyless 403 |
| `application-linked`, `application-deleted`, `application-remote`, `application-other-space`, `application-build` | each id | 200, 404, G2, G6, `built_from_app_id` |
| `application-429` | at the limiter's floor | G5 |
| `source-remote`, `source-other-space` | the source read of each, kept through `_keep_raised` | G2, G6 |
| `source-shadow`, `application-shadow` | the `shadow` state: the app of the existing `hq-built` state (an advanced menu with a shadow form, a report menu), with two mirror menus added by `ShadowModule.new_module`, one whose `source_module_id` names the first menu and one that names none; the source read and the application resource of it | G4 |
| `current-version`, `current-version-after-save` | before and after a save made through HQ's model | the counter moves |
| `fixture-rows-empty-field` | a table one of whose rows holds a field with no value, by HQ's model, kept through `_keep_raised` | G7 |

`proof/views/reading_reads.py` (new, B1) holds `app_list_read`, `application_read`,
`api_access_read`, `remote_app_through_hq`, `seed_api_superuser` and `client_request`, imported by
`proof/hq/test_retained_reads.py`; B13 moves them into `proof/hq/operations.py` when the
observation first calls them (part 14, `14-proof.md`, sections 5.3 and 11.2). `proof/hq/` is an
observation directory (`proof/observe/partition.py::OBSERVATION_DIRECTORIES`), so new functions
there would move every part key in B1 for reads only a test module makes; `proof/views/` is not.
The module imports `api_request`, `HqAnswer`, `ApiCredential`, `seed_api_user` and `seed_api_key`
from `proof.hq.operations` and changes none of them:

```python
def app_list_read(state, credential: ApiCredential) -> HqAnswer:
    """``views/cli.py::list_apps``, as Nova's ``listHqApps`` reads it:
    ``GET /a/<state.domain>/apps/api/list_apps/`` through ``api_request``."""

def application_read(state, app_id, credential: ApiCredential) -> HqAnswer:
    """``api/resources/v0_4.py::ApplicationResource`` for ``app_id``, as Nova's ``readHqApplication``
    reads it: ``GET /a/<state.domain>/api/application/v1/<app_id>/`` through ``api_request``."""

def api_access_read(state, credential: ApiCredential) -> HqAnswer:
    """The probe's read, as Nova's ``probeHqApiAccess`` makes it:
    ``GET /a/<state.domain>/api/lookup_table/v1/?limit=1`` through ``api_request``."""

def remote_app_through_hq(state) -> str:
    """A ``RemoteApp`` document saved by HQ's model in the state's project space. Returns its id."""

def seed_api_superuser(state, username: str) -> ApiCredential:
    """The member ``seed_api_user`` makes, with ``is_superuser`` then set and saved on its Django
    user by HQ's model, and its key through ``seed_api_key``. ``seed_api_user`` alone makes a
    role-scoped member and cannot make a superuser."""

def client_request(state, method: str, path: str, *, credential: ApiCredential | None) -> HqAnswer:
    """One request through ``django.test.Client(raise_request_exception=False)``, with the
    credential's ``Authorization`` header as ``api_request`` writes it, so HQ's middleware runs and
    an exception is answered by HQ's ``handler500``. The answer is built as ``api_request`` builds
    one. Used by G1 alone."""
```

`__tests__/helpers/retainedHqReads.ts` gains:

```ts
/** The files of `proof/hq-reads/reading/`, by name without `.json` (the table above). */
export type RetainedReadingRead =
	| "list-apps" | "list-apps-429"
	| "api-access" | "api-access-no-plan" | "api-access-no-permission"
	| "application" | "application-error-module" | "application-no-api-access"
	| "application-no-api-access-superuser" | "application-api-cut-off"
	| "application-no-permission" | "application-linked" | "application-deleted"
	| "application-remote" | "application-other-space" | "application-build" | "application-429"
	| "source-remote" | "source-other-space" | "source-shadow" | "application-shadow"
	| "current-version" | "current-version-after-save" | "fixture-rows-empty-field";
export function retainedReadingRead(name: RetainedReadingRead): RetainedHqAnswer;
/**
 * The retained `application` answer with its body's `id` set to `appId` and its `versions` set
 * to `versions`, HQ's build rows as a suite writes them.
 */
export function applicationAnswer(appId: string, versions: readonly unknown[]): RetainedHqAnswer;
```

The four suites that serve the application resource to a status check use `applicationAnswer` in
place of a bare `{ versions }` (Tests). A file that holds `{"exception": "<class>"}` is read as
`{ status: 500, headers: {} }` with no body, which is the answer a deployed HQ gives a view that
raised;
`lib/deployment/__tests__/hqResourceBaseline.test.ts` already serves such a file as a 500 by hand,
and the helper makes that the one rule. `replyRetained` does not change.

The media read has no file here and no operation: section 9's reader matches nothing of HQ's answer
but a status and bytes, so `hqMedia.test.ts` exercises it whole against a peer it writes (Tests).

The existing `lookups/` files already hold a table with field properties and row attributes
(`lookup-tables.json`, `fixture-rows-rich.json`); section 10's detectors are tested over them and no
copy is made.

### 14.2 The surface manifest's `hq-api` family

`proof/surface/families/hq_api.py::RESOURCES` gains
`("corehq.apps.fixtures.resources.v0_1", "FixtureResource")` and loses
`("corehq.apps.fixtures.resources.v0_6", "LookupTableItemResource")`;
`proof/surface/test_hq_api.py::NOVA_PATHS` gains `"FixtureResource": "/a/demo/api/fixture/v1/"` and
loses the item resource's row; the family's docstring replaces its last sentence about
`LookupTableItemResource` with "the lookup table rows (`fixtures/resources/v0_1.py::
FixtureResource`)". `npm run surface` then regenerates `lib/commcare/surface/surface.json`:
`hq-api:FixtureResource` appears, `hq-api:LookupTableItemResource` and any `hq-api-support:` item only
it named disappear. No authored entry names either key (`rg "hq-api" lib/commcare/surface/entries`
finds `hq-api:case_fixture` alone), so no entry edit follows. `VIEWS` is unchanged: `list_apps`,
`app_source` and `current_app_version` are already recorded, and `hq-api:ApplicationResource` already
records the inherited `dispatch`. Its facts print the plan sentence as a literal, so the weekly pin
pull request shows a change to that sentence. They do not print the cut-off sentence: the method
builds it in a local variable, and the facts hold `json.dumps({'error': msg})`. What holds the
cut-off sentence to the pin is the retained `reading/application-api-cut-off.json`, on every lane
run, and `hqFailure.test.ts` over it. The media read gets no item and no retained file (Departure
3).

---

## Copy

B1 changes two sentences a person can meet today, both in a publish's preflight and both for a
refusal the edge gave (Changes 1 and 2 under Contracts), and none in Settings or the import. Change
3 stops a publish it lets through today, with a sentence that already exists.

Part 01 holds the binding copy of every circumstance (`lib/publish/hqFindingCopy.ts::
CIRCUMSTANCE_COPY`, its section 9.3), one block of title, body and next step a code. This part
writes no sentence for a code A2 lands. For the seven codes B1 adds (section 4.3), these are the
blocks, in part 01's form and with its placeholders (`{space}` the project space, `{app}` the HQ
app's name, `{name}` `detail.name`); part 01's section 9.3 holds the same seven, word for word, and
part 13 (`13-the-experience.md`, section 6, B11) lays each out. Nothing has been created when any
of them shows.

| Code | Title | Body | Next |
|---|---|---|---|
| `hq-gateway-refused` | A security gateway turned Nova away | A security gateway in front of CommCare HQ turned Nova's request away before CommCare HQ saw it, so it says nothing about your key or your permissions. | You can check again in a few minutes. If it keeps happening, Dimagi support (support@dimagi.com) can help. |
| `api-cut-off` | CommCare HQ has paused API access | CommCare HQ has paused API access for your account or for {space} after too many requests. Your key and the plan are fine. | Dimagi support (support@dimagi.com) can turn it back on. Then you can check again. |
| `browser-only` | CommCare HQ sent a page meant for a browser | Nova asked {space} for an app and CommCare HQ answered with a page meant for a person, as it does when a project space asks you to sign in another way or isn't active. | Opening {space} in CommCare HQ shows what it's asking for. Once that's settled, you can check again. |
| `remote-app` | This app isn't kept in CommCare HQ | {app} is hosted outside CommCare HQ, which only links to it, so there's nothing here for Nova to bring in. | You can go back and choose another app from {space}. |
| `cannot-read-organization` | Nova couldn't read this project space's organization | {app} reads places, and reading them from {space} needs Locations and API access on its plan, and the Edit Locations and Access APIs permissions on your account. CommCare HQ doesn't say which one is missing. | An admin of {space} can check these four. Then you can check again. |
| `app-unreadable-in-hq` | CommCare HQ can't summarize this app | CommCare HQ returned an error where its own summary of this app's forms should be, so Nova has nothing sure to check its reading against. | Opening the app's forms in CommCare HQ's form builder usually shows which one is broken. If they all open, Dimagi support (support@dimagi.com) can help. Then you can check again. |
| `table-rows-unreadable` | CommCare HQ couldn't send this table's rows | CommCare HQ listed the lookup table {name} and then couldn't send its rows. A row that holds a field with no value is one cause Nova knows of. | You can open the table in CommCare HQ and fill in or remove that row, then check again. |

`api-cut-off` says "your account or {space}" because the switch behind it is set for a project
space or for one user (`corehq/toggles/__init__.py::API_BLACKLIST`, both namespaces), and the answer
does not say which. No block shows HQ's own error text: `menu-unreadable-in-hq` and
`app-unreadable-in-hq` name the place and never the message (section 8.3).

Log lines (a developer reads them), each with `domain` and the request kind and never a body:
`[commcare] <label> rate limited, sending again` (warn), `[commcare] <label> is longer than Nova
reads` (error, unchanged), `[commcare] app list row is malformed` (error, with the row's index),
`[commcare] application modules are malformed` (error, with the path),
`[commcare] application module not summarized` (error, with the position and HQ's message),
`[commcare] app reading misaligned` (error, with the place), `[commcare] media map is malformed`
(error), `[commcare] media map entry is unreadable` (warn, with the entry's index).

---

## Tests

All Vitest, at the adapter boundary: an undici `MockAgent` answers the exact URL, and where HQ's
answer matters the reply is a retained file (`replyRetained`), as `lib/commcare/__tests__/
client.test.ts` and `appSource.test.ts` do. No test writes an answer of HQ's by hand where a retained
one exists; `hqMedia.test.ts` is the one suite whose peer is written by the test, because its reader
matches nothing of an answer but a status and bytes (section 14.1). A retained file that holds an
exception is served as a bodiless 500 (`retainedReadingRead`). Fake timers are owned and restored
by each test that waits, and a test of a resend serves every answer the read will ask for.

| Test (file under `lib/commcare/__tests__/` unless a path is given) | Holds | The failure it would catch |
|---|---|---|
| `hqReadJson.test.ts`: over the bound, a page, broken JSON | `too-large`, `browser-page`, `malformed`, each 502 | the three folded again, so a person is told "couldn't read" for a large app |
| `hqReadJson.test.ts`: `refusedBody` | absent unless asked; cut at 2,048 characters; the body read once | a refusal text leaking to a caller that did not ask, or a double read hanging |
| `hqReadJson.test.ts`: 429s, with `reading/application-429` and `list-apps-429` | one second for no header, the header's wait up to 2 seconds, none past it, three sends at most; with a caller's `HqReadDeadline` one second away, a two second wait is not begun and the 429 is the answer; with the reader's own deadline, the same | a tastypie 429 ending a reading at once; a long window waited out; a wait begun that the caller's deadline cuts off, which would report a timeout for a throttle |
| each reader's own suite: synthesized causes | each row of section 2.4 carries `cause: "malformed"` at its status (502, and 508 for a cursor that never ends) | a wrong-shaped answer classified as an outage and never logged as Nova's |
| `hqFailure.test.ts`: the rule table | every row of section 4.2 and every cell of rule 10; every `HqFailureKind` produced by some row | a kind no answer reaches, or an answer with no kind |
| `hqFailure.test.ts`: `hqReadCircumstance` | total over every kind, every `HqRequestKind` and every `HqPermissionNeed`, each answer a member of `READ_CIRCUMSTANCES`; `not-found` is `app-gone` for the three app requests and `hq-unavailable` for every other; `too-large` is `too-large` for `application` and `app-source` alone; each row of section 4.3's table | a deleted table worded as a missing app; a long app list worded as an app too large; a code part 01's list does not hold |
| `hqFailure.test.ts`: retained answers | `application-no-api-access` is `plan-lacks-api-access`; `application-api-cut-off` is `api-cut-off`; `application-no-permission` with `member: true` is `permission`, `access-apis`; `publish/source-missing` is `not-found` | HQ's sentence drifting from Nova's constant at a pin |
| `hqApps.test.ts` | `list-apps` reads to three listings; a row without `app_id`, a duplicate id and a wrong envelope are malformed for `listHqApps`; `testDomainAccess` answers `true` for an envelope whose rows `listHqApps` refuses, `false` for HQ's own 401 and 403, the error otherwise, and `false` with no request for an invalid slug | a picker row with no id; one odd app failing the save of a key for every project space; an odd slug stopping discovery |
| `hqApps.test.ts`: the probe | the three `api-access*` files give the three named answers | the plan refusal read as a bad key |
| `hqApplication.test.ts` | `application` reads to builds and typed modules with real ids; `application-error-module` gives one `error` entry and the others whole; `application-shadow` reads a mirror menu with no forms and a shadow form whose `xmlns` is its parent's; `application-build` exposes `builtFromAppId`; a question without `value` gives `malformedAt` with its path; the retained `application` body with one module's `unique_id` set to null, removed and set to `""` reads `uniqueId: null` each time, and with it set to a number gives `malformedAt`; the build inventory cases `appReadings.test.ts` holds today ("requires a complete build inventory with unambiguous identities and release flags"), moved here and served inside the retained envelope | form ids taken from a build; one bad menu losing every id; a silent skip of an unreadable question; a mirror menu refused as malformed |
| `appSource.test.ts` (extended) | `case-list-inline/app-source-after-media` reads `name`, `lastModified` and one map item; an entry with a bad id reads `unreadable: true`, the map is kept and the read still answers `source`; `hq-built/app-source` and `reading/source-shadow` are `malformed` under the default and read under `admit: "any"`, with the shadow form's `xmlns` null and its `shadowParentReadId` equal to its parent's `readUniqueId`, and the mirror menus' `caseType` null; the retained `publish/source-live` body with one menu's `unique_id` removed is `malformed` under the default and reads that menu's `uniqueId` null under `admit: "any"`, the same for null and for `""` under `any`, while `""` reads `""` under the default and a numeric `unique_id` is `malformed` under both; `publish/source-deleted` is `gone` with `deleted: true`, `source-missing` with `false`; the existing over-the-bound case now expects `too-large` | a publish read failing on a media map, or newly passing a source it refuses today; a reading failing whole on a mirror menu or on a menu with no id; deleted and missing told as one |
| `hqAppReading.test.ts` | the whole sequence over retained answers: `read` with aligned ids; `changed` when the counter differs; `linked`; `remote` (resource 404, list holds it); `deleted`; `gone`; a 403 with the list answering is `permission`, with the list refusing is `not-a-member`, and an edge's 403 is `gateway-refused` with no list request sent; one deadline spans all three requests and its instant reaches each | an app saved mid-read accepted; a remote app reported as gone; a permission problem reported as lost membership; a throttled request spent on an edge's refusal |
| `hqAppReading.test.ts`: `alignHqForms` | a module count, a module id, a form count and an `xmlns` that differ each give `misaligned` at the named place; a shadow form aligns by its parent's `xmlns` (`source-shadow` with `application-shadow`), a shadow form with no parent aligns null with null, and a null on one side alone is `misaligned`; an error entry gives `not-summarized` with the source's module id and `docType`; a menu whose source `uniqueId` is null aligns by position with `uniqueId: null`, whether the resource reports null or a string for it, and a null from the resource beside a string from the source is `misaligned` at `modules[i].unique_id` | real ids paired to the wrong forms, which would publish over HQ's forms with crossed ids; every app with a shadow form refused as Nova's defect; an app with one menu HQ never gave an id stopped where a finding names the menu |
| `hqAppReading.test.ts`: the step's budget | `HQ_APP_READING_DEADLINE_MS + HQ_PROJECT_DATA_READING_DEADLINE_MS + HQ_READING_STEP_REMAINDER_MS` is 270,000 | a constant raised alone, so a step that keeps its deadlines outlives its request |
| `hqAppReading.test.ts`: `notSummarizedMenus` | `none` for a whole summary; `menus` naming one basic menu's position when it alone is an error; `app` when every basic and advanced menu of two or more is an error; an error at a mirror or a report menu named nowhere | a failure in the app's shared case properties reported as a fault in each menu, sending a person to fix menus that hold no cause |
| `hqMedia.test.ts` (a peer the test writes) | bytes of a 200 are returned with the declared type; a body one byte over `maxBytes` is `too-large` and the stream is cancelled; a 404 is `missing`; an HTML 200 is `browser-page`; a 503 then bytes is `read` after one resend, two 503s are the error, and a 500 is the error with one request sent; an id with a slash sends nothing | an oversized file buffered; a sign-in page stored as an image; a request built from an unchecked id; an outage reported as a missing file |
| `hqLookupTables.test.ts` (extended) | a definition with a non-array `properties`, an entry of `fields` with no name and a non-boolean `is_global` are each malformed; `rowsHoldOtherThanOneValue` is true for `lookups/fixture-rows-rich` and false for `fixture-rows-plain`; `reading/api-access-no-plan` served to the list classifies as `plan-lacks-api-access`; a caller's deadline spans the list and a row read | a table with properties read as plain and brought in without them; the refused body lost in the page reader |
| `app/(app)/(site)/settings/__tests__/hqFailureMessage.test.ts` | every kind at both moments, and for `gateway-refused` and `browser-only` each status row, against the sentences of section 12; a table of today's answers (a 401, 429, 503, 302 and 403, each HQ's and the edge's, and each synthesized cause) against today's `invalidKeyMessage` and `settingsErrorMessage` text | a sentence changed by the refactor: an edge's 401 losing the key sentence, a 302 gaining the unavailable one |
| `lib/deployment/__tests__/hqFailureSentences.test.ts` | ladders 2, 3 and 4 over every kind; ladder 2 over the same table of today's answers, byte for byte; ladders 3 and 4 with an edge's 401 and 403 on the sentences of Changes 1 and 2 | the same, and either change landing on an answer it was not meant for |
| `proof/surface/test_hq_api.py` (lane) | `NOVA_PATHS` equals the family's names; `FixtureResource`'s route resolves | the family and the client's calls drifting apart |
| `proof/hq/test_retained_reads.py` (lane) | section 14.1 | a retained answer HQ no longer gives |

**Existing suites B1 changes, and what changes in each.** Each serves or expects an answer sections 2
to 12 change; none changes what it proves.

| Suite | What it serves or expects today | From B1 |
|---|---|---|
| `lib/deployment/__tests__/observe.test.ts` | the application resource as `{ versions: [...] }` | the retained `reading/application.json` body with `id` set to the path's app id and `versions` set to the case's rows, through one helper `applicationAnswer(appId, versions)` in `__tests__/helpers/retainedHqReads.ts` |
| `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`, `deploymentTools.postgres.test.ts` (`BUILD_PATH`), `entryPointLink.postgres.test.ts` (`PATH.builds`) | the same bare `{ versions: [...] }` | the same helper |
| `lib/commcare/__tests__/appReadings.test.ts` | imports `listAppBuilds`; a bare 502 for a malformed version | its build inventory test moves to `hqApplication.test.ts`; its version test stays and expects `cause: "malformed"` |
| `lib/commcare/__tests__/discoverAccessibleDomains.test.ts` | `cause: "malformed"` for a 200 `<html>Sign in</html>` (two cases); one 429 per intercept; a bare 502 for a wrong envelope | `cause: "browser-page"` for the page; the 429 case serves three 429s with no `Retry-After` under fake timers it owns and restores, and expects the 429 after three sends, and a second case serves `Retry-After: 30` and expects the 429 after one; `cause: "malformed"` on each synthesized 502 |
| `lib/commcare/__tests__/hqLookupTables.test.ts` | `cause: "malformed"` for a 200 `<html>Sign in</html>`; a bare 502 for a table with no id | `cause: "browser-page"`; `cause: "malformed"` |
| `lib/commcare/__tests__/importApp.test.ts`, `hqLocations.test.ts` | a bare 502 where an acknowledgement or an inventory is malformed; in `hqLocations.test.ts`, `cause: "malformed"` for a 200 `<html>Sign in</html>` on a list read | `cause: "malformed"` beside each bare 502; `cause: "browser-page"` for the page on a read (the import and the place patch own their fetch and keep what they answer) |
| `app/(app)/(site)/settings/__tests__/commcare-actions.test.ts` | `refreshApprovedDomains` mocked as `{ ok: false, kind: "hq_error", status }` | mocked as `{ ok: false, kind: "hq_error", error: { success: false, status } }`, with the same sentences expected |
| `lib/deployment/__tests__/publishGates.postgres.test.ts` | no case for a malformed table definition or an edge's refusal of the table list | gains both: a `fields` entry with no name stops the publish at `project-data` with the "couldn't ask" sentence and sends nothing (Change 3), and an edge's 403 prints the same sentence (Change 2) |

Two sweeps in B1 find any case this table does not name. Every 429 a suite serves to a read that
goes through `readHqJson` must answer the resends too: each hit of `rg -n "429"` over
`lib/commcare/__tests__` and `lib/deployment/__tests__` that is such a read either serves
`HQ_READ_SENDS` answers or names a `Retry-After` over two seconds. Every page a suite serves to
such a read expects `browser-page`: each hit of `rg -n "<html>"` over the same directories.

**Existing suites that stay green unchanged**, because what they hold does not move:
`lib/deployment/__tests__/publishSequence.postgres.test.ts` and
`lib/commcare/__tests__/client.test.ts`, whose "rejects dot segments and URL syntax before an
authenticated request" still gets `false` from `testDomainAccess` (section 5.1) and whose import
retry cases read `IMPORT_RETRY_MAX_WAIT_MS` at its old name and value.

---

## Contracts and docs these changes make false

All in B1.

| Where | Old | New |
|---|---|---|
| `lib/commcare/CLAUDE.md`, "CommCare HQ project-space compatibility", the paragraph "JSON source, version/build, project-space and collection reads share `hq/readJson.ts`: ... explicit HTTP/transport/JSON failures." | as quoted | "JSON source, application, version, app-list, project-space and collection reads share `hq/readJson.ts`: native fetch, no redirects, no cache, an owned deadline through body consumption, and five causes told apart (no answer, the deadline, a body over the bound, a page for a browser, an answer Nova cannot read). A 429 is sent again by one rule (`hq/throttle.ts`): three sends at most, a `Retry-After` of at most two seconds waited, one second where HQ names none, inside the read's deadline. Every status a read synthesizes for an answer it could not use names its cause; a request Nova will not send (a slug or an id it cannot put in a URL) is a bare 400. Every failed answer is classified once, by `hq/failure.ts::classifyHqFailure`; no caller writes its own status ladder." |
| the same section, "Version and build-list readers validate the JSON envelope before reading fields" | as quoted | "The version reader and the application resource reader (`hq/application.ts::readHqApplication`, the one reader of that resource, bounded at 64 MiB) validate the JSON envelope before reading fields; its modules stay unread until `hqApplicationModules` types them, so a summary Nova cannot read never stops a status check." |
| the same section, "App-access success requires the HQ `status: success` / `applications` envelope." | as quoted | "App-access success requires the HQ `status: success` / `applications` envelope (`hq/apps.ts::readHqAppListEnvelope`); the rows are read only by `listHqApps`, for the picker, so one app Nova cannot type never costs a key its project spaces." |
| the same section, "Paginated reads carry one signal through the full list" | as quoted | "Paginated reads carry one deadline, its signal and its instant, through the full list, or the caller's where it owns one across several lists (`ReadHqCollectionOptions.within`)" |
| `lib/commcare/CLAUDE.md`, the sentence "The three reads a key CAN make about a published app (`readAppVersions`, `listAppBuilds`, `probeBuildProfile`) live here beside the writes." | as quoted | the same with `hq/application.ts::readHqApplication` in place of `listAppBuilds` |
| `lib/commcare/CLAUDE.md`, the paragraph "A key is **not** one-project-per-user", "The upload *target* is chosen by `resolveUploadDomain`" | as quoted | "The project space an operation targets is chosen by `resolveHqDomain`", the rest unchanged |
| `lib/deployment/previewTarget.ts`, the comment "The same refusal `resolveUploadDomain` makes for an upload target" | as quoted | the same with `resolveHqDomain` |
| `lib/commcare/hq/appSource.ts`, the comment on `HqAppSourceModule.caseType` | "`case_type`; the empty string for a menu with none." | "`case_type` as stored: `\"\"` for a menu with none, null on a mirror menu, which stores none." |
| `lib/commcare/CLAUDE.md`, a new subsection "Reading an app from CommCare HQ" after "CommCare HQ project-space compatibility" | none | the six paragraphs under "The new subsection" below, and G1's sentence |
| `lib/deployment/CLAUDE.md`, the table row "Read build ids + release flags" | "`api/resources/v0_4.py::ApplicationResource.dehydrate_versions` ..." | the same row with "read through `lib/commcare/hq/application.ts::readHqApplication`" appended |
| `lib/commcare/hq/appSource.ts`, header comment | "It serves no `version` and no `_id`" | "It serves `name`, `last_modified` and `multimedia_map` as stored, a mirror menu with a null `case_type`, a shadow form with a null `xmlns` and a menu HQ never gave an id with no `unique_id`, and no `version` and no `_id`" |
| `proof/surface/families/hq_api.py`, docstring | "``fixtures/resources/v0_6.py::LookupTableItemResource``, which the plan names for reading an HQ table's rows, is recorded beside them." | "the lookup table rows (``fixtures/resources/v0_1.py::FixtureResource``)," placed in the list of endpoints Nova calls |
| `proof/hq/test_retained_reads.py`, docstring | the list of groups | gains the `reading` group's paragraph, as section 14.1 writes it |
| `proof/README.md`, the table row "The drift comparison", whose cell names `proof/hq/test_retained_reads.py` and `proof/hq-reads/` | its last cell as it stands | that cell with a full stop and this sentence appended: "Its `reading/` group holds HQ's answers to the reads that bring an app in, through the requests of `proof/views/reading_reads.py`." |
| `proof/README.md`, "HQ's own pages and views", after its first paragraph | none | "`proof/views/reading_reads.py` is the one module here that is no test: it holds the lane's requests for the reads that bring an app in (`app_list_read`, `application_read`, `api_access_read`, `remote_app_through_hq`, `seed_api_superuser`, `client_request`), which `proof/hq/test_retained_reads.py` imports, outside the observation's directories because no observation calls them." |
| `docs/research/2026-09-26-hq-round-trip/harness-findings.md`, under "### Found while planning step 6", which this plan's own pull request wrote with every bullet | the bullet on a superuser's key, the paragraph on a `RemoteApp`, and the bullet "HQ's source read serves more than the reader's comments say" | unchanged where each run answers A. B1 writes there only what one of its own runs corrects: under G1's outcome B, under G2 where the source read answers a source, and under G4's outcome B or C, as "The harness findings" below words each |

**The new subsection.** `lib/commcare/CLAUDE.md` gains "### Reading an app from CommCare HQ" after
"### CommCare HQ project-space compatibility", with these six paragraphs:

> `hq/apps.ts::listHqApps` reads `views/cli.py::list_apps`: every working app of a project space by
> id, name and save counter. A row carries no kind, no date and no build fact, so a linked or a
> remote app looks like any other until it is read. `hq/apps.ts::probeHqApiAccess` asks the lookup
> table list for one row, after the list answered. API access is told by two sentences of
> `api/resources/__init__.py::HqBaseResource.dispatch` that `hq/http.ts::apiRefusalSentence` matches
> exactly (`HQ_API_ACCESS_REFUSAL`, `HQ_API_CUT_OFF_REFUSAL`); any other 401 is a key that was not
> accepted, never a guess at the plan.
>
> `hq/appReading.ts::readHqAppForReading` is one bracketed attempt under
> `HQ_APP_READING_DEADLINE_MS`: the application resource (`hq/application.ts::readHqApplication`:
> the save counter, real form ids and HQ's question summary), the source (`readHqAppSource` with
> `admit: "any"`), then `readAppVersions`. A counter that moved answers `changed`, and the function
> never loops. The bracket covers the app document and its media map and nothing else: lookup
> tables, levels and places are rows outside it. Two saves keep the counter
> (`models/delete_records.py::DeleteApplicationRecord.undo`, `views/utils.py::_update_forms`), and
> neither is of an app a reading reads through. `linked` is the source's `doc_type`
> `LinkedApplication`; `remote` is an app the list holds that the application resource answers 404
> for.
>
> `alignHqForms` pairs menus and forms by position, held by the menu's `unique_id` where the source
> stores one and by each form's `xmlns`, a shadow form by its parent's; any disagreement is kind
> `answer-unreadable`. A mirror menu stores a null `case_type` and no forms, a shadow form a null
> `xmlns` and `shadow_parent_form_id`, and a menu may store no `unique_id`. Only a reading admits
> the three (`admit: "any"`); a publish's read refuses them as before. A menu HQ returns as an
> error is `not-summarized`; `notSummarizedMenus` says whether that is a finding at each menu or
> one at the app, and HQ's message goes to the log and to no person.
>
> One read step's budget is three constants that sum to 270 seconds: `HQ_APP_READING_DEADLINE_MS`
> (120), `HQ_PROJECT_DATA_READING_DEADLINE_MS` (60: one deadline over the table list, every row
> page, the level list and the place list) and `HQ_READING_STEP_REMAINDER_MS` (90). The throttled
> reads of one reading run one at a time.
>
> `hq/media.ts::readHqMediaFile` reads one file from the address HQ gives its media map item
> (`hqmedia/models.py::HQMediaMapItem.url`), bounded by the caller's limit, under a deadline of its
> own, with one resend. It returns bytes and the declared type; `lib/media` says what a file is.
>
> HQ's answers to these reads are retained under `proof/hq-reads/reading/` and held byte for byte
> by `proof/hq/test_retained_reads.py`.

G1's sentence, as its outcome gives it ("Written and not yet run"), ends the first paragraph, which
is the one about API access.

**The harness findings.** The heading "### Found while planning step 6" and every bullet under it
are written by this plan's own pull request, which merges beneath both stacks (part 15,
`15-stack-contracts-and-exit.md`, section 8.1). B1 adds no heading and no bullet. The ten facts
below are the ones that pull request records from this part, listed here because B1's code rests on
each; two are marked inferred, and a retained read of this part settles each of those:

1. `export_json` and `scrub_source` are defined on `Application` alone
   (`app_manager/models/applications.py::Application.export_json`), so the source view fails for a
   `RemoteApp` on the missing method before any source is built (inferred).
2. Nova reads a lookup table's rows through `fixtures/resources/v0_1.py::FixtureResource`, whose
   `obj_get_list` takes `fixture_type_id`; `LookupTableItemResource`'s list is every row of the
   project space, and Nova calls it nowhere.
3. `api/resources/__init__.py::HqBaseResource.dispatch` tests `request.user.is_superuser` before
   tastypie authenticates, and no entry of `settings.py::MIDDLEWARE` authenticates an API key, so
   a key's request reaches that test with the anonymous user (inferred).
4. The app source and the application resource are two requests with no shared revision: the
   source strips `version` (`app_manager/models/applications.py::ApplicationBase._meta_fields`),
   and the save counter read after both is what ties them to one saved version.
5. The source view serves a build's id too, as `Application`
   (`app_manager/dbaccessors.py::get_app` does not test `copy_of`).
6. `FixtureResource.Meta.limit` is `0`, which tastypie reads as its `max_limit`, so the page size
   is HQ's to choose and a reader follows `meta.next`.
7. A mirror menu stores `"case_type": null` (`app_manager/models/modules.py::ShadowModule.case_type`
   is a property), a shadow form stores `"xmlns": null`
   (`app_manager/models/forms.py::ShadowForm.xmlns` is a property), and a report menu stores `""`
   (`app_manager/models/modules.py::ReportModule.new_module`).
8. `app_manager/models/case_list.py::DetailColumn.endpoint_action_id` is declared with
   `FormIdProperty` and holds a form's session endpoint id, which
   `app_manager/helpers/validators.py::ModuleBaseValidator.validate_case_list_field_actions`
   compares with `form.session_endpoint_id`; no source read rewrites it.
9. Two saves of a working app do not raise `version`: HQ's restore of a deleted app
   (`app_manager/models/delete_records.py::DeleteApplicationRecord.undo`) and a linked app's pull
   (`app_manager/views/utils.py::_update_forms`), each with `increment_version=False`.
10. The `hq-api` family recorded `LookupTableItemResource`, which Nova calls nowhere, and not
    `FixtureResource`, which it calls for rows; step 6 swaps them
    (`proof/surface/families/hq_api.py::RESOURCES`).

B1 completes only the outcomes of its own runs under that heading, and only where an outcome
corrects what a bullet there states (part 15, sections 1.4 and 8.1):

- **G1, outcome B** (a superuser's key passes the plan check): fact 3 is wrong. B1 rewrites the
  bullet "A superuser's API key does not reach the plan check as a superuser" to say the bullet is
  withdrawn and the research's sentence stands, with the retained file as its evidence. Outcomes A
  and C leave the bullet as written: it already says what each means.
- **G2, where the retained source read of a `RemoteApp` answers a source** and not the failure:
  fact 1 is wrong. B1 rewrites the sentence on a `RemoteApp` in "Planning's own first readings" to
  what the read answered. Every other answer of G2 leaves it as written.
- **G4, outcome B or C** (an answer for a mirror menu, a report menu or a shadow form that differs
  from fact 7): B1 writes the answer CommCare HQ gave into the bullet "HQ's source read serves more
  than the reader's comments say".

No other run of this part writes there: G3, G5, G6 and G7 settle a branch of B1's code and no claim
the research states.

B1 changes what a person can meet in three places, each on purpose and each held by a case of
`hqFailureSentences.test.ts` or `publishGates.postgres.test.ts`:

**Change 1, the source read's sentence for an edge's refusal.** A 401 or 403 the edge answered for a
source read moves between two sentences of `preflight.ts::hqAppSourceReadFailure`, both of which
exist today, unchanged. For an app that was there before this publish, from

- `` `Nova couldn't read the current app on “${domain}”, so it left that app unchanged. Reading it needs permission to edit apps in CommCare HQ. Check the connected account, then publish again.` ``

to

- `` `Nova couldn't safely read the current app on “${domain}”, so it left that app unchanged. Check that the app still opens in CommCare HQ, then publish again.` ``

and for an app this publish made (`createdApp`), from

- `` `Nova couldn't read the app on “${domain}”, so Nova stopped before sending the app's content. ${CREATED_APP_IS_EMPTY} Reading it needs permission to edit apps in CommCare HQ. Check the connected account, then publish again.` ``

to

- `` `Nova couldn't safely read the app on “${domain}”, so Nova stopped before sending the app's content. ${CREATED_APP_IS_EMPTY} Check that the app opens in CommCare HQ, then publish again.` ``

It is the correction `importRejectionMessage` already makes for the import: an edge's status is no
fact about the account.

**Change 2, the table list's sentence for an edge's refusal.** A 401 or 403 the edge answered for
the `project-data` read moves from

- `` `Nova can't see which lookup tables “${domain}” already has, so it won't push over them. Reading them needs API access on that project space and the Access APIs permission on your CommCare HQ account; ask a CommCare HQ administrator for both.` ``

to

- `` `Nova couldn't ask “${domain}” which lookup tables it already has, so it stopped rather than push over them. Try publishing again in a moment.` ``

Both sentences exist today, unchanged. Section 12 calls the first the "needs API access" sentence
and the second the "couldn't ask" sentence.

**Change 3, a malformed table definition stops a publish.** Where HQ serves a table whose `fields`
hold an entry with no name, whose `properties` or `item_attributes` is no array of strings, or
whose `is_global` is no boolean, today's `listHqLookupTables` skips or defaults it and the publish
goes on; from B1 the read is malformed and the publish stops at `project-data` with the "couldn't
ask" sentence of Change 2, before anything is sent (section 10.1). It is a guard:
`fixtures/resources/v0_1.py::LookupTableResource` declares `is_global` as a boolean field and
`item_attributes` as a list field, and the retained `lookups/lookup-tables.json` passes it.

Beside these, a 429 on any read is now sent again before it stops a preflight (section 3.2), which
changes no sentence.

No public docs page changes in B1: nothing a person sees or does changes until the entry points of
part 13 (`13-the-experience.md`, section 2, B11). Stack B's `content/docs/` pages land in B14, which
part 15 (`15-stack-contracts-and-exit.md`) plans.

---

## Departures

Each item is a departure from the research, from a rule of the repo or from part 01's list as A2
lands it, or a decision of this part beside which an alternative was weighed and not taken.

1. **From the research ("Reads"): rows are not read through `LookupTableItemResource`.** Evidence:
   `fixtures/resources/v0_1.py::FixtureResource.obj_get_list` is the only row list that takes a
   table; `LookupTableItemResource` defines no `obj_get_list` filter and its list is the project
   space's every row. Decision: section 10.2.
2. **A save between the bracket's reads restarts the read on the reading's next step, never inside
   the read.** Decision: `readHqAppForReading` answers `changed`; part 12
   (`12-the-reading-and-the-birth.md`, sections 2.4 and 3.3, B10) runs one more attempt on the next
   step and then gives `changed-while-reading`. The rule a person can observe holds: the counters
   are compared for equality, and a change reads again. Not done: a loop inside
   `readHqAppForReading` that reads again at once, because of section 3.3's budget: one attempt is
   bounded at 120 seconds, and two do not fit the 270 second step beside the project data reads
   and the reader.
3. **From the `hq-api` family's rule that it records the HQ views and resources Nova calls
   (`proof/surface/families/hq_api.py`, its docstring's first sentence) and from this part's own
   rule that each read's answer is retained: in B1 the media read gets no generated item and no
   retained file.** The family prints a view's decorators and body, and a retained file holds an
   answer's shape to the pin. `readHqMediaFile` reads neither: it holds a status and bytes under a
   bound, and matches no sentence, key or shape of HQ's, so there is nothing of an answer for a pin
   to hold, and a peer the test writes exercises the reader whole. What the reader does take from
   HQ is the URL of `HQMediaMapItem.url`, and that is held where it is used for real, by part 14
   (`14-proof.md`, sections 5.2 and 5.3 and run P8, B13): each HQ-authored base that maps media has
   its files read through HQ in the lane's unit, at the address HQ gives each map item, and brought
   in by this reader against those recorded reads, so a pin that moves the address fails that
   base's reading by name.
4. **From part 01's `READ_CIRCUMSTANCES` as A2 lands it (twenty codes): seven further members,
   which B1 lands** (section 4.3; part 01's sections 8.3 and 9.3 hold them as this part words
   them). Evidence, one line each in section 4.3's table: each is an answer HQ gives that no
   listed member words truthfully. An
   edge's refusal is no fact about the key; `API_BLACKLIST`'s 401 is no bad key; a page for a
   browser is no outage; a remote app is not a linked one (`models/applications.py::RemoteApp`
   holds no content to rewrite); the organization read's 403 names four gates and neither
   permission code; a summary that fails for every menu has its cause in none; and a table whose
   rows HQ cannot send is the person's to open in HQ. Two rows of part 01 follow from this part's
   reading and stand in its section 8.3 as written: `linked-app`'s "When" is "the source's
   `doc_type` is `LinkedApplication`", because a remote app's source read answers no `doc_type` at
   all (section 8.2, run G2) and has its own code; and `menu-unreadable-in-hq` carries no
   `detail.name`, because HQ's message is the text of a Python exception (section 8.3), so the
   place names the menu and the message stays in the log.
5. **API access is required, and it is checked twice.** Once when the project space is chosen
   (`probeHqApiAccess`, section 5.2), so the person learns before choosing an app, and again as the
   first read of the app (section 8.2). Evidence: `HqBaseResource.dispatch` makes one plan check for
   every resource, so the cheap probe and the application resource cannot disagree at one moment.
   Not done: one check alone. The first read alone would let a person choose an app in a project
   space whose plan cannot serve it. The probe alone would leave a plan that changed since the
   picker unchecked, so the application resource read classifies the same refusals and tells it
   truthfully (section 8.2).
6. **`lib/db/settings.ts`'s two functions are renamed** (section 11). One concept per meaning: the
   same resolution serves a publish, a probe and a reading. Not done: keeping `resolveUploadTarget`
   and `getCredentialsForUpload` under their names and adding only the list reader, because a
   reading resolves no upload, and each of its call sites would then name one.
7. **The widened source read gains more than `name`, `lastModified` and a checked `multimediaMap`:
   it also reads a mirror menu, a shadow form and a menu that stores no `unique_id`, which
   today's reader refuses.** Evidence: "Claims corrected", the stored nulls, and
   `models/modules.py::ModuleBase.get_or_create_unique_id`, which gives a menu its id lazily.
   Today's shape check answers `malformed` for all three, which would end a reading as Nova's own
   defect with no account, where a mirror menu is one `not-yet` finding beside every other (part
   06, `06-the-reader-forms.md`, section 7.1, B2; the reader reports every finding in one pass,
   `../6-bring-in.md`, "The experience in brief") and part 06 (its section 7.2, B2) raises
   `menus-and-case-lists/module-unique-id-missing` for the third. Decision: section 7's
   `admit: "any"` for a reading, with a publish's check unchanged. Not done: the three fields
   alone under today's shape check, because every app that holds a mirror menu, a shadow form or
   a menu with no id would then stop with no account.

---

## Files by pull request

**B1**

- New: `lib/commcare/hq/readBody.ts` (`readBoundedBody`, `BoundedBody`); `lib/commcare/hq/throttle.ts`
  (`HQ_THROTTLE_MAX_WAIT_MS`, `HQ_THROTTLE_ABSENT_WAIT_MS`, `HQ_READ_SENDS`,
  `HQ_THROTTLED_READ_CONCURRENCY`, `readRetryWaitMs`); `lib/commcare/hq/failure.ts`
  (`HQ_FAILURE_KINDS`, `HQ_REQUEST_KINDS`, `HqFailure`, `HqPermissionNeed`, `classifyHqFailure`,
  `hqReadCircumstance`); `lib/commcare/hq/apps.ts` (`HqAppListing`, `HQ_APP_LIST_MAX_BYTES`,
  `readHqAppListEnvelope`, `listHqApps`, `HqApiAccess`, `HQ_API_ACCESS_PROBE_MAX_BYTES`,
  `probeHqApiAccess`);
  `lib/commcare/hq/application.ts` (`HQ_APPLICATION_MAX_BYTES`, `HqApplication`, `HqAppBuild`,
  `readHqApplication`, `HqQuestionSummary`, `HqApplicationForm`, `HqApplicationModule`,
  `hqApplicationModules`); `lib/commcare/hq/appReading.ts` (`HQ_APP_READING_DEADLINE_MS`,
  `HQ_PROJECT_DATA_READING_DEADLINE_MS`, `HQ_READING_STEP_REMAINDER_MS`, `HqAlignedForm`,
  `HqAlignedModule`, `HqFormAlignment`, `alignHqForms`, `notSummarizedMenus`, `HqAppReading`,
  `readHqAppForReading`); `lib/commcare/hq/media.ts` (`HQ_MEDIA_FILE_DEADLINE_MS`,
  `HQ_MEDIA_READ_CONCURRENCY`, `HQ_MEDIA_FILES_PER_STEP`, `HqMediaFileRead`, `readHqMediaFile`);
  `app/(app)/(site)/settings/hqFailureMessage.ts` (`settingsFailureMessage`).
- Changed: `lib/commcare/hq/http.ts` (the error's `cause` and `refusedBody`,
  `HQ_REFUSED_BODY_MAX_CHARS`, `HQ_REFUSED_BODY_READ_MAX_BYTES`, the two sentences,
  `apiRefusalSentence`, `warnAndReturnError`'s overload); `lib/commcare/hq/deadline.ts`
  (`HqReadDeadline`); `lib/commcare/hq/readJson.ts` (section 2.3, the retry; `readBoundedBody` and
  `BoundedBody` leave for `readBody.ts`); `lib/commcare/hq/readCollection.ts` (`keepRefusedBody`,
  `within`, the pair passed to every page, the cause on its 508); `lib/commcare/hq/appSource.ts`
  (section 7);
  `lib/commcare/hq/lookupTables.ts` (`keepRefusedBody` on the list, the strict definition checks,
  the cause on a malformed identity, the deadline parameter, `rowsHoldOtherThanOneValue`);
  `lib/commcare/hq/locations.ts` (the deadline parameter on both lists, the cause on
  `malformedInventory`); `lib/commcare/client.ts` (`listAppBuilds` removed, `HqAppBuild`
  re-exported, `testDomainAccess` over `readHqAppListEnvelope`, `readAppVersions`'s deadline,
  `listDomainsMatching` and `runBoundedCompatibilityProbe` passing the pair, the causes of section
  2.4, `IMPORT_RETRY_MAX_WAIT_MS` from `throttle.ts`); `lib/db/settings.ts` (the renames, and
  `RefreshDomainsResult`'s `hq_error` arm carrying the error), `lib/db/domainResolution.ts` and the
  call sites of section 11; `lib/deployment/observe.ts`, `lib/deployment/entryPointLinks.ts`
  (`readHqApplication`); `lib/deployment/service.ts::importRejectionMessage`;
  `lib/deployment/preflight.ts` (`hqAppSourceReadFailure`, the `project-data` edge);
  `app/(app)/(site)/settings/actions.ts`; `lib/publish/hqFindings.ts` and
  `lib/publish/hqFindingCopy.ts` (the seven members of section 4.3 and their blocks, added to the
  lists A2 lands).
- Tests: the new and extended files of "Tests" and each suite of its second table;
  `__tests__/helpers/retainedHqReads.ts`.
- Lane: `proof/views/reading_reads.py` (new), `proof/hq/test_retained_reads.py`,
  `proof/hq-reads/reading/*.json` (new), `proof/surface/families/hq_api.py`,
  `proof/surface/test_hq_api.py`, `lib/commcare/surface/surface.json` (regenerated).
  `proof/hq/operations.py` is not edited in B1 (section 14.1).
- Docs: the rows of "Contracts and docs these changes make false".
  `docs/research/2026-09-26-hq-round-trip/harness-findings.md` is in B1's diff only under G1's
  outcome B, under G2 where the source read answers a source, or under G4's outcome B or C ("The
  harness findings"); B1 adds no heading and no bullet to it.
- `biome.json`: no edit. Every new module is under `lib/commcare/hq/`, imported by sub-path from
  consumers the rule already allows (`lib/deployment`, `app/`, `lib/mcp`); none joins the barrel.
- `lib/hostnames.ts`: no edit. B1 adds no route.

---

## What this part needs of other parts

Each line below names the part by its number, its file, the section that meets the need and its
pull request. Of part 15 (`15-stack-contracts-and-exit.md`) this part needs one thing, the last
line.

- **Part 01 (`01-the-bar-and-the-manifest.md`, sections 8.3 and 9.3; A2).** `READ_CIRCUMSTANCES`,
  `CIRCUMSTANCE_STANDINGS` and `CIRCUMSTANCE_COPY` land in A2 with twenty codes, and
  `ReadCircumstance` is exported from `lib/publish/hqFindings.ts`. This part's own answers name
  eleven of them (`key-not-accepted`, `plan-lacks-api-access`, `not-a-member`, `cannot-edit-apps`,
  `cannot-access-apis`, `app-gone`, `app-deleted`, `rate-limited`, `hq-unavailable`, `too-large`,
  `linked-app`), and B1 adds seven (section 4.3, Copy), which part 01 lists as landing in B1 and
  its completeness test then holds. The two rows this part's reading rests on stand in its section
  8.3: `linked-app`'s "When" is "the source's `doc_type` is `LinkedApplication`", and
  `menu-unreadable-in-hq` carries no `detail.name`, the place naming the menu. What part 01 asks
  of this part is answered in sections 3.2 (the three sends after which `rate-limited` is raised),
  8.2 (the second `changed` in a row) and 4.2 (which permission each read reports).
- **Part 06 (`06-the-reader-forms.md`, sections 2.2, 7.1 and 7.2; B2).** The reader gives a mirror
  menu, a report menu and a shadow form their findings from `HqAlignedModule.docType` and
  `HqAppSourceForm.docType` (its section 7.1), and raises
  `menus-and-case-lists/module-unique-id-missing` at a menu whose `uniqueId` is null, giving it no
  draft (its section 7.2; sections 7 and 8.3 here). Its `ReadMenuAndFormIdentities` (its section
  2.2) therefore keeps `modules[].uniqueId` a `string`.
- **Part 07 (`07-the-reader-cases-menus-lists.md`, section 11.2; B5).** The reader of case lists
  reads `endpoint_action_id` against each form's `session_endpoint_id` (section 8.3 here).
- **Part 08 (`08-the-reader-expressions.md`, section 9.2; B6).** A row attribute an expression reads
  is the reader's finding, since neither read of section 10 shows an undeclared attribute.
- **Part 09 (`09-acceptance-and-the-first-publish.md`, section 7; B7).** Acceptance check 5 reads
  `HqQuestionSummary` through the aligned modules, and skips every form of a menu that is
  `not-summarized` (its section 7.6).
- **Part 10 (`10-identity-and-the-ledger.md`, sections 3.1 and 5.5; B8).** `adoptedIdentityRows`
  reads `HqAlignedForm.uniqueId` and `xmlns` into the adopted deployment's identity rows (an app
  with a null `xmlns` holds a shadow form, and a menu with a null `uniqueId` gets no draft, so no
  null reaches a row; part 06's `ReadMenuAndFormIdentities`, which it imports, keeps
  `modules[].uniqueId` a `string`).
  `readHqAppClaims` is the claim index that says which `HqAppListing.appId` Nova already holds.
- **Part 11 (`11-project-data.md`; B9).** Its project data read (sections 5.1 and 14.1) passes the
  one `HqReadDeadline` it is handed to `listHqLookupTables`, to `readHqLookupTableRows` one table
  at a time, and to the two place reads (its section 11.1), and judges the tables with
  `unsupportedLookupContent` and `rowsHoldOtherThanOneValue` (its section 5.3). Its
  `fetchAndStageHqMediaFile` (section 2.2) calls `readHqMediaFile` with `maxBytes` of
  `ASSET_SIZE_CAPS_BYTES[file.kind]`, and its media step runs `HQ_MEDIA_READ_CONCURRENCY` at a
  time over at most `HQ_MEDIA_FILES_PER_STEP` files, asking only for files the app's content
  references, each once. It adds `lib/media/validate.ts::validateSniffedMediaBytes` (section 2.3),
  the entry point that sniffs the bytes before any name is trusted
  (`validateMediaBytes` refuses an off-list extension first, section 9 here), and calls it with the
  bytes alone (its Departure 9: the declared type is passed to no verdict). It writes the
  findings (sections 2.4, 3.2 and 5.3): `missing` as `media-file-unreadable` where a platform the
  app runs on draws the slot, a file over the limit under the manifest entry part 01 names, an
  unreadable map entry only where content references its path, and `table-rows-unreadable` under
  run G7's outcome A. It states what no API-key read returns (its sections 5.4 and 11.3).
- **Part 12 (`12-the-reading-and-the-birth.md`; B10).** Its read step (section 3.3) calls
  `getHqCredentials` and gives `not-connected` itself (step 1), then `readHqAppForReading` once a
  step (step 3): it counts `changed` and gives `changed-while-reading` on the second in a row
  (sections 2.4 and 3.3), turns `failed` into a circumstance through `hqReadCircumstance`,
  `linked` into `linked-app`, `remote` into `remote-app`, `deleted` into `app-deleted` and `gone`
  into `app-gone`, and, under run G3's outcome B, `not-summarized` into an account of one
  `app-unreadable-in-hq` finding at the app. Step 4 turns `notSummarizedMenus` into findings:
  `menus` as `menu-unreadable-in-hq` at each named menu, `app` as `app-unreadable-in-hq` at the
  app, neither with HQ's message. Step 5 opens the one deadline of
  `HQ_PROJECT_DATA_READING_DEADLINE_MS` around part 11's project data read. Its first step holds
  to the three constants of section 3.3 (its section 3.6 divides the 90 second remainder). Its
  media step (section 3.4) asks for no more files than fit its request: at
  `HQ_MEDIA_FILE_DEADLINE_MS` a file and `HQ_MEDIA_READ_CONCURRENCY` at a time, 180 seconds of a
  270 second step hold at most twelve files that each run to their deadline, so the step takes
  the next twelve wanted files that have no verdict, stages what it read under the media
  contract's pending keys (part 11, section 2.5), and resumes on the next step until none is
  left. Twelve is `HQ_MEDIA_FILES_PER_STEP`, exported from `hq/media.ts`. Its re-read at creation
  (section 5.3) covers the tables, levels and places the bracket does not.
- **Part 13 (`13-the-experience.md`; B11 and B12).** In B11 its `listHqAppsForPicker` (section 4.2)
  calls `getHqCredentials`, `listHqApps` and then `probeHqApiAccess` when a project space is
  chosen, shows name alone from HQ and marks a row from part 10's claims. Its stop and account
  screens (sections 6 and 7) draw each circumstance from part 01's `CIRCUMSTANCE_COPY`, the seven
  blocks of "Copy" among them. In B12 its six MCP tools (section 14.1) take the scopes of section
  13 here for the three that rest on these reads.
- **Part 14 (`14-proof.md`; B13, and the proof lines of B1).** B1's lane reads stay in
  `proof/views/reading_reads.py` until B13 moves them into `proof/hq/operations.py` (its sections
  5.3 and 11.2). Its HQ-authored bases record the source and application answers through
  `source_read` and `application_read`, and each base that maps media has its files read through
  HQ in the lane's unit and brought in by `readHqMediaFile` against those recorded reads (its
  sections 5.2 and 5.3, run P8), which is what holds the URL of section 9 to the pin (Departure
  3). Runs G1 to G7 are listed among its hand runs for B1 (its section 11.2).
- **Part 15 (`15-stack-contracts-and-exit.md`; B14).** No public docs page changes in B1; whatever
  stack B's pages say of these reads lands in B14 (Contracts).

## What other parts read from this one

- Types and functions, by file under `lib/commcare/hq/` unless a path is given:
  - `apps.ts`: `listHqApps`, `readHqAppListEnvelope`, `HqAppListing`, `probeHqApiAccess`,
    `HqApiAccess`.
  - `application.ts`: `readHqApplication`, `HqApplication`, `HqAppBuild`, `hqApplicationModules`,
    `HqApplicationModule` (its `summarized` arm's `uniqueId` is `string | null`),
    `HqApplicationForm` (its `xmlns` is `string | null`), `HqQuestionSummary`.
  - `appSource.ts`: `readHqAppSource` with `ReadHqAppSourceOptions` (`admit: "plain" | "any"`),
    `HqAppSource.name`, `lastModified` and `multimediaMap`, `HqAppSourceModule.docType`,
    `uniqueId` (`string | null`, null only under `admit: "any"`) and `caseType`
    (`string | null`), `HqAppSourceForm.docType`, `xmlns` (`string | null`) and
    `shadowParentReadId`, `HqMediaMapItem` (with `unreadable`), `HqMediaType`, `HQ_MEDIA_TYPES`,
    `HqAppSourceRead` (its `gone` arm carries `deleted`).
  - `appReading.ts`: `readHqAppForReading`, `HqAppReading`, `alignHqForms`, `HqFormAlignment`,
    `HqAlignedModule` (both arms carry `docType` and a `uniqueId` that is `string | null`),
    `HqAlignedForm` (its `xmlns` is `string | null`), `notSummarizedMenus`.
  - `media.ts`: `readHqMediaFile`, `HqMediaFileRead`.
  - `lookupTables.ts`: `rowsHoldOtherThanOneValue`, and `listHqLookupTables` and
    `readHqLookupTableRows` with their `options?: HqReadDeadline`; `locations.ts`:
    `listHqLocationTypes` and `listHqLocations` with the same.
  - `failure.ts`: `classifyHqFailure`, `hqReadCircumstance`, `HqFailure`, `HqFailureKind`,
    `HqRequestKind`, `HqPermissionNeed`.
  - `deadline.ts`: `HqReadDeadline`; `readCollection.ts`: `ReadHqCollectionOptions.within` and
    `keepRefusedBody`; `http.ts`: `apiRefusalSentence`; `throttle.ts`: `readRetryWaitMs`;
    `readBody.ts`: `readBoundedBody`, `BoundedBody`.
  - `lib/db/settings.ts`: `getHqCredentials`, `resolveHqTarget`, `HqTargetResult`,
    `HqCredentialsResult`; `lib/db/domainResolution.ts`: `resolveHqDomain`.
- Circumstance codes B1 adds to part 01's list: `hq-gateway-refused`, `api-cut-off`, `browser-only`,
  `remote-app`, `cannot-read-organization`, `app-unreadable-in-hq`, `table-rows-unreadable`.
- Constants: `HQ_APP_READING_DEADLINE_MS` (120,000), `HQ_PROJECT_DATA_READING_DEADLINE_MS` (60,000),
  `HQ_READING_STEP_REMAINDER_MS` (90,000), `HQ_APPLICATION_MAX_BYTES` and `HQ_APP_SOURCE_MAX_BYTES`
  (64 MiB), `HQ_APP_LIST_MAX_BYTES` (4 MiB), `HQ_API_ACCESS_PROBE_MAX_BYTES` (1 MiB),
  `HQ_REFUSED_BODY_READ_MAX_BYTES` (64 KiB), `HQ_REFUSED_BODY_MAX_CHARS` (2,048),
  `HQ_MEDIA_FILE_DEADLINE_MS` (60,000),
  `HQ_MEDIA_READ_CONCURRENCY` (4), `HQ_MEDIA_FILES_PER_STEP` (12), `HQ_THROTTLED_READ_CONCURRENCY`
  (1), `HQ_READ_SENDS` (3), `HQ_THROTTLE_MAX_WAIT_MS` (2,000), `HQ_THROTTLE_ABSENT_WAIT_MS` (1,000).
- Facts: the app list has no kind, no date and no build fact; the source carries no version and
  mints form ids on every read; real form ids exist only in the application resource, which needs
  API access; a mirror menu stores a null `case_type` and no forms, a shadow form a null `xmlns`
  and its parent's id, a report menu `""`, and a menu HQ never gave an id no `unique_id`, in the
  source and in the application resource alike; the bracket covers the app document and its media
  map and nothing else; a 401 is one status for five causes; a tastypie 429 names no wait; places
  and levels are not throttled; no API-key read returns a table's description, a field's indexed
  flag, row owners, a level's worker or expand settings, or an archived place; HQ's message for a
  menu it could not summarize is exception text and is shown to no one.
- Files: `proof/hq-reads/reading/`, `retainedReadingRead` and `applicationAnswer` for any test that
  needs HQ's answer to one of these reads; `proof/views/reading_reads.py`, the lane's requests for
  them (`app_list_read`, `application_read`, `api_access_read`, `remote_app_through_hq`,
  `seed_api_superuser`, `client_request`), which B13 moves into `proof/hq/operations.py`. B1
  retains no answer of the media read; part 14 (`14-proof.md`, section 5.3, B13) records each
  mapped file's read for its HQ-authored bases.
