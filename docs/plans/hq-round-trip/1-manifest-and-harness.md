# Step 1: The manifest and the harness

Step 1 builds the evidence every later step stands on: the surface manifest,
the proof harness that runs proofs 1 to 5 of the research's "Proof when a
feature is built", and the corpus those proofs run over. It changes no stored
Nova document, so it has no cutover and no migration. Its exit is the research's:
every inventory entry is in the manifest with its disposition, and the harness
reproduces the symptom of every defect visible in HQ's build, HQ's search, HQ's
lookup upload, HQ's submission processing, Core's runtime or an HQ editor save
(defects 1 to 10, 12 to 16, 20, 21, 23 to 27 and 30).

## Where Nova stands today

- The native proofs are manual. `scripts/fixtures/hq/` holds 20 Python
  consumers and their TypeScript producers, and `scripts/fixtures/javarosa/`
  holds the Core runtime tests. No npm script, workflow or hook runs them; each
  Python consumer repeats its own copy of the HQ boot, and none runs HQ's whole
  `validate_app()` or `create_all_files()`. Ordinary CI runs only the
  TypeScript export tests in `lib/commcare/__tests__/`.
- The research executed most of what this step builds (HQ's full build under
  six seams, HQ's merge in memory, Core's form validation in place of
  Formplayer's, HQ's vendored Vellum opening and saving forms headless, and
  HQ's app-manager page partials producing real saves with HQ's saves and
  database reads patched out), but as private one-off scripts. None of it is in
  the repo, and none of it runs twice the same way. It never ran HQ's import
  API through its save path, which writes to HQ's SQL tables and reads Couch
  views (work item 2).
- HQ's virtualenv on a developer machine drifts from the checkout's `uv.lock`
  (`django-oauth-toolkit`, `oauthlib` and `pkg_resources` differ), so booting
  HQ from it needs a dependency overlay.
- The flag audit (`scripts/audit-commcare-hq-feature-flags.mjs`, weekly from
  `.github/workflows/commcare-hq-feature-flags.yml`, `npm run
  audit:hq-feature-flags`) matches substrings in HQ's source against
  `config/commcare-hq-feature-flags.json`. It checks 8 flags and the HQ
  resources the probe calls (the `user_domains` feature-flag filter and its
  paginator, the case search endpoint's refusal message and decorators). It
  fails today at the pinned HQ because `corehq/toggles/__init__.py::SESSION_ENDPOINTS`
  passes its namespace positionally and the audit looks for `namespaces=`.
- The runtime flag probe reads that JSON through
  `lib/commcare/projectSpaceCompatibility.ts::privateFeatureFlag`, which uses
  only each flag's `id`, `slug` and `expectedNamespaces`. The capability to
  flag joins are hand-written in `projectSpaceCompatibilityProbePlan`.
  `lib/commcare/__tests__/projectSpaceCompatibilityBoundary.test.ts` reads the
  JSON's slugs and symbols as tokens no public surface may contain.
- Nova publishes through `lib/commcare/client.ts::importApp`, which posts to
  HQ's `import_app_api`; HQ's `app_import_api.py::_handle_import_app` creates
  through `models/applications.py::import_app_from_doc` and updates through
  `overwrite_app_from_source` (the merge, then `wrap_app`, the report map,
  `save_attachments` and the media domains).
- Nova's application shell declares CommCare `2.54.0` (`hqShells.ts`), but
  HQ's create drops `build_spec` and its update never writes it, so the target
  app's version is HQ's, never Nova's.
- CI (`.github/workflows/ci.yml`) runs on every pull request on GitHub-hosted
  runners. The repository is public, so those runners and a public GitHub
  Container Registry package cost nothing.

## Decisions

1. **The harness lives in `proof/`,** one top-level directory holding the pins,
   the image, the HQ, Core and editor drivers, the checks, the corpus
   definitions and the registers below. `scripts/fixtures/hq/` and
   `scripts/fixtures/javarosa/` move into it (work item 5), so Nova has one
   native-proof harness.
2. **One pins file, `proof/pins.json`,** names the commit of each upstream the
   harness uses: commcare-hq `f57e85e02913`, commcare-core `8e9ba8d908e9`,
   commcare-android `fd79cac4a0f1` (its parsers and installer registrations
   feed the surface) and commcare-connect `4a200c9d9` (the Connect proof reads
   its extractor). Vellum is not pinned separately: the harness uses HQ's
   vendored Vellum build, and the image self-test asserts that
   `corehq/apps/app_manager/static/app_manager/js/vellum/version.txt` at the HQ
   pin names the research's Vellum pin `01215f251c57`. Formplayer is not in
   step 1: the check HQ's build asks Formplayer for is Core's `XFormParser`
   with `JSONReporter`, which the Core runner runs directly, and nothing else
   in this step runs Formplayer. The step that first needs it adds its pin.
   Changing a pin is a pull request that rebuilds the image and regenerates the
   surface.
3. **One harness image,** built from the pins and published publicly to
   `ghcr.io/voidcraft-labs/commcare-nova-proof` for `linux/amd64` (CI) and
   `linux/arm64` (developer machines). It holds HQ's source at its pin with its
   seven git submodules, and a virtualenv built by `uv sync --locked` from HQ's
   own `uv.lock` (so no overlay exists; the image build fetches the lock's git
   and URL sources, and only the image's checks run offline), JDK 17 and Gradle with Core compiled at its pin and its
   test classpath recorded, the Android sources at its pin, node at Nova's
   version, Playwright's Chromium at Nova's Playwright version, and the
   editor bundles work item 4 builds from HQ's node packages at image build
   time; HQ's `node_modules` itself is not kept. It holds no Nova source and no
   Nova dependencies: Nova's checkout is mounted at run time, and Nova's
   `node_modules` for Linux lives in a volume the harness fills with `npm ci`,
   keyed by `package-lock.json`, so a macOS checkout's binaries never enter the
   container. The image holds only public, licensed upstream sources and Nova's
   harness code. Connect's checkout carries no license file, so Connect is
   never in the image: the Connect proof clones it at its pin at run time.
4. **The image is rebuilt only when its inputs change,** as the build-tools
   image is (`docs/architecture/deployment.md`), but by a workflow rather than
   by hand: `proof-image.yml`, run manually for a change to the image recipe
   and called by the weekly pin pull request (work item 9), builds each
   architecture on a native GitHub runner of that architecture (HQ's locked `jsonobject` 2.3.1 has no arm64
   wheel, so the arm64 build compiles it from source), pushes both, and prints
   the digest, which the same pull request records in `proof/image.lock` with
   the pins it was built from. The CI `quality` job fails when `image.lock`'s
   recorded pins differ from `pins.json`.
5. **The manifest lives in `lib/commcare/surface/`,** inside the CommCare
   boundary, as two layers. The **surface** (`surface.json`) is generated from
   the upstream checkouts and never edited by hand. The **entries**
   (`entries/<area>.json`) are authored: one file per inventory area file, one
   entry per counted inventory row, and the gate entries (decision 8). From
   step 1 the manifest is the living record of every disposition; the inventory
   in `docs/research/` stays as the research's evidence and is not kept in step
   with it.
6. **An entry names what it covers by surface key.** Every surface item has a
   key of the form `<family>:<name>` (`schema:Detail.display`,
   `format:enum`, `mug:Secret`, `toggle:SESSION_ENDPOINTS`,
   `privilege:SAVE_TO_CASE`, `jr-fn:count`, `parser:DetailParser/field@sort`,
   `csql-fn:fuzzy-match`, `setting:properties.cc-autoup-freq`,
   `version-gate:support_document_upload`, `hq-api:import_app_api`,
   `appearance:android/minimal`, `media-format:audio/flac`). An entry lists one
   or more surface keys and, where the inventory splits one item into value
   classes (its rule 3), a `valueClass` slug. A surface item may be covered by
   several entries, one per value class. One family is authored rather than generated: `media-format`,
   whose facts come from the vendors' documentation the inventory's Media
   section cites, not from source; it lives beside the entries, and a change to
   it is a reviewed edit.
7. **A surface item no entry names is refused wherever an app uses it.** This
   is the research's rule for the reader ("Refused: everything else, including
   anything the reader does not recognize"), stated for the manifest: a schema
   field no entry names is refused at any value other than HQ's default, and a
   format, question type, function, parser element or attribute, appearance
   token or setting value no entry names is refused wherever it occurs. So the
   entries are the inventory's rows and no more, and the surface can be finer
   than the inventory (every parser attribute is an item) without any item
   being accepted unclassified. Two checks keep that default from hiding
   anything: Nova's own exports may use only items an entry names (work item
   11), and the weekly pin pull request names every item upstream adds (work
   item 9).
8. **Gates are their own entry kind.** Each row of `inventory/gates.md` is a
   gate entry: the 70 app-building toggles, the removed toggles with document
   residue, the plan-gated privileges and the build versions, plus the
   project-space settings publish confirms (the case search configuration, sync
   on form entry, CommTrack, the flat location fixture). A gate entry holds its
   class as `gates.md` names it (target-owned, retiring, inert, removed with
   residue), the entries whose content it gates, the build output it changes,
   and its target preflight (none, precondition, confirmation, or refusal). The
   research found that the other toggles and privileges in HQ's registries
   (137 of the 207 toggles at the pin) change nothing about how HQ builds an
   app, so they have no entry. One check holds that true: a flag HQ reads while
   building a Nova export must have a gate entry (work item 11).
9. **The flag probe reads each flag's identity from its gate entry and keeps
   its behavior.** `privateFeatureFlag` gives way to a typed accessor by symbol
   over gate entries (`lib/commcare/surface/gates.ts`), which supplies each
   flag's slug and namespace. Which flags the probe checks, and for which
   content, stays in `projectSpaceCompatibilityProbePlan` exactly as today
   (including `MM_CASE_PROPERTIES`, `CUSTOM_PROPERTIES` as an advisory, and
   `VIEW_FORM_ATTACHMENT`), because a gate entry's preflight states the target
   the research sets, not what Nova checks now. Step 2 moves the probe to the
   target preflights (defect 12). `config/commcare-hq-feature-flags.json`, the
   audit script, its workflow and its npm script are deleted; the HQ resources
   the audit watched become the `hq-api` surface family (work item 6).
10. **Checks are orchestrated by pytest** inside the image. HQ's side of every
    check is Python, so pytest owns discovery, one test per corpus document and
    check, and the lifetimes of two owned child services it starts per session:
    the Core runner (a long-lived JVM, work item 3) and the editor driver (node
    and Chromium, work item 4). Both are joined at session teardown, and a
    failure to start either fails the session; nothing is skipped. The Core
    runtime tests that already live in `scripts/fixtures/javarosa/` stay JUnit
    tests, run through Core's Gradle build in the image, as a second native
    suite.
11. **Checks run on every pull request** in their own CI lane, sharded, in
    parallel with the existing jobs, so the lane adds to the workflow's time
    only where it outlasts the longest existing lane. Its shard count is chosen
    the way the smoke lane's was (`docs/testing.md`, "Performance and
    verification"): from three hosted runs per candidate, counting the image
    pull, so the workflow keeps its five-minute target. Only the fuzz sample
    scales with the budget; the fixed floor (the producer and targeted
    documents, the self-checks, the editor runs, the Core JUnit suite) is
    measured first. If the floor cannot fit the target at the concurrency the
    repository's runners allow, the step's pull request records those
    measurements and the person sets the lane's target before it merges. The
    surface is regenerated on every pull request, and against the upstream
    default branches in the weekly pin pull request (work item 9).
12. **A known defect is a strict register entry, not a skipped test.**
    `proof/known-defects.json` lists each defect part the harness reproduces
    (work item 12) as a symptom class: its defect number, the check that shows
    it, the artifact, and the structural path of the difference (for example
    every form's `unique_id` in the app JSON), with exact values only where the
    input is a targeted document whose values are fixed. Every comparator
    reports the full set of differences it finds, never only the first. The
    lane passes only when every difference it sees, on any corpus document,
    falls in a registered class; every entry matches a difference on the
    current export of its targeted document; and every entry reproduces on its
    own control. So a new failure fails CI, a fix fails CI until its pull
    request removes the entry, and the size of the fuzz sample never changes
    the register. Each entry's control is a retained pre-fix input under
    `proof/controls/`: the upload bodies and export bytes step 1 emits for the
    targeted document, and the expected values its checks compare against, so
    a control never depends on a document shape a later cutover changes. The
    check must keep showing the symptom on its control after the fix: the
    negative-control practice `docs/testing.md` already names.
13. **Accepted identity moves are a register too.**
    `proof/identity-moves.json` lists each identity change a migration decides,
    by defect number and entity; proof 1 accepts exactly those. It is empty in
    step 1; step 2 adds its first entries.
14. **The harness publishes the way Nova publishes.** A and every later state
    come from the upload bodies Nova's real publish client
    (`lib/commcare/client.ts::importApp`) sends, captured from a local peer, and
    applied by calling HQ's `app_import_api.py::_handle_import_app` with
    Django's `RequestFactory`: no `app_id` for the create, the app's id for each
    update. So A is exactly what Nova's first publish leaves in HQ, and when
    step 2 makes publish a create followed by an id-writing update, the harness
    follows without change. HQ's import and save path reads and writes HQ's
    SQL tables and Couch views, so the harness gives it a real Postgres and an
    in-memory Couch (work item 2), and A's `cloudcare_enabled` is what HQ's
    create sets from the configuration's `cloudcare` privilege.
15. **Two builds of one document are compared as well as two publishes.**
    Besides the research's comparison of `build(A)` with HQ's build after the
    next publish, proof 3 compares Nova's local `.ccz` with HQ's build of the
    same document, and proof 1 compares two local `.ccz` exports of one
    unchanged document, since defects 7, 9 and 10 are differences on the local
    path.
16. **Absolute checks, where both sides of a comparison are wrong.** A
    comparison cannot see a defect present on both sides, such as a display
    condition HQ cannot build (defect 2) or a validation Nova drops from every
    export (defect 8). So every Nova export also meets the research's bar
    directly (HQ builds it, and Core admits everything HQ generates), and
    intent checks compare what HQ builds and what Core runs with what the Nova
    document states: its case types, its authored validations, its lookup rows,
    its orderings. The expected value is read from the document, never from
    Nova's emitter or its evaluator. On corpus documents intent checks are
    structural (a case type HQ built, a property HQ learned, a validation Core
    enforces at all); a value-level check (a constraint verdict for a given
    answer, a time ordering, a row order) runs only on a targeted document,
    whose expected values are fixed by hand from the document's authored
    meaning and stored in its control.
17. **Feature-matrix apps move to step 6.** They are HQ apps built through HQ's
    own models, and until the reader exists nothing but a harness self-check
    can consume them. Step 6 builds them with the reader, whose exit reads them.
    Step 1's corpus is the rest of the research's list (work item 10), plus the
    one HQ-built app a reproduction needs because no Nova export can show the
    symptom (defect 20's advanced module, work item 12).
18. **Android is cited, not run.** The exit names HQ and Core, not Android, and
    the Android classes involved (`HiddenPreferences`, `AppUtils`,
    `ProfileAndroidInstaller`, `HomeScreenBaseActivity`) run only inside a
    running CommCare app: they read `CommCareApplication`, its
    `SharedPreferences` and its record storage. Where a defect's harm is on
    Android (7, 9, and 20's form that never opens), its register entry
    observes the artifact through Core's parse and names the Android predicate
    it rests on (`HiddenPreferences.isSavedFormsEnabled` and
    `isIncompleteFormsEnabled`, `AppUtils.getAppById`,
    `ProfileAndroidInstaller.checkDuplicate`,
    `HomeScreenBaseActivity.launchRemoteSync`).

## What it builds, in order

### 1. Pins and the harness image

- `proof/pins.json`, `proof/image/Dockerfile`, `proof/image.lock`, and
  `.github/workflows/proof-image.yml` (manual dispatch, one native runner per
  architecture).
- The image recipe builds HQ's virtualenv from HQ's `uv.lock`; installs HQ's
  node packages only long enough to build the Vellum host page and the
  app-manager bundles (work item 4); compiles Core at its pin with JDK 17 and
  records its test classpath; and installs Playwright's Chromium.
- `npm run proof -- [selection]` runs the pinned image locally with the
  worktree mounted read-only, the Linux `node_modules` volume, and an output
  directory mounted writable; the same command runs in CI.
- An image self-test proves the boot (work item 2) comes up offline, that HQ,
  Core and Android are at their pins, and that HQ's vendored Vellum is the
  research's Vellum pin.

### 2. The HQ boot and the build seams

`proof/hq/` is one Python package that every HQ-side check imports; nothing
repeats it.

- **Boot:** `CCHQ_TESTING`, HQ's `testsettings`, `manage.init_hq_python_path()`,
  `django.setup()`. Every socket connection is refused except to the lane's
  Postgres. Caches are local memory, and quickcache's tiers are rebound to
  local memory; a boot self-test proves no quickcache tier reaches a network
  cache. Celery runs tasks inline (`testsettings` sets
  `CELERY_TASK_ALWAYS_EAGER`), so a task HQ's save starts, such as the data
  dictionary refresh, runs inside the check.
- **HQ's state.** HQ's import API, its saves and its page contexts read and
  write SQL and Couch: `ApplicationBase.save` clears version caches through
  `GlobalAppConfig`, `Application.save` refreshes the data dictionary and sends
  `app_post_save` (whose receiver reads the app-structure repeaters), create
  checks `domain_has_apps` through a Couch view, and
  `views/modules.py::get_module_view_context` saves module ids and reads the
  domain's lookup tables. So the harness gives HQ:
  - **Postgres**, a service in the proof lane, holding exactly the tables of
    the HQ models these paths reach, created from HQ's models by Django's
    schema editor. The model list is fixed in the harness and found by
    running every path the checks use: a query against a table the list lacks
    fails with "relation does not exist", so the list cannot silently fall
    short. Each check runs in its own database, dropped at teardown.
  - **An in-memory Couch** (`fakecouch`, which HQ's `uv.lock` already
    carries) and an in-memory blob store, answering the Couch views these
    paths query (`app_manager/applications_brief`, `users/by_username`,
    `groups/by_name`) from the documents the check stores. A view the harness
    does not answer raises.
  With real tables, defect 3's harm is observed where HQ keeps it: the data
  dictionary rows `refresh_data_dictionary_from_app` writes.
- **Requests.** Every `RequestFactory` request carries a session, message
  storage (HQ's views call `messages.warning`, and Nova decodes those
  warnings) and a `couch_user` seeded with edit-apps permission on the domain,
  so decorated views run as HQ runs them.
- **The research's six build seams,** each a context owned by the test that
  opens it: feature flags off unless the corpus document's configuration names
  them (each flag HQ reads is recorded); the previous build
  (`ApplicationBase._get_version_comparison_build`), which is none for A's
  build and `build(A)` for the build after the next publish, so HQ's own
  `set_form_versions` decides which forms get a new version; Formplayer's form
  validation served by the Core runner for every form (never skipped, and no
  stub mode); privileges from the configuration; `get_xform_resource_overrides`;
  and the default build spec. The harness builds at CommCare 2.57, the highest
  `_require_minimum_version` in `feature_support.py` and Nova's floor from step
  2; since HQ never takes the version from Nova's upload, this is the
  harness's choice of target, and a document's configuration may name another.
- **Project-space seams** from HQ's own test utilities:
  `app_manager/tests/util.py::commtrack_enabled` and
  `::case_search_sync_cases_on_form_entry_enabled_for_domain`.
- **Operations:** `publish(bodies)` (decision 14); `build(app)`
  (`validate_app()`, `create_all_files()`, and `create_all_files(build_profile_id)`
  for each build profile); HQ's case processing of a submission up to its case
  database (`casexml/apps/case/xform.py::extract_case_blocks` and
  `get_case_updates`, then `form_processor/casedb_base.py::AbstractCaseDbCache`
  over the in-memory case state), so an empty case id is refused as HQ refuses
  it; HQ's CSQL compiler (`case_search/filter_dsl.py::build_filter_from_xpath`)
  and its request configuration
  (`case_search/models.py::extract_search_request_config`); and HQ's lookup
  workbook upload (`fixtures/upload/run_upload.py::_run_upload`).
- **The lookup upload runs on HQ's state as above.** `_run_upload` works
  through HQ's database managers (`LookupTable.objects`,
  `LookupTableRow.objects`, `LookupTableRowOwner.objects`) inside a transaction
  with `bulk_create`, and resolves owners through `users/by_username`,
  `groups/by_name` and the locations table, so its tables are among the
  harness's and its owners are documents in the in-memory Couch. A document
  whose case list or search reads a lookup table has that table uploaded the
  same way before its pages render, so HQ's page context lists it.
- **The CSQL compiler runs in a case search context.** HQ checks related
  lookups (`filter_dsl.py::_require_related_lookups_flag`) only for
  `subcase-exists`, `subcase-count` and `ancestor-exists`, and only when the
  context's helper is a case search helper, so the harness builds that
  context as HQ's search does.

### 3. The Core runner

`proof/core/` is one long-lived JVM per test session, speaking JSON lines over
stdin and stdout, with a deadline on every request.

- **Validate a form:** the body of Formplayer's `UtilController.validateForm`
  (`XFormParser` with `JSONReporter`), the check HQ's build asks Formplayer
  for, without a JVM per form.
- **Admit an archive:** install a `.ccz`, or HQ's built files arranged as one,
  the way Core's archive installer does, parsing the suite, profile, app
  strings and every form.
- **Run a scripted session** and return its trace: each screen, command id,
  entity rows, question sequence with prompts, the profile's properties that
  the manifest holds as app content with a runtime reader (so the two export
  paths are not compared on properties no runtime reads) and its required
  version, the normalized submission, the case database after submission, and
  the stack after submit. A script is derived from the baseline build: every
  menu command, and every reachable form opened with the first entity of each
  list. Each question is answered from a fixed table of values per question
  type (for a select, its options in order); when Core refuses an answer, the
  refusal is recorded and the next value is tried, at most three per question,
  and a question with no accepted value ends the session there, recorded. The
  same script replays on the other build, and a step that cannot replay there
  is itself a difference.
- **Case data, search and sync.** Each corpus document has a generated case
  database: cases of each of its case types, with values for each property
  from its type, including values whose text and numeric orders differ ("10"
  and "2"). A remote search is answered with every case of the requested case
  type from that database; the runner does not evaluate CSQL, whose meaning is
  checked against HQ's own compiler (work item 2). A sync request is answered
  with the same case database and recorded in the trace, so a session that
  asks for one (defect 20) shows it.
- **Evaluate an intent check** (decision 16): open a form or a case list with
  given session and case data and report the values, constraint verdicts,
  instance contents and row order Core produces.

### 4. The editor driver

`proof/editors/` drives HQ's own editors.

- **Vellum:** HQ's vendored Vellum build in headless Chromium, on a host page
  built at image build time with HQ's own Bootstrap, jQuery and select2. Its
  options come from HQ's own view helpers
  (`views/formdesigner.py::_get_vellum_features`, `_get_vellum_plugins`, and
  the case and form data sources HQ computes for the form builder), called
  through the HQ package, never copied by hand. It waits on Vellum's own load
  and save events rather than fixed sleeps, and it records parse errors,
  question errors, and the saved XML. Each form is opened and saved twice (the
  research's second round trip), and every result is parsed and serialized by
  Core before comparison, never compared by pattern over XPath text.
- **App-manager pages.** HQ gates these pages in its view context and Django
  templates as well as in JavaScript (for example, `case_search_property.html`
  offers the date input only under `CASE_SEARCH_ADVANCED`), so HQ renders each
  one. The harness renders the page's own settings partials, the templates
  that hold its forms and Knockout templates, through HQ's view-context
  function (`views/modules.py::get_module_view_context` and its equivalents for
  forms and app settings) against HQ's state (work item 2), under the
  configuration's flags and privileges. It does not render HQ's site frame
  (`view_generic` and the base templates), which holds navigation and no
  settings. The page's JavaScript is HQ's own: each page's entry modules, as
  HQ's webpack configuration names them, bundled with esbuild at image build
  time, with shims only for the page globals the site frame would supply. The
  save request the page makes is applied through HQ's own view function,
  decorators included (for example `views/modules.py::edit_module_detail_screens`,
  `views/forms.py::edit_form_actions`, `views/apps.py::edit_app_ui_translations`),
  with a request as work item 2 builds it. Pages covered: app settings,
  add-ons, UI translations, module settings, the case list, case search, form
  settings, and case management (basic and advanced). Flags and privileges
  are the only reads the harness replaces (through the seams of work item 2,
  including the request-based `has_privilege` the page context calls); every
  other read is HQ's, against HQ's state.
- **Configurations.** Each document names its minimum configuration: the
  flags today's probe requires for its content and the privileges its content
  needs, since a target without them is one Nova's publish refuses, so an
  editor dropping content there is not a defect. The editors run under that
  minimum, under the maximum (every app-building flag the manifest classes as
  target-owned on), and under the single-flag configurations a reproduction
  names.

### 5. The existing native proofs move onto the harness

Each Python consumer in `scripts/fixtures/hq/` moves to `proof/native/` and
imports the shared boot and seams in place of its own copy. Each Core test in
`scripts/fixtures/javarosa/` moves to `proof/native/core/` and runs through the
image's Core build. The producers keep emitting through Nova's real expander
and compilers. Each moved proof is re-read against `docs/testing.md` as it
moves: one that proves nothing the checks of work item 11 do not is removed,
one that proves something they do not is kept, and the pull request records
which and why. Their READMEs fold into `proof/README.md`, and the references
`docs/testing.md` and the Core README make to evidence files that no longer
exist (`native-core-arithmetic.json`, `native-{hq,core}-prompts.json`) are
corrected. After this item every kept native proof runs in the proof lane.

### 6. The surface extractor

`proof/surface/` regenerates `lib/commcare/surface/surface.json` from the
checkouts at the pins, inside the image. Each family is read from its
authoritative source, by the method that sees every reader:

| Family | Source | Method |
|---|---|---|
| App schema | `corehq/apps/app_manager/models/` and the mixins it imports (`hqmedia`, `integration`, `appstore`, `blobs`) | after the boot, walk `_properties_by_key` of every class reachable from `Application`, the four module classes and the three form classes, seeded with the classes `ModuleBase.wrap`, `FormBase.wrap` and `get_correct_app_class` dispatch to; record each key's type and choices. A Python AST pass over the `wrap` methods adds the legacy spellings they rename. |
| Detail formats | `detail_screen.py::register_format_type`; the editor's `details/utils.js::getFieldFormats` | the registered map after the boot; an AST parse of the editor list with each entry's toggle and add-on guard |
| Vellum | HQ's vendored Vellum build; `views/formdesigner.py::_get_vellum_features`, `_get_vellum_plugins` | an AST pass over Vellum's `features.<key>` readers finds the keys Vellum reads; the build is loaded headless and its mug-type registry and question menus read with every feature off, every feature on, and each of those keys alone on |
| Toggles, feature previews, privileges | `corehq/toggles/__init__.py`, `corehq/feature_previews.py`, `corehq/privileges.py`, `accounting/bootstrap/features.py` | after the boot, every `StaticToggle` instance with its class, slug, tag, namespaces, parents and privilege; privilege constants and plan allocations statically |
| Build-version gates | `feature_support.py::CommCareFeatureSupportMixin` and every comparison of `build_version` in `app_manager` | AST: each property's minimum version and toggle conjuncts; each direct comparison with its enclosing function |
| Settings | `commcare-app-settings.yml`, `commcare-profile-settings.yml`, `commcare-settings-layout.yml` | HQ's own loader, `commcare_settings.py::_load_custom_commcare_settings`, keyed `<type>.<id>`, with `since`, `toggle`, `toggles`, `privilege` and `disabled` |
| Add-ons | `app_manager/add_ons.py` | the loaded registry |
| Suite instances | `suite_xml/post_process/instances.py` | its factories and scheme keys, loaded |
| Project-space settings | the Django model fields publish confirms: `CaseSearchConfig` (`enabled`, `sync_cases_on_form_entry`), `Domain.commtrack_enabled`, `LocationFixtureConfiguration.sync_flat_fixture` | the loaded model fields with their defaults |
| HQ API | every HQ view or resource Nova calls: `app_import_api.py::import_app_api`, `views/apps.py::app_source`, `api/resources/v0_4.py::ApplicationResource`, `api/resources/v0_5.py::UserDomainsResource` with its feature-flag filter and paginator, `ota/views.py`'s case search endpoint and its decorators, `fixtures/views.py::upload_fixture_api`, `fixtures/resources/v0_1.py::LookupTableResource`, `v0_6.py::LookupTableItemResource`, the location resources, and the multimedia upload | a Python AST pass recording each one's route, decorators, the request parameters it reads, and the fields a resource declares (its `fields` and `dehydrate_*` methods); the response shapes Nova decodes stay the business of Nova's decoders and their tests |
| JavaRosa | Core's `ASTNodeFunctionCall.buildFuncExpr`, `XFormParser`'s type, handler and action maps, `Action.allEvents` | a Java AST pass (JavaParser) for the function switch; reflection over Core's compiled classes for the parser maps and events; a static pass for the registrations Android (`XFormAndroidInstaller`) and Core (`XFormUtils`) add |
| Runtime parsers | Core's `org/commcare/xml/*Parser.java` and Android's `AndroidSuiteParser`, `AndroidDetailParser` | a Java AST pass with constant resolution over each parser's element and attribute reads, and the child-parser graph for nesting. Restore-side parsers (case, fixture, ledger) are not app content and are out of the surface. |
| Appearances | Android's widget construction (`WidgetFactory.java` and the widgets it builds) and Core's group reader (`FormEntryController.isHostWithAppearance`); Web Apps' form-entry client (`cloudcare/static/cloudcare/js/form_entry/`) | a Java AST pass and a JavaScript AST pass over each read of a control's appearance, recording the token, how it is matched (whole string, contained, prefix, split on spaces) and its case handling |
| Media | `hqmedia/models.py` (the media classes and the file types HQ assigns each) and the paths HQ's build writes for them | the loaded classes and their type maps |
| Lookup tables | `fixtures/models.py`, `fixtures/upload/workbook.py`, `fixtures/utils.py::is_identifier_invalid`, `fixturegenerators.py::to_xml` | the loaded models' fields; an AST pass over the workbook's sheet and column vocabulary and the serializer's element vocabulary |
| CSQL | `case_search/xpath_functions/__init__.py`, `case_search/const.py`, `es/queries.py::DISTANCE_UNITS` | static AST of the literal tables |

Each surface item records the attributes whose change matters (a toggle's tag,
a field's choices, a gate's minimum version, an API view's decorators), so a
change in them is a diff. Nothing in the extractor matches source text with
regular expressions.

### 7. The manifest entries

- `lib/commcare/surface/schema.ts` is the Zod schema. A surface entry holds its
  id, surface keys, optional value class, disposition (HELD, HELD-NEW, TARGET-OWNED, INERT or REFUSED), the slot change
  a HELD row names (`widen` or `narrow`, with its text), a REFUSED entry's
  reason from the inventory's rule 5 with the gate, rule, validator or failure
  it names, the Web Apps and Android behavior (runs, ignored, unavailable,
  different, or not applicable, with its note), the gates it needs (gate entry
  ids), and its emission. A gate entry holds what decision 8 lists.
- The entries are written from the inventory's rows, and only from them. A one-off script,
  `scripts/surface-from-inventory.ts`, parses the seven inventory files (every
  row there has four cells, and the first cell is unique within its file) into
  entries with every column; surface keys and value classes are then assigned
  per row. The 39 rows that list several items take several keys; the 57
  pointer rows are not entries. Every assignment is checked against the
  checkout at the pin, not inferred from the row's wording.
- A second one-off script, `scripts/reconcile-surface-inventory.ts`, checks the
  result: every counted inventory row is exactly one `inventory` entry with the
  same disposition, platform cells and emission, and those entries' counts equal
  the inventory's Counts table (274 HELD, 416 HELD-NEW, 26 TARGET-OWNED, 161
  INERT, 345 REFUSED; 1,222 rows), and every gate row of `gates.md` is exactly
  one gate entry. Both scripts are committed so their run is
  auditable, run in the step's pull request with the output recorded there, and
  removed in a later commit of the same pull request.
- `lib/commcare/surface/__tests__/manifest.test.ts`, in ordinary CI, parses
  every entry with the schema and checks the manifest against the surface:
  every key and gate an entry names exists, and no two entries claim the same
  key and value class. It prints the coverage number,
  "N of M entries held".

### 8. The flag probe reads the manifest

- `lib/commcare/surface/gates.ts` exposes the accessor by symbol;
  `projectSpaceCompatibility.ts` takes each flag's slug and namespace from its
  gate entry, and its capability joins stay as they are (decision 9).
- `projectSpaceCompatibilityBoundary.test.ts` takes its forbidden tokens from
  the gate entries of the flags the probe checks.
- The existing probe tests keep their boundaries (`withHttpPeer`,
  `withSocketHttpPeer`, the Postgres MCP tests) and pass unchanged, which shows
  the probe's behavior did not move.
- Delete `config/commcare-hq-feature-flags.json`,
  `scripts/audit-commcare-hq-feature-flags.mjs`,
  `.github/workflows/commcare-hq-feature-flags.yml` and the
  `audit:hq-feature-flags` script.

### 9. The weekly pin pull request

Upstream changes reach Nova as one pull request a week that moves the pins,
alongside the weekly dependency upgrades, so they are reviewed where Nova's
other upstream changes are and every check runs against the new code before it
is adopted.

- `.github/workflows/upstream-pins.yml` runs on a weekly schedule and by hand.
  It reads each upstream's default-branch head. When none differs from
  `pins.json`, it does nothing.
- Otherwise it calls `proof-image.yml` for the candidate pins, regenerates the
  surface, and commits `pins.json`, `image.lock` and `surface.json` to one
  branch, `upstream/pins`, replacing last week's commit there. It opens that
  branch's pull request, or updates it, and requests the person's review.
- There is only ever one such pull request. A week's run updates the open one
  in place rather than opening another, and a week with nothing new leaves it
  as it is.
- A run that cannot finish (the image does not build for the new commits, or
  the extractor fails on them) reports through the same pull request: its last
  step, which runs whenever an earlier step fails, commits the new pins alone
  to the branch and writes the failed step and a link to the run into the
  description. CI on that pull request is then red, which is the signal: HQ
  changed something the harness depends on.
- The description always states the date and outcome of the latest run, so a
  week with no update is visible as a stale date.
- The pull request's description is the classified difference from the
  committed surface: each item added (refused wherever an app uses it until an
  entry names it, and for a toggle, checked for whether it changes how HQ
  builds an app), removed (entries name a key that is gone), or changed (with
  the entries that name it and their dispositions), so a changed decorator on
  an HQ API view Nova calls, or a toggle's new tag, is named with what it
  affects.
- A pull request opened with the workflow's own token starts no
  `pull_request` runs, so the workflow dispatches `ci.yml` (which already has
  a `workflow_dispatch` trigger) on the branch. The whole proof lane, the
  surface job and the manifest test then run against the new upstream code,
  and the pull request shows whether Nova's exports still build, run and
  survive HQ's editors there.
- The work a change needs (an entry for a new item, a register entry for a
  newly visible defect, a harness seam HQ's refactor moved) is committed to the
  same branch before it merges. Merging it moves the pins.
- The workflow has `contents: write`, `pull-requests: write`, `packages: write`
  and `actions: write`, and nothing else.

### 10. The corpus

- **Nova documents.** Every admitted document the moved producers emit
  (work item 5), the admitted expander corpus, and a fixed-seed sample of the
  compiler fuzz generators (`lib/commcare/__tests__/xformDocArbitrary.ts` and
  the suite oracle's), each passing Nova's strict schema and full validation.
  Each document comes with an edit batch from a new generator: the document
  fuzz suites (`lib/doc/__tests__/*.fuzz.test.ts`) edit fixed seed documents
  with constant ids, so they cannot edit an arbitrary admitted document. The
  generator draws from every mutation kind the reducer defines, targets
  entities of the given document, and keeps a batch only when the real commit
  gate (`lib/doc/commitVerdicts.ts::mutationCommitVerdict`) admits it, so every
  edited document is admitted too; its census reports each mutation kind's
  share, as the compiler corpora report theirs. Each document's configuration names its flags,
  privileges and CommCare version. The sample size is set by the lane's time
  budget (decision 11).
- **Targeted documents,** one per defect part in work item 12 that no other
  corpus document shows, each fixed so its symptom values are exact.
- **HQ's apps, as harness self-checks:** the app JSONs in
  `corehq/apps/app_manager/tests/data` and its `suite` folder that build clean,
  the apps HQ's tests construct with `AppFactory` (with a generated source per
  form: a unique `xmlns`, one question per case-configuration path, itext per
  language), HQ's template apps, and the HQ-built `.ccz` apps in Core's and
  Android's test resources (Formplayer's join when a step adds Formplayer to the
  harness). The same build twice must give identical traces,
  and each must build as the research found (17 of the test JSONs, 8 of the 11
  harvested apps). The self-checks build at CommCare 2.54.0, the version the
  research built them at, so those counts check the harness.

### 11. The checks

Until the reader exists, A is what Nova's first publish of a document D leaves
in HQ, and B is what Nova's next publish leaves there: of D again, or of D′
after an edit batch (decision 14).

**The bar,** on every Nova export:

- **HQ builds it:** `validate_app()` returns no error and raises nothing, and
  `create_all_files()` and every build profile's
  `create_all_files(build_profile_id)` succeed, for A and for B.
- **Core admits it:** the Core runner admits HQ's build of A and B and Nova's
  local `.ccz`.

**Intent checks** (decision 16) compare HQ's build and Core's runtime with the
Nova document: HQ side, each module's case type, the case properties HQ learns
(`FormBase.get_all_case_updates`), each attachment path, and the profile's
required version and settings; Core side, what work item 3's intent requests
report.

**Manifest checks,** on every Nova export: every surface item the export uses
(a schema field at a value other than HQ's default, a format, a question type,
a function, a parser element or attribute, an appearance token) is named by an
entry, and every flag the seam records HQ reading while building it has a gate
entry.

**Configuration sensitivity:** each document is also built with each flag
the seam recorded HQ reading during its plain build flipped, and under each
project-space seam (CommTrack, sync on form entry). Every difference from the
plain build is either named in that gate entry's effects, written as an
artifact and a structural path in the register's vocabulary, or falls in a
register class. Step 1 fills each gate entry's effects from these runs, and
the pull request lists them for review.

**Proofs 1 to 5:**

1. **Identity.** Every identity in the research's identity table ("External
   identity") is equal between A and B for a publish with no edit, and, for a
   publish after an edit batch, for every entity outside the batch's
   footprint: app id, each form's `xmlns` and `unique_id`, each module's
   `unique_id`, session endpoint ids, the session datum ids form logic reads,
   the full data path of every answer leaf and which segments repeat, the
   body's question order, each question's type class, select values, the
   position and element names of every case block, `case_references_data`,
   case types, case properties and index identifiers, lookup tags, fields and
   field properties, location type codes, worker-data slugs, multimedia paths,
   language codes, and menu and form order. On the local path, two `.ccz`
   exports of one unchanged document carry the same form `xmlns`, profile
   `uniqueid`, and a version no lower than the first. Differences are accepted
   only when `proof/identity-moves.json` names them.
2. **Build equivalence.** `build(A)` against `build(B)` for a publish with no
   edit, after B's module and form ids and `xmlns` are mapped to A's by proof
   1's positional alignment, so identity is judged once, by proof 1: both `validate_app()` results and every `create_all_files()` output,
   compared after the closed set of spelling rules. A form's version, and each
   resource version, may differ only where that form's or resource's content
   differs; HQ's own `set_form_versions` decides it, with `build(A)` as the
   previous build.
3. **Behavioral equivalence** wherever an artifact still differs, and between
   Nova's local `.ccz` and `build(A)` (decision 15): the Core runner's traces
   are identical for the same scripted sessions over the same case database,
   and HQ's case processing reads the same case blocks from both submissions.
4. **HQ editability.** Vellum opens and saves every form of B twice, and each
   app-manager page saves over it, leaving it unchanged up to the spelling
   rules. Where an editor's save changes B, the saved app is built and traced
   against B exactly as proofs 2 and 3 compare `build(A)` and `build(B)`, so a
   change is seen as a build failure, a build difference, or a behavior
   difference.
5. **Locality.** After an edit batch, every entity outside its footprint keeps
   its canonical digest, with ids mapped as in proof 2. The footprint is the entities the batch's mutations
   touch and every entity the reference index (`lib/doc`) says reads one of
   them; the digest is over the canonical bytes of that entity's emitted wire
   (its module or form JSON and its XForm source).

**Spelling rules.** `proof/rules/` holds the closed set. Each rule names the
artifact and the difference it erases (Vellum's added `<alert>` and
`requiredCondition`, attribute order, XPath whitespace, the order of `<update>`
children and their binds), and has its own test proving HQ's build output or
Core's trace does not depend on that difference. The comparators apply only
registered rules. Step 1 also registers the equivalent rewrites HQ's saves make
to spellings Nova emits today (defect 13's ref-bearing repeat group and absent
Connect `work_area_id`; defect 14's `case_preload`, `open_case.external_id`,
registration `update never`, `no_vellum`, the `calculate` column format, date
formats outside HQ's five, sort type `string` and blanks, field and
`sort_calculation` pairs, `custom_variables: null` and empty short case lists),
each proven equivalent by proof 3 before it is registered. Step 2 removes each
such rule when the emitter writes the editor's spelling.

### 12. Reproducing the defects

Each row below is one register class (decision 12). A defect with several
parts has a row for each part whose harm shows in a system the exit names; the
parts whose harm shows nowhere the harness runs are listed after the table and
are proven by step 2's own tests. Nova's behavior at `29294f6a` matches the
research for every defect here. "Proof 4, then 2" or "then 3" means the
editor-saved app is compared with B as proof 4 describes.

| Defect | Symptom the harness shows | Check | Input |
|---|---|---|---|
| 1, ids and `xmlns` | every module and form `unique_id` and form `xmlns` differs between A and B, so HQ gives every form a new version | proof 1 | any document, published twice |
| 1, local path | two `.ccz` exports carry different form `xmlns` | proof 1, local path | any document, exported twice |
| 1, language codes | adding a language whose code collides renames an existing language's code, and a build profile naming the old code then fails `create_all_files(profile)` ("Form does not contain any translations…", `xform.py::XForm.exclude_languages`) or drops the language | proof 1 over the edit; the bar on B with A's build profiles | a document with a language whose code the added one collides with |
| 2 | `validate_app` fails with "Expecting 'QNAME', got 'AT'" (`helpers/validators.py`, the form's `validate_for_build`) | the bar | a form display condition on the loaded case's status, id, type or owner |
| 3 | the data dictionary rows HQ's save writes (`refresh_data_dictionary_from_app`) lack the properties Nova's Save to Case blocks write, and a Vellum save rewrites `case_references_data.save`, after Vellum reports each `#case/<property>` as an unknown question | intent (HQ); proof 4 | a form with case operations, under a configuration with `save_to_case`, which HQ's refresh requires |
| 4, translations | an HQ-side UI translation override is gone from `app_strings.txt` after the next publish | proof 2 | A with an override saved through `views/apps.py::edit_app_ui_translations`, then B |
| 4, `auto_gps_capture` | the form's meta loses its location after the next publish (`xform.py::XForm._add_meta_2`) | proof 2 | A with the setting saved in HQ, then B |
| 5, table content | HQ's upload with `replace` sees a different `table_key`, deletes and re-creates the table, re-mints its row ids, and drops owners and row attributes | `_run_upload` on Postgres | an HQ table with field properties, row attributes, a description and owners, then Nova's workbook for its tag |
| 5, reserved substrings | a select over a table whose tag contains `casedb` reads the case database, and one containing `ledgerdb` the ledger database, not the table (`CommCareInstanceInitializer.generateRoot` tests `ledgerdb`, then `casedb`, before `fixture`) | intent (Core) | documents whose lookup-backed selects read such tables |
| 6, CSQL | HQ's compiler raises `CaseFilterError` for an ordering on a time property, and for `''` or a number compared with `date_opened`, `closed_on` or `last_modified` | intent (HQ): `build_filter_from_xpath` | documents whose searches order a time and blank-check `date_opened` |
| 6, Core | `'14:30' < '15:00'` is false on the device while the document orders it | intent (Core) | a form condition ordering two times |
| 7 | HQ's profile sets `cc-show-saved` and `cc-show-incomplete` to `no`; Nova's `.ccz` profile omits both, which Android reads as yes | proof 3 across the two paths (profile properties in the trace) | any document |
| 8 | a barcode or secret answer that breaks its authored validation is accepted (`FormEntryController.answerQuestion`) | intent (Core) | a form with validated barcode and secret questions |
| 9 | two `.ccz` exports of one document carry different profile `uniqueid`s, both at version 1, and Nova's profile declares no required CommCare version where HQ's does | proof 1, local path; proof 3 across the two paths | any document, exported twice |
| 10 | ID-mapping and select columns, and a list with no sort, give different row order on HQ's build and Nova's `.ccz` | proof 3 across the two paths, over a case database holding "10" and "2" | a case list with an ID-mapping column, a select column, and no sort |
| 12, related lookups | HQ's compiler raises without `CASE_SEARCH_RELATED_LOOKUPS` (`filter_dsl.py::_require_related_lookups_flag`) | intent (HQ) with the flag off | a search with a related-case filter |
| 12, custom tile | a Case List save under `CASE_LIST_TILE` alone drops the custom tile | proof 4 under that configuration, then 2 | a case list with a custom tile |
| 12, single-date prompt | a Case List save without `CASE_SEARCH_ADVANCED` drops the date input | proof 4 under that configuration, then 2 | a search with a single-date input |
| 12, same-type child | with `DONT_INDEX_SAME_CASETYPE` on, HQ's build drops the parent index of a basic child case of its menu's own case type (`xform.py`, guarding `add_index_ref`) | configuration sensitivity | a form creating such a child case |
| 13, shadows | the saved form's calculate, relevance or constraint holds a predicate on a form path, which Core's parser rejects, so HQ's build fails | proof 4, then 2 | a constraint over a repeat's rows |
| 13, guard blocks | the saved form loses each guard's case-id bind, and HQ's case processing refuses the empty id (`AbstractCaseDbCache.get`, "case_id must not be empty") | proof 4, then 3 | case-type, retype and text guards |
| 13, reserved names | Vellum reports each `__nova_` node as not a valid question id | proof 4 | any form with an emitted node |
| 13, wrapper conditions and leaf guards | the save drops an operation's condition and its case-leaf constraints, so the operation always runs and Core accepts a blank or over-long value | proof 4, then 3 | a conditional operation and a guarded case leaf |
| 13, datetime leaves | the save drops the leaf's type and HQ stores only the date | proof 4, then 3 | a datetime written to a case |
| 13, root create id | the save turns a live create id into a load-time value, and a later update fails ("Unable to update or close case", `CaseXmlParser`) | proof 4, then 3 | a create keyed by a form answer at the form root |
| 13, `#form/` defaults and block ids | Vellum marks a default that reads `#form/…` and a read of another block's `case/@case_id` as errors | proof 4 with the flag off | a default reading another answer; two blocks sharing a case id |
| 13, blank translations | the save fills an explicitly empty translation from the default language | proof 4, then 3 | a multilingual form with an empty translation |
| 14, non-writing follow-up | a Case Management save turns `update never` into `always` with a touch block, which HQ applies as an update | proof 4, then 3 | a follow-up form that writes nothing |
| 14, close conditions | the save strips an answer's surrounding quotes; an answer holding `'` builds unescaped, and Core rejects the built form or reads another condition | proof 4, then 3; the bar (Core admits it); intent (Core) | close conditions on those answers |
| 14, multi-select destinations | the form settings save refuses them, and HQ's build refuses the mismatch | proof 4; the bar | the destinations in a multi-select menu and under one |
| 14, search settings | a Case List save resets the search button label, refuses a lookup prompt without a sort, and refuses an input named like a default filter; HQ's search takes an input with a reserved name as configuration or a filter | proof 4; intent (HQ): Core's raw query parameters from a proof 3 session fed to `extract_search_request_config` | a labelled search, a lookup prompt, and inputs with those names |
| 14, survey menus | the module's case type is `''` where the document holds one | intent (HQ) | a menu of surveys that lists no cases |
| 14, tiles | the save writes a font size and places unplaced columns, changing the suite | proof 4, then 2 | a tile without sizes or positions |
| 14, data node name | Vellum's save rewrites the data node's `name`, which HQ reads as the submission's name | proof 4, then 3 | any form |
| 15 | Vellum rejects question ids with a leading underscore, a leading `XML`, or `meta`, and Connect ids of those forms; an entry-point id that is not a `slugify` fixed point fails the settings save under `SESSION_ENDPOINTS` (`views/utils.py::set_session_endpoint`) | proof 4 | such ids, and such entry points |
| 16, hidden columns | a case list search no longer matches a hidden column's values, because Nova drops the column (`EntitySortUtil.sortEntities`) | intent (Core) | a hidden column that sorts nothing |
| 20, sync on form entry | HQ's build adds a claim with no condition to the entry, and Core's session asks for a sync on a form entry (`CommCareSession.getNeededData`) | configuration sensitivity; proof 3 under the seam | a module that offers search |
| 20, CommTrack | HQ's build gives an advanced module's case list menu item a `product_id` datum, and gives a form whose source contains the session's `supply_point_id` path an autoselect datum whose assertion fails for a worker without one | configuration sensitivity; proof 3 under the seam | an HQ-built app with an advanced module whose case list menu item is on (decision 17); a Nova form whose label text contains that path |
| 21 | a Case List save where the Web Apps workflow selector shows turns list-first into search-first | proof 4, then 2 | a list-first module in an app with Web Apps on |
| 23 | HQ's build gives an attachment-mode write no attachment path without `MM_CASE_PROPERTIES`, and a Vellum save drops the Save to Case attachment | configuration sensitivity; proof 4 | an attachment-mode capture |
| 24 | a Case Management save turns the inert subcase's relationship from extension to child | proof 4, then 2 | an extension child case |
| 25 | a Vellum save rewrites a query repeat into model iteration, after which a nested one throws, one under a group that becomes relevant later stays empty, and one under a false condition gets rows | proof 4, then 3 | query repeats in those three places |
| 26 | the form settings save drops a hidden link beside a visible one and clears a navigation fallback its page does not offer, which changes the stack | proof 4, then 2 | those links and fallbacks |
| 27 | Vellum reports "Repeat Count is required." for a user repeat in a labelled group | proof 4 | a labelled group holding a user repeat |
| 30 | Core serializes a second `nova_count_<repeat>` node holding a hidden value's count, truncated where the count is fractional | intent (Core), over the submission | a repeat counted by a hidden value, and by a fractional expression |

The parts the harness does not observe, because their harm is in no system the
exit names: defect 4's `add_ons` (only HQ's app-manager pages read them); defect
5's "Upgrade Required" report and 32-character refusal (Nova's own); defect
12's inline search, multi-select case lists and `exclude`, which HQ's saves
keep without `CASE_SEARCH_ADVANCED` (the gate is in HQ's editor alone), and its
`VIEW_FORM_ATTACHMENT` over-requirement (a Nova publish check); defect 14's
logos (a linked-app pull) and `both_fixtures` (saves keep it); defect 16's
comments, dead code, copy and media slots; defect 24's export columns; and
defect 30's export column. Defect 15's harm in Connect is Connect's. Defect
13's and 14's equivalent spellings are spelling rules, not defects (work item
11).

### 13. CI

- `quality` gains the pins check (decision 4).
- A `surface` job pulls the pinned image, regenerates the surface, and fails on
  any difference from the committed `surface.json`.
- A `proof` matrix runs the proof lane in shards, with a Postgres service for
  the lookup check and a `proofs-gate` fan-in, and uploads each shard's traces
  and difference sets as artifacts.
- The manifest test runs in the ordinary test shards.

### 14. Documentation

- `proof/README.md`: how to run, select, and read a check's failure, and how to
  add a corpus document, a spelling rule, a register entry, or a pin change.
- `docs/testing.md`: the native-proof paragraphs point at the harness and the
  proof lane in place of manual commands.
- Root `CLAUDE.md`: `proof/` in the map, and `npm run proof` and `npm run
  surface` in the commands.
- `lib/commcare/CLAUDE.md`: the paragraphs about
  `config/commcare-hq-feature-flags.json` and the weekly workflow describe the
  manifest, its gate entries and the weekly pin pull request.

## Contracts

- `contracts.md`: "Smart-link authoring does not ship before Nova models
  data-registry search." becomes "Smart links belong to data registries, which
  are retiring, so they never ship." (the research's contracts table, step 1).
- `lib/commcare/CLAUDE.md`, as in work item 14.

## Pull requests

One stack (`gh stack`), merged together:

1. Pins, image, boot, seams, Core runner, editor driver, the moved native
   proofs, and the proof lane in CI (work items 1 to 5, 13).
2. The surface extractor, the manifest and its test, the probe reading gate
   entries, the deletions, and the weekly pin pull request (work items 6 to 9).
3. The corpus, the checks with the spelling rules, and the known-defect
   register with its controls and targeted documents (work items 10 to 12),
   together, so the proof lane is green at every pull request of the stack.
4. The documentation (work item 14).

## Tests and the boundaries they earn

| Contract | Plausible failure | Boundary |
|---|---|---|
| The boot is offline and pinned | a socket other than the lane's Postgres, or a network cache, reached; the wrong commit | the image self-test, which attempts each and inspects each checkout's commit |
| HQ's state is complete | a path reaches a table or a Couch view the harness lacks | by construction: Postgres refuses a missing relation and the in-memory Couch raises on an unanswered view, and every check runs every path it uses |
| A seam changes only what it names | a seam leaks into another check | each seam is a context owned by its test; a test runs two checks in sequence and compares the recorded flag reads |
| The harness publishes as Nova does | bodies that differ from what Nova sends | the bodies are captured from `importApp` itself, and a test compares one capture with the upload Nova's publish tests already decode |
| The Core runner's traces are faithful | a trace that omits a difference | a negative control: a corpus document with one answer path altered must give a different trace |
| Proof 2 compares everything HQ builds | a file left out of the comparison | the comparison enumerates `create_all_files()` output and fails on any file it has no comparator for |
| Each spelling rule is sound | a rule that hides a real difference | the rule's own test builds both spellings and asserts identical output or traces |
| The register is strict | a fixed defect left listed, or a new failure absorbed | the lane's own check over the register, plus a control that removes one entry and must fail |
| The editor driver saves as HQ does | a page rendered without HQ's template gates | a control: a Case List save of a single-date input with `CASE_SEARCH_ADVANCED` on keeps the input, and with it off drops it |
| The manifest names only what exists | a dangling key or gate | `manifest.test.ts` in ordinary CI |
| Nothing Nova emits is unclassified | an export using an item no entry names, or HQ reading a flag no gate entry names | the manifest checks in the proof lane (work item 11) |
| The surface matches the pins | a hand edit or a stale regeneration | the `surface` job |
| The weekly pin pull request reports every outcome once | a pull request with no upstream change, a second pull request, one that never runs CI, pins committed without their image, or a failed run that reports nothing | the workflow's script run with controlled `git`, `gh` and image-build executables, as `docs/testing.md` asks of authored build scripts: an unchanged head does nothing; a changed one commits the pins, lock and surface together, updates the one open pull request and dispatches CI; a failing image build still updates that pull request with the failed step |
| The probe did not change | a gate slug or namespace read wrongly | the existing probe tests, unchanged |

## Exit

- `reconcile-surface-inventory.ts` reports every counted inventory row as
  exactly one entry with the same disposition, and its output is recorded in
  the pull request.
- The `surface` job passes at the pins.
- The proof lane passes, and `proof/known-defects.json` holds an entry for
  every row of work item 12's table (defects 1 to 10, 12 to 16, 20, 21, 23 to
  27 and 30), each reproducing its symptom on its control.
- Every kept native proof runs in the proof lane.

## What step 2 inherits

The harness, the registers, the controls and the spelling rules for today's
spellings. Step 2 is planned in full once this step exits: each of its fixes
removes that defect's register entries and any spelling rule it makes
unnecessary, adds its decided identity moves to `identity-moves.json`, and
proves on the defect's control that the check still sees the symptom there.
