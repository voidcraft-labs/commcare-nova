# proof: the proof harness

The proof lane holds every Nova export to CommCare's own code at pinned
upstream commits: HQ's import, build, case processing, editors, receiver,
restore and Connect repeater, CommCare Core's runtime, Formplayer's
application, HQ's Web Apps client and CommCare Connect's own server, over a
reproducible corpus, on
every pull request; commcare-android's own code reads every archive a
device installs, in the lane's Android stage (`proof/android`), outside the
image.
`proof/README.md` says what it proves, how to run it and read a failure, how
to add a document, a targeted document, a spelling rule, a register entry and
its control, and how a pin changes. These are the rules every change to the
harness keeps, each with its reason.

- **HQ's real code produces every observation.** The lane's claims are about
  what HQ and Core do, so a stand-in proves only the stand-in. HQ runs its own
  views, decorators, templates and models over a real Postgres (HQ's own
  migrated schema) and its own in-memory Couch; the seams answer only what HQ
  reads from outside its state (flags, privileges, project settings, the
  previous build, resource overrides), each recorded, and every other read
  is HQ's. Elasticsearch is HQ's own server at HQ's version, one a worker,
  its indexes written only by HQ's own code (a user's save, and the
  Elasticsearch processors of HQ's own pillows over every change the unit
  records) and held to each unit's marks as Postgres is
  (`proof/hq/elasticsearch.py`); HQ's client is refused outside a unit and on
  an index the lane keeps nothing in, never answered by the harness. The form validation HQ asks Formplayer for is
  answered by Formplayer's own application, sent the request HQ wrote
  (`proof/hq/seams.py::formplayer_validation`). A speed seam computes exactly what HQ computes and can be switched
  off to compare (`PROOF_HQ_SPEED=0`). `DEBUG` stays on, since HQ branches on
  it in what it does; HQ's soft assertions are noted as production notes
  them, never raised, and each one is evidence. A view or Couch query the
  harness does not answer raises rather than returning empty.
- **Formplayer runs whole, and HQ answers it with its own views.** A claim
  about Formplayer or Web Apps' server side is observed on Formplayer's own
  application (`proof/formplayer`), started by its own `main` on its boot
  jar's classes, its own Postgres schema and a real Redis, never on Core
  alone and never on a controller taken out of its filters and aspects. HQ's
  address is the runner's peer, and each request Formplayer makes of HQ is
  answered by the view HQ's URLconf names, behind HQ's own middleware, over
  the unit's state (`proof/formplayer/hq.py`): a worker HQ made, the
  document's cases saved through HQ's receiver, a build HQ released. A
  request no view answers is HQ's 404; a harness refusal ends the
  observation. Never answer one of Formplayer's requests with a function
  called on HQ's behalf, a restore written beside HQ, or a submission
  acknowledged without being processed, in the packages' own tests as in
  the lane's records (`proof/formplayer/apps.py::served`). What HQ lacks
  here is named where it
  is answered, and stays that narrow: Nova's local archive, which HQ does
  not hold and Formplayer is handed as bytes. The worker signs in through
  HQ's own sign-in form (`proof/formplayer/hq.py::sign_in`), as every
  person the lane signs in does. HQ's locks are real (HQ shares
  Formplayer's Redis, as production does, and relies on it), and what HQ
  runs when a transaction commits runs where the commit would
  (`Unit.committing`). Each run of a walk is a fork of the unit, so no run
  reads what another's submission left; start each run as a worker who
  cleared their data, and give each runner its own database and Redis.
- **The accepted seams are these five, each for its reason; a new one is a
  claim to justify here.**
  - *A restore hands a worker's cases in id order*
    (`proof/formplayer/hq.py::cases_in_id_order`). HQ asks its database for
    no order (`livequery.py::batch_cases`), so the order is whatever
    Postgres returns, and every fixed order is one production can give;
    the lane needs one for its records to be byte-identical. What a device
    shows is not the restore's order where it matters: HQ's build gives an
    unsorted list a default sort on its first column.
  - *A page's repeating timers of 10 s or more are held*
    (`proof/editors/driver/steps/page/polls.js`), and so is Elasticsearch's
    own refresh timer (`proof/hq/elasticsearch.py`, each written index
    refreshed as its operation or request ends). Holding them models a
    person who saves within 20 s and a pillow that has caught up before the
    next request, both real; what a poll or a timer does once it fires is
    not a claim the lane makes.
  - *Connect's opportunity, worker, payment unit and claim rows are made
    with Connect's own factories* (`proof/connect/driver.py`). They are
    setup state, like the seeded cases a worker starts with, not anything
    Nova exports; what Connect does with what HQ forwards is Connect's own
    code.
  - *Connect's source is fetched at run time at its pin*
    (`proof/connect/checkout.py`). It works, and keeps a repository that
    carries no license out of a public image; its environment is built from
    its own lock in the image.
  - *The unseeded weekly lane runs no Android stage.* Its purpose is the
    determinism comparison of Nova's and HQ's draws, which the seeded
    lanes' Android records do not change, and an unseeded run keeps no
    document records under a key for the stage to read.
- **The harness's own settings are these five, each for its reason; a new
  one is a claim to justify here.** None changes what HQ, Formplayer or the
  client decide of a Nova export; each takes away something of the
  machine a run happens on.
  - *Elasticsearch's disk watermarks are off* (`proof/hq/elasticsearch.py`).
    They measure the host's whole volume, and past the flood stage the
    server makes every index read-only, so a lane on a fuller runner would
    read differently: no result may depend on how full a runner's disk is.
  - *Postgres takes 500 clients* (`proof/compose.yaml`). Each worker holds
    HQ's connections and a pool for every Formplayer it runs, and the
    default of 100 ran out; how many connections a machine allows is no
    claim about an export.
  - *HQ names a map layer with a placeholder token*
    (`proof/hq/localsettings.py::MAPBOX_ACCESS_TOKEN`). The client draws no
    map, and takes no answer to a location question, without one
    (`entries.js::GeoPointEntry`); production names one. The token is no
    credential, and the layer's pictures are on a host the browser does not
    reach, so the map is drawn without them and moves and answers the same.
  - *A step waits for the client's own timers under a second*
    (`proof/editors/driver/steps/page/timers.js`). A worker acts once the
    page has settled (an answer's throttle, a dialog's transition), and a
    step that went on while one was set read the client mid-reaction.
  - *A page's repeating timers of 10 s or more are held*, the accepted seam
    above: a person who saves within 20 s.
- **Web Apps is HQ's own client, clicked and read.** A claim about what a
  worker sees in Web Apps is observed on HQ's client itself
  (`proof/webapps`): HQ's `FormplayerMain` page, the bundle built from HQ's
  entry, HQ's own compiled stylesheets, and Formplayer's own answers to the
  client's own requests, over a build HQ released in a project space that
  has Web Apps (every configuration of the lane grants it), on a desktop,
  on a phone and in App Preview: HQ's `PreviewAppView` page at the size of
  the builder's frame, for the project space's admin, who logs in as the
  worker through the client's own Log in as, which HQ draws only where the
  plan has Log In As, so App Preview's runs alone state that it has
  (`proof/hq/seams.py::also_granted`, as Connect's Data Forwarding is
  stated). Never copy a
  client function into a test or call the client's code from a step: a step
  clicks what a worker clicks, gives what a worker gives through the
  browser itself (a file chosen in the file chooser, a stroke of the
  pointer on a signature pad or a map: the driver's `files` and `draw`
  steps), or reads the document. Every question a worker can answer, the
  client answers: HQ names a map layer as production does
  (`proof/hq/localsettings.py`), so a location question draws its map and
  is answered by dragging it, though the layer's pictures are on a host the
  browser does not reach. The client reads some
  things from the app HQ stores and never from the build (the logo,
  `cc-show-incomplete`), so a claim that two builds are alike says nothing
  of them: release the state and read the page. A step waits on what the
  client itself waits on (its route, its own request-in-flight flag, a
  dialog done opening or closing) and on the client's own short timers
  having run (`steps/page/timers.js`: its answer throttle, a dialog's
  transition), never on a time or on the page merely being quiet: the client
  asks Formplayer after timers and animations of its own, and a screen read,
  or a click made, before it got there is a race the record would hold (a
  hosted run once submitted a form before the client's throttled answer, and
  its list showed a case more). A worker acts once the page has finished
  reacting. A computed style means
  something only under HQ's stylesheets; never read one from a page that
  loaded none. The client has a browser of its own (proof 4 shows a saved
  app while the page that saved it is still open), and is shown a state only
  where Formplayer's answers or what HQ's page hands it of the app are not
  its baseline's: the client reads nothing else.
- **A served state is judged like every other observation.** The unit serves
  A, B aligned to A, Nova's local archive, B and each editor save
  (`proof/observe/served.py`), and proofs 3 and 4 compare what Formplayer
  and the client made of them (`proof/checks/served.py`), one
  difference a symptom. A saved state is always the one HQ's own editor page
  saved in proof 4, never an app document written by hand to look saved.
- **Observation is separate from judgment.** The observation partition
  (`proof/observe/partition.py::observes`: `proof/observe`, `proof/hq`,
  `proof/core`, `proof/formplayer`, `proof/webapps`, `proof/connect`,
  `proof/editors` with its driver fingerprinted apart as the browser's,
  `proof/lane`, `proof/store`,
  the comparators, the few checks files it runs, the session's fixtures and
  the gate entries) runs HQ, Core, Formplayer
  and the browsers and writes records; the judges (the rest of `proof/checks`,
  and `proof/rules`) are pure functions of records and import neither HQ nor
  Django. Records and judgments are reused across runs under keys
  fingerprinted by each side's files (`proof/store/fingerprints.py`; the
  observation's fingerprint, `in_observation`, covers the partition and the
  lane's container configuration, `LANE_FILES`), so a judge that ran HQ, or an
  observation that ran code or read a file outside its partition, would make
  that reuse wrong: put code a record depends on in the partition
  (`observes`), and `test_judge_purity.py` and the store's read guard hold the
  rest. The surface extractor, the spelling rules' proofs and the native
  proofs also run HQ or Core, as package groups keyed by every file of the
  harness.
- **Every HQ, Core and browser input is deterministic from a content key.**
  Nova's exports draw their ids from a generator seeded by (corpus seed,
  operation ordinal, configuration); HQ's entropy and clock inside an
  operation come from the unit's key and depth; the browser's clock is fixed
  and its randomness seeded from the run's spec. The store, its audits and
  every byte comparison rest on records being byte-identical run to run, and
  the ordinals keep defects 1 and 9 visible. Never read the wall clock or the
  system's entropy inside an operation, and wait with `time.perf_counter` or a
  C-level wait: `time.monotonic` is frozen there, so its timeouts never
  arrive.
- **The register is strict, and the spelling rules are a closed set.** Every
  difference a check reports is held by an entry of `known-defects.json` or
  erased by a spelling rule, and every entry must hold some difference no
  other entry holds on its document and still show on its control (step 1's
  decision 12, `proof/README.md`). A fix removes its entry in the same pull
  request. Never skip, mark, loosen a comparator or widen a path to make the
  lane pass. A spelling rule erases exactly one spelling, and tests run both
  spellings on every reader of it to show none depends on it: HQ's build
  and Core's trace in the rule's own test, and, where its readers are
  others, each of those too, run for real and named by the rule
  (`SpellingRule.readers`): Formplayer's walk of both spellings served by
  HQ's own views, the Web Apps client's screens on them, HQ's own Connect
  repeater and Connect's own receiver, and CommCare Android, whose test is
  a method of `proof/android/predicates.py` that installs both spellings on
  a device (it runs where the reader's runtime is, on every run of the
  runtime's job, never in the image). `test_closed_set.py` refuses a rule
  naming a test that is not there. An equivalence is a rule or it is
  nothing: the register holds no entry marked as one, and its loader
  refuses the field. Before calling two spellings equivalent, look for the
  state in which a reader reads them apart, and run it: a forced profile
  default reads as an absent one on a device that never held another value
  and replaces the value on one that did (finding 40), which makes it a
  defect, never a rule. A rule that normalizes what one reader hands the
  next (Formplayer's answer, which the client reads) must name the test of
  the reader that reads it.
- **A precise witness writes its precise edit.** The fixed producers' edits
  are balanced together, so an unrelated document can change which admitted
  edit another gets. A harness test or registered symptom that needs one
  particular edit belongs in a targeted document with explicit identities,
  D and D′, planned and admitted through the same production gates. Keep the
  original assertion and defect class, retain its frozen control, and prove
  the witness's emitted inputs stay fixed as unrelated documents change.
- **A structural path names a symptom, never a document.** A register entry
  matches one exact path across every document, so a name the app authored (a
  question, group or repeat id, a case property or type, an operation name, a
  minted id, a language code) is `*` in `path` and kept in `at`, while
  CommCare's own vocabulary stays as it is, decided from the format's readers
  at source. Compare collections the way their readers key them, never by
  position where position is not what the reader reads; name a refusal's cause
  in its path; report nothing the bar already reports.
- **Settle every CommCare fact at source.** Read the pinned checkouts
  (`proof/pins.json`; the image holds the same trees at `/opt/hq`,
  `/opt/core`, `/opt/android` and `/opt/formplayer`), cite `file::symbol`,
  search every reader of a value and its enclosing condition, and execute
  where reading leaves doubt. Never
  switch a shared checkout, never read one through `git show <commit>:<path>`
  or raw URLs. A fact a brief or plan states and the source contradicts is
  reported with the evidence, never coded around.
- **Never read XPath or XML with regular expressions.** XML is parsed with
  lxml; XPath is read through Core's own parser (the Core runner's
  `xpathParse`, `xpathStrings`, `xpathSame`), HQ's (eulxml, js-xpath), or
  `proof/rules/_xpath.py`, the port of Core's lexer that its test holds to
  Core. The surface extractor matches no source text by pattern either.
- **The lane shares CI's five-minute target, which serving every state no
  longer fits.** A document served to Formplayer and the client costs about
  ten times what it did, so the lane's target is the person's to set again
  (`proof/README.md`, "Timings and the five-minute target"). Every hosted
  job has four vCPUs, so optimize the work, never the parallelism: measure a change in
  CPU-seconds (the harness's and Postgres's container cgroups) and wall time
  with the worker count, per document, per check, per group and per job's
  fixed cost. Never buy speed with more shards, workers or processes than a
  four-vCPU job serves, and never with a seam that computes something HQ would
  not.
- **Android is read by its own code, in a stage the gate judges** (step 1's
  decision 18, which said cited and no longer stands). The Android reader
  (`proof/android`) runs commcare-android's own classes over the archive
  each state's record keeps for it, one JVM and one device a request, on
  linux/amd64 and macOS only (Robolectric's native runtime), so the Android
  stage runs after the shards, from their records, on amd64
  (`proof/android/stage.py`), and its output is an output like a shard's.
  A claim about what a device does is observed there, or on both spellings
  of one difference in `proof/android/predicates.py`: never cite an Android
  symbol in place of a run (the register's loader refuses an `android`
  field), and never copy or rewrite an Android class to
  observe it (call the app's own, by reflection where it is private). Each
  answer is kept under the archives, restore and options it read and the
  reader that read it, so put anything an answer depends on in that key
  (`proof/android/records.py`), and never read the wall clock on the
  device: the app's clock is the lane's fixed instant. A record holds
  nothing two readings of one archive give differently: an id the device
  drew is written by what its case holds, a file Android kept for a capture
  question by the file the walk gave, a widget's answer only where the form
  holds one, and no two forms are given their answer files in one second
  (Android names a form's answer file by the second its load finished in, so
  the next form opens only in a later second). The device's libraries are the
  app's own, ahead of the unit tests' (`reader.init.gradle`): a method the
  unit-test classpath lacks raises on the reader and on no worker's device.
  A walk follows the
  app's own navigation (a menu's own click, a list's own tap, a form's own
  finish button); what the walk cannot do as a worker does it names and
  stops at. An entry whose artifact is `android@...` is that stage's, held
  on its document and its control like any other; the shards' checks hold
  only their own. Name a control for an Android entry only where the
  control already keeps the files that check reads, and retain a new
  control where none does: retaining an existing control again from
  today's corpus would lose every fixed symptom it was kept for. The stage's logic is held in the lane with a stand-in
  reader (`proof/android/test_stage.py`); commcare-android's own code is
  held where it runs (`selfcheck.py`, `predicates.py`, which the lane's
  pytest does not collect).
- **A check runs only against a target Nova's publish accepts** (step 1's
  decision 19). A symptom that shows only where Nova refuses to publish
  reaches no one, so a configuration lacking a flag or confirmation Nova
  requires is never checked. The one exception is configuration sensitivity:
  a gate's effects are what HQ's build changes when the gate flips, wherever
  that is, so a flip into such a configuration is still built and its
  differences are held to the gate's effects alone, never to the register
  (`proof/checks/sensitivity.py`).
- **Tests follow `docs/testing.md`.** Each names its contract and the
  plausible failure it catches, pairs every refusal with an accepted case,
  never sleeps, and owns every process it starts: run commands through
  `proof/processes.py`, which stops and reaps a command's whole process group.
  Python in the image is CPython 3.13 with the standard library and HQ's
  virtualenv, no new dependencies; `proof/connect/driver.py` alone runs on
  Connect's interpreter and virtualenv, and imports only the standard
  library, Django and Connect
  (`uvx ruff check --line-length 120 --select F,E,W,I,B`,
  `uvx ruff format --line-length 120`). pytest tests are `test_*.py`; the
  TypeScript tests under `proof/**/__tests__/` run in ordinary CI's Vitest.
  Only the per-document checks run over `Corpus.documents`, the run's sample
  of the corpus where the weekly audits sample it; every other test reads
  `Corpus.emitted`, so it holds alike over a sample and the whole corpus.
- **What runs with no image stays on Python 3.12's standard library.** The
  gate, the queue builder, `proof.store.pack`, `proof.store.audit` and
  `proof.native.produce` run on a hosted runner's own `python3` (no workflow
  sets one up, and `ubuntu-24.04`'s is 3.12), `proof.store.fingerprints` on
  the host `npm run proof` starts from, and `registers verify` and
  `sensitivity effects` wherever a person runs them. Each imports only the
  standard library and the proof's own standard-library modules, and uses no
  API newer than 3.12. `proof/lane/test_gate.py` holds the gate's imports to
  the standard library, but on the image's 3.13, so a 3.13-only API passes the
  lane's tests and breaks CI's gate.
- **Connect runs as Connect, and is given only what HQ sent.** A claim
  about what Connect makes of a Nova app is observed on Connect's own
  server at its pin, in its own process, on its own interpreter, database
  and Redis (`proof/connect/runtime.py`): never import Connect or its
  Django into the harness's process, which is HQ's. What reaches Connect is
  what HQ's own Connect repeater sent after HQ's own receiver took a form
  whole (`proof/connect/hq.py::forwarding`), over a real connection, with a
  token HQ asked Connect for; and what Connect asks of HQ is answered by
  HQ's own view. Never write a payload or a submission by hand, call HQ's
  receiver or payload functions on its behalf, hand Connect an archive HQ
  did not serve where the unit runs, or acknowledge a forward that did not
  reach Connect's receiver. A Connect document's unit makes one
  opportunity from A's release and every later state is received by it
  (`proof/observe/connect.py`); each run meets Connect as that opportunity
  stood, as each run meets HQ as the unit's fork leaves it. Connect is the
  reader, so the judge compares what Connect did (its answers, tasks and
  rows) and never a payload (`proof/checks/connect.py`). What stands in for
  a person or a machine the lane does not have is named where it is done
  (the opportunity's rows, the 404 retry production's Connect forwarder
  gets, Data Forwarding on the
  plan, a device's location fix, ConnectID), and a new stand-in is a claim
  to justify there.
- **What reaches a person through another of HQ's pages or views is run
  there.** A harm the per-document checks cannot show (what a page offers,
  what an upload answers, which fixture a restore hands a worker) is a test
  of `proof/views` over a real Nova export: the request a client sends,
  answered by HQ's URLconf, middleware and the view's own decorators
  (`ask`), or HQ's page loaded in Chromium and read for what it holds
  (`offered`). Never call the view's inner function, never read a template
  for what a page offers, and pair every observation with its counterpart
  (the flag on, the privilege granted), so a page or a view that answered
  nothing cannot pass. "No system the lane runs shows it" is a hole to
  close there, never a reason to leave a harm to a citation.
- **The harness never changes how a stored form source is spelled.** HQ
  reads a stored source as text in one place (its CommTrack test for the
  session's supply point is a substring test), and a source written again
  by a serializer spells its apostrophes another way. A state the harness
  makes of B (aligned to A) keeps B's own bytes but for the namespace's
  name (`proof/observe/alignment.py::renamespace_xform`).
- **The repository is public.** Nothing here describes an HQ route usable
  without a credential or any other HQ weakness, holds client data, or
  references a scratch directory or private script.
