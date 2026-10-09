# The proof harness

The proof lane holds Nova's exports to the code that reads them. CommCare HQ's
own import, build, case processing, app editors, receiver, restore, search
views and Connect repeater, CommCare Core's own form engine, session engine
and archive installer, Formplayer's own application, HQ's own Web Apps
client and CommCare Connect's own server run at the upstream commits
`proof/pins.json` names, inside one pinned image, over a corpus of admitted
Nova documents that Nova's real publish client and compilers export; and
CommCare Android's own application, installers, activities and views read
every archive a device installs of each document, in a stage of their own
after the image's ("The Android stage"). Every pull request runs the lane in
CI (`.github/workflows/ci.yml`), and `npm run proof` runs it on your machine.

Each check reports the complete set of differences it finds, never only the
first. The lane passes when every difference is erased by a proven spelling
rule or held by an entry of the known-defect register, and every register
entry still shows its symptom on its document and on its control. So a new
failure fails CI, and so does a fixed defect whose entry is left behind.

`proof/CLAUDE.md` holds the rules every change to the harness keeps, each with
its reason. This document says what the lane proves, how to run it and read
what it reports, how to extend it, and how each part works.

## What the lane proves

### A, B and B-edit

For each corpus document D, under each configuration it is checked under, the
lane publishes D into a fresh HQ project space the way Nova's publish does.
The request bodies are the ones Nova's own client sends (the lookup workbook,
`lib/commcare/hq/lookupTables.ts::uploadLookupTableWorkbook`; the app,
`lib/commcare/client.ts::importApp`; then its media, `uploadAppMediaBundle`),
captured from a loopback peer when the corpus is emitted
(`proof/corpus/publish.ts`), and HQ applies them with its own code: the
workbook through its lookup upload
(`fixtures/upload/run_upload.py::_run_upload`), the app and its media through
its own views (`app_import_api.py::_handle_import_app` and
`_handle_upload_multimedia`) called with Django's `RequestFactory`
(`proof/observe/publish.py`):

- **A** is what Nova's first publish of D leaves in HQ, and what a person
  then saves there, where the document carries it (`hq-side.json`): UI
  translations, app settings, build profiles, and a lookup table kept with a
  field property, row attributes, owners and a description, each saved
  through the HQ view a person's page or upload reaches, before A is built
  (`proof/observe/hqside.py`);
- **B** is what Nova's next publish of D leaves over A;
- **B-edit** is what Nova's publish of D′ leaves over A, where D′ is D after
  the document's edit batch.

HQ builds each state (`validate_app()`, `create_all_files()` and
`create_all_files(build_profile_id)` for every build profile). B and B-edit
are built with HQ's saved copy of `build(A)` as the previous build, so HQ's
own `set_form_versions` decides each form's version. Beside them, Nova's local
`.ccz` is exported twice for D (`local.ccz`, `local-again.ccz`) and once for
D′.

### The bar

On every export (`proof/checks/bar.py`):

- HQ accepts each of Nova's uploads, each lookup workbook Nova's push sends
  before them, and maps every file of the media upload after them;
- `validate_app()` returns no error and raises nothing, and
  `create_all_files()` and every build profile's
  `create_all_files(build_profile_id)` succeed, for A, B and B-edit;
- the Core runner admits HQ's build of each state (arranged as HQ's archive
  download arranges it) and each of Nova's local archives, parsing the suite,
  the profile, the app strings and every form;
- every soft assertion HQ notes while it publishes and builds is a difference.
  HQ notes them and goes on, as production does (`proof/hq/boot.py`), so what
  would have raised under a test boot is evidence the register classifies.

### Intent checks

A comparison cannot see a defect both sides share, such as a display condition
HQ cannot build or a validation Nova drops from every export. So the intent
check (`proof/checks/intent.py`) holds what HQ builds and what Core runs to
what the Nova document states, read from `document.json` and never from Nova's
emitter or evaluator. On every document the checks are structural: each
module's case type, the case properties HQ learns each form writes
(`FormBase.get_all_case_updates`), the data dictionary rows HQ's save writes,
each attachment path, the profile's required version and settings, and on
Core's side each case a form creates, each property it writes and each
validation Core holds at its node, in HQ's builds and in the local archives.
On a targeted document the value-level checks run too: each expectation in its
`expected.json` names an export, a form, a request Core's `evaluate` runs
there (answers, constraint checks, expressions, instances, a session and a
restore) and the values Core must give, fixed by hand from the document's
authored meaning. On HQ's side the check also compiles every CSQL string a
run sends HQ (each literal `_xpath_query` of build(A)'s suite and each one
proof 3's sessions send) with HQ's case search compiler under the
configuration's flags, and reports each it refuses by the exception and
where HQ raised it (`csql@A`).

### Manifest checks

A surface item no manifest entry names is refused wherever an app uses it
(`lib/commcare/CLAUDE.md`, "The surface manifest"). The manifest check
(`proof/checks/manifest_usage.py`) holds Nova's own exports to that: every
surface item an export uses, read from its parsed artifacts by the reader the
surface records for it (a schema field at a value other than HQ's default, a
format, a question type, an XPath function or grammar, a parser element or
attribute, an appearance token, a setting, a hashtag, CSQL), must be held by
an inventory entry, and every flag HQ reads while it builds the export must
have a gate entry. Where entries split an item by value class, a use is held
only by the entry whose class takes it
(`proof/checks/manifest_value_classes.py`, which reads each use where it sits
in the export by the rule the entry's row states): a use a REFUSED class takes
is refused under that class's name, and a use the check cannot place in or out
of a REFUSED class is undecided, a gap in the check that a value-class reader
closes and that the register refuses to hold.

An allowing class is what its row describes and is never read: it holds the
rest of its item's values, every use no REFUSED class takes, so a value is a
use only where a reader of it reads it (an appearance token only on the
elements whose appearance that reader compares). A REFUSED class refused only
because HQ's build refuses its state is the bar's, which reports every export
HQ cannot build. In Nova's own local archives, which runtimes read and no
editor does, a REFUSED class refuses only for what a runtime does: a use a
class refused for how HQ's editors treat the source takes is judged on the app
JSON that carries it, and a use no class takes (what HQ's build adds to the
source) needs an allowing entry like any other. Each standing is its own
symptom, named in the difference's path after the surface key: `/<key>` (no
entry names it), `/<key>/refused/<value class>`,
`/<key>/undecided/<value class>` and `/<key>/unheld` (every entry naming the
key rules the use out). A REFUSED class whose uses are two defects' names the
part a use is after its class (`/<key>/refused/<value class>/<part>`,
`manifest_value_classes.py::VARIANTS`): Nova's scaffolding nodes by their
name, apart from the ids a person authors.

Protected custom validation messages are one derived wire class, read from the
artifact after its recorded Core parse and HQ XPath structure are installed.
The classifier requires the expression's outer media choice to name the same
base itext group as an exact empty, irrelevant, readonly sibling input's sole
label. Every translation must carry the finite identity, locale, mode and
ASCII JSON piece forms with their expected payloads and output-form suffixes.
Piece ordinals can be noncontiguous, localized pieces can be blank, media forms
can be absent, and the typed composition can contain any supported XPath.
Its functions and grammar are still classified from the recorded Core parse.
Only owned helper forms lose their unknown-form use; their ordinary generic
`value@form` use remains. A prefix alone, an unrelated group, a raw message,
or any other readonly bind receives the existing refusal. Missing readings
cannot establish ownership.

The export-use rows cite the accepting owners: Core's
`XFormParser.parseTextHandle` registers named forms, `Constraint` evaluates the
message, `FormDef.initEvalContext` selects output-form keys, and
`XPathJsonPropertyFunc` decodes pieces. Vellum's `javaRosa/plugin.js` loads and
writes arbitrary forms, preserves the raw message, and retains the group through
the technical label; `parser.js::parseBindElement` and `writer.js::getBindList`
preserve readonly. HQ's `ItextNodeGroup` equality includes the identity form,
preventing `XForm.normalize_itext` from merging groups while rewriting only
direct base references. The generated inventory, upstream pins and known-defect
register do not change for this classification.

### Configuration sensitivity

Each document's A is built again once for each gate HQ read while building it,
with that gate flipped and everything else as it was: each feature flag HQ
read, and each project-space setting it read (CommTrack, sync cases on form
entry, the flat location fixture). Every difference from the plain build must
be named in that gate entry's `effects` (an artifact and a structural path,
the register's vocabulary) or fall in a register class
(`proof/checks/sensitivity.py`). A flip to a configuration Nova's publish
refuses is still built, since a gate's effects are what HQ's build changes,
and its differences are held to the gate's effects alone. The flips are built,
never run: no session runs over a flipped build.

```bash
python3 -m proof.checks.sensitivity effects <output>/blocks/* --corpus <corpus>
```

writes every gate entry's effects (into
`lib/commcare/surface/entries/gates.json`, or the file `--out` names) from the
evidence of one whole run over a whole corpus, for review in the pull request
that changes them. It reads only each named block directory's
`checks/sensitivity/`, and a group the queue cached runs nowhere and writes
none, so the run must be one that reused no stored judgment: a local
`npm run proof` with no `PROOF_STORE`, or `proof-lane.yml`'s fresh run. Name
every block of it (of every shard, for `proof-lane.yml`), and the corpus it
read: `<output>/corpus` where the run emitted it, or the directory
`PROOF_CORPUS` named.

### Proofs 1 to 5

1. **Identity** (`proof/checks/proof1.py`). Every identity in the research's
   "External identity" table is equal between A and B, and, after an edit
   batch, for every entity outside the batch's footprint: the app id, each
   module's and form's `unique_id`, each form's `xmlns`, session endpoint ids,
   the session datum ids form logic reads, every answer leaf's data path and
   repeat, question order and type class, select values, case block positions,
   `case_references_data`, case types, properties and index identifiers,
   each lookup table by its tag (its id and description, its fields and their
   properties, its row attributes, and each row in the table's order with its
   id, attributes and owners), location type codes, worker-data slugs, media
   paths, language codes, and menu and form order. On the local path, two
   `.ccz` exports of one document carry the same form `xmlns` and profile
   `uniqueid`, and a version no lower than the first. Only a difference
   `proof/identity-moves.json` names is accepted.
2. **Build equivalence** (`proof/checks/proof2.py`). `build(A)` against the
   build of B after B's module and form ids and `xmlns` are mapped to A's by
   position, so identity is judged once, by proof 1: both `validate_app()`
   results and every file every `create_all_files()` writes, each parsed by
   its comparator (one that has none refuses the file), after the spelling
   rules. A form's or resource's version may differ only where its content
   does. A build profile's build is the app's kept to the profile's
   languages, so a difference its file shows as the main build's same file
   does is reported once, on the main build.
3. **Behavioral equivalence** (`proof/checks/proof3.py`). The Core runner's
   scripted sessions, derived once on `build(A)` (every menu command, every
   reachable form with the first case of each list), replay over the
   document's case database on Nova's local archive always, and on B's aligned
   build wherever proof 2 still finds a difference. The traces are compared,
   a case list's rows by the case each selects, a submission's version
   between A's and B's builds under proof 2's version clause, and so is HQ's case
   processing of every submission, read as HQ applies it (case by case, each
   case's blocks where the form holds them, a block with an empty case id by
   the action HQ applies it at), and each language's app strings as Core
   reads them (over the default file's). Formplayer's sessions are compared
   the same way, each state served to it by HQ's own views ("Served
   states"): Nova's local archive against A always, and B's aligned build
   against A wherever proof 2 still finds a difference, with the Web Apps
   client's screens on it; and every request HQ's views refuse while
   Formplayer walks A is a difference of its own. For a Connect app, HQ
   forwards each state's submissions to one opportunity in CommCare Connect
   ("Connect in the unit"), and what Connect made of them is compared the
   same way: the local archive's and B's against A's, and what stands on
   its own at A (a payload Connect did not take, a visit rejected for the
   task its own form completes).
4. **HQ editability** (`proof/checks/proof4.py`). Over B and over B-edit,
   under each configuration: every app-manager section HQ offers is saved the
   way a person saves it without changing a value (app settings, add-ons, UI
   translations; each module's settings, case list with its case search, and
   case detail; each form's settings, case management and user properties),
   and every form is opened and saved twice in HQ's vendored Vellum, the
   second time over what the first left. Each save is made in a fork of B and
   judged against B (the second Vellum save against the first's result): the
   editor's own report, the stored app, then, where the stored app changed,
   its build against B's as proof 2 compares builds, and, where that still
   differs, its sessions against B's as proof 3 compares them. Where the
   build differs, or what HQ's Web Apps page hands the client of the app
   does, the saved app is served too, and Formplayer's sessions and the
   client's screens on it are compared with B's, and for a Connect app so
   is what Connect made of its submissions. So a change shows as a build
   failure, a build difference or a behavior difference, in Core, in
   Formplayer, in the client or in Connect. For a Connect app, what Connect
   makes of B's and of B-edit's own submissions is also held to the
   opportunity it made from A: a payload it no longer takes, and a Connect
   id that moved under it.
5. **Locality** (`proof/checks/proof5.py`). After an edit batch, every entity
   outside its footprint keeps the canonical digest of its emitted wire: its
   module or form JSON and XForm source in the upload, and its form, suite
   part and app strings in the local archive, each suite element placed by
   Core's parse of the archive. A suite element no runtime reads (no menu,
   endpoint, datum or stack step reaches it) is its entity's where the other
   archive names the same element and an entity at that position owns it;
   any other is compared as one record with its own names read out, inside
   the footprint where the footprint reaches the app or holds every module.
   The footprint (`proof/corpus/footprint.ts`) is the entities the batch's
   mutations touch, every entity the reference index says reads one of them,
   and every entity whose wire Nova derives from what the batch edits.

### Spelling rules and the registers

A spelling rule erases one difference in how an artifact is spelled that no
reader of it depends on, and tests prove that by running both spellings on
every one of those readers: HQ's build, Core, Formplayer, the Web Apps
client, Connect and CommCare Android ("Spelling rules", below). Every other
difference is a symptom: it is held by an entry of the known-defect register
or it fails the lane ("The registers", below).

### What the lane does not observe

- **What the Android stage does not show.** CommCare Android's own code
  reads every archive a device installs of every document, and proofs 1, 3
  and 4 judge what it read ("The Android stage", below), with these left
  out. A device's own sensors and services are not run: no location fix
  reaches a form (`PollSensorAction` asks the device's location service;
  the permission a form asks the device for is recorded, `deviceAsked`, and
  not granted), so a Connect visit's location on Android is still written
  by the harness into Core's submission; and no file is given to an image, audio, video,
  signature or document question, so a walk leaves one unanswered and ends
  at one that is required. Neither is out of reach: Robolectric's own
  location manager can hand Android's `PollSensorAction` a fix through the
  device's own permission grant, and its activity results can hand a
  question's capture a file, so what settles both is the reader granting
  them as a worker's device does, and Connect then receiving the form the
  device saved in place of Core's with the harness's fix (a stage after
  Android's, since Connect runs in the shards today). Nothing is sent: a form is saved and applied to
  the device's own case database; where a device would post it is read by
  Android's own reader (`FormSubmissionHelper.getFormPostURL`), and nothing
  is posted there. A search is answered
  with every case of the asked types the device holds, so what a search's
  filter selects is not read (as on Formplayer). Robolectric lays views out
  and does not draw them: a cell's class, text, gravity, text size, scale
  type and width are read, and no rendered picture or played sound. Not run:
  a language other than the one the app starts in, a tablet's two-pane
  layout, and the rows of a case detail tab that lists a row a node. The
  stage reads the archives of the states HQ releases: a document whose build
  of A HQ's validation refuses has no Android reading, as it has no
  Formplayer one.
- **What a served state does not show.** Formplayer and the Web Apps
  client read every state the lane builds ("Served states", below), with
  these left out. HQ reads a restore's cases with no order of its
  own, so the order is its database's; the harness hands them in the order
  of their ids in every state (`proof/formplayer/hq.py::cases_in_id_order`),
  and what order a production database gives is not observed. The worker's
  sign-in form is not run (the session is Django's own `login`). Not run in
  the client: a language other than the worker's default, a small screen's
  layout, App Preview (the same client under another HQ page), and a web
  user signing in as a worker. The one request the page makes that nothing
  answers is for a web font on another host, so text is laid out in the
  browser's fallback face and no measured width or height is recorded. The
  client walks every run of the walk whole ("The Web Apps driver"), and
  answers each question through the widget it draws for it; it draws no
  widget a worker can answer with a typed value for a map (a geopoint, where
  the page has no map provider), a file, a signature or a question it does
  not support, and such an answer is recorded as `unanswerable`, as a
  worker could not give it either.
- **What Connect in the unit does not show.** Every Connect document's
  submissions are forwarded to Connect in its unit ("Connect in the unit",
  below), with these left out. ConnectID, the service Connect sends a
  worker's notifications through, is not in the lane: each notification
  task Connect queues is run up to that request, which is recorded and
  fails as a connection that could not be made. A device's location fix,
  which only CommCare Android writes (`PollSensorAction`), is written into
  each of Core's submissions where the form holds its node; where a device
  posts a form of an archive that names no address is Android's own default
  and is not run (the lane posts it to the project space's receiver with no
  app named). The opportunity's own rows (its worker, payment unit, claim
  and assigned tasks) are made through Connect's models, and HQ's Connect
  repeater and its connection settings through HQ's models, holding what
  HQ's pages save for a forwarder to Connect, not through either system's
  pages (HQ's Add Forwarder page lists the project space's users from
  Elasticsearch). The opportunity is made once, from A's release: a
  manager who asks for its units again after an edit, or pays for a renamed
  unit, is not in the unit (`proof/connect/test_receiver.py` runs both), and
  neither is the distance check between two visits. HQ's Connect payload
  carries no attachments, so Connect's download of a visit's attachments
  runs and asks HQ for nothing.
- **A configuration Nova's publish refuses is not checked** (decision 19).
  Each document's configurations hold the flags and case search Nova's
  publish requires for it, so a symptom that shows only where Nova refuses to
  publish reaches no one and is not a defect: defect 23 without
  `MM_CASE_PROPERTIES` is one. Configuration sensitivity alone still builds a
  flip into such a configuration, since a gate's effects are what HQ's build
  changes wherever that is, and holds its differences to the gate's effects,
  never to the register.
- **Not yet run, and nothing stands in the way but the work.** Each names
  the reader that would settle it:
  - defect 12's `VIEW_FORM_ATTACHMENT` over-requirement: HQ's attachment
    view (`reports/views.py::_can_view_form_attachment`) opened by a person
    with and without the Submission History permission, with the flag on
    and off;
  - defect 14's logos on a linked-app pull
    (`models/applications.py::LinkedApplication.reapply_overrides` over a
    master holding Nova's `logo_refs`);
  - defect 16's comments, dead code and copy, and its media slots (hint,
    group label and validation message media on Android, Formplayer and
    the client);
  - defect 24's and defect 30's export columns (HQ's form and case export
    over each path's submission; `proof/hq/test_report_retention.py` already
    runs HQ's export writer over saved forms);
  - a CSQL string a search builds from a prompt's answer. Every search of
    every document is sent, by Core's sessions and by Formplayer's walk, with
    its prompts as the app leaves them, and HQ's own search view answers
    Formplayer's (its request reading and its compiler run whole over the
    session's own parameters, "Served states"); no walk types an answer
    into a prompt, so the strings an answer would build are compiled only
    for the native families' own apps (`quote`, `function`, `prompt`).
- **Defect 20's `product_id` datum** needs an advanced module, and no Nova
  document holds one: the manifest check reads every export for the surface
  it uses and holds no use of an advanced module's fields.

What the earlier text of this section listed as harm in no system the lane
runs, or as inputs Nova cannot produce, is now run or proven, each where it
is held:

| What | Held by | What it shows |
| --- | --- | --- |
| Defect 3's unknown-question clause | `targeted-save-to-case-read`, proof 4 | Vellum warns "Unknown question" on a read of a property only a Save to Case block writes, and not on the same read of a property an ordinary field writes |
| Defect 4's add-ons | `proof/views/test_add_ons.py` | an add-on a person turned on in HQ is offered by HQ's module page, and gone from it after Nova's next publish |
| Defect 5's "Upgrade Required" answer | `proof/views/test_lookup_upload.py`, and `proof/views/__tests__/lookupUploadAnswer.test.ts` for Nova's side | without the Lookup Tables privilege, HQ's upload API answers Nova's own push with its HTML upgrade page and HTTP status 200, and writes no table; handed an answer of that status and type, Nova's own client reports an upload that may have landed |
| Defect 5's 32-character tag | `proof/views/test_lookup_upload.py` | HQ's upload takes a 32-character tag and answers a 33-character one with a 500 (a database error; it checks no length) |
| Defect 12's inline search, multi-select lists and `exclude` | `proof/views/test_case_list_offers.py` | HQ stores each without `CASE_SEARCH_ADVANCED`, and its Case List page holds the control for each only under the flag |
| Defect 14's `both_fixtures` | `proof/views/test_location_fixture.py` | a device, which restores at the address that names the app, gets the flat fixture whatever the project space says; Web Apps, whose restore names no app, gets it only where the project space syncs it (finding 69) |
| "12, same-type child" | `proof/targeted/__tests__/unproducedInputs.test.ts` | Nova's gate admits a case type that is its own parent, and a write of the menu's own type from its own menu exports no `subcases` action: there is no such child case to index |
| "20, CommTrack" | `targeted-supply-point-read`, the manifest check and proof 4; the same vitest file | Nova's gate admits a read of the session's supply point (finding 68) |
| The form validation HQ asks Formplayer for | every unit's seams (`proof/hq/seams.py::formplayer_validation`), `proof/formplayer/test_validation.py` | every form every build of every document sends is validated by Formplayer's own controller, sent the headers and the digest HQ wrote; the same form HQ signs with another key is refused |
| What Formplayer's and the client's own tests read of HQ | `proof/formplayer/test_*.py`, `proof/webapps/test_*.py` | HQ's own views answer every request Formplayer makes, over a worker HQ made, cases its receiver saved and a build it released; the states a save leaves are saved by HQ's own pages and views |

Step 1's exit asks the register for an entry for every row of its defect table
("The defect rows", below). Every row now has entries that reproduce on their
controls or a test of `proof/views` that runs HQ's own page or view; the one
row that has neither, "12, same-type child", is an input no Nova document
holds, which a test of Nova's planner and gate shows.

## Running the lane

### What you need

Docker, and the image `proof/image.lock` records (pulled on the first run), or
a local build named by `PROOF_IMAGE` ("Building the image", below). The first
run on a machine also fills a Docker volume with Nova's dependencies for Linux
(`npm ci` inside the image, once per `package-lock.json`), since a macOS
checkout's native binaries cannot run in the container; on Linux a checkout's
own install is used in place. HQ's state lives in a Postgres the run starts
beside the image and removes when it ends (`proof/compose.yaml`).

### Selecting what runs

```bash
npm run proof                                           # the whole harness
npm run proof -- proof/checks/test_bar.py               # one check over every document
npm run proof -- proof/checks -k targeted-time-ordering # every check of one document
npm run proof -- proof/native                           # the native proofs
npm run proof -- proof/connect                          # the Connect proof
npm run proof -- proof/views                            # HQ's own pages and views over Nova's exports
npm run proof -- --workers 4 proof/checks               # four forked workers
npm run proof -- --bin 2/4                              # bin 2 of 4 of the collected groups
```

Everything after `--` but `--workers k` and `--bin i/n` is pytest's
(`proof/pytest.ini`), and a path in this checkout is rewritten to the same
path under `/work` in the container. With no path the whole of `proof/` runs.
Inside the image one fork server (`python -m proof.lane.serve`) boots HQ once,
restores HQ's migrated database as a template, compiles the Core runner, warms
HQ and forks `k` pytest workers (1 by default), each with its own database
clone, Core runner JVM and editor driver. The items of one corpus document are
one group and run together on one worker, so the document's records are
observed once for all its checks.

With no corpus named, the run emits one into its output first
(`proof/checks/corpus.py::emit_corpus`, inside the image), at the default seed
and fuzz sample (`proof/corpus/defaults.ts`).

### Where a run writes

Each run writes into a directory of its own under `.proof/runs/`, and
`.proof/out` links to the latest. A run removes only earlier runs whose
process has ended, so two runs in one checkout never remove each other's
output. `PROOF_OUT_DIR` names another directory, which must be new or empty.
In it:

- `serve.json`: the run's fixed costs, forks, phases, claims, workers and
  every problem;
- `queue.json`: the queue the run made of what it collected, all of it one
  block it claims itself (with `--bin`, a block per group);
- `blocks/<id>/block.json`: each group's items, outcomes and seconds, and why
  a group failed when its worker could not finish it;
- `blocks/<id>/checks/<check>/corpus-<id>.json` and `control-<id>.json`: each
  check's evidence, the complete set of its differences on that document;
- `blocks/<id>/native/`: the native proofs' artifacts ("What each run leaves",
  below);
- `workers/w<n>.log` and `workers/w<n>/`: each worker's output;
- `timings/`: each group's seconds per worker, which
  `node proof/run.mjs --timings <output>...` turns into `proof/timings.json`;
- `blocks/<id>/connect-unit/`: the logs of the Connect runtime a Connect
  document's observation started (its fetch, its services, its migrations
  and each served session);
- `store/`: what the run observed for the evidence store, and `audit/`, any
  record the audit sample observed differently from the store;
- `corpus/`: the corpus the run emitted, and `corpus.log`.

`python3 -m proof.lane.gate .proof/out` holds a finished run to the lane's
verdict, as CI's gate does ("The gate", below).

### The switches run.mjs passes

`run.mjs` reads these on your machine, each only when set:

| Variable | What it does |
| --- | --- |
| `PROOF_IMAGE` | The image to run instead of the one `proof/image.lock` records. |
| `PROOF_OUT_DIR` | The run's output directory, new or empty, instead of one under `.proof/runs`. |
| `PROOF_CORPUS` | A corpus directory on your machine (one `proof/corpus/emit.ts` wrote), mounted read-only at `/corpus` and read instead of emitting one; the container sees `PROOF_CORPUS=/corpus`. |
| `PROOF_STORE` | An evidence store snapshot directory to read records and judgments from, mounted read-only at `/store`; the container sees `PROOF_STORE=/store`. Without one the run reads nothing from the store and still writes what it observed into its output. |
| `PROOF_SURFACE_EXTRACTION` | A surface extraction `npm run surface` left in `.proof/surface`, mounted read-only at `/surface-extraction`, which the surface tests read instead of extracting again when its key is the run's. |

It passes these into the container unchanged, each only when set:

| Variable | What it does |
| --- | --- |
| `PROOF_CORPUS_SAMPLE`, `PROOF_CORPUS_SEED` | The fuzz sample's size and the corpus seed, for a corpus the run emits. |
| `PROOF_HQ_SPEED=0` | HQ without its speed seams (`proof/hq/speed.py`), to compare. |
| `PROOF_HQ_DETERMINISM=0` | HQ's entropy and clock left real (`proof/hq/determinism.py`), to compare. The tests marked `under_determinism` are skipped, and the store holds two records of one key to each other with their drawn values masked. |
| `PROOF_VERIFY_MEMOS=1` | Every memo, kept build and kept trace computed again on every hit and held to the kept answer. |
| `PROOF_EDITOR_AUDIT=<fraction>` | That fraction of editor views and Vellum runs rerun on a fresh page and held to the reused one (CI uses `0.03`). |
| `PROOF_BRANCH_DOCUMENTS` | Which corpus documents the HQ branch proofs hold to fresh states (`proof/hq/test_branches.py`; `all` for every one that carries an edit). Each document's branch items run in that document's group, so shards share them. |

Nothing else of your machine's environment reaches the harness. The
container's environment is otherwise the image's and `proof/compose.yaml`'s
(the Postgres host, `PROOF_OUT=/out`, `PYTHONHASHSEED=0`, `TZ=UTC`), with
what `run.mjs` computes: `PROOF_IMAGE_ID`
(the image's content-addressed id) and `PROOF_FINGERPRINTS`
(`python3 -m proof.store.fingerprints`, computed on your machine), which key
the surface extraction and the evidence store. Where `python3` or `git` cannot
compute the fingerprints, the run says so and keeps the store off.

### Regenerating the surface

```bash
npm run surface
```

extracts the surface in the image with no network
(`python -m proof.lane.extraction`), writes
`lib/commcare/surface/surface.json`, and leaves the extraction, its timings
and its key in `.proof/surface`, where `PROOF_SURFACE_EXTRACTION` can name it.
Commit the regenerated file with the change that moved it: CI's gate fails
while the committed surface is not byte for byte the extraction at the pins.

### Building the image

From the repository root:

```bash
docker build $(node proof/image/build-args.mjs) -f proof/image/Dockerfile -t nova-proof:dev .
PROOF_IMAGE=nova-proof:dev npm run proof
```

`proof/image/build-args.mjs` turns `proof/pins.json`, `.nvmrc` and
`package.json` into the build arguments, so a local build and the image
workflow build from the same inputs. The default target is `slim`, the image
every run pulls; `--target full` builds everything the stages install, which
the image workflow compares with it. The image holds HQ at its pin with its
submodules and a virtualenv from HQ's own `uv.lock`, HQ's database schema as
HQ's migrations leave it (`/opt/hq-schema/hq.sql`), JDK 17 and Gradle with
Core compiled at its pin and its test classpath recorded, Formplayer at its
pin with the Core it vendors, its boot jar built by its own Gradle build and
unpacked with its classpath recorded (`/opt/formplayer`,
`/opt/formplayer-app`), a `redis-server` for it, the Android sources
at their pin, the HQ pin's commit time (`/opt/hq-pin-time`, HQ's clock), node,
Playwright's Chromium (the slim image keeps only the headless shell every
launch runs), the page bundles built from HQ's node packages
(`/opt/editors`: the editor pages' and the Web Apps page's), HQ's node
packages themselves where HQ finds them (`/opt/hq/node_modules`: HQ's XPath
validator reads two, and HQ's static finders and stylesheet precompiler the
rest for the Web Apps page), and the `sass` that precompiler runs, among the
image's own Node tools. It holds only public, licensed upstream sources and
the harness's own code; Nova's checkout is mounted at run time. The Android
reader's runtime is not in it (`proof/android/README.md`): Robolectric's
native runtime has no linux/arm64 build, and the runtime holds SDK-derived
and Google libraries, so the Android stage builds its runtime from the pins
on linux/amd64 (`proof/android/build-runtime.sh`) and keeps it in the
repository's Actions cache, and nothing the image builds reaches it. What of
`proof/android` the lane's own tests import (the stage's logic, held with a
stand-in reader) is standard library alone. Connect's checkout carries no
license file, so none of Connect's source is in the image: the Connect proofs
fetch it at its pin when they run (`proof/connect/checkout.py`). The image
holds what Connect runs on (the `full` stage): Python 3.11, a virtualenv from
Connect's own lock at its pin (`/opt/connect-venv`, the environment
Connect's own tests run in), the libraries Connect's Dockerfile installs for
GeoDjango, and the two services its `docker-compose.yml` starts, Postgres 15
with PostGIS and Redis, which a Connect proof starts as its own processes.

The Connect runtime is its own stage over everything else, so it can be built
over an image this recipe already made, in about a minute:

```bash
docker build $(node proof/image/build-args.mjs) --build-arg FULL_BASE=<image> \
  --target full -f proof/image/Dockerfile -t nova-proof:dev .
```

Vellum is not pinned on its own: the harness runs the build HQ vendors at its
pin, and the image's self-test (`proof/hq/test_boot.py`) holds HQ's
`version.txt` to the research's Vellum pin, beside each checkout's commit and
HQ's offline boot.

## Reading a failure

A check is one test per document (`test_every_export_meets_the_bar[<id>]`,
`test_identity_survives_the_next_publish[<id>]` and the rest). When it fails,
its message says which of three things happened
(`proof/checks/registers.py::Reconciliation.explain`):

- **differences no entry names**: a new failure. They are listed by class
  (check, artifact, structural path), with one example of each;
- **an entry the check no longer shows** on its document: a defect fixed, or a
  symptom moved. Remove the entry in the same change, or find where the
  symptom went;
- **an entry every one of whose differences another entry also holds**: one of
  the two is redundant.

The evidence file (`blocks/<id>/checks/<check>/corpus-<id>.json`) holds every
difference the check found, whether the register held it or not. A difference
names its `check`, `document`, `artifact` (what was compared: `validate_app@A`,
`form:0.1@A`, `suite.xml@toggle/SESSION_ENDPOINTS`, `trace@local.ccz`,
`editor:case list@B@minimum`), `path` (where, with every position and every
name the app authored written `*`, so one symptom has one path on every
document), `at` (the same path with the concrete positions and names), `kind`
(`changed`, `added`, `removed`, `error` or `refused`) and the two values. A
`refused` difference is a comparison that could not run, and its path names
why (`/unbuildable/...`, `/not_admitted/...`, `/status/<HTTP status>`); a
check never reports a refusal whose cause the bar already reports.

What a failure calls for:

- **A defect in Nova**: fix it; or, where the fix is a later step's, register
  its class ("Adding a register entry and its control", below).
- **A spelling no reader of it depends on**: a spelling rule, with the tests
  that run each reader on both spellings ("Spelling rules", below).
- **The harness's own fault** (a comparison that reads a position its reader
  does not, a name kept that is the app's, a refusal that names no cause): fix
  the comparator or the observation, never the register.

A worker that failed to run a group says why in `block.json` and its log; a
problem of the run itself (a fork, a claim, the corpus) is in `serve.json`.

## The corpus

### Where documents come from

A corpus document is one admitted Nova document with what Nova's publish reads
beside it (its Project's lookup data and uploaded media), under an id that is
the same on every run and machine (`proof/corpus/documents.ts`). Five sources
feed it:

- **the native producers' documents** (`proof/corpus/producers.ts`), read from
  the same fixture modules the producers emit from, so every document a native
  proof reads is also held to every check;
- **the workforce documents** (`proof/corpus/workforce.ts`): producer
  documents that also hold roles, personas, place properties, automations and
  worker properties, so every removal kind has a document to land on;
- **the admitted expander corpus**, captured from
  `lib/commcare/__tests__/expander.test.ts`;
- **the targeted documents** (`proof/targeted/`), below;
- **a fixed-seed sample of the compiler fuzz generators**
  (`proof/corpus/fuzzSample.ts`: the XForm oracle's and the suite oracle's),
  whose size the lane's time budget sets (24 by default). A document's id
  names its generator, seed and index, so a smaller sample is a prefix of a
  larger one.

Every document passes Nova's strict schema and full validation, or the
emission stops. A document Nova's publish or local export refuses is not a
corpus document: the emission leaves it out and names it, with the boundary's
findings, in the census (`index.json`).

### Emitting it

```bash
node --conditions=react-server --import ./proof/corpus/entropy.mts \
  --import tsx proof/corpus/emit.ts --out <dir> [--sample <n>] [--seed <n>] [--jobs <n>]
```

CI emits it once, in the `quality` job; a local run emits it inside the image
unless `PROOF_CORPUS` names one. Every file but `timings.json` is the same,
byte for byte, on every run at one seed, on every machine: the entropy preload
answers every identity Nova's exports mint (`lib/commcare/ids.ts`, the `.ccz`
profile's `uniqueid`, `lib/doc`'s `crypto.randomUUID`) from a generator seeded
by the corpus seed, the operation's ordinal and the configuration
(`proof/corpus/entropy.mts`). The seed names no document, so two documents
with the same content export the same bytes; the ordinals keep apart what Nova
keeps apart, so A and B mint different ids (defect 1 stays visible) and so do
the two local exports (defect 9). `PROOF_ENTROPY=real` leaves every draw real,
which the weekly audit compares against.

### The layout on disk

`proof/corpus/emitCorpus.ts` documents the layout and `proof/checks/corpus.py`
reads it. Per document, under its id:

- `document.json`: D as Nova stores it, its lookup snapshot and media, its
  source, and where its modules, forms and languages sit on the wire
  (`wire.modules`, `wire.languages`);
- `configurations.json`, `verdict.json` (Nova's publish verdict for D);
- `export/<configuration>/`: the captured `create` and `republish` requests,
  each a body and a JSON sidecar, with the lookup workbook and media upload a
  sidecar names;
- `local.ccz`, `local-again.ccz`;
- `edit/`: the edit batch with its footprint (`batch.json`), D′
  (`document.json`), its verdict, its `update` capture per configuration and
  its `local.ccz`;
- `expected.json` and the restores it reads, on a targeted document;
- `hq-side.json`, where the document carries what a person saves in HQ over
  A before Nova's next publish;
- `inputs.json`: the digest of every file a check reads, by the part of the
  document's HQ tree that reads it.

`<corpus>/native/` holds the native proofs' products, which CI's `quality` job
writes beside the corpus (`python3 -m proof.native.produce`).

### Configurations

Each document is checked under the project spaces its `configurations.json`
names (`proof/corpus/configurations.ts`), each building at CommCare 2.57.0,
the highest minimum version HQ's feature support names:

- `minimum`: the flags Nova's publish check requires of a project space for D
  and D′, and case search where Nova requires it;
- `maximum`: the minimum and every app-building flag a gate entry classes as
  target-owned;
- a single-flag configuration, the minimum and one flag, for each flag a
  reproduction names.

Sync cases on form entry and CommTrack are each off, but where a reproduction
turns one on for the document (`CorpusDocument.projectSettings`:
`targeted-sync-on-form-entry`, `targeted-supply-point-read`).

The plan privileges a document's content needs are HQ's to say: the lane
derives them where HQ runs, from the apps Nova sends, one rule per privilege
gate (`proof/checks/configurations.py`), so the emission never starts HQ.
One of them every document needs: Web Apps (`CLOUDCARE`). Every app Nova
sends is one a worker opens there, and Web Apps lists an app only in a
project space that has it (finding 64), so every configuration grants it
and every app the lane builds is one Web Apps runs.

### Edit batches

Every document but a targeted one carries one edit batch
(`proof/corpus/editBatches.ts`), drawn from one mutation kind the reducer
defines, targeting the document's own entities, and kept only when Nova's real
commit gate admits it, D′ differs from D, and Nova's publish accepts D′. The
fixed documents' batches are balanced so every kind lands on one of them, and
the emission fails, naming the kind, when one lands on none. Each batch's
footprint (`proof/corpus/footprint.ts`) is what proof 5 holds everything
outside of.

### Adding a corpus document

- **From a native family**: add its scenario to `produced()` in
  `proof/corpus/producers.ts`, with the lookup data and media its Project
  holds. The fixed documents' edit batches are balanced together, so adding
  one can move another's batch, and with it that document's records.
- **From the expander corpus**: an admitted document `expander.test.ts`
  captures joins the corpus by itself.
- **A targeted document**: below.

### Targeted documents

A targeted document (`proof/targeted/`) shows one defect part's symptom with
values fixed by hand: one per work item 12 row no other corpus document shows,
and one per symptom only the fuzz sample shows, since the sample's size is the
budget's and a register entry must never depend on it. Each is written as the
document it must be, a `buildDoc` spec with every identity named from the
document's id (`targetedUuid`), and made the way an editor makes one: Nova's
diff planner turns the empty document into it as one mutation batch, and
Nova's commit gate admits that batch (`proof/targeted/build.ts`); a planner
that dropped or reshaped anything stops the corpus there, by name. It carries
the hand-fixed values the intent check holds Core to (`expected.json`,
`proof/targeted/expected.ts`, with the restores they read,
`proof/targeted/restore.ts`), and no edit batch but the one it writes: where
its symptom shows on Nova's publish of an edit, it writes D′ too, which Nova's
planner makes from D as one batch and Nova's gate admits over D. Adding one
changes no other document. Where its symptom needs it, it names what a person
saves in HQ over A (`hqSide`, written as `hq-side.json`) and project
settings every configuration holds (`projectSettings`).

The harness's own tests also use targeted documents when their contract
needs a precise edit. `stableWitnesses.ts` keeps the two parent-registration
edits that reorder a child menu's frame, and a purpose edit whose republish
and update have identical bytes with a real case-writing form. The intent
self-check independently observes B and B-edit with matching complete keys,
requires a parsed form and its authored data-dictionary property, and retains
both records under the block's `witnesses/wire-equal-intent/` directory.
`targeted-save-to-case-read` is defect 3's last clause: one form writes a
property through a case operation alone and another validates an answer
against it and against a property an ordinary field writes, so HQ's form
builder warns about the first read and not the second.
`targeted-supply-point-read` reads the session's supply point in a project
space with CommTrack on (finding 68).
`targeted-search-button-label` owns the three unchanged search-label defect
classes; their retained `case-operation-query` control stays byte-identical.
These documents join the emitted corpus without joining balanced edit
assignment. `targeted-form-link-hidden-target` is the Formplayer runner's:
three forms each link to one target, a shown form, a form and a menu whose
display condition is false for the lane's worker (Nova refuses a condition
no worker could meet), which `proof/formplayer/test_end_of_form.py` runs on
Formplayer and on Core (finding 58). `targeted-empty-list-no-english` is the
Web Apps driver's: an app written in Spanish alone, whose empty-list message
`proof/webapps/test_empty_list.py` reads in Web Apps before and after HQ's
module settings save (finding 41). The focused `stableWitnesses.test.ts` holds every emitted byte
to an emission after an unrelated document advances the fixture counter and
changes that balance.

To add one: write `proof/targeted/documents/<name>.ts` returning
`targetedDocument({id, rows, doc, expected, ...})`, with its id
`targeted-<what it shows>`, the work item 12 rows, finding numbers or harness
contracts it shows
in `rows`, `singleFlags` where its symptom needs a flag beyond the
minimum, and `edit`, `hqSide` or `projectSettings` where it needs them;
list its maker in `TARGETED_DOCUMENTS` (`proof/targeted/index.ts`).
`proof/targeted/__tests__/targeted.test.ts`, in ordinary CI, holds every
targeted document to admission.

### HQ's apps as self-checks

`python -m proof.corpus.hq --out <corpus>/hq` (or the emission's `--with-hq`)
writes HQ's own apps beside the corpus: the app JSONs of
`corehq/apps/app_manager/tests/data` and its `suite` folder, HQ's template
apps, the HQ-built `.ccz` apps in Core's and Android's test resources, and the
apps HQ's own app-manager tests build, harvested by running each test whole
(`proof/corpus/hq/harvest.py`), each at CommCare 2.54.0 with every privilege.
`proof/corpus/hq`'s tests hold the harvest and the copied sources to what the
research counted. No lane check builds them: no test module belongs to their
group, `hq-selfchecks` (`proof/checks/sharding.py`), and no queue holds it.

## How the lane observes

Observation runs HQ, Core and Chromium and writes records; judgment reads the
records and runs none of them. The evidence store fingerprints each side's
files apart (`proof/store/fingerprints.py`), and a record is reused only under
its side's fingerprint:

- **observation** (`proof/store/fingerprints.py::in_observation`): the
  observation partition (`proof/observe/partition.py::observes`), which is
  every file under `proof/observe`, `proof/hq`, `proof/core`,
  `proof/formplayer`, `proof/webapps`, `proof/connect`, `proof/editors`
  (but its driver), `proof/lane`, `proof/store` and the comparators
  (`proof/checks/compare`), the files of the checks the observation runs but
  does not own (`proof/checks/corpus.py`, `differences.py`,
  `configurations.py`, `sharding.py`), the session's fixtures and process
  handling (`proof/conftest.py`, `proof/processes.py`, `proof/pytest.ini`),
  the pins (`proof/pins.json`, which a Connect document's observation
  fetches Connect at) and `lib/commcare/surface/entries/gates.json`; and,
  beside it, the lane's
  container configuration (`LANE_FILES`: `proof/compose.yaml` and
  `proof/run.mjs`), which decides what that code runs under;
- **browser**: the editor driver, `proof/editors/driver/`, which node runs;
- **judge**: the rest of `proof/checks`, `proof/rules`, both registers and
  the rest of `lib/commcare/surface/`.

The judges are pure functions of records: `proof/checks/test_judge_purity.py`
imports every judge where HQ cannot be imported, and holds the observation's
import closure to its partition. The surface extractor (`proof/surface`), the
spelling rules' proofs (`proof/rules`' tests) and the native proofs
(`proof/native`) also boot HQ or run Core, but as package groups: their
outcomes are kept under the **harness** fingerprint, every file under `proof/`
and `lib/commcare/surface/` with Nova's package manifest, lock and Node
version, so any change to the harness runs them again.

### One HQ unit per document and configuration

`proof/observe/unit.py::observe_document` opens one HQ unit per configuration
and runs every step every check reads, each inside an operation keyed by the
digest of its input:

```
seed → lookup upload → create(D) → media → HQ-side saves → build(A) → admit → identities, flag reads
  mark@A → A's restore for proof 3 → intent hook at A → A served (a Connect app's opportunity made) → sensitivity: each gate read, flipped, in a fork
  b:         restore@A → republish(D) → media → build(B) → admit → identities
               mark@B → intent hook at B → proof 4 over B (B served, and each save that can differ) → restore@B
  b_aligned: B aligned to A → build → proof 3's sessions (local archive and A; B where the raw builds differ)
               → the local archive served over HQ's state, and B aligned where the raw builds differ
  b_edit:    restore@A → update(D′) → media → build(B-edit) → admit → identities
               mark@B-edit → intent hook at B-edit → proof 4 over B-edit → restore@B-edit
local: Core's admission of local.ccz, local-again.ccz and edit/local.ccz → the intent and manifest local hooks
```

The HQ-side saves are what a person saves in HQ over A, where the document
carries them (`hq-side.json`, `proof/observe/hqside.py`), each an operation
of its own, so B and B-edit are published over them.

The records are split into parts (`a`, `b`, `b_aligned`, `b_edit`, `local`),
each under a key that names exactly the inputs it reads
(`proof/observe/record.py`). Where B-edit's inputs equal B's, its record is
`{"same_as": <b's key>}` and nothing is observed twice. Records are canonical
JSON with no timing, path or clock in them; bytes (every built file, stored
app, restore and trace) are blobs named by their sha256.

### HQ, booted offline

`proof/hq` is the one HQ package every HQ-side check imports
(`proof/hq/__init__.py` names its modules):

- **The boot** (`boot.py`) takes HQ's own test boot (`CCHQ_TESTING`,
  `testsettings` with the harness's local settings, `init_hq_python_path`,
  `run_patches`, `django.setup`) with `DEBUG` left on, refuses every Python
  socket, UDP send and name lookup but the lane's Postgres, moves every cache
  and every quickcache tier to local memory, and runs Celery tasks inline with
  their errors propagated. HQ's soft assertions behave as production's: noted
  and passed over, each kept in the record.
- **State** (`state.py`, `database.py`, `couch.py`, `branch.py`): Postgres is
  a clone of the database HQ's own migrations create, restored once per
  session as a template and cloned once per worker; each unit is one
  transaction, always rolled back, with HQ's deferred constraints checked
  where production would commit. Couch is HQ's in-memory test double with
  every view a path queries computed from the stored documents by that view's
  own map function, and an unanswered view raising. Blobs live in HQ's
  temporary filesystem blob store, and the change feed is recorded. A unit's
  state has a key: each operation moves it to `sha256(key | label | digest)`,
  a mark takes a savepoint, every sequence, Couch's documents, the blobs and
  the key, and a restore puts them all back. A new connection or an aborted
  transaction inside a unit ends the check. An `on_commit` callback is also
  refused in a rollback unit, whose transaction never commits. The existing
  fresh-database mode (`open_unit(transactional=False)`) commits HQ's actual
  transactions and runs their real callbacks; its database is dropped at exit.
- **Seams** (`seams.py`) answer what HQ reads from outside
  its state, from the configuration: every feature flag off unless named (each
  read recorded), the plan's privileges, the project settings through HQ's own
  test utilities, the previous build, HQ's resource overrides, and the
  form validation HQ asks Formplayer for, answered by Formplayer's own
  application (`formplayer_validation`: a Formplayer runner of the
  session's own for validation, `proof/observe/services.py::validator`,
  sent the headers and the digest HQ wrote). One privilege a
  part of the lane states of the project space beyond what the document's
  content needs is granted for that part alone (`also_granted`: Data
  Forwarding, where a Connect app's forms are forwarded). Every other read
  is HQ's, against HQ's state.
- **Elasticsearch** (`elasticsearch.py`) is HQ's own: the version and the
  plugin HQ's image of it holds (`docker/files/Dockerfile.es.6`, 6.8.23 with
  `analysis-phonetic`, held to the image by `test_elasticsearch.py`), one
  server a worker on a loopback address of its own, and the four indexes the
  lane's paths read (cases, case search, forms and users), each created as
  HQ's own test suite creates one (`es_test`'s `CreateIndex`). HQ writes
  them with its own code: a user's save writes the user, and every change
  HQ publishes for its pillows (which the unit records in place of Kafka) is
  read as HQ's change feed reads a Kafka message and handed to the
  Elasticsearch processors of the pillows that read its topic, as HQ
  constructs them (the case pillow's cases and case search processors, the
  form pillow's forms processor), as each operation or request ends, under
  its own key and clock: a pillow runs behind production's requests, and
  here it has caught up before the next one. HQ's client answers only inside
  a unit opened with its seams, and is refused on any other index. What a
  unit holds is held to its marks as Postgres is: each unit starts with
  every index empty, a mark keeps what each index holds (its documents in
  the order it holds them), and a restore puts back each index a write
  touched since. Elasticsearch's own refresh timer is held, as the pages'
  repeating timers are, and each index a scope wrote is refreshed and merged
  to one segment as the scope ends, so what a search scores against and the
  order it gives documents that score alike (HQ's case search sorts by score,
  then by `_doc`) never depend on when Elasticsearch's own merges ran. Each
  related-case lookup HQ's search compiler runs while it compiles, each case
  search Formplayer sends, Vellum's question of whether a form has
  submissions, the practice workers the app manager's pages list and the
  case types the data dictionary refresh clears are HQ's own queries of
  these indexes.
- **What HQ's receiver needs** (`redis.py`, `localcache.py`,
  `branch.py::Unit.committing`): HQ takes a lock in Redis around each form,
  case and user it writes, and admits a mobile endpoint's request by finding
  in Redis the token Formplayer wrote for it, so while a state is served HQ
  shares the Formplayer runner's Redis, as production does (the network
  guard admits that one loopback address; outside a served state HQ's raw
  Redis client is refused as before). HQ's receiver saves a form and its
  cases in one atomic block and runs what follows from it when that block
  commits; a unit's transaction never commits, so inside `committing()` the
  unit runs each such function where production's commit runs it. HQ's rate
  counters make two django-redis calls of the Redis-alias caches, which the
  local caches answer as Redis does.
- **Determinism** (`determinism.py`): inside an operation every entropy source
  HQ draws from is a DRBG seeded by the operation's key, and HQ's clock is
  frozen at the HQ pin's commit time plus one second per depth, so the same
  operation over the same state gives the same bytes in any process.
- **Speed** (`speed.py`, `buildcache.py`): only `DEBUG`'s speed effects (the
  cached template loader, no query log, the memoized webpack manifest), the
  settings YAML parsed once, HQ's XPath validator in one long-lived node
  child, and the build's pure computations kept once computed. Each computes
  exactly what HQ computes; `PROOF_HQ_SPEED=0` leaves them all out to compare.
- **Operations** (`operations.py`): publish, the media upload, app source,
  build, HQ's case processing of a submission, standalone form retention,
  the case search compiler and request reading, and the lookup workbook
  upload, each HQ's own code.

`proof/hq/test_report_retention.py` saves two case-free submissions through
HQ's SQL processor and attachment writer in a fresh database, then reads new
domain-scoped form models. It checks their stored XML and answers, distinct
rows from HQ's `TableConfiguration`, a workbook from its export writer, and
zero cases. The paired rollback-unit test refuses the real attachment commit
callback. This proves storage and row generation from known saved forms; indexed
export discovery and actor permissions are held by `proof/views/test_exports.py`. Run it with
`npm run proof -- proof/hq/test_report_retention.py`.

### The Core runner

`proof/core` is one long-lived JVM per worker (`client.py`), compiled from
`proof/core/src` against Core's recorded test classpath, speaking one JSON
line per request with a deadline on each: `validateForm` (Core's parse of a
form as a report, the runner's own lifecycle tests' probe; HQ's validation is
Formplayer's own), `admit` (Core's archive installer over a `.ccz` or HQ's build), `session` (a
scripted session's trace: every screen, command, row, question with its
prompt, answer, the submission, the case database after it and the stack;
answers come from a fixed table per question type, `proof/core/answers.json`,
with up to three tried where Core refuses one), `evaluate` (an intent
expectation), `formShape`, and the XPath readings the judges compare by
(`xpathParse`, `xpathStrings`, `xpathSame`). Core's clock readers are frozen
to each request's clock, and every id the runtime generates is marked, so two
traces name each generated id by the first place both hold it. Each document's
sessions run over its case database (`proof/observe/casedata.py`): cases of
each of its case types with values whose text and numeric orders differ ("10"
and "2"), written as a restore by HQ's own code; a remote search is answered
with every case of the requested type.

### The Formplayer runner

`proof/formplayer` runs Formplayer's whole application, one per worker
(`client.py`), started by Formplayer's own `main` on the classes and
libraries of its boot jar in its launcher's order, which the image builds at
the Formplayer pin with Formplayer's own Gradle build
(`proof/image/formplayer/build.sh`). Its web server, security chain,
aspects, controllers, services and JSON serialization are its own, and so are
its services: a database of its own on the lane's Postgres, migrated by
Formplayer's own Flyway migrations as it starts, and a real `redis-server`
the runner starts on a loopback address of its own (Formplayer keeps each
worker's last sync, each archive it installs and each form's volatility
there). It runs the Core it vendors (`libs/commcare`, the commit
Formplayer's tree records, which the runner announces), with that Core's
three clock readers reading the request's clock, as the Core runner's do.

The one address Formplayer is given in place of production's is HQ's
(`commcarehq.host`). It is the runner's own loopback peer, which answers
nothing itself: every request Formplayer makes of HQ is written to the
client as a protocol line and answered there, by HQ's own views over the
unit's state wherever the lane serves a state (`hq.py`, below), and every
one is recorded. Formplayer
runs in its own `replace-host` mode, so the URLs an app names (its
submission URL, a search's, a claim's) reach the peer too. That mode covers
only Formplayer's RestTemplate; Core's `JavaHttpReference`, which an install
reads a form from at the remote location HQ's profile names under the
build's own address when the archive's copy cannot be installed, opens a URL
connection of its own, and it left for the address HQ's settings name over
the network (a hosted run waited on one past the request's deadline). The
runner sends every http and https URL connection the way replace-host sends
the rest (`src/.../PeerUrls.java`, through Tomcat's own handler factory), so
HQ's download view answers it (`test_observe.py`). The runner speaks
one JSON line per request, shaped as the Core runner's, with a deadline on
each: `http` (one HTTP request to Formplayer's own server, with Core's
random source seeded from the request's ordinal), `clock`, `syncTimes`
and `ageSync` (a worker's last sync as Formplayer keeps it, read and moved
back through the same Redis template bean Formplayer writes it with, for
what a worker's absence does, which no run can wait for), and
`forgetCaches`, which empties every cache of Formplayer's own
`CacheManager`. Formplayer keeps what a query fetched, each form
definition and each session in memory for five minutes of the machine's
time (`application.properties`, `caching.specs.*`), and a worker's
`clear_user_data` leaves them, so a run started within five minutes of an
earlier one read that one's answers without asking HQ, and one started
later asked: on a loaded hosted runner one key held both for
`search-hidden-link`, whose end-of-form link fetches the chosen case again
(HQ's `case_fixture`). Every run of a walk and of the Web Apps client now
starts with them empty, as on a fresh Formplayer
(`test_observe.py` observes that document twice and holds both alike; with
the caches left, the second omits the fetch).

- **HQ's own views** (`hq.py`): where the lane serves a state, each request
  Formplayer makes of HQ is built from the bytes Formplayer sent, handed to
  Django's handler loaded with HQ's own middleware, resolved by HQ's URLconf
  and answered by the view that URL names, over the unit's state: the
  session's user (`SessionDetailsView`, which reads the Django session the
  worker's browser holds), the app's archive (`direct_ccz`, HQ's own
  download of the released build), the restore (`ota/views.py::restore`,
  HQ's restore of the cases HQ holds, with the tables Nova's push uploaded
  and the user case HQ made), a submission (HQ's receiver whole:
  `SubmissionPost.run`, its locks, its case processing and what it does on
  commit), a case search (`app_aware_search`, its query applied by HQ's own
  Elasticsearch to the cases HQ's pillows indexed as its receiver saved them) and a claim (`claim`, which makes the claim case HQ makes).
  `serve` makes what HQ needs for that with HQ's own code: the project
  space's default roles, the worker (`CommCareUser.create`), the document's
  cases submitted through HQ's receiver as the worker, and a build released
  as HQ's Releases page releases one. A view that raises answers Formplayer
  a 500, as production's does, and is recorded with what it raised.
- **The package's own tests** (`apps.py`): a document published as Nova
  publishes it and served by `hq.py` as the lane serves it, and a state a
  person's save leaves saved by HQ's own App Settings page in Chromium
  (`saved_page`) or by HQ's own settings view (`saved_profile`), never
  written by hand.
- **The Web Apps client's requests** (`webapps.py`): each body holds the
  fields HQ's client writes (`cloudcare/js/formplayer/menus/api.js`,
  `cloudcare/js/form_entry/web_form_session.js`), with HQ's session cookie
  and Formplayer's CSRF cookie as a browser holds them.
- **The walk** (`walk.py`): scripted sessions as the Core runner's, derived
  (every menu command, the first case of each list, each list action once,
  each search) or replayed, each run starting as a worker starts after
  clearing their data and with Formplayer's caches empty, each form answered from the Core runner's answer
  table and submitted as the client submits it. The trace is Formplayer's
  own JSON for every request, with what it asked HQ during each, the
  submission HQ received and the screen Formplayer's end of form navigation
  names next.
- **Canonical JSON** (`canonical.py`): each id Formplayer or its Core drew
  is marked by its first appearance, as the Core runner marks its traces, so
  the same inputs give the same bytes.
- **A served state's record** (`observe.py`): the marked trace of
  Formplayer's walk, every request an HQ view did not answer 2xx, how often
  Formplayer asked each view, and each search's parameters ("Served
  states", below).

The runner costs each worker about four seconds once (its compile, its
database, its Redis, and Formplayer's start, which is most of it), and a
document's walk of one build between half a second and three seconds.

What its own tests observe on HQ's releases of real Nova exports, served by HQ's own views:

| Claim | Observed | Test |
| --- | --- | --- |
| A form link whose target is hidden (finding 58) | Core's session opens the hidden form, or asks for a command of the hidden menu; Formplayer stops at the menu that holds the hidden form, or at the app's first screen | `test_end_of_form.py` |
| A search answer holding both quote marks (finding 48) | Formplayer answers the search screen again with the validation's message and sends HQ nothing; an answer with one mark is sent inside the CSQL, HQ's own search view reads it (and refuses the query for the document's own date comparison, defect 6), and HQ's compiler takes the string that holds the answer | `test_search.py` |
| The saved app's empty search description (finding 54) | Formplayer hands Web Apps `""` for Nova's export and a non-breaking space for the saved app | the rule `search-description-empty` (`proof/rules/test_search_description_empty.py`) |
| `cc-autosync-freq` absent or the `freq-never` HQ's App Settings save writes (finding 40) | Formplayer asks HQ for no restore after eight days in either; with `freq-daily`, which HQ's settings view saves for a person's change, it asks for one | `test_settings.py` |
| `cc-fuzzy-search-enabled` absent or the `yes` the same save writes (finding 40) | a search one letter off a case's name finds nothing when absent and the case after the save | `test_settings.py` |
| A custom tile's vertical alignment (finding 42) | Formplayer hands the client no alignment for Nova's export and `start` for the saved app, and nothing else of the list differs | the rule `tile-vertical-align-start` (`proof/rules/test_tile_vertical_align_start.py`) |

### The editor driver

`proof/editors` drives HQ's own editors in Chromium (`driver/driver.mjs`, node
with the image's playwright-core). Every request a page makes to HQ comes back
to Python and is answered by HQ's own URLconf, decorated views, templates and
context processors over the unit's state (`hq.py`); the page's JavaScript is
HQ's own, bundled at image build time with an esbuild configuration derived
from HQ's webpack configuration.

- **Pages** (`pages.py`) are rendered by HQ's page views through
  `view_generic`. A view is loaded once on a reused page; each section HQ
  offers is armed the way a person arms it (the change event its listeners
  watch, or a control changed and changed back), its Save clicked and its
  request held; then each held save is released into a fork of its own, where
  HQ answers it and everything the page asks after it. A page that answers
  Save with a dialog and sends nothing (HQ's Case List page refusing a
  configuration it finds errors in, `details/bootstrap3/screen.js::save`)
  leaves the section unsent, named by that dialog, which proof 4 reports as
  the page's refusal (`/save/unsent/<what the dialog says>`).
- **Vellum** (`vellum.py`) runs HQ's vendored build with the options HQ's form
  designer computes (`views/formdesigner.py`'s own helpers), on a warm host
  reset between forms as Vellum's own tests reset theirs, with what every
  instance shares (its check for submissions, the mug types and property
  specs its plugins extend) put back as a fresh page starts it, waiting on
  Vellum's load and save events, never a fixed time. The parse is held until
  the data sources arrive, as on HQ's page. A run that does not end clean is
  followed by a fresh load.
- **Determinism** (`seeding.py`, `driver/steps/page/seed.js`): the page's
  `Date` reads HQ's epoch, `Math.random` and `crypto.getRandomValues` draw
  from a generator seeded from the run's spec, and the origin's storage and
  cookies are cleared before each load.
- **Polls** (`driver/steps/page/polls.js`, `test_polls.py`): every document
  of every page the driver opens, seeded or not, holds each repeating timer
  of ten seconds or more. HQ's app manager asks `current_app_version` every
  20 seconds of real time (`app_manager/js/menu.js`), so a slow run's
  records gained a second check, and on a loaded runner one landed while an
  App Settings section's save was in flight and the writes-alone guard
  refused the view (`ConcurrentWrite`). The check the page makes as it
  loads still runs, and so do shorter repeating timers and every one-off
  timer.
- **Transcripts** (`transcripts.py`): a view or Vellum run keeps what it asked
  HQ and what it showed. A replay has HQ answer every recorded request again
  and stands for a live run only when every answer is byte for byte the one
  recorded; at the first difference the fork is put back and the browser runs
  live.

The reused page and the warm host are proven equal to a fresh page per section
and per form (`test_view_equivalence.py`, `test_vellum_warm_equivalence.py`),
and `PROOF_EDITOR_AUDIT` reruns a share of live runs the fresh way in every
run. `test_control.py` is the driver's control: a Case List save of a
single-date search input keeps it under `CASE_SEARCH_ADVANCED` and drops it
without, as HQ's template gates decide.

### The Web Apps driver

`proof/webapps` runs HQ's Web Apps client, the JavaScript a worker's browser
runs, in the editor driver's Chromium, against the lane's Formplayer, over a
build HQ released of a Nova export. Nothing of the client is copied or called:
a step clicks what a worker clicks, or reads what the page shows.

- **The project space and the release** (`hq.py`). Web Apps lists an app only
  where the project space has Web Apps (the `CLOUDCARE` privilege, from which
  HQ sets a new app's `cloudcare_enabled` when Nova's upload lands) and the
  app has a released build. Every configuration of the lane grants the
  privilege (finding 64), so every app it builds is one Web Apps lists. The
  build is made as HQ's Releases page makes one
  (`Application.make_build` and the build's save, then HQ's own
  `release_build` view), optionally after HQ's own editor pages saved the app
  in the same Chromium (`released(saves=...)`, `proof.editors.pages`), so a
  test reads Web Apps over Nova's export and over the app a person's save
  leaves. Each release's operation is keyed by the stored app's content, so
  each build has an id of its own, as HQ's builds do and Formplayer's kept
  installs need. The release is served as the lane serves a state
  (`proof/formplayer/hq.py::serve`): the page is answered for a mobile
  worker HQ made, their cases saved through HQ's receiver, and every
  request Formplayer makes of HQ answered by HQ's own views.
- **The page** (`session.py`). HQ's `FormplayerMain` view answers the
  navigation through HQ's URLconf, decorators and templates; the script is
  the bundle the image builds from HQ's `cloudcare/js/formplayer/main` entry
  under HQ's webpack configuration (`proof/image/editors/build.mjs`). The
  page is told Formplayer lives at `/formplayer` on HQ's own origin, where a
  deployment's proxy serves it, and each request the client sends there
  goes, headers and body as the browser wrote them, to Formplayer's own web
  server, whose answer and cookies go back to the page. The lane has two
  names for HQ where a deployment has one (the browser's origin, and the
  address Formplayer reaches HQ at), so the `Origin` and `Referer` the
  browser wrote are sent under Formplayer's name for HQ, and Formplayer's own
  CORS rule and CSRF token then judge the request as they judge
  production's. Every run starts as a worker who cleared their data, on
  Formplayer's own install of the build.
- **Stylesheets** (`static.py`). What a worker sees is the client's markup
  under HQ's stylesheets, so the page has them: HQ's own precompiler compiles
  the SCSS the page names (HQ's test settings switch it off, and HQ's own
  note there says how a test turns it on), and HQ's static finders serve the
  compiled files and every other static file the page asks for. The one
  request nothing answers is for a web font on another host.
- **Steps** (`steps.py`, `driver/steps/webapps`): a click on the one element
  a selector and a text name, an answer given through a question's own
  widget (`answer.js`: a text box typed into, an option or check box
  clicked, a drop-down's option chosen, a date or a time typed in the format
  the client's picker reads), a form's Submit (`submit.js`, which reports a
  Submit the client keeps disabled), and `screen.js`, which reads the screen
  the client rendered: the home screen's tiles, a menu's rows, a case list
  (headers, rows, the empty-list message, and each tile cell's grid area,
  alignment and font size as the browser computed them), a case's detail
  dialog, a search screen and its description, a form's title and
  questions with the answer each widget shows and the error the client
  shows for it, and the client's alerts.
- **Arriving, never a time.** Every step that leads somewhere waits until
  the client itself says it is there (`arrived.js`): its route (the address
  it keeps a worker's session in, which it sets before it asks Formplayer
  and then sets to the selections Formplayer's answer hands back) holds
  what the walk's request and Formplayer's answer say it holds, its own
  flag of a request in flight (`formplayerQueryInProgress`, cleared at
  jQuery's `ajaxStop`, once the answer is drawn) is down, no dialog is open
  or moving, and no notification is fading. A case's detail dialog is
  waited for until it is done opening (`detail.js`: Bootstrap focuses it in
  the callback that ends its opening, the same one that lets it close), and
  only then is its Continue clicked: a Continue clicked while the dialog
  was still opening was a close Bootstrap ignored, which left the dialog
  over every later screen, and was what made the client's records differ
  between states on loaded runners. An answer waits for the request the
  client sends for it (after its knockout bindings and a throttle), and
  Submit for Formplayer's answer to the submission and the client's
  arrival wherever that takes it. A step that waited out its deadline says
  what the client was still doing.
- **A document's record** (`observe.py`): Formplayer's own walk of the
  release, every run replayed whole in the browser in one page: the app's
  first screen, each choice clicked as a worker clicks it (a case's detail
  read where the client opens one), and where the run reached a form, each
  of the walk's answers given through its widget in the walk's order, the
  form read as the worker leaves it, Submit, and the screen the client lands
  on, with what became of each answer (`answered`, `unanswerable`) and of
  Submit (`submitted`, `disabled`). Where the client shows nothing to click
  for a choice, its record of that run ends there, with `stopped` and the
  screen it stood on. It holds no id Formplayer drew, no time and no path,
  so the same inputs give the same bytes; `test_observe.py` holds two
  observations alike, and they hold alike with Chromium's processor slowed
  eightfold.

The page's randomness is seeded, as an editor page's is, and its clock starts
at HQ's epoch and runs on (`steps/page/seed.js`, `advancing`), so the
client's own animations end and its debounced handlers run as in a worker's
browser; nothing the client shows reads its clock. A session costs between
one and two seconds (a document's publish and release about one more, its
record three to four); about 0.7 s of each page load is HQ compiling the
page's four stylesheets again.

What its own tests observe on released builds of real Nova exports, each on
the client itself:

| Claim | Observed | Test |
| --- | --- | --- |
| A tile cell's vertical alignment, absent or the `start` the Case List save writes (finding 42) | `align-self: start` for both | `test_tiles.py` |
| Its horizontal alignment, absent or `left` (finding 42) | `start` for Nova's export, `left` for the saved app, alike left to right and apart right to left | `test_tiles.py` |
| Its font size, absent or the `medium` the save writes (defect 14) | 12px under HQ's stylesheet for Nova's export, 16px for the saved app | `test_tiles.py` |
| The empty search description the Case List save writes (finding 54) | no description element for `""` or for a non-breaking space, on a search opened from a list, one the menu opens and an inline one; a description with text is shown | `test_search.py` |
| List-first turned search-first by the Case List save (defect 21) | the menu opens the list for Nova's export and the search for the saved app | `test_search.py` |
| A column hidden from a list (defect 16) | a list search for its value finds no case; a shown value finds the case | `test_search.py` |
| A sort-only column | no header and no cell for the column Formplayer hands with a width hint of 0 | `test_search.py` |
| The empty-list text in an app without English (finding 41) | "List is empty." for Nova's export; after the module settings save a message box holding only a non-breaking space | `test_empty_list.py` |
| The logo Nova sends (`logo_refs.hq_logo_web_apps`) | the app's tile shows HQ's own URL for the mapped file, and HQ serves Nova's bytes there; without one, the client's own image | `test_app_list.py` |
| `cc-show-incomplete` after the App Settings save (finding 62) | the Incomplete Forms tile shows for Nova's export and is gone after the save | `test_app_list.py` |
| An after-submit link to a hidden target, end to end (finding 58) | the link to a shown form opens it; to a hidden form, the menu that holds it, listing its shown form alone; to a hidden menu, the app's first screen; HQ's receiver processes one submission each time, and the client shows the message it answered | `test_links.py` |

### Served states

A document's unit serves each state of its app as HQ serves an app to Web
Apps and keeps what its two readers make of it (`proof/observe/served.py`):

- **Which states.** A (the unit's `served` hook, the baseline of proof 3's
  comparisons); with `b_aligned`, B aligned to A wherever its raw build
  differs from A's, and Nova's local archive, which Formplayer walks over
  HQ's state with the archive itself handed to it as bytes; and in proof 4,
  B and each editor save whose build differs from the state it was saved
  over or whose app differs in what HQ's Web Apps page hands the client
  (`cloudcare/utils.py::format_app_doc`: its name, languages, profile, logo
  and multimedia). The saved states are the ones HQ's editor pages saved in
  proof 4's own forks, never an app written by hand.
- **Formplayer** walks each: the walk is derived on the baseline (A, or B in
  proof 4) and replayed on every other, as Core's script is. Each run is a
  fork of the unit with the worker signed in afresh, so a submission HQ's
  receiver processed is in HQ while its run lasts and gone for the next.
- **The Web Apps client** is shown the same walk in a browser of its own
  (`proof/observe/services.py::client_browser`), every run whole, its forms
  answered through their widgets and submitted, and its screens are read
  after every step that leads somewhere. It is shown a state only where Formplayer's trace or
  what HQ's page hands it of the app is not the baseline's: the client
  reads nothing else, so the same answers and the same page show the same
  screens (`PROOF_VERIFY_MEMOS=1` serves every kept state again).
- **The release is the build.** HQ makes the release with `make_build`, the
  other checks build with `validate_app` and `create_all_files`; each served
  state's archive is held to the build's files entry for entry, but for the
  profile, which names the build itself (`release@<state>`,
  `/release-differs`).
- **What is compared** (`proof/checks/served.py`). Formplayer's
  traces as the client reads them: a list's rows by the case each selects
  with their order beside them, a form's instance and each submission as
  parsed XML, a form's version under proof 2's version clause, and one
  difference a symptom (a response of another kind is its kind; a refused
  submission is its status and what Formplayer said, and what follows from
  it is not reported again). On the local archive, a message of Core's that
  names a question by its label's text id is read with HQ's id for the same
  texts, where HQ's build of that form merged them
  (`XForm.normalize_itext`; `merged_text_ids` reads the pairing from the two
  forms, and a message naming another question stays a difference). The
  client's screens the same way, its own home tiles by their kind. A difference is `formplayer@<state>` or
  `webapps@<state>` in proof 3 (`local.ccz`, `B`) and
  `formplayer@<editor>@<B>@<configuration>` or `webapps@...` in proof 4,
  held by the register as any other. Each request HQ's views refused while
  Formplayer walked A is `formplayer@A`, `/hq/<view>/<status>/<what HQ said>`.
- **Cost.** A served state costs one to two seconds of Formplayer and three
  to four of the client, and a document has between four and twenty of
  them a configuration, so a document that took five to ten seconds takes
  forty to a hundred ("Timings and the five-minute target").

### Connect in the unit

Where a document's app holds a Connect block (an element of Connect's
namespace in one of its forms, `proof/observe/connect.py::is_connect`), its
unit also observes Connect, the last reader of a Connect app, on every state
it serves (`proof/observe/connect.py`). Each link is its owner's code at the
pins, and nothing is called on a system's behalf:

- **The opportunity** is made once, while A is served, as a manager makes
  one. Connect is a served process of its own for the life of the unit
  (`proof/connect/runtime.py::ConnectSession`: Connect's own WSGI
  application on a loopback address, its own Postgres and Redis). It asks
  HQ for the app's released build, which HQ's own archive view answers
  (`views/cli.py::direct_ccz`, `latest=release`), and reads its learn
  modules, deliver units and tasks
  (`opportunity/tasks.py::sync_learn_modules_and_deliver_units`,
  `app_xml.py::get_task_units_for_app`). Every deliver unit is paid for, the
  worker's claim is made, GPS verification is on and one task of each type
  is assigned. Connect's database as the opportunity then stood is kept, and
  every later state of the document is received by that opportunity, as an
  app republished, edited or saved in HQ goes on being received by the
  opportunity made before. An app that only an edit makes a Connect app gets
  its opportunity from B-edit's release.
- **Each served state forwards.** The project space holds a Connect
  repeater (`proof/connect/hq.py::forwarding`). HQ's receiver view takes
  each form whole (`SubmissionPost.run`), HQ's own signal registers the
  repeat record, HQ's own task fires it, and HQ's own HTTP client asks
  Connect for a token (OAuth's client credentials grant, at Connect's own
  token endpoint) and posts the payload to Connect over a real connection.
  Connect answers through its own URLconf, middleware, authentication and
  request transaction, and HQ keeps the answer on its repeat record.
- **Whose submissions.** Formplayer's are the ones its walk of the state
  makes. Core's are the ones its sessions made on the state's build, each
  posted to HQ's receiver view as a device posts one: to the address the
  released build's profile names (`PostURL`, the receiver under the build's
  own id), with the worker's own credentials, and with a location fix
  written where the form holds the node (only CommCare Android writes one).
  Nova's local archive names no address, so its submissions are posted to
  the project space's receiver with no app named, and once more where HQ's
  own build's profile sends a device, which shows what Connect would make
  of them if they named their app.
- **Each run is one worker's.** It meets HQ as the unit's fork leaves it
  and Connect as the opportunity stood, so no run reads what another's
  submission left in either. After it, Connect's queued tasks are run by
  Celery's own task machinery, and the run is kept: what HQ's receiver
  answered, what HQ kept of each forward, each payload as it reached
  Connect with Connect's answer, each task, and the rows Connect holds
  (its modules, units and task types, the worker's progress and pay, the
  visits, completed work and assigned tasks).
- **What is compared** (`proof/checks/connect.py`). Connect is the reader,
  so what is compared is what Connect did: its answer to each payload, the
  tasks it ran and the rows it holds, run by run. A payload is never
  compared: two payloads Connect answers alike and makes the same rows of
  are two spellings to it. One symptom is one difference (a payload one
  side had taken and the other refused is its answer, and the rows that
  follow are not reported again), and a run only one side made, or one HQ's
  receiver answered otherwise, is left to the walks and the case processing
  that report it. A difference is `connect@local.ccz` or `connect@B` in
  proof 3 and `connect@<editor>@<B>@<configuration>` in proof 4.
- **What stands on its own** of one state: a payload Connect did not take
  (`/runs/*/refused/<status>/<cause>`), a visit rejected for the task its
  own form completes, a unit Connect made of its own on receiving a form, a
  task that completed nothing, and, after an edit, a Connect id that moved
  under the opportunity (`/ids/<kind>/moved`). Proof 3 reports A's
  (`connect@A`); proof 4 reports B's and B-edit's that A did not show
  (`connect@<B>@<configuration>`). An edit changes what a form submits, so
  B-edit's rows are not held to A's; what the edit breaks in Connect is.
- **Cost.** Connect starts once per worker that meets a Connect document
  (its fetch and its migrations, about thirteen seconds); an opportunity
  costs about two seconds, and a run that reaches Connect about a third of
  one.

What the unit states of the world for that, each named where it is done: the
project space's plan has Data Forwarding (`proof/hq/seams.py::also_granted`);
Connect is reached over plain HTTP at a loopback address
(`proof/connect/hq.py`); HQ's count of the devices a worker submits from
lives in the Redis HQ shares with Formplayer (`proof/hq/redis.py`); and the
address Connect knows HQ by is answered by HQ's own views over the unit's
state, as Formplayer's requests are.

### The Android stage

CommCare Android's own code cannot run where the lane's shards do:
Robolectric's native runtime and the Android Gradle plugin's resource
compiler ship for Linux on x86-64 alone, and the shards are arm64. So Android
reads after the shards, from what they observed, as a stage of the same lane:
its own queue, its own shards on amd64, and the same gate.

**What a document's record keeps for it.** Every state HQ built keeps the
archive a worker installs of it (`state.archive`,
`proof/observe/build.py::device_archive`: HQ's own download arrangement with
the app's multimedia, each entry a blob), and proof 4 keeps the same for every
editor save whose build is not the one it was saved over. Beside them are the
restores the states' sessions read: A's (`restoreA`), the local archive's
(`sessions.restoreLocal`) and B's or B-edit's (`proof4.restore`). Nova's own
local archives are files of the document.

**What Android reads** (`proof/android/records.py::plan`, each a request of
the reader, `proof/android/README.md`): the whole app as a worker meets it
(`app`: the install, every profile reader, the home screen, and a walk down
every path the app's menus offer, through each list, detail, search, claim
and form to its save and whatever home starts after it) for Nova's
`local.ccz`, for A, B and B-edit of each configuration, and for each editor
save; two installs in turn (`installs`) for the two local exports and for A
then B; and a device that updates (`update`) from `local.ccz` to
`local-again.ccz` and from A to B, with every form left incomplete before it
and a worker's own settings, and from B to each save whose profile is not
B's. An archive of a state HQ would not release is not read.

**Each answer is kept under what it is a function of.** A request's key
(`Request.key`) is the digest of every entry of each archive it reads, its
restore, its options and the reader (`records.fingerprint`: the reader's
files, the commcare-android and commcare-core pins, the answer table, the
toolchain and the platform). The evidence store holds each answer under that
key (its `android` entries), so an archive read before is never read again,
whichever document or state it is an archive of, in this run or a later one;
and a change to one form of one state reads only the archives that hold it.

**What is judged** (`proof/checks/android.py`, pure functions of the
answers, each difference under an `android@...` artifact):

- **Proof 3**: what a device shows of Nova's local archive against HQ's
  build of A (`android@local.ccz`), and of HQ's build of B against A's
  (`android@B`), per configuration.
- **Proof 4**: what a device shows of the app each editor save left against
  the state it was saved over (`android@<editor>@<state>@<configuration>`),
  and each of the worker's own settings an update to that app replaced
  (`/update/workerSettings/<setting>`).
- **Proof 1**: the two installs and the update of the local path against
  HQ's (`android@local.ccz`: each install's status, where the update
  stopped, and, where both installed one, whether it is the same app at no
  lower a version); and, of each path alone, each form a worker left
  incomplete before the update that the device no longer opens after it
  (`/update/reopened/*`, under `android@local.ccz` and `android@B`), or
  whose session, as Android itself stored it, home cannot read
  (`/update/reopened/*/session`).
- **Of each archive alone**, under proofs 3 and 4: a search that sent, for
  an answer holding both quote marks, the query HQ refuses (`android@A`,
  `…/query/withAnswer/sent-unquotable-search`), and a form the device did
  not save and yet left a mark of
  (`…/form/saved/applied-though-refused`: the cases it holds are not the
  ones it held as the form opened), which Android's one transaction a form
  should never give.

One symptom is one difference: a walk whose screens part from the
baseline's is named by where they part
(`/walks/*/screens/after-<screen>:<the baseline's next>:<the other's next>`,
the screen a walk stopped at named with the alert it holds for the worker,
`FormEntryActivity!Error Saving your Form`) and its steps are not compared; a form that takes another path of screens, a
list whose rows are another kind of view, an archive Android does not
install, each is that. A list records which case each row is and which case
the walk opened: two lists that show their cases in another order are that
once (`/list/order`), with each row compared against the same case's row,
and where the two walks opened another case (`/list/chose`) nothing past the
choice is compared, since every screen there is of another case. What a
reader keys by a name is compared by that name (a menu's items, a Sort
choice, a search's term, a hidden button, and a case a form left, each case
one value).
Left out, because it names an install and not what a worker reads, or says
again what a reader beside it says: the app's id and version (proof 1's), the
profile's stored values (each reader's answer is compared, so a stored value
no reader reads differently is no difference on a device that installs
either), and the media check's flags beside its reader.

**How it sits in the lane.** Each document has an Android group
(`android:corpus:<id>`, and `android:control:<id>` for each control an
Android entry of the register names), in a third queue built with the main
one (`python3 -m proof.store.queue android`): a block, or cached where the
store holds the group's outcome and each judge's evidence under its key (the
document's key, the reader and the judge's code with both registers). The
stage (`python3 -m proof.android.stage run`) runs the blocks of its static
bin: it finds each document's records in the shards' outputs or the store,
reads or makes each answer, judges, and writes an output like a shard's
(`blocks/<id>/block.json` with one item for the answers and one a check, the
evidence with `"stage": "android"`, the answers in the run's delta). The gate
reads it with the shards' outputs: every Android block ran exactly once,
every item passed, and the stage's evidence of a check on a document is held
to the register beside the shards' own evidence of it.

A register entry belongs to the stage whose check shows it: one whose
artifact is `android@...` is the Android stage's, held and verified there on
its document and its control; every other is the shards'
(`proof/checks/registers.py::stage_of`). The shards' check holds only the
shards' entries, and still runs a control only an Android entry names, since
its records are what the stage reads.

The item `android::<group>::records` fails where the reader itself could not
answer a request (never where Android refused something, which is an
answer), and where a group the queue marks fresh made an answer that is not
the one the store holds, both written under the output's `audit/`.

**What it costs.** Measured on hosted four-vCPU x64 runners with nothing
in the store, so every answer was made: 351 documents, 11,933 requests,
11,234 of them made by the reader (the others an archive two documents
share, read once), none the reader could not answer, in 38,144 job-seconds
(10.6 runner-hours): about 3.4 seconds a request with four devices a job.
In 24 bins a job took 17 to 36 minutes, and the account ran 20 x64 jobs at
once, so four bins waited over twenty minutes for a runner. The default is
therefore 20 jobs (`proof/android/stage.json`), all started together. A
later whole run (376 groups, about 43,000 job-seconds) took 25 to 44
minutes a job in 20 bins, because the bins were packed by what each
document cost the proof shards, which says little of what a device does
with its archives. Each Android group is now measured by its own seconds on
a stage job (its block record's `seconds`: the stage runs one group at a
time with every device of the box), `node proof/run.mjs --timings` reads
them from the stage jobs' outputs beside the shards', and the queue packs
the stage's bins from them (`proof/checks/sharding.py::estimate`): the same
groups in 20 such bins come to about 36 minutes each. The next hosted run
packed so still took 24 to 41 minutes of stage time a job, with each job
making about as many requests as the others (553 to 633) at 2.5 to 4.0
seconds a request: what is left is how fast each hosted runner is, which no
packing changes. The runtime's build,
when a pin or the toolchain moves, takes about eleven minutes with the
reader's own checks. A later run reads each unchanged archive's answer from
the store and makes only the others.

**Its tests.** `proof/android/test_stage.py` and
`proof/checks/test_android.py` run in the lane with a stand-in reader: each
archive read once, a changed archive read again and no other, a planted
difference failing until an entry holds it, the gate and the register reading
the stage's output. `proof/android/selfcheck.py` and
`proof/android/predicates.py` run commcare-android's own code, where the
reader runs (the job that builds or restores its runtime, on every run):
the reader held to itself, the stage end to end with a planted difference
Android must show, and each Android predicate the register rests on over both
spellings of its difference.

### HQ's own pages and views

`proof/views` holds what reaches a person only through one of HQ's pages or
views that no per-document check runs, each test over a real Nova export
published into a check's own project space
(`proof/views/conftest.py`):

- **A request as a client sends it** (`ask`): resolved by HQ's URLconf and
  answered by the view that URL names, behind HQ's own middleware and that
  view's own decorators, by the handler that answers Formplayer's requests.
  Nova's lookup push is the bytes Nova's own client sent (the corpus's
  capture), with an API key HQ's own model made; a device's restore is asked
  at the address the released build's profile names, with the worker's own
  credentials.
- **A page read for what it offers** (`offered`): HQ's module page loaded in
  the editor driver's Chromium by HQ's own page view, its JavaScript run,
  and each control counted in the document
  (`proof/editors/driver/steps/pages/offered.js`). A control HQ's template
  leaves out under a flag or an add-on is not in the document; each test
  also reads a control no gate holds back, so a page that offered nothing
  would not pass.

Each test pairs what it shows with its counterpart: the flag on, the
privilege granted, the project space's setting on. One thing stands in, named
where it is done: the "Upgrade Required" page's own script is named by HQ's
webpack manifest, which the image's build writes only for the pages its
browsers run, so that test names the base page's entry in the manifest for
the block (`test_lookup_upload.py::base_page_script`); the answer's status,
type and text are HQ's. That answer's status and type are retained
(`proof/views/retained/`), held to HQ by the lane, and handed to Nova's own
client over real HTTP by the package's Vitest test in ordinary CI, so what
Nova reports of it is observed on Nova's code too.

## The registers

### Known defects

`proof/known-defects.json` lists each symptom class the lane reproduces
(`proof/checks/registers.py` loads and enforces it):

```json
{"id": "d1-ids-app-xmlns", "defect": 1, "part": "ids and xmlns",
 "check": "proof1", "artifact": "app.json", "path": "/modules/*/forms/*/xmlns",
 "document": "<a document that shows it>", "control": "<its control>"}
```

- `defect` is the research's number (1 to 30) or one of the harness's own
  findings, numbered from 31 in
  `docs/research/2026-09-26-hq-round-trip/harness-findings.md`; `part` names
  the part of the defect the entry shows: a row's part below, a narrower name
  for one of its symptoms, or the finding's.
- `check`, `artifact`, `path` and `kind` name the class. A difference is in it
  when its check is the entry's, its artifact matches the entry's (`*` matches
  any run of characters), its structural path is exactly the entry's, never
  read as a pattern, and, where the entry names a kind, its kind is that one.
  An entry without `kind` holds every kind at its path.
- `document` is a corpus document whose current export shows the symptom: a
  non-fuzz document or a targeted one. The loader refuses an entry on a fuzz
  document: the fuzz sample's size is the budget's, so such an entry would
  fail whenever the sample shrank past it or the corpus seed changed.
- `values` (`{"before", "after"}`) pins the exact values, only on an entry
  whose document is targeted.
- An entry whose artifact is `android@...` is the Android stage's: a
  difference in what CommCare Android's own code read of two archives ("The
  Android stage", above), reported and held by that stage's judge of the
  entry's check, on the entry's document and on its control. Every other
  entry is the shards'. What a defect does on a device is such an entry,
  never a citation of Android's source.
- An entry is a symptom, never an equivalence. Two spellings every reader
  of which reads alike are a spelling rule, proven by tests that run each
  of those readers on both ("Spelling rules"), and the register holds no
  entry for them; the loader refuses an `equivalence` field, and an
  `android` field that cites a class in place of a run.
- `control` names the entry's control under `proof/controls/`.
- A manifest entry never names an undecided use: that is a gap in the check.

The register is strict. A check on a document passes only when every
difference it reports falls in an entry, every entry naming that document and
check matches a difference, and each such entry holds some difference no other
entry holds. Over a whole run, every entry must have been seen on its document
and on its control: the gate's register section holds that, reading the
evidence of every block that ran and, for the groups the queue cached, the
store's. A run over a sample of the corpus (`python3 -m proof.store.queue
main --documents sample:N`, the weekly runs) checks only the sampled
documents: the sample's `index.json` lists the others under `unsampled`, whose
files stay for the tests that name them, and the queue names them too, so the
gate holds each entry naming one on its control alone and its register
section says how many entries it held so. On a run's own output,

```bash
python3 -m proof.checks.registers verify <output>/blocks/*
```

does the same from the named block directories' `checks/` alone, so it holds
only a run that reused no stored judgment and checked the whole corpus: a
local `npm run proof` with no `PROOF_STORE`, or `proof-lane.yml`'s fresh run
of every document (every block of every shard).
So a new failure fails, and a fixed defect left listed fails until its pull
request removes the entry; `test_registers.py` proves both, including that
removing any one entry fails.

A control is a retained pre-fix input: a directory under `proof/controls/`
holding one document's files in the corpus layout, the upload bodies and
export bytes the checks read and the expected values they compare against. The
checks read it the way they read a corpus document (`control:<id>`, a group of
its own in the main queue), and every entry naming it must show its symptom
there. A check runs on a control only while an entry of that check names it
(`proof/checks/cases.py::control_params`). One control serves every entry its
document shows, so the controls are kept to the smallest set of documents
that covers every entry, each keeping only what its entries' checks read
(`proof/checks/controls.py`): the edit only where the bar, the intent or
manifest check, or proof 1, 4 or 5 names it (proofs 2 and 3 and configuration
sensitivity read A and B alone, and the unit observes no B-edit for a control
without one), and each local archive only where a check that opens it names
it (`local.ccz` for the bar, the intent and manifest checks and proofs 1, 3
and 5; `local-again.ccz` for those but proofs 3 and 5; `edit/local.ccz` for
the bar, the intent and manifest checks and proof 5). Since a control keeps the bytes the export sent before the
fix (the upload bodies, the archives) and the values the checks compare
against, it keeps showing the symptom after the emitter that made it is
fixed. It keeps no `document.json`, whose `doc` is Nova's persistable shape,
which a later cutover changes: what the checks derive from D and D' (the
wire layout and languages, the intent, the lookup tags and the case
database) is written beside its files when it is retained (`derived.json`,
`proof/checks/controls.py`), and each check reads it there. Nor does it keep
an `inputs.json`: its part keys and the evidence store's guard read its
input files from the files themselves (`proof/observe/unit.py::input_files`),
so a control edited by hand is keyed by what it holds, and its records and
judgments are kept and read back as a document's are ("The evidence store
and its audits", below).

### The defect rows

Step 1's plan (its work item 12) named a row for each defect part whose harm
shows in a system the lane runs, and the register holds entries for each row
the lane reproduces, one per symptom class. The table gives each row's
symptom, the checks whose differences its entries hold, and the documents that
show it. "Proof 4, then 2" or "then 3" means the editor-saved app's build or
its sessions differ from B's, as proof 4 compares them. The manifest check
shows most rows as well, where the shape a defect rests on is a REFUSED value
class; the table names it where it shows what the row's other checks do not.
"Correction n" is the research claim `harness-findings.md` corrects under that
number.

One row is not reproduced: "12, same-type child", whose input no Nova document
holds ("What the lane does not observe", above). "20, CommTrack", which step 1
left out the same way, is a row again: Nova's gate admits the read it needs.

| Defect, part | Symptom | Shown by | Documents |
|---|---|---|---|
| 1, ids and `xmlns` | every module and form `unique_id` and form `xmlns` differs between A and B, so HQ gives every form a new version | proof 1 | any document, published twice |
| 1, local path | two `.ccz` exports carry different form `xmlns` | proof 1, local path | any document, exported twice |
| 1, language codes | adding a language whose code collides with an existing one, or removing one of a colliding pair, renames the existing language's code, and a build profile a person saved in HQ naming the old code then fails `create_all_files(profile)` ("Form does not contain any translations for any of the build languages", `xform.py::XForm.exclude_languages`) | proof 1 over the edit; the bar on B-edit, over A's build profile | `targeted-hq-side-state` (adds one, under a build profile saved over A); `localization-mandarin` (removes one) |
| 4, translations | a UI translation saved in HQ (`views/apps.py::edit_app_ui_translations`) is gone from `app_strings.txt` after the next publish, whose import replaces the app's translations with Nova's (`_merge_source_into_app`) | proof 2 | `targeted-hq-side-state` |
| 4, `auto_gps_capture` | the setting saved in HQ (`views/apps.py::edit_app_attr`) is set back by the next import, so each form's meta loses its location and its poll of the location sensor (`xform.py::XForm._add_meta_2`) and its submission the location | proof 2; proof 3 between A's and B's builds | `targeted-hq-side-state` |
| 5, table content | Nova's next push uploads its workbook for a table a person keeps in HQ (a field property, row attributes, owners and a description) with `replace`; HQ's upload sees another table (`run_upload.py::table_key`), deletes it and makes it again, so the table and its rows get new ids and lose the property, the attributes, the owners and the description | proof 1 (the project's lookup tables) | `targeted-hq-side-state` |
| 2 | `validate_app` fails with "Expecting 'QNAME', got 'AT'" (`helpers/validators.py`, the form's `validate_for_build`) | the bar | a form display condition on the loaded case's status, id, type or owner |
| 3 | the case properties HQ learns each form writes (`FormBase.get_all_case_updates`) and the data dictionary rows its save writes (`refresh_data_dictionary_from_app`) lack the properties Nova's Save to Case blocks write, and a Vellum save rewrites `case_references_data.save` | intent (HQ); proof 4 | a form with case operations, under a configuration with `save_to_case`, which HQ's refresh requires |
| 3, unknown question | HQ's form builder warns "Unknown question: #case/<property>" where a form reads a property only a Save to Case block writes, and not where an ordinary field writes it | proof 4 (Vellum's report) | `targeted-save-to-case-read` |
| 4, add-ons | an add-on a person turned on in HQ (`views/apps.py::edit_add_ons`) is gone after Nova's next publish, whose upload writes its own ten, and HQ's module page no longer offers the section | `proof/views/test_add_ons.py` (HQ's page in Chromium) | `search-multiple` |
| 5, the upload's answers | without the Lookup Tables privilege HQ's upload API answers Nova's push with its "Upgrade Required" page, status 200, and writes nothing; it takes a 32-character tag and fails with a 500 on a 33-character one | `proof/views/test_lookup_upload.py` (HQ's view, to Nova's captured request) | `lookup-app` |
| 12, what no editor offers | HQ's Case List page holds the control for an inline search, a multi-select list and an excluded search input only under `CASE_SEARCH_ADVANCED`, which Nova's publish does not ask for | `proof/views/test_case_list_offers.py` (HQ's page in Chromium) | `case-list-inline`, `search-multiple`, an expander search document |
| 14, `both_fixtures` | a device restores the flat location fixture by the app's own choice, and Web Apps by the project space's setting, so with that setting off the same app has its places on Android and none in Web Apps, where its form moves no case (finding 69) | `proof/views/test_location_fixture.py` (HQ's restore view, as a device and as Formplayer ask it) | `location-direct` |
| 20, CommTrack | Nova's gate admits a read of the session's `supply_point_id`; no session of a Nova app holds it, so the form does not open; under CommTrack HQ's build gives the form the datum only once a save in HQ's form builder has respelled the source, and then a worker without a supply point is refused the form (finding 68) | manifest; proof 4, then 2 and 3 | `targeted-supply-point-read` |
| 5, reserved substrings | a select over a table whose tag contains `casedb` reads the case database, and one containing `ledgerdb` the ledger database, not the table (`CommCareInstanceInitializer.generateRoot` tests `ledgerdb`, then `casedb`, before `fixture`) | intent (Core); manifest (the instance source Core gives the table) | `targeted-lookup-reserved-tags` |
| 6, CSQL | HQ's compiler raises `CaseFilterError` for an ordering against a time of day, and for `''` or a number compared with `date_opened`, `closed_on` or `last_modified` | intent (HQ): each CSQL string a run sends, compiled by HQ (`build_filter_from_xpath`); manifest: each search's CSQL, read by HQ's CSQL parser, falls in those comparisons' REFUSED classes | `targeted-search-hq-compile` |
| 6, Core | `'14:30' < '15:00'` is false on the device while the document orders it | intent (Core); manifest | `targeted-time-ordering` |
| 7 | HQ's profile sets `cc-show-saved` and `cc-show-incomplete` to `no`; Nova's `.ccz` profile omits both, which Android reads as yes | proof 3 across the two paths (the profile in the trace) | any document |
| 8 | a barcode or secret answer that breaks its authored validation is accepted (`FormEntryController.answerQuestion`) | intent (Core) | `targeted-validated-barcode-secret` |
| 9 | two `.ccz` exports of one document carry different profile `uniqueid`s, both at version 1, and Nova's profile declares no required CommCare version where HQ's does | proof 1, local path; proof 3 across the two paths | any document, exported twice |
| 10 | a list sorted by an ID-mapping or a select column is sorted by the label it shows on HQ's build and by the raw value in Nova's `.ccz`, so its rows come in another order on each path; so do an interval column with text and an image-map column (correction 3); the sort HQ places on the first of two columns that share a property orders the rows alike unless that column is one of these, and moves only the sort key (defect 51). An unsorted list differs only where HQ sorts its first column by a date or an image map (correction 10). Rows are compared by the case each selects, so a reorder is its order alone, and a sort key only one build gives a column is defect 51's | proof 3 across the two paths, over a case database holding "10" and "2" | `targeted-label-sort`; documents whose lists hold those columns |
| 12, related lookups | HQ's compiler raises without `CASE_SEARCH_RELATED_LOOKUPS` (`filter_dsl.py::_require_related_lookups_flag`) | intent (HQ), under the minimum configuration | `targeted-search-related-lookups` |
| 12, custom tile | a Case List save under `CASE_LIST_TILE` alone drops the custom tile | proof 4 under that configuration, then 2 | `targeted-custom-tile` |
| 12, single-date prompt | a Case List save without `CASE_SEARCH_ADVANCED` drops the date input | proof 4 under the minimum, then 2 | a search with a single-date input |
| 13, shadows | the saved form's calculate, relevance or constraint holds a predicate on a form path, which Core's parser rejects, so HQ's build fails | proof 4, then 2 | a constraint over a repeat's rows |
| 13, guard blocks | the saved form loses each guard's case-id bind, and HQ's case processing refuses the empty id (`AbstractCaseDbCache.get`, "case_id must not be empty") | proof 4, then 3 | case-type, retype and text guards |
| 13, reserved names | Vellum reports each `__nova_` node as not a valid question id | proof 4 | any form with an emitted node |
| 13, wrapper containers | Vellum asks to "Add at least one property to update, or deselect the Update action." on every Save to Case block that creates and updates a case inside a wrapper container (correction 9) | proof 4 | a form with case operations |
| 13, wrapper conditions and leaf guards | the save drops an operation's condition and its case-leaf constraints, so the operation always runs and Core accepts a blank or over-long value | proof 4, then 3 | a conditional operation and a guarded case leaf |
| 13, datetime leaves | the save drops the leaf's type and HQ stores only the date | proof 4, then 3 | a datetime written to a case |
| 13, root create id | the save turns a live create id into a load-time value, and a later update fails ("Unable to update or close case", `CaseXmlParser`) | proof 4, then 3 | a create keyed by a form answer at the form root |
| 13, `#form/` defaults and block ids | Vellum marks a default that reads `#form/…` and a read of another block's `case/@case_id` as errors | proof 4 | a default reading another answer; two blocks sharing a case id |
| 13, blank translations | the save fills an explicitly empty translation from the default language | proof 4, then 2 | a multilingual form with an empty translation |
| 14, non-writing follow-up | a Case Management save turns `update never` into `always` with a touch block, which HQ applies as an update | proof 4, then 3 | a follow-up form that writes nothing |
| 14, close conditions | the save strips an answer's surrounding quotes, and clears a condition on a question its tab does not offer, after which HQ's build of the saved app fails (correction 6); an answer holding `'` builds unescaped, so Core refuses HQ's build or reads another condition | proof 4, then 2 and 3; the bar (Core's admission of HQ's build); proof 3 across the two paths | `targeted-close-conditions`, `targeted-close-condition-unparsable` |
| 14, multi-select destinations | the form settings save refuses them, and HQ's build refuses the mismatch | proof 4; the bar | `targeted-multi-select-destinations` |
| 14, search settings | a Case List save resets the search button label and refuses a lookup prompt without a sort; the Case List page refuses to save an input named like a default filter, with an alert (`details/bootstrap3/screen.js::save`), and sends nothing; HQ's search takes an input with a reserved name as configuration or a filter | proof 4, then 3; manifest (the search keys HQ's search reads as its own, and a name a filter and a prompt share) | `targeted-search-button-label`, a lookup prompt, `targeted-search-default-filter-name`, `targeted-search-hq-compile` |
| 14, survey menus | the module's case type is `''` where the document holds one | intent (HQ) | `targeted-survey-menu` |
| 14, tiles | the save writes a font size and places unplaced columns, changing the suite, and aligns every custom-tile cell (defect 42) | proof 4, then 2 | a tile without sizes or positions; `targeted-custom-tile` |
| 14, data node name | Vellum's save rewrites the data node's `name`, which HQ reads as the submission's name | proof 4, then 3 | any form |
| 15 | Vellum rejects question ids with a leading underscore, a leading `XML`, or `meta`, and Connect ids of those forms; a question named `meta` in any case also loses its data node in HQ's build, so Core will not install the build, and HQ's form settings page warns of a meta block (correction 5); an entry-point id that is not a `slugify` fixed point fails the settings save under `SESSION_ENDPOINTS` (`views/utils.py::set_session_endpoint`). Renaming a Connect id under an opportunity that holds it breaks the opportunity: Connect refuses every delivery of a renamed deliver unit ("Payment unit is not configured for the deliver unit"), makes a second learn module of a renamed one, and completes no assigned task for a renamed task | proof 4; the bar; proof 4 over B-edit, on what Connect made of the edit's submissions | `targeted-invalid-question-ids`, `targeted-invalid-connect-ids`, `targeted-connect-deliver-rename`, `targeted-connect-learn-rename` |
| 16, hidden columns | a case list search no longer matches a hidden column's values, because Nova drops the column (`EntitySortUtil.sortEntities`) | intent (Core) | `targeted-hidden-column` |
| 20, sync on form entry | with the setting on, HQ's build gives the entry of each form that loads a case in a module that offers search a claim with no condition, and Core's session asks for a sync on that form entry (`CommCareSession.getNeededData`), which Android meets by clearing the session (`HomeScreenBaseActivity.launchRemoteSync`) | configuration sensitivity; proof 3 across the two paths, under the setting, where HQ's build's session takes a sync step the local archive's does not | a module that offers search; `targeted-sync-on-form-entry` |
| 21 | a Case List save where the Web Apps workflow selector shows turns list-first into search-first | proof 4, then 2 and 3 | any list-first menu in a project space that searches; `targeted-list-first-web-apps` |
| 23 | a Vellum save drops the Save to Case attachment | proof 4, then 3 | an attachment-mode capture |
| 24 | a Case Management save turns the inert subcase's relationship from extension to child | proof 4; proof 3 across the two paths | an extension child case |
| 25 | a Vellum save rewrites a query repeat into model iteration, whose rows are built by setvalues that run as the form loads. Where that breaks is a REFUSED class of the model-iteration entries (`lib/commcare/surface/entries/questions.json`): a repeat nested in another; a query reading an answer still blank where those setvalues run; and a repeat under a group that Core's load has already left not relevant there (its condition reads what an earlier load-time setvalue wrote) and that becomes relevant later: the repeat stays empty. Otherwise a group relevant later costs no rows: `FormDef.initialize` runs the load-time setvalues before it evaluates the form's conditions (`initAllTriggerables`), and a group whose condition nothing has evaluated yet reads as relevant (`XFormParser` leaves it so), so for a query that reads no form answer the repeat keeps its rows after the save, and one under a group never relevant submits none either way (correction 7) | proof 4, then 3; manifest | query repeats in those places, `targeted-query-repeat-places` |
| 26 | the form settings save drops a hidden link beside a visible one and clears a navigation fallback its page does not offer, which changes the stack | proof 4, then 2 and 3 | `targeted-form-links-hidden-and-fallback` |
| 27 | Vellum reports "Repeat Count is required." for a user repeat in a labelled group | proof 4 | `targeted-labelled-group-repeat` |
| 30 | Core serializes a second `nova_count_<repeat>` node holding a hidden value's count, truncated where the count is fractional | intent (Core), over the submission; manifest (a count from a hidden value that is not an integer) | `targeted-repeat-count-copy` |

The harness's own findings, numbered from 31, are in
`docs/research/2026-09-26-hq-round-trip/harness-findings.md`, each with what
goes wrong, its source evidence, where its harm shows, and the research claim
it corrects, if any.

### Adding a register entry and its control

1. Settle at source that the class is a defect and which: a numbered one, or a
   new finding in `harness-findings.md` with what goes wrong, its source
   evidence, where its harm shows and what research claim it corrects. A
   class every reader reads alike is a spelling rule, never an entry: its
   proof runs every one of those readers on both spellings ("Spelling
   rules"), and where one of them reads the two apart in any state a device
   or a project space can be in, it is a defect and an entry. A difference
   in what Android reads is an entry of the Android stage (an `android@...`
   artifact): the stage's failing item prints the class, and
   `python3 -m proof.android.stage show --out <its output>` lists every
   class with an example.
2. Name a non-fuzz document that shows it, or write a targeted document that
   does. Pin `values` only on a targeted document.
3. Retain that document from an emitted corpus, unless a control already
   retains it: `python3 -m proof.checks.controls <corpus> <document id>
   <check>[,<check>...]` writes `proof/controls/<document id>/` with the files
   those checks read and what they derive from the document.
4. Add the entry, run the document's checks and its control
   (`npm run proof -- proof/checks -k <document id>` and `-k control-<name>`),
   and confirm the entry holds what the check reported and nothing more.

### Identity moves

`proof/identity-moves.json` lists each identity change a migration decides,
`{"defect", "entity", "path"}`; proof 1 accepts exactly those. It is empty
until a step decides one.

## Spelling rules

A spelling rule erases one difference in how an artifact is spelled that no
reader of it depends on. The rules are a closed set in `proof/rules/`: each is
a module, `proof/rules/<rule>.py`, exporting
`RULE = SpellingRule(id, artifact_glob, description, normalize, readers)`, and
`RULES` in `proof/rules/__init__.py` lists them in the order the comparators
apply them. The comparators apply those and no others; the observation
compares raw builds without them, so registering a rule changes judgments
only. A rule that holds only under a condition (an empty update only beside
other actions, a tile cell only outside a custom tile) states the condition in
its docstring and leaves the artifact as it is elsewhere. A rule reads an
XPath expression's shape (a path of plain steps, a value that reads no node,
the functions it calls) only through `proof/rules/_xpath.py`, a port of Core's
XPath lexer that `proof/rules/test_xpath_reading.py` holds to Core's own
parser, and leaves an expression the port does not read as it stands.

The `setvalue-order` rule also reads the exact
`format-date(now() or today(), string literal)` shape as reading no node.
Core's `XPathFormatDateFunc` only formats its evaluated arguments. The
rule's proof runs both clock spellings before and after the other actions;
field reads, nested calls, wrappers and random or uuid date arguments stay
outside that shape and retain their order.

**A rule is proven by running every reader of its spelling on both
spellings.** Each rule has its own proof test, `proof/rules/test_<rule>.py`,
run in the lane as the `proof/rules` package. It publishes a corpus document
into HQ as Nova's publish leaves it, writes the app document or a form's
source both ways in forks of that state (`proof/rules/conftest.py`), and shows
that HQ builds both alike or, where HQ's build carries the spelling, that
Core's sessions over both builds and HQ's processing of their submissions
compare equal, and that the rule erases exactly the spelled difference. Where
the rule's condition does not hold, the test builds or runs the two spellings
there and shows that they differ and that the rule leaves them. Where a rule
leaves a spelling only to stay narrow (a neighbour HQ reads alike, such as a
preload's `if` condition, or a case the source settles and no corpus document
holds, such as a `send` between two setvalues), the test shows on the parsed
artifact that the rule leaves it. `conftest.py`'s `DOCUMENTS` names every
corpus document the tests read, and its `rule_documents` hands a test those
alone.

Where the spelling's readers reach past HQ's build and Core, the rule names
each in `readers`, with the test that runs that reader on both spellings
(`proof.rules.READERS`):

| Reader | How a rule's test runs it | Where the test is |
| --- | --- | --- |
| `formplayer` | each spelling released as HQ's Releases page releases a build and served by HQ's own views; Formplayer's own walk of each, compared by the lane's judge (`conftest.py::served_readings`, `formplayer_differences`) | the rule's own test module |
| `webapps` | HQ's Web Apps client shown the same walks in Chromium, under HQ's own stylesheets; its screens compared by the lane's judge (`client_differences`) | the rule's own test module |
| `connect` | HQ's own receiver and Connect repeater forwarding each spelling's submissions to one opportunity in CommCare Connect, whose answers, tasks and rows are compared (`proof.observe.connect`) | the rule's own test module |
| `android` | both spellings installed on a device and read by commcare-android's own code: the install, every profile reader, the home screen and every walk | a method of `proof/android/predicates.py`, which runs where the reader's runtime is (the `proof-android-runtime` job, on every run) |

`test_closed_set.py` fails while a module is unlisted or untested, while a
rule names a reader whose test does not exist, and while a rule that reads
what Formplayer hands on (the `formplayer` artifact, a Formplayer trace as it
is compared) names no test of the client that reads it. Android's method is
found by reading `predicates.py`, never by importing it: nothing in the image
runs it.

The rules whose readers reach past HQ's build and Core:

- **`connect-work-area-empty`** (finding 55): a Vellum save writes an empty
  `work_area_id` into a Connect deliver unit. Its test writes the form both
  ways, builds both in HQ, runs Core's sessions and Formplayer's walk over
  both, and has HQ's own receiver and Connect repeater forward each
  submission to one opportunity in Connect, which answers and holds the same
  for both; an id that names a work area is refused by Connect, and the
  rule leaves it. A device opens, walks and saves the form with the node as
  without it. Formplayer's traces take the rules for an `instance` (each XML
  document a trace holds).
- **`search-description-empty`** (finding 54): the Case List save writes a
  search description of no text. HQ's build gives the search a
  `<description>` for it, Formplayer hands the client a non-breaking space
  where it handed nothing, the client shows no description for either and
  the same screens throughout, and a device's search screen is the same; a
  description that holds text is shown, and the rule leaves it.
- **`tile-vertical-align-start`** (finding 42): the Case List save writes a
  vertical alignment of `start` into every tile cell. HQ's build writes the
  attribute, Formplayer hands the client `start` where it handed none, the
  client computes `align-self: start` for both, and Android's tile lays a
  text cell and an image cell out the same; `center` moves the cell, and
  the rule leaves it.

To add a rule: write `proof/rules/<rule>.py` and its test, list its `RULE` in
`RULES` where its artifact's rules apply, name each reader beyond HQ's build
and Core with its test, and add any document its test reads to `DOCUMENTS`.
Two spellings are a rule only where every reader reads them alike in every
state it can be in: the ten profile settings HQ's settings save writes at
their readers' defaults read alike on a device that never held another
value, and apart on one an earlier profile gave another, so they are
entries and a defect (finding 40), not a rule. When an emitter starts
writing the editor's spelling, the rule that erased Nova's former spelling
goes in the same change.

## The surface extractor

`proof/surface` regenerates `lib/commcare/surface/surface.json` from the
checkouts the image holds at the pins: every item HQ, Core and Android accept
in an app, keyed `<family>:<name>`, with the facts whose change matters (a
toggle's tag and namespaces, a field's choices, a gate's minimum version, an
API view's decorators with their arguments) and where each was read. Each
family is read from its authoritative source by the method that sees every
reader (`proof/surface/__init__.py` lists the families and their key
grammars): HQ's registries after HQ's own boot, Python's `ast` over HQ's
source, JavaParser and reflection over Core's and Android's Java, acorn over
HQ's JavaScript, and HQ's vendored Vellum run headless. Nothing matches source
text with a regular expression, and the same pins always give the same bytes.
The surface tests (`proof/surface/test_*.py`) hold each family to an
independent reading of the same source and plant a change into a copy of an
upstream file to show the extractor sees it.

In the lane the surface is one group of the early queue (`surface`); its
extraction is keyed by the image and the extractor's code
(`proof/lane/extraction.py`), and the gate holds it to the committed file.

## The evidence store and its audits

The lane reuses what it observed and judged only under keys that name every
input that could change it (`proof/store`). A document's record parts
(`proof.observe.record`) are kept under their part keys and the fingerprints
of the observation code, the image, the Postgres image, the architecture and
the observation's environment (the parts that drive the editors, B's and
B-edit's, name the browser's code in their own keys); each check's evidence on
a document under the document's files, the observation's and the browser's
code, every record it was judged from and the judge's code (which includes
both registers); a browser transcript under the observation's and the
browser's code (which start the browser, hand it what HQ does not answer and
record what it did), the platform, the environment and the run's spec and
first answer, replayed only where HQ, really run again, answers every recorded
request alike; and each package group's outcome under every file of the
harness and the corpus data its tests read (every document, or the sample a
test module names). While a part is observed, an audit hook refuses any read
of a file its key does not name, and any archive the Core runner is sent to
admit (`proof/store/guard.py`); an observation hook may declare only files of
its document's directory, so a document's key names everything any of its
parts reads. A control (`control:<id>`) is a document here: it keeps no
`inputs.json`, so the input files its part keys read and the guard allows
are computed from its own directory (`proof.observe.unit.input_files`), and
a run whose fingerprints and control files are unchanged judges or caches it
rather than observing it again.

The queue builder (`python3 -m proof.store.queue`, standard library and git)
reads the restored store and makes each group cached (its every judgment held
whole, its items passed: it runs nowhere, and the gate holds the stored
evidence to the register), judged (its records held: only its checks' judges
run) or observed. Documents that share a record part's inputs go in one block,
so the second reads what the first kept. `python3 -m proof.store.pack` makes a
snapshot of the shards' outputs, merges snapshots, and writes a pull request's
delta over main's with every blob its entries name; an entry whose blob no
source holds is dropped and read as a miss. A snapshot is one GitHub cache
entry: `index.json` and `blobs/`.

`PROOF_STORE` names the snapshot a run reads (`npm run proof` mounts it at
`/store`), and every run writes what it observes into `store/` in its output.
Inside the container `PROOF_STORE=off` turns the store off entirely (nothing
read, written or guarded), and without `PROOF_FINGERPRINTS` it stays off.
Outcomes and judgments are kept only from a run of the lane's own selection
(no pytest arguments, no `PYTEST_ADDOPTS`), and a package group's only from a
run in the environment its queue keys it under.

The register's hold over every judgment runs fresh on every pull request: the
gate holds each stored judgment to the register as it holds a new one. What is
reused is only what a key names whole, and the reuse is audited:

- **every pull request**: the queue builder marks documents fresh, chosen by
  the run's id, until they hold eight (document, configuration) units; each is
  observed whole and held to the store, a mismatch written under `audit/` and
  failing its group. A share of live editor runs (`PROOF_EDITOR_AUDIT`) is
  rerun on a fresh page;
- **nightly, on main** (`proof-audit.yml`): the whole lane fresh, nothing
  shared between documents and every editor view live, compared with main's
  newest snapshot (`python3 -m proof.store.audit compare`), then saved as the
  newest snapshot every pull request reads. A scheduled audit that fails opens
  an issue. A merge to main writes nothing to main's store (only the
  audit and the pin pull request's prewarm do, "Changing a pin", below), so
  a pull request opened right after a large merge is cold: its queue
  observes every group the merge changed until the nightly audit refreshes
  main's store;
- **weekly** (`proof-audit.yml`): four fresh runs. Three run a fixed
  24-document sample: a baseline, one with Nova's emission and HQ unseeded,
  compared with the baseline (equal once every drawn id and clock reading is
  read as one value, with defects 1 and 9 still showing), and one with HQ's
  speed seams off, compared with it (equal). A sampled run checks every control and package but only
  the sampled documents, so it holds each register entry naming a document
  the sample left out on its control alone ("Known defects", above). The
  fourth runs the whole corpus with every memo verified, every editor view
  rerun the slow way and every document's HQ branches held to fresh states,
  and must pass on its own, as each of the four must. Each runs the Android
  stage over what its shards observed, its queues keyed under the lane's own
  environment (`--lane-env`), but the unseeded one: its shards keep no
  document's records under a key (`proof/store/runtime.py`), so its Android
  queue is empty and its gate holds the shards' entries alone, as it reads
  from the shards' own record of their environment; the other three hold the
  Android entries. `proof-image.yml` compares the slim image with the full one
  and arm64 with amd64.

## How the harness proves itself

| Contract | Plausible failure | Where it is held |
| --- | --- | --- |
| The boot is offline and pinned | a socket other than the lane's Postgres, or a network cache, reached; another commit | `proof/hq/test_boot.py`, the image's self-test |
| HQ's state is complete | a path reaches a table or a Couch view the harness lacks | by construction: Postgres refuses a missing relation, the in-memory Couch raises on an unanswered view (`proof/hq/test_state.py`) |
| A unit's branches are fresh states | a restore that leaves a row, a sequence, a document or a blob behind | `proof/hq/test_branches.py`, against fresh databases |
| A seam changes only what it names | a flag read leaking from one check into another | `proof/hq/test_seams.py` |
| The same inputs give the same bytes | an unseeded draw or a real clock inside an operation | `proof/corpus/__tests__/emitCorpus.test.ts` (the corpus), `proof/hq/test_determinism.py` (HQ), `proof/checks/test_record_determinism.py` (the records), `proof/editors/test_seeding.py` (the browser), the weekly unseeded comparison |
| What a browser run asks HQ does not depend on how long it took | a page's poll reaching HQ in a slow run, or a hold that stops a timer a page needs | `proof/editors/test_polls.py`: a ten-second poll never runs, one just shorter does, and so do a quick poll and a longer one-off timer |
| The harness publishes as Nova does | bodies other than the ones Nova sends | `proof/corpus/__tests__/publish.postgres.test.ts`: the captured requests are the ones Nova's real `publishAppToHq` sends; `proof/hq/test_publish_capture.py`: an update applies only over the profile it was built from |
| The Core runner's traces are faithful | a trace that omits a difference | `proof/core/test_session.py`: one altered answer path changes exactly the runs that reach it |
| What runs is Formplayer's own application at its pin | another commit, or a runner that started something else | `proof/formplayer/test_boot.py` |
| HQ's form validation is answered by Formplayer's own controller, with HQ's own request | a seam that answers validation itself or signs HQ's request again; a report not Formplayer's | `proof/formplayer/test_validation.py`, `proof/hq/test_build.py` |
| Formplayer's walk gives the same bytes and is faithful | an id or an install left unmarked; a trace that loses a difference | `proof/formplayer/test_walk.py`, `test_canonical.py`, `test_observe.py` |
| What answers Formplayer in the lane is HQ | a request answered from outside HQ, a submission acknowledged and not processed, a walk that passes with no worker signed in | `proof/checks/test_served.py` |
| A served state gives the same bytes, and each reader shows a planted difference and only it | an id HQ, Formplayer or the browser drew in a record; a walk or a screen reading that loses a difference | `proof/checks/test_served.py`, `proof/formplayer/test_observe.py` |
| A run of a walk leaves HQ as it found it | a run reading the cases an earlier run's submission made | `proof/checks/test_served.py` |
| The release Formplayer installs is the build the other checks read | a release built from another state | `proof/checks/test_served.py`, and `release@<state>` on every document |
| HQ's commit callbacks run where a commit would, and its locks are a real Redis's | a callback run before the rows it reads exist, or after a rollback; a lock answered by a stand-in | `proof/hq/test_commits.py` |
| The Formplayer runner is always joined | a JVM, a Redis or a database left behind | `proof/formplayer/test_lifecycle.py` |
| What a Web Apps session runs is HQ's own page, bundle and stylesheets on Formplayer's own answers, each build under its own id | a stubbed answer, a page with no stylesheet, a request around Formplayer's security chain, an earlier build's install | `proof/webapps/test_session.py` |
| A document's Web Apps record reads every screen and gives the same bytes | a screen read before its click's answer rendered; an id or a time reaching a screen | `proof/webapps/test_observe.py` |
| Proof 2 compares everything HQ builds | a file left out | `proof/checks/test_build_files.py`: a file no comparator reads refuses the comparison |
| Each spelling rule is sound | a rule that hides a real difference | `proof/rules/test_<rule>.py`, and `test_closed_set.py` for an unlisted or untested rule |
| A rule's readers beyond HQ's build and Core are each run on both spellings | a rule proven for HQ and Core alone that Formplayer, the client, Connect or a device reads apart; a rule naming a test that is not there | `test_closed_set.py` (each named test exists; a rule reading Formplayer's answers names a client test), the named tests of `proof/rules`, and the named methods of `proof/android/predicates.py` |
| What reads a device's archives is commcare-android's own code at its pin | a reader that answers from something other than the app's classes; a runtime built from another commit; a classpath the app does not ship | `proof/android/selfcheck.py` (the reader held to itself, and a planted difference Android must show), on every run of the `proof-android-runtime` job |
| Each Android predicate a register entry or a rule rests on holds on both spellings | an entry claiming a harm a device does not show; a rule erasing what a device reads apart | `proof/android/predicates.py`, on every run of the same job |
| The Android stage reads each archive once and judges like a shard | an archive read twice or never; a planted difference passing; a control judged by another stage's entries | `proof/android/test_stage.py`, `proof/checks/test_android.py` (a stand-in reader, in the lane) |
| HQ's own pages and views answer a real Nova export | a page read before its bindings ran; a view answered around its decorators; a request other than the one Nova's client sent | `proof/views/test_*.py`: each pairs what it shows with its counterpart (the flag on, the privilege granted, the project setting on) |
| An aligned source keeps its own spelling | HQ's build of B aligned to A reading a source another way than it reads B's own (its CommTrack test is a substring test on the stored text) | `proof/checks/test_alignment.py` |
| The register is strict | a fixed defect left listed, or a new failure absorbed | `proof/checks/test_registers.py`: removing any one entry fails |
| The editor driver saves as HQ does | a page rendered without HQ's template gates | `proof/editors/test_control.py` |
| A reused page and a warm Vellum host save as fresh ones | state one view or form leaves for the next | `proof/editors/test_view_equivalence.py`, `test_vellum_warm_equivalence.py`, and the in-band audit |
| Judges are pure | a judge that runs HQ, so a stored record no longer stands for its observation | `proof/checks/test_judge_purity.py` |
| A stored record stands for a fresh one | a key that misses an input | `proof/store/test_keys.py`, `test_guard.py`, the per-pull-request audit sample and the nightly audit |
| Forked workers observe what one session does | state a fork shares | `proof/lane/test_forkserver.py` |
| Connect runs at the pin, each scenario alone | a virtualenv from another commit's lock; a row or queued task one scenario leaves the next | `proof/connect/test_runtime.py` |
| What reaches Connect is what HQ's own receiver and repeater sent | a payload built beside HQ's repeater; a forward acknowledged without reaching Connect; an opportunity made from an archive HQ did not serve; a project space forwarding without Data Forwarding | `proof/connect/test_forwarding.py` |
| A Connect document's records hold every state, give the same bytes, and are the same under a stored part | a state that forwards nowhere; a run reading another's rows; Connect's address or a drawn id in a record; an opportunity made again from another release | `proof/checks/test_connect_unit.py` |
| The Connect judge shows a planted difference and only it | a row difference lost or reported with what follows a refusal; two spellings Connect read alike reported; an added unit read as a moved one | `proof/checks/test_connect.py` |
| The manifest names only what exists | a dangling key or gate | `lib/commcare/surface/__tests__/manifest.test.ts`, in ordinary CI |
| Nothing Nova emits is unclassified | an export using an item no entry names, or HQ reading a flag no gate entry names | the manifest check |
| The surface matches the pins | a hand edit or a stale regeneration | the gate's surface section |
| The weekly pin pull request reports every outcome once | no change, a second pull request, how CI starts left unsaid, pins without their image, a failure that reports nothing | `proof/upstream/__tests__/pins.test.ts`, with controlled `git` and `gh` |

## The Connect proof

`proof/connect` holds what runs CommCare Connect at its pin (its runtime, its
driver and HQ's forwarding, which a Connect document's unit uses: "Connect in
the unit", above) and the package's own tests, which run scenarios the unit
does not: a manager who asks for an app's units again, pays for a renamed
unit or turns a verification on, a second visit, and each name Connect's
receiver looks for. They run in the lane as the package group
`proof/connect`:

```bash
npm run proof -- proof/connect
```

### The chain

Every link is its owner's code:

1. **Nova** exports the app (the corpus document's captured publish and its
   local `.ccz`), and for a document that carries the edit renaming its
   Connect ids, the publish and the local archive of the edit.
2. **HQ** imports and builds it (`proof/rules/conftest.py::published`, the
   path every spelling rule's test takes), applies Nova's publish of the edit
   over it and builds that, and builds the form as its own form designer
   saves it (`proof.editors.vellum`).
3. **Core** fills and submits the form on each build and on each local
   archive (`proof.core`, the script derived on HQ's build and replayed on the
   rest), on the lane's day and on the day after.
4. **HQ** receives each submission and forwards it
   (`proof/connect/conftest.py::_forwarded_by_hq`): the submission is posted
   to HQ's own receiver view as a device posts it, HQ's receiver takes it
   whole, and HQ's own Connect repeater sends the payload, with a token it
   asked Connect for, to a served Connect over a real connection
   (`proof/connect/hq.py::forwarding`). The payload is read where it
   arrived, so its bytes are the ones HQ sent.
5. **Connect** reads the app's learn module, deliver unit and task from HQ's
   archive (`opportunity/tasks.py::sync_learn_modules_and_deliver_units`,
   `app_xml.py::get_task_units_for_app`) and receives each payload through
   its own URLconf, OAuth authentication, serializer and request transaction
   (`/api/receiver/`, `form_receiver/views.py::FormReceiver`,
   `processor.py::process_xform`).

What stands in for a person or a machine the lane does not have is written
down where it is done: the opportunity, its worker, a payment unit, the claim
and an assigned task are made through Connect's models with the factories
Connect's own tests use (`proof/connect/driver.py`); in a scenario of these
tests Connect's download of an app's archive is answered with the archive HQ
built (the unit's is answered by HQ's own view); and a device's location
fix is written into the submission's own location node
(`proof/connect/hq.py::with_fix`).

### The runtime

`proof/connect/runtime.py::ConnectRuntime` fetches Connect at its pin, starts
a Postgres 15 with PostGIS and a Redis from the image as processes of its own
(`proof.processes`), and runs Connect's own `manage.py migrate` once into a
template database. One runtime serves a session
(`proof/observe/services.py::connect`), started the first time a test or a
Connect document's observation asks. It runs Connect two ways, each on
Connect's interpreter and virtualenv with Connect's own test settings, in a
clone of the template over an emptied Redis:

- **a scenario** (`ConnectRuntime.run`): one run of `proof/connect/driver.py`
  over a list of steps (make the opportunity, sync, pay for deliver units,
  claim, set verification flags, assign a task, post a payload), whose
  result holds, after each step, every row the receiver reads or writes, by
  the names the app and HQ gave them, and the tasks Connect queued;
- **a session** (`ConnectRuntime.session`): Connect served for as long as an
  opportunity is observed. Connect's WSGI application answers on a loopback
  address of the worker's own, where HQ's repeater reaches it, and the same
  steps are taken one at a time. A request Connect makes of its HQ server is
  handed back to the harness, which answers it with HQ's own view; one to
  ConnectID is recorded and fails. A session keeps named copies of its
  database and goes back to one, which is how each run meets the
  opportunity as it stood.

Starting the runtime costs about thirteen seconds (the fetch two, the
migrations ten), a scenario under one, and a session about one.

### What the package's tests hold

`proof/connect/test_forwarding.py` holds the chain itself (above, "How the
harness proves itself"). `proof/connect/test_receiver.py` states each of
these as a test, over `targeted-connect-deliver-rename` and
`targeted-connect-learn-rename` (a deliver app and a learn app that each
carry the edit renaming their Connect ids), and, for finding 60,
`connect-deliver-default`, `targeted-connect-deliver-key-names` and
`targeted-connect-learn-key-names`:

- Connect reads exactly the authored learn module, deliver unit and task from
  HQ's builds.
- A learn submission and a delivery, from HQ's build and from Nova's local
  archive, each received under the app's id, leave Connect the same rows: the
  module completed and the assessment scored; the visit approved and paid.
- Nova's local archive names no submission URL. Its submission, received with
  no app named, is forwarded with a null app id and Connect refuses it.
- Finding 34: with GPS verification on, a delivery with no location is
  flagged and left pending, the local archive's always; the distance check
  passes over it on both sides.
- Finding 55: the empty `work_area_id` a Vellum save writes leaves the same
  rows.
- Defect 15: after a rename, deliveries are refused ("Payment unit is not
  configured for the deliver unit") until a manager pays for the new unit; a
  renamed learn module leaves a later learner at half, never finished; a
  renamed task never completes the task a worker was assigned, which then
  rejects each of the worker's deliveries.
- Finding 60: a block whose id is one of the names the receiver looks for
  (`task`, `deliver`, `work_area_update`, `module`, `assessment`) fails the
  receiver on every submission of its form.
- Finding 61: a deliver form that also holds a task loses its own visit while
  the task is assigned.

Each run leaves, under its block's `connect/`: each document's archives, each
path's submission and HQ's payload for it (`<document>/`), every scenario's
steps with the rows after each (`scenario.<name>.json`) and its timings; the
runtime's logs, with each session's, are under `connect-unit/`.

## Native proofs

The native proofs read Nova's exports with the systems that consume them: HQ's
own classes regenerate what HQ builds from each export, and CommCare Core's
own parsers, form entry, session engine and case processing run both paths
(Nova's CCZ and HQ's regeneration). They live in `proof/native/` and run in
the proof lane like every other check.

A native proof stays only where it proves something the checks over the corpus
(`proof/checks`) do not. Every admitted document a producer emits is a corpus
document too, but for the two nested-menu shapes Nova's publish refuses
(`proof/corpus/producers.ts` builds each from the producer's fixture module,
and the expander corpus comes from the same capture of `expander.test.ts`), so
the checks already hold each one to the bar (Nova's publish, HQ's whole
`validate_app()` and `create_all_files()`, and Core's admission of HQ's build
and of the CCZ, which parses the suite, the profile, the strings and every
form), to the structural intent checks, and to proofs 1 to 5. What stays
native is what those cannot say: values fixed by hand from what a document
authors, read back from Core's runtime with chosen answers and case data (the
checks' sessions answer from a fixed table, and their intent checks read
structure); whole suite elements compared between the two paths (proof 3
compares only what its sessions reach, and no session opens an endpoint); HQ
code no check runs on these inputs (Connect's extractors, the flat location
fixture, the lookup workbook reader, the CSQL compiler on the queries Core
builds from chosen answers, HQ's validators and its language-code rule); and
inputs that are not corpus documents (wire corpora, pre-fix controls, and the
shapes Nova's publish refuses). An HQ step whose family has no HQ check of its
own still runs, because its Core classes read what it regenerates.

```bash
npm run proof -- proof/native                        # every native proof
npm run proof -- proof/native/test_case_emission.py  # one family's HQ checks
npm run proof -- proof/native -k media               # a family across HQ and Core
```

### How a family runs

A family is one corpus, and each runs as one chain:

1. **The producer** (`proof/native/producers/emit-*.ts`) builds its admitted
   Nova documents from the same fixture modules Nova's ordinary tests use, and
   emits them through Nova's real expander (`expandDoc`) and CCZ compiler
   (`compileCcz`) into `native/<family>/` (below). Two families come from
   Vitest suites that already build them: `expander`
   (`lib/commcare/__tests__/expanderEvidence.ts`, run by `expander.test.ts`
   with `NOVA_EXPANDER_EVIDENCE_DIR`) and `hq-oracle` (`hqJsonOracle.test.ts`
   with `NOVA_HQ_ORACLE_EVIDENCE_DIR`). `npm run proof` runs each inside the
   image from the checkout, with the Linux `node_modules` it mounts. CI's
   shards mount none: there `quality` runs every producer once
   (`python3 -m proof.native.produce`, `proof/native/produce.py`) and the
   corpus carries what they wrote as `native/`, which the session copies in
   place of producing (`NativeSession.family`), a producer's failure with its
   output.
2. **The HQ step** (`proof/native/steps/`) imports each export into HQ
   (`Application.from_source`) and runs the HQ classes the proof names,
   writing each regenerated artifact beside its input: `<scenario>.hq.xml`,
   `<scenario>.hq-suite.xml`, `<scenario>.hq-details.xml`, and the like.
3. **The HQ checks** (`proof/native/test_*.py`), for the families whose HQ
   output carries a claim the corpus checks do not make, assert what HQ
   produced against the export and write the family's evidence record
   (`<family>/<proof>.evidence.json`: the HQ commit, the source and artifact
   digests, and what was compared).
4. **The Core classes** (`proof/native/core/*.java`, JUnit, package
   `nova.compatibility`) run in Core's own Gradle test build at the pin,
   compiled into Core's test source set by `core/native-proof.init.gradle`,
   offline against the image's Gradle home. Gradle runs every class once per
   session, after every family's producer and HQ step, and
   `test_core_runtime.py` reports one class per test from its JUnit XML, so a
   failure names the class, each failing method, and anything that failed
   before Core for that family.
5. **HQ payload checks** read what three Core classes write back
   (`NavigationRuntimeTest`, `CsqlFunctionRuntimeTest`,
   `CsqlQuoteRuntimeTest`): the search queries Core's query manager builds,
   which HQ's case search compiler then compiles.

`NativeSession` (`proof/native/session.py`) runs each producer, step and
Gradle build once per session, whichever test needs it first, and produces
every family the selected tests name at the start, several at a time. It
empties its `native/` directory when the session starts, so no earlier run's
artifact stands in for this one's.

HQ runs on the harness's shared boot, state and seams (`proof/hq`), one
project space per check (`proof/native/hq_support.py::native_check`): the
proof's domain, the flags HQ answers on (every other flag is off), the
privileges its plan grants (every other is refused), and HQ's default build at
CommCare 2.53.0, the version these proofs have always built at (2.60.0 for the
HQ-JSON oracle, whose probes carry no build of their own). Proofs that build
remote requests also name Nova's server (`https://www.commcarehq.org`) as the
app's base URL and as HQ's own address. Formplayer's form validation is
Formplayer's own application (the session's validation Formplayer). The network is refused except for the lane's Postgres,
and a step or test that reaches for anything else fails.

### What each run leaves

The native proofs write into `native/` under `PROOF_OUT`, which in the lane is
the directory of the block that runs them (`<output>/blocks/<block>/native/`,
`proof/lane/blocks.py`; a local `npm run proof` runs one block). In it:

- `<family>/`: the producer's corpus, HQ's regenerated artifacts, each proof's
  `*.evidence.json`, and the files Core writes back for HQ.
- `logs/`: each producer's output, and the Connect fetch.
- `core/<run>/`: Gradle's output (`gradle.log`) and the JUnit XML (`junit/`)
  of each Core run (`suite`, and `media-certificate`).
- `timings.json`: what each producer, step, fetch and Core run cost.

Core loads each family's artifacts from its own classpath namespace,
`/<family>/<file>`: the test JVM's classpath holds that `native/` and the
checked-in controls in `proof/native/core/resources`, each with one
subdirectory per family, so two families' scenarios of the same name never
meet. Every class runs in one test JVM, as Core's own tests do; none reads
Core's static state (the global localizer, the reference manager's roots) as
another left it, so the suite passes with its classes in any of the orders
tried and with a JVM per class.

### Adding a family

Add its producer under `proof/native/producers/`, name it in
`proof/native/families.py` (`FAMILIES`, and `CORE_CLASSES` for each Core class
that reads it), add its HQ step to `proof/native/steps/` and `STEPS`, and its
checks to a `test_*.py` whose module names the families it reads in
`FAMILIES`. Its documents join the corpus through `proof/corpus/producers.ts`,
so give the family a native check only for what the corpus checks cannot say
(above). A Core class loads its resources from `/<family>/...`, and writes
anything it hands back to HQ into `NativeProof.familyDirectory(<family>)`.

### The families

#### Case emission (`case`, `relation-instance`)

The case producer emits strictly admitted documents through the real expander
and CCZ compiler. Six extension scenarios (registration, followup, user
repeat, query repeat, multiple selected parents, and repeats under multiple
selected parents) each create two extension cases with an ordinary child
between them; registration also links to the first new extension, and an
extension carries a captured file, including the combined repeat and selection
scope. The same fixtures drive `extensionCaseEmission.test.ts`. Two documents
write a worker record from a survey and from a followup form
(`usercaseWriteWire.test.ts`); the followup app has a separate browse module.
Five capture documents combine both capture modes on registration, followup,
user repeats, query repeats and multiple selected cases
(`caseCaptureEmission.test.ts`). Twelve operation documents cover submission
order, conditions, retypes, generated and authored repeat ids, scalar bounds,
dynamic links, relation context and nested-menu selection
(`caseOperationEmission.test.ts`), and one more document covers operation
relevance. The `relation-instance` producer emits four admitted forms that
count, condition on, test for and read the absence of related cases.

HQ's basic case builder ignores `OpenSubCaseAction.relationship`
(`xform.py::XForm._create_casexml` calls `add_index_ref` without it, so every
index is `child`), and HQ allocates new-case datums for subcase actions whose
condition is `never`. Nova therefore carries the extension transaction in the
source XForm, keeps the action as navigation metadata with its condition
`never`, and HQ gives the redundant generated case `relevant="false()"`. The
local CCZ omits that inactive transaction; both paths use the same generated
case id, and repeats generate ids per iteration.

The HQ checks run `Application.from_source`, `XForm._create_casexml`,
`EntriesHelper.get_new_case_id_datums_meta` and HQ's navigation matcher, and
assert both extension indices with their attributes, every inactive native
case path, the complete create-datum list and the registration link match; a
separate `add_case_preloads` call checks the owner preload. The worker
scenarios run with HQ's `USERCASE` privilege and add `XForm._add_usercase`,
`EntriesHelper.get_extra_case_id_datums` and `add_usercase_id_assertion`:
every worker-case bind equals the CCZ's, and the datum and assertion join the
suite entry. Capture and operation forms are regenerated whole
(`add_case_and_meta`, `strip_vellum_ns_attributes`) and carry no editor
attributes. The relation-instance forms are regenerated the same way for
`RelationInstanceRuntimeTest` and have no HQ check of their own: the corpus
checks build them (the bar) and hold the operation's write to a case block of
the form HQ built (intent). Expansion allocates fresh HQ ids and form
namespaces, so the recorded digests identify one run's artifacts; they are not
fixed expectations.

In Core, `CaseCaptureRuntimeTest` (ten methods) runs `FormParseInit`,
`FormDef.initialize`, form-entry traversal, answer propagation, XPath
evaluation and `XFormSerializingVisitor` over both paths' capture forms, with
only the session and existing case data supplied. User repeats are created
through the entry controller; query repeats materialize through entry events.
It checks distinct attachment file names and submission URLs, hidden questions
omitting both case writes, an active blank URL clearing one property,
untouched neighboring rows keeping their URL, capture fields starting empty on
followup, and child indices naming the selected parent; the multiple-parent
document writes shared file names to both ids, and all-blank shared answers
omit the whole ordinary update. `CaseOperationRuntimeTest` (26 cases, both
paths) seeds native `Case` records in Core's indexed in-memory storage, reads
them through `CaseInstanceTreeElement`, finalizes with `postProcessInstance`
and applies the submission through `XmlFormRecordProcessor` and
`CaseXmlParser`. Its assertions inspect the stored cases: generated and
authored ids, conditional create and retype dependencies, snapshot reads,
final writes and closure, link creation and removal, scalar normalization and
bounds, nested-menu child selection, parent updates through the child's saved
relationship, and repeat-local relation conditions. Datetime writes keep the
instant `now()` gives; active blank answers clear a saved value and excluded
answers leave it. The sequence form also captures recorded-time text with
`format-date(now(), '%Y-%m-%d %H:%M:%S %Z')` and formats a typed datetime answer
after `coalesce` unpacks it. Core's supported function-handler seam controls
only `now()`; Nova's emitted types, calculations, defaults and plain/Markdown
prompts run unchanged. Independent `java.time` expectations cover eight
instants across four writer zones and four reader zones, including year and
leap-day rollover, fractional offsets and both sides of daylight-saving
transitions. The text retains the writer's clock and offset when displayed
directly. This does not establish viewer-local conversion of stored datetime
strings or an absolute chronology scalar from them.
A two-row query reuses an authored key and confirms the
accepted same-type merge. Invalid keys, names, owners, external ids and
dynamic link targets raise `InvalidStructureException`, and the accepted
counterparts run in the same harness. `OperationRelevanceRuntimeTest` reads
the local CCZ form only: an operation reads an excluded question as blank,
keeps a hidden calculated value, and creates nothing from an excluded repeat.
`RelationInstanceRuntimeTest` runs the four relation consumers on both paths
with zero and two matching children, plus unrelated and wrong-type rows, and
keeps the pre-fix form from Nova `bffd10f7`
(`core/resources/relation-instance/before-related-count-instance.xml`), which
must fail initialization on its missing `casedb` declaration.

None of this sends a submission or applies a server case transaction: Core's
in-memory storage applies records as the parser visits them, so it does not
establish rollback, and neither Android nor HQ's case processor runs.

#### XML text and well-formedness (`xml`)

`proof/native/xml/well-formedness.json` is one syntax corpus shared by Nova's
own gates (`lib/commcare/__tests__/xmlBoundary.test.ts`) and HQ's libxml:
legal Unicode range edges, illegal literal and referenced characters, scoped
namespaces, duplicate expanded attribute names, and comments and CDATA holding
literal reference spellings. libxml, as HQ's lxml runs it, must give each case
its recorded verdict. DTD and XML 1.1 refusals are Nova policy (`policyOnly`),
not malformedness, and are not claimed.

The four `proof/native/xml/before-audit-*.json` files keep source content Nova
emitted before its XML audit; their documents passed Nova's schema and commit
validation, and HQ's import must fail to parse all four. The producer checks
that admission and serialization now refuse those characters. The Unicode
scenario must parse in HQ, and in HQ's parse and the CCZ alike the label reads
its exact decoded text and the default keeps its tab, newline and carriage
return; the profile carries the app's name. `XmlTextRuntimeTest` then
initializes both forms in Core, asserts that default and reads the prompt with
accents, combining marks, non-Latin scripts, emoji and C1 characters.

That admitted document also contains adjacent reference outputs separated by
paragraph breaks, spaces, tabs and carriage returns, plus boundary whitespace,
Unicode spacing, embedded NBSP and escaped literal markup. The same fixture
feeds ordinary exported-structure tests and the proof corpus. HQ source, local
CCZ and HQ-regenerated XML retain ASCII separators as literal outputs; Unicode
whitespace and embedded NBSP use ASCII JSON outputs so HQ indentation and
Vellum's NBSP replacement preserve their values. Literal markup stays text.
The ordinary proof consumes full HQ builds and both Vellum saves. Core reads
exact plain and Markdown labels, hints, help, options and validation messages
with one and three meals in English and Spanish. Validation messages use
protected raw constraint expressions, read through `jr:constraintMsg` without
body alerts.
These are native text-value checks, not browser or Android typography checks.

#### Case tiles (`tile`)

Eight admitted documents cover row and tile layouts, visible borders and
shading, hidden placement and sort, explicit one- and two-row groups, search,
persistent tiles and a formless browser. HQ's `DetailContributor` regenerates
every detail from the HQ JSON, and the check compares decoded grid and style,
values, sort rules, group settings and action counts with the CCZ's details.
Absent and false border flags mean the same to the consumer. Child order is
not compared: HQ can append search after the group, and Core accepts both.
This is detail regeneration, not a full HQ build.

`TileSuiteRuntimeTest` (sixteen cases) parses the whole local suite or HQ's
regenerated details through Core's `SuiteParser` with resource installation
off, and inspects `Detail` and `DetailField` values, maximum grid dimensions,
hidden sorting, explicit and inherited style, and group header depth; local
suites also resolve the form and browse entries and the entity and computed
datums of persistent details and group companion data.
`TileGroupingRuntimeTest` completes case selection in three grouped variants
and checks the computed parent ids; the retained pre-fix suite
(`core/resources/tile/before-grouped-tile-instances.suite.xml`) must throw for
its missing session instance. Neither is a renderer test.

#### Navigation forms and search payloads (`navigation`)

HQ regenerates the eleven forms of eight admitted documents and allocates the
registration datum (`case_id_new_patient_0`, `uuid()`) Nova's suite names.
`NavigationRuntimeTest` (six methods) covers saved-value and default
precedence (including a stored blank) and normalized registration external ids
on both paths, suite instances for module and case conditions, case nodes for
empty and whitespace owner exclusions, link and fallback frame selection, and
`RemoteQueryDatum` payloads for supplied and absent prompts. It writes the ten
search queries Core builds (`navigation/nova-search-payloads.tsv`), and
`test_search_payload.py` compiles them in HQ's CSQL compiler to complete
filters: leap-day arithmetic and UTC half-open date and datetime ranges on the
right property. A property wrapped in a value function must raise
`CaseFilterError`. No Elasticsearch request or search screen is claimed.

#### Search, prompts, CSQL functions, quotes and links

Six corpora go through the same HQ suite contributors (advanced search on),
and every `<entry>` and `<remote-request>` is compared whole: attributes,
decoded text and child order.

- `search`: twelve admitted apps cover inline, browse and remote search;
  single, multiple and parent selection; automatic, hidden, advanced and
  defaulted prompts; and automatic and explicit registration links. Exactly
  two differences are asserted present and set aside: HQ's explicit unfiltered
  `match-all()` query, and Nova's ordinary collection-instance declaration
  that no suite expression reads. `SearchRuntimeTest` (seven methods) parses
  both paths: entity nodesets exclude related rows and wrong case types, the
  inline open-case filter and parent selection hold, and remote search keeps
  its different status behavior. Detail templates read a typed supporting
  parent and refuse the same id under another case type. `PostRequest`
  evaluates claim parameters and relevance for single, parent and multiple
  selections. `CommCareSession` selects the query and
  `RemoteQuerySessionManager` owns default answers and input instances. Both
  form-link frames hydrate the newly created case; the retained pre-fix suites
  (`core/resources/search/before-manual-search-link.*`) must be refused,
  because the later manual datum cannot supply an earlier step.
  `test_search_validation.py` runs HQ's own validator methods over three of
  these apps and their paired counterexamples (see `searchFirst.ts`).
- `prompt`: three admitted documents (widget metadata and lookup choices,
  numeric and quote guards, dependent computed values with location guards)
  match without exception. `SearchPromptRuntimeTest` (four methods) runs both
  suites through the query manager with the emitted lookup rows and
  source-language strings: required conditions, combined author and CSQL
  rules, visible and hidden defaults, labels and parameters, removal of
  unavailable selections, numeric and location guards, and quote obligations
  shared by two composed answers; the lookup value is checked in the CSQL
  payload. The evidence is the prompt family's `search-emission.evidence.json`
  and Core's JUnit report for the class.
- `function`: two admitted apps. `CsqlFunctionRuntimeTest` feeds emitted
  lookup rows to date, datetime, numeric and date-arithmetic arguments, and
  changing session data changes a conditional nested argument. It writes
  twenty query payloads and twelve relation and matcher arguments
  (`function/nova-function-*.tsv`); HQ compiles the queries to independently
  specified complete filters and parses the arguments into their relation and
  case-type trees, without running a relation query. The pre-grouping quantity
  must be refused.
- `quote`: the `runtime-quotes` app. `CsqlQuoteRuntimeTest` drives twelve
  answer states on each path through the query manager, including clearing and
  an explicitly present empty answer, and checks prompt errors and refusal
  values even when prompt validation is bypassed. It writes the 144 queries
  (`quote/nova-quote-payloads.jsonl`); HQ compiles 130 to complete filters and
  refuses the 14 that mix both quote marks. Query-like text stays one literal,
  and absent inputs differ from explicitly empty ones.
- `static-quote`: one admitted app. `StaticQuoteRuntimeTest` compares four
  retained pre-fix refused queries
  (`core/resources/static-quote/before-static-quote-branches.suite.xml`,
  exported before the admission fix at Nova `06f097e1`; never regenerate it
  past current validation) with four safe queries on each current path.
- `form-link`: seven admitted apps. `FormLinkRuntimeTest` checks ordered stack
  frames, conditions and selection values; a missing source raises, and an
  empty source never prompts for the target case.

None of these sends a search, a claim or an HTTP request.

#### Location owners (`location`)

HQ's flat location fixture is built from real places: the check's project
space holds the location types region, district and clinic, the location data
fields `ward` and `unset`, and each scenario's places, saved through HQ's own
models, and `FlatLocationSerializer.get_xml_nodes` serializes them with its
index schema and lineage attributes. Four scenarios cover two complete
branches, an empty footprint, a missing destination and a skipped intermediate
place; HQ also regenerates the three owner forms. `LocationOwnerRuntimeTest`
(five tests) parses these exact restores into Core's fixture storage and runs
both paths' forms through initialization, entry, serialization and case
processing: both branches reach their exact destination, a skipped non-owning
place stays valid, ordinary worker ownership needs no location data, and an
empty fixture or a missing destination is refused. HQ's footprint query and a
remote restore are not claimed.

On Android, a form's case processing runs in one user-database transaction
marked successful only after `FormRecordProcessor.process` returns
(`FormRecord.updateAndProcessRecord`,
`FormSubmissionHelper.checkFormRecordStatus`, at the Android pin), so the
invalid-case guard keeps a refused form from committing. The Android stage
runs it: wherever a device does not save a form, it records whether the
device still holds the cases it held as the form opened, and reports a
refused form that changed one
(`/walks/*/steps/*/form/saved/applied-though-refused`, "The Android stage").

#### Media (`media`)

The media chain interleaves HQ and Core. HQ's first pass writes each form
source with `XForm.strip_vellum_ns_attributes` (`<scenario>.validation.xml`),
the bytes HQ sends Formplayer; Core parses exactly those
(`MediaRuntimeTest.sourceFormsParseWithRealCoreBeforeHqMatching`, run alone
before HQ's main pass) and writes their digests to
`media/core-validated-sources.properties`. HQ's main pass then regenerates
each scenario's form, suite, strings, profile and media suite, and the media
suite's local resources must equal the CCZ's. With media, HQ's whole bulk
upload task runs over Nova's upload zip on the harness's Couch and blob store:
it completes with no error, unmatched or skipped file, classifies three
images, one audio and one video, maps each zip entry to the form path HQ
derives, stores exactly the uploaded bytes and records the project space as
each file's owner. Every form HQ sends to Formplayer on the way must be one
Core certified, and Formplayer's own controller validates it. `MediaRuntimeTest` then
installs both paths' media resources and resolves prompts and image maps; no
remote download or rendering is claimed.

#### Connect (`connect`)

Connect's metadata extractors (`commcare_connect/opportunity/app_xml.py`) run
at the pin `proof/pins.json` names. Connect's source is never in the harness
image, so the session fetches exactly that commit, shallowly, with
`proof/image/fetch-commit.sh` run as a child process (the lane's one network
reach, which the Connect proof makes too; HQ's network guard refuses only the
harness's own Python sockets), and removes it when the session ends.
Connect's receiver over these apps' submissions is the Connect proof's ("The
Connect proof", above). The module's unused database model, HQ API
exception and HTTP client imports are stood in for, and the extractors read
the same learn and deliver metadata from HQ's source, the CCZ form and HQ's
regenerated form. `ConnectRuntimeTest` computes the metadata in Core on both
paths and checks the Connect namespace in the submission.

#### The rest

| Family | HQ | Core |
| --- | --- | --- |
| `case-list` | Suite contributors and authored app strings regenerate the eight case list scenarios for the Core class; no HQ check (the bar builds them, and no structural equivalence is claimed). | `CaseListRuntimeTest`: typed sort and ties, formatted templates, long-detail order and nodesets on both paths. |
| `container` | Each group and repeat scenario's form regenerated for the Core class; no HQ check (the bar builds them). | `ContainerRuntimeTest`: group relevance, repeat entry, live counts, per-row values and case effects on both paths; initialization snapshots, row insertion and field-list timing on the local forms; private wire counterexamples for count types. |
| `endpoint` | `<endpoint>` and reached `<remote-request>` elements equal Nova's, with `SESSION_ENDPOINTS` on. | `EndpointRuntimeTest`: argument binding, refusing missing and unexpected keys. |
| `expander` | HQ regenerates the suites and app strings the Core class reads; no HQ check (the bar publishes and builds every admitted expander document, and Core admits each build and CCZ). | `ExpanderRuntimeTest`: a case list column over eleven options shows `Tag 10` for `tag_10` on both paths, so HQ's enum key replacement keeps double-digit option keys apart. |
| `hq-oracle` | `Application.wrap` fails exactly where Nova's HQ-JSON oracle reports a fatal code; `RemoteApp` dispatch. | None. |
| `localization`, `worker` | Every localization code passes HQ's `validate_lang`, which no build runs; forms, suites and each language's authored strings regenerated for the Core classes, with no stock translation catalog. | `LocalizationRuntimeTest`, `WorkerIdentityRuntimeTest`: language switching and prompts; worker data through form and suite expressions, and the built-in worker identity on the local form. |
| `lookup` | HQ's workbook reader reads Nova's tables, a 50-column table, and strips exactly the padding Nova predicts; the lookup forms regenerated. | `LookupRuntimeTest`: fixture install and replacement, dynamic choices, labels, answers and case processing; a missing fixture cannot pass as an empty list. |
| `nested-menu` | Entries and menus equal Nova's for eight shapes; the two shapes Nova's HQ export refuses reproduce their losses. Which instances an element reads comes from HQ's own XPath parser (js-xpath, which HQ's build runs on every filter), never from pattern matching. | `NestedMenuRuntimeTest`: all ten shapes on both paths, reproducing HQ's two losses. |
| `no-matches` | Case list action, entry stacks and menus equal Nova's. | `NoMatchesRuntimeTest`: result-count relevance, registration action and navigation state. |
| `arithmetic` | None. | `ArithmeticRuntimeTest`: integer quotients, signed remainders, a decimal holding `10` and a literal beyond int4 stored through case processing; zero division keeps Infinity and NaN. |
| `standard-case-reads` | None. | `StandardCaseReadsRuntimeTest`: identity, name, owner, status, external id and dates read from a selected record and a closed parent in native case storage. |
| `oracle` | None. | `XFormOracleRuntimeTest`, `SuiteOracleRuntimeTest`: Core's verdicts on deliberately corrupted private XML corpora, and detail text evaluation. Not admitted apps. |
| `predicate` | None. | `PredicateRuntimeTest`: 52 schema-parsed predicate programs on instance trees. No app admission is claimed. |
| `xpath` | None. | `XPathCarrierCompatibilityTest`: the production lowerer's output against Core's dispatch and arities; raw `normalize-space()` stays unhandled. |

The arithmetic and standard-case-read families prove the local CCZ path only:
HQ's import and server case processing do not run, and numeric precision is
not claimed identical across evaluators. Their provenance is the family's
producer output and Core's JUnit report in the run's `native/` directory.

## The lane in CI

### The pull request lane

CI runs the lane in `ci.yml`, beside the existing jobs:

- **`quality`** ("Lint & type-check", x64) emits the corpus once
  (`proof/corpus/emit.ts`) and, beside it, the native proofs' products
  (`python3 -m proof.native.produce`, carried in the corpus as `native/`),
  builds the main queue from them and the evidence store
  (`python3 -m proof.store.queue main`), and uploads both as artifacts. A
  failed emission never fails this job: it uploads a failure marker, the
  shards stop waiting, and the gate names the step that failed.
- **`proof-plan`** builds the early queue (groups that need no corpus: the
  surface block and every package whose tests read none; the lane's server
  refuses an early queue holding a document's, a control's or a package in
  `proof.lane.blocks.CORPUS_PACKAGES`) and the matrix
  (`node proof/run.mjs --matrix`). It waits for `smoke-plan`, so its shards
  queue behind every existing job.
- **`proof`** ("Proof i/n", `ubuntu-24.04-arm`) installs nothing and runs none
  of Nova's TypeScript: it pulls the image and Postgres while it fetches the
  queues, and its fork server (`node proof/run.mjs --lane`) runs the early
  queue's blocks and the main queue's as it claims them, with four workers.
  `proof/ci/wait.mjs` brings the main queue and the corpus into a shard that
  started before they existed, and `proof/ci/drained.mjs` ends a shard that
  starts after every block is claimed. A shard fails only when it cannot run
  its blocks; whether the proofs hold is the gate's.
- **`proof-android-runtime`** ("Android reader runtime", x64) puts the
  Android reader's runtime in the Actions cache: commcare-android's own
  unit-test build at the pins, kept under the digest of everything a build
  of it reads (`python3 proof/android/toolchain.py key`: the two pins, the
  toolchain, the scripts that build it). A run that does not find it kept
  builds it from exactly those, with every download named by commit,
  checksum or revision (`proof/android/build-runtime.sh`), and saves it.
  Every run then holds the reader to its own checks on it (`selfcheck.py`,
  `predicates.py`, some four minutes, beside the proof shards), since the
  reader's code changes without the runtime changing.
- **`proof-android`** ("Android i/n", `ubuntu-24.04`, x64) is one shard of
  the Android stage ("The Android stage", above). `quality` builds the
  Android queue with the main one; each shard waits for the proof shards,
  restores the runtime, downloads their outputs, the corpus and the store,
  and runs its static bin (`python3 -m proof.android.stage run`), four
  devices at a time. It fails only when it cannot run its blocks.
- **`proofs-gate`** ("Proofs") is the lane's one check, whatever its shard
  count: the proof shards' outputs and the Android shards' together.
- **`proof-store`** saves this pull request's evidence store beside the gate:
  what it held and what this run observed that main's does not hold, the
  reader's answers and each Android group's outcome among it.

CI makes the corpus and the native products on an x64 runner, with the
runner's own Node, and the shards read them on arm64 in the image. So
`proof-image.yml` also emits the corpus and produces the products weekly on
each architecture, on the runner and inside the image, and holds the four
alike: the corpus byte for byte, the products (`proof/ci/products.mjs`) up to
the ids their producers mint afresh in each production, which they draw
outside the corpus's seeded operations.

### The gate

`python3 -m proof.lane.gate` runs on the runner's own Python with no image and
reads every shard's output, the queues and the store. Four sections, each with
its problems:

1. **Exactly once**: every queued block ran exactly once (a block two shards
   ran fails, whatever they wrote), every group ran every item its worker
   collected, cached groups ran nowhere, and the shards collected alike. The
   Android queue is a queue like the other two (`--android-queue`), and an
   Android shard's output an output like a proof shard's.
2. **Tests**: every item that ran passed, or ended as pytest's marks on it
   allow.
3. **Register**: the evidence of every block that ran, with the cached groups'
   evidence read from the store, held to `proof/known-defects.json`: each
   stage's evidence of a check on a document to that stage's entries, and
   every entry seen on its document and its control by its own stage.
4. **Surface**: the surface block's extraction, or the store's for this image
   and extractor, is byte for byte the committed `surface.json`.

It prints each section, writes the whole to `--summary` (uploaded as the run's
verdict), and appends it to the job's summary.

### Claims

CI and the reusable proof lane use `static` allocation by default.
`proof.checks.sharding.static_bins` sorts blocks by estimated cost and assigns
each to the least-loaded shard, with deterministic ties. Each shard runs only
its exclusive bin; allocation makes no artifact claim or listing request.
The aggregate gate still rejects every duplicate or missing block.

The explicit `create` and `steal` modes are claim diagnostics
(`proof/ci/claim.mjs`), using artifacts named
`proof-claim-<attempt>-<block>`. `create` depends on the artifact service
refusing concurrent creation of the same name. `steal` depends on a listing
after finalization including every finalized marker. GitHub's service has
violated both assumptions: it accepted duplicate names and returned listings
that omitted newly finalized owner and intent markers, allowing two shards
to run one block. Dynamic claims therefore do not establish exclusive
execution on this service. A claim that cannot be settled stops that shard.

The run steps reach the artifact service with the job's runtime token, which
`.github/actions/proof-runtime` exports and the lane's server passes to its
claim and wait commands alone. `proof-claim-race.yml`, run by hand, measures
the claim modes on GitHub's service; `ci.yml`'s `proof_claims` input selects an
explicit diagnostic mode, and `proof_shards` selects another shard count.

### The other workflows

- **`proof-lane.yml`** runs the lane whole and fresh for the workflows that
  check the lane rather than a pull request, the Android stage after the
  shards (always on x64, whatever the shards' runner). It records a candidate
  image in the checkout's lock first (`proof/ci/candidate.mjs`), so every key
  the run computes names the image it pulls. `ci.yml`'s `lane_sample` input
  runs it from a branch over a sample of that many documents, storing
  nothing, to hold a change to it before main's audit runs it.
- **`proof-android.yml`** runs the Android stage alone, again, over what an
  earlier CI run's proof shards observed, and the gate over that run's
  blocks and the stage's: for a change to the reader, its judges or the
  register's Android entries that changes no observation. By hand, or
  through `ci.yml`'s `android_from_run` input.
- **`proof-audit.yml`**: the nightly audit and the weekly comparisons ("The
  evidence store and its audits", above).
- **`proof-image.yml`** builds the image: by hand for a change to the recipe,
  weekly, and for the weekly pin pull request.
- **`upstream-pins.yml`**: the weekly pin pull request ("Changing a pin",
  below).

### Timings and the five-minute target

The lane shares CI's five-minute target for the whole workflow
(`docs/testing.md`, "Performance and verification"). `proof/timings.json`
holds each group's measured cost in box-seconds and CI's default `execution`
(shards, runner, workers per shard); the queue builder packs blocks from it,
and a group it does not list counts the median document's or a default.
`node proof/run.mjs --timings <output>...` refreshes it from runs' outputs,
the proof shards' and the Android stage jobs' (an Android group's
box-seconds are its seconds on a stage job).
Choose the default shard count the way `docs/testing.md` chooses the smoke
lane's: three hosted runs per candidate (`ci.yml`'s `proof_shards` input),
counting setup, the image pull and the gate. The costs `proof/timings.json`
holds were measured off GitHub's runners, so the default shard count stands
until hosted runs confirm it; where they show the lane cannot finish in five
minutes, the pull request records them and the person sets the lane's target
(step 1's decision 11, below). Measure a change to the harness
by the work it does: the CPU-seconds the harness's and Postgres's containers
use (their cgroups' CPU usage before and after) beside the wall time and the
worker count, per document, per check and per job, since a hosted runner has
four vCPUs and more parallelism on a larger machine buys nothing there.

Serving every state to Formplayer and the Web Apps client ("Served states")
moved the floor: a document's group costs about ten times what it did
(forty to a hundred seconds on one worker), nearly all of it Formplayer's
walks and the client's page, neither of which more workers on a four-vCPU
job make cheaper. The lane no longer fits five minutes at ten shards, and
`ci.yml`'s shard timeout is raised to hold it. `proof/timings.json` holds
the costs a hosted run of sixteen shards and twenty Android jobs measured
with every state served and every reader running: about 16,800
box-seconds over 448 groups for the shards (eighteen to twenty-five minutes
a shard, counting setup and the image pull) and about 43,000 over 376
groups for the Android stage. Connect in the unit is a small part of that:
each of the sixteen Connect documents costs about ten box-seconds more than
it did, and its three controls about forty-three each. The default is
sixteen shards: the account runs about twenty jobs at once across CI, so
more shards only wait for a runner beside the test and smoke jobs, and the
Android stage, which starts when the last shard ends, is the longer half.
What the lane's target is now is the person's to set (decision 11).

## Changing a pin

`proof/pins.json` names the commit of each upstream the harness uses
(commcare-hq, commcare-core, commcare-android, commcare-connect, formplayer),
and `proof/image.lock` the image built from them, with the pins it was built
from. CI's `quality` job fails while the two disagree
(`scripts/ci/check-proof-image-lock.mjs`). Formplayer runs the Core it
vendors, the commit its own tree records for `libs/commcare`, whatever the
Core pin is: the runner announces both, and where they differ the Core
runner and Formplayer run two Cores, so a difference between their sessions
may be Core's own. Connect's source is fetched at its pin when a proof runs,
and the image's Connect virtualenv is built from that pin's lock, so moving
Connect's pin rebuilds the image like any other
(`proof/connect/test_runtime.py` holds the two to one commit).

The Android reader's runtime is no part of the image. It is built from the
commcare-android and commcare-core pins and `proof/android/toolchain.json` by
the first CI run that finds none kept under their digest, so moving either
pin (or the toolchain) builds a new runtime, and the reader's fingerprint
names all three, so every archive is read again with it. Where a new
commcare-android asks for another Gradle, another compile SDK or another
Robolectric Android runtime, the build stops and names what to move in the
toolchain.

### The weekly pin pull request

Upstream changes reach Nova as one pull request a week, alongside the weekly
dependency upgrades (`upstream-pins.yml`, scheduled and by hand):

1. **Plan** (`node proof/upstream/pins.mjs plan`) reads each upstream's
   default-branch head. When none differs from the pins, or the open pin pull
   request already carries exactly these heads, it does nothing. Otherwise it
   commits the new pins to the branch `upstream/pins`, one commit on top of
   main, replacing last week's.
2. **Image**: `proof-image.yml` builds the image at those pins.
3. **Surface**: the surface is extracted in the new image.
4. **Prewarm**: the whole lane runs fresh on the candidate image over the tree
   the pull request will carry and saves what it observed as main's store for
   that image, so the pull request's own CI reads its records.
5. **Report** (`pins.mjs report`) adds the image lock and the regenerated
   surface to the one commit, opens the pull request or updates the open one,
   and requests review. GitHub holds CI on a pull request the workflow's own
   token opened: it starts when a person approves its run on the pull request
   or updates the branch, and a run dispatched on the branch would not stand
   in for it, because the held run hides its checks. Its description
   states the run's date and outcome and classifies every surface item the new
   pins add (refused wherever an app uses it until an entry names it), remove
   or change (each with the entries that name it and their dispositions). When
   the image or the surface failed, it commits the new pins alone and names
   the failed step, so CI on the pull request is red: HQ changed something the
   harness depends on.

There is only ever one such pull request, and a week with nothing new leaves
it as it is, with a stale date. The work a change needs (an entry for a new
item, a register entry for a newly visible defect, a seam HQ's refactor moved)
is committed to the same branch before it merges; merging it moves the pins.
The workflow never merges.

### Moving a pin by hand

Edit `proof/pins.json` on a branch, run the "Proof image" workflow on that
branch, record the slim image's digest it prints in `proof/image.lock` with
the pins, regenerate the surface in that image
(`PROOF_IMAGE=<the digest reference> npm run surface`), and commit all three
together.

### Changing the image recipe

A change under `proof/image/` builds the same way: run the "Proof image"
workflow on the branch and record its digest in `proof/image.lock`. The image
the lock records changes only when its inputs do; the workflow's weekly build
proves the recipe still builds and that its variants observe alike.

## Step 1's decisions

The harness is step 1 of the HQ round trip
(`docs/plans/hq-round-trip/README.md`). Its decisions endure as the lane's
contract, and code cites them by number ("decision 12", "plan decision 19");
each is stated here as it is built.

1. **The harness lives in `proof/`**: the pins, the image recipe, the HQ, Core
   and editor drivers, the checks, the corpus definitions and the registers.
   The native proofs moved into it, so Nova has one native-proof harness.
2. **One pins file**, `proof/pins.json`, names each upstream's commit:
   commcare-hq, commcare-core, commcare-android (its parsers, widgets and
   installers feed the surface) and commcare-connect (the Connect proof reads
   its extractors). Vellum is HQ's vendored build, held to the research's
   Vellum pin by the image's self-test. Formplayer was not pinned while the
   lane ran none of it; it is the fifth pin now that its application runs
   ("The Formplayer runner"), and it answers the form validation HQ's
   build asks Formplayer for. Changing a
   pin is a pull request that rebuilds the image and regenerates the surface.
3. **One harness image**, public at
   `ghcr.io/voidcraft-labs/commcare-nova-proof`, built for linux/amd64 and
   linux/arm64, holding only public, licensed upstream sources and the
   harness's own code ("Building the image"). Nova's checkout is mounted at
   run time, with its Linux `node_modules` in a volume keyed by
   `package-lock.json`. Connect's source is never in the image; the
   interpreter, virtualenv and services it runs on are.
4. **The image is rebuilt only when its inputs change**, by `proof-image.yml`,
   and `proof/image.lock` records its digest with the pins it was built from;
   CI's `quality` job fails while they differ from `proof/pins.json`.
5. **The manifest lives in `lib/commcare/surface/`**, inside the CommCare
   boundary, as a generated surface and authored entries
   (`lib/commcare/CLAUDE.md`, "The surface manifest"). It is the living record
   of every disposition; the research's inventory stays its evidence.
6. **An entry names what it covers by surface key**, `<family>:<name>`, with a
   value class where the inventory splits one item by value.
7. **A surface item no entry names is refused wherever an app uses it.**
8. **Gates are their own entry kind**, and a flag HQ reads while building a
   Nova export must have a gate entry.
9. **The flag probe reads each flag's identity from its gate entry** and keeps
   its behavior: which flags it checks, and for which content, stay in
   `projectSpaceCompatibilityProbePlan`.
10. **pytest orchestrates the checks** inside the image and owns the session's
    services (the Core runner, the editor driver), joined at teardown; a
    service that fails to start fails every check that needs it, and nothing
    is skipped. Core's native JUnit classes run through Core's own Gradle
    build. One fork server per job boots HQ once and forks the workers.
11. **The checks run on every pull request**, in their own CI lane, sharded,
    in parallel with the existing jobs, sharing the workflow's five-minute
    target; only the fuzz sample scales with the budget. The shard count is
    chosen from three hosted runs per candidate, counting the image pull, and
    the fixed floor (the producer and targeted documents, the editor runs,
    the Core JUnit suite) is measured first. Where the floor cannot fit the
    target at the concurrency the repository's runners allow, the pull request
    that sets the lane's shape records those measurements and the person sets
    the lane's target before it merges.
12. **A known defect is a strict register entry, not a skipped test** ("The
    registers").
13. **Accepted identity moves are a register too**,
    `proof/identity-moves.json`.
14. **The harness publishes the way Nova publishes** ("A, B and B-edit"), into
    a real Postgres and an in-memory Couch, so HQ's import and save paths run
    whole.
15. **Two builds of one document are compared as well as two publishes**:
    proof 3 compares Nova's local `.ccz` with HQ's build, and proof 1 two
    local exports of one document.
16. **Absolute checks, where both sides of a comparison are wrong**: the bar
    and the intent checks, with expected values read from the document, and
    value-level checks only on targeted documents.
17. **HQ's feature-matrix apps belong to step 6**, whose reader is their first
    consumer.
18. **Android is run, and judged.** The decision was that Android be cited
    and not run; it no longer stands. CommCare Android's own code reads every
    archive a device installs of every document, in a stage of the lane on
    amd64 after the shards, and proofs 1, 3 and 4 judge what it read and hold
    it to the register ("The Android stage"). What a defect does on a device
    is an entry of that stage, with a document and a control, never a
    citation of Android's source.
19. **A check runs only against a target Nova's publish accepts.**

These were settled while the lane was built, and stand where the plan's first
text said otherwise: HQ's database is a clone of the schema HQ's own
migrations create, not a list of models; Elasticsearch is HQ's own server at
HQ's version, its indexes written by HQ's own code and held to each unit's
marks; app-manager pages render through
HQ's own page views (`view_generic`), their JavaScript bundled at image build
time with an esbuild configuration derived from HQ's webpack configuration;
`DEBUG` stays on, with only its speed effects as seams; HQ's soft assertions
are noted as production notes them and kept as evidence; every input is
deterministic from a content key; observations are reused only under exact
keys, with audits; proof 4 saves every section and form over B, each in a fork
of its own; the warm Vellum host follows Vellum's own tests; sensitivity runs
under both the minimum and the maximum configuration; proof 5's footprint also
holds what `proof/corpus/footprint.ts` lists beyond the reference index's
readers (among them the readers and writers of an edited case type or
property; the owner of an edited translation, and a case property's readers
for a unit its option owns; every module and form and the app's own record for
a language-catalog or Connect-type edit; the modules holding an edited form;
the module a no-matches registration form is lowered into, and its host
module) and every entity whose wire Nova derives from what the batch edits;
the lane runs on arm64; the input of one defect row ("12, same-type child")
cannot come from a Nova document, which a test of Nova's planner and gate
shows, so it is not reproduced (the same was said of "20, CommTrack", whose
read Nova's gate admits: it is a row again, "What the lane does not
observe"); the `hq-api` family records each view's decorators
with their arguments and the module constants a view returns; and the weekly
pin pull request is opened with the workflow's own token, and the workflow
never merges.

Code also cites the plan's work items by number: 3 is the Core runner, 4 the
editor driver, 7 the manifest entries, 10 the corpus ("The corpus"), 11 the
checks ("What the lane proves"), and 12 the defect rows ("The registers").
