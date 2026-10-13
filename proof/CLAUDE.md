# proof: the proof harness

The proof lane holds every Nova export to CommCare's own code at pinned
upstream commits: HQ's import, build, case processing, editors, receiver,
restore and Connect repeater, CommCare Core's runtime, Formplayer's
application, HQ's Web Apps client, CommCare Android's own app and CommCare
Connect's own server, over a reproducible corpus. Every pull request runs it
without the readers (`PROOF_READERS=0`, `proof/lane/readers.py`: HQ and Core
whole, no state served to Formplayer, the client, a device or Connect); each
night runs it with every reader over what changed since main's last store
snapshot, and each week runs it whole and fresh, which is what proves the
store's keys; a scheduled failure of either opens an issue.
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
  (`proof/hq/seams.py::formplayer_validation`); a lane server starts one such Formplayer for all its workers
  (`proof/formplayer/shared.py`), which holds only because Formplayer's validation keeps no state between
  requests: a seam that made it keep any would need a Formplayer a worker again. A speed seam computes exactly
  what HQ computes and can be switched off to compare (`PROOF_HQ_SPEED=0`). `DEBUG` stays on, since HQ branches on
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
- **The accepted seams are these four, each for its reason; a new one is a
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
- **The harness's own settings are these five, each for its reason; a new
  one is a claim to justify here.** None changes what HQ, Formplayer or the
  client decide of a Nova export; each takes away something of the
  machine a run happens on.
  - *Elasticsearch's disk watermarks are off* (`proof/hq/elasticsearch.py`).
    They measure the host's whole volume, and past the flood stage the
    server makes every index read-only, so a lane on a fuller runner would
    read differently: no result may depend on how full a runner's disk is.
  - *Postgres takes 125 clients a worker, and never fewer than 500*
    (`proof/compose.yaml`, set by `proof/run.mjs` from the worker count).
    Each worker holds HQ's connections and a pool for every Formplayer it
    runs, and the default of 100 ran out, as a fixed 500 did for a box of
    forty-eight workers; how many connections a machine allows is no claim
    about an export.
  - *HQ names a map layer with a placeholder token*
    (`proof/hq/localsettings.py::MAPBOX_ACCESS_TOKEN`). The client draws no
    map, and takes no answer to a location question, without one
    (`entries.js::GeoPointEntry`); production names one. The token is no
    credential, and the layer's pictures are on a host the browser does not
    reach, so the map is drawn without them and moves and answers the same.
  - *A step waits for the client's own timers under a second*
    (`proof/editors/driver/steps/page/timers.js`). A worker acts once the
    page has settled (an answer's throttle, a dialog's transition), and a
    step that went on while one was set read the client mid-reaction. The
    client's progress bar's own timers (nprogress's trickle, which re-arms
    itself while the bar shows, and its fade) are not waited for: a
    lifetime a worker watches, as a notification's fade is, which changes
    nothing but the bar.
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
  browser does not reach. Formplayer's walk submits what the client submits
  (`proof/webapps/observe.py::submitted_alike` holds the two alike): it sends
  the answers the client's own reconciliation sends, chooses an option as the
  client binds it (by its label), and gives a location the place the
  client's map gave, each window's own (`derived_places`), which every
  replay gives again by the same drags; a difference between the two is the
  harness's to find, never a check to loosen. The client reads some
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
  `proof/android`,
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
  rest. A pytest test module (`test_*.py`) is in no observation, so an edit
  to a test observes no document again (on the nightly that would be the
  whole lane with every reader); it stays exact only while nothing the
  observation can import is a test module, which
  `proof/store/test_partition.py` holds from the sources: a module the
  observation can reach never imports a test module (what it needs of one
  moves into a helper beside it). A test module whose items run in
  documents' groups is the judge's (`fingerprints.DOCUMENT_GROUP_TESTS`,
  HQ's branch proof); the same test fails while another collects one
  unnamed. The surface extractor, the spelling rules' proofs and the native
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
  lane pass. A skipped item holds at the gate, so a test never skips for
  what the image or the corpus should hold (a tool, a document every
  emission writes): it fails by name. The one skip is `under_determinism`
  where a lane leaves HQ's determinism off, which is that lane's purpose. A spelling rule erases exactly one spelling, and tests run both
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
- **A walk reaches its end or a held stop.** Proofs 3 and 4 compare two
  states' walks, so a run cut short alike on both sides passes with the rest
  of it unseen. `proof/checks/stops.py` reads each walk on its own, and
  `walk-stops.json` holds every stop by its document, reader and cause,
  strict both ways as the register is (`proof/README.md`, "Walk stops"). A
  stop a worker would get past is never an entry: give the walk what a
  worker gives (the table's next answer, a question cleared, a repeat's Add,
  a search sent the way the client sends it, App Preview's own "Use one
  question per screen" switched off), on Formplayer's walk and the client's
  replay alike. An entry is a reader's own end, with a reason a reviewer can
  check at the reader's source. A walk's bounds are safety nets: reaching
  one fails by the bound's name, never ends a run, and none is a time.
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
- **Three lanes, and nothing is left out for time.** (`proof/README.md`,
  "The lane in CI".) If something cannot be properly verified where it
  runs, it is not truncated to fit: it runs whole, or it runs in a lane that
  can hold it and says so.
  - **Pull request** (`ci.yml`): the lane without the readers
    (`PROOF_READERS=0`). Every group the store does not hold runs, however
    long the lane then takes; there is no cap on its time and no group is
    deferred, sampled or dropped to meet one. `python3 -m proof.lane.plan fit`
    chooses only the shard count (the fewest whose expected end is within
    fifteen seconds of the soonest any count ends) and says in the job's
    summary when the lane is expected to end, as modelled from
    `proof/timings.json`: about six minutes with nothing changed, nine or
    less up to about forty changed documents, about thirteen with every
    group fresh. A shard's deadline is twice its expected time, never under
    twenty minutes: it ends a stuck shard, which fails the lane, and never
    decides what is verified.
  - **Nightly** (`proof-audit.yml`): both profiles over main against main's
    store, so every group main's store lacks is observed, and the two are
    merged into the snapshot every pull request reads.
  - **Weekly** (`proof-audit.yml`): both profiles whole and fresh, the run
    that proves the store's keys and replaces the snapshot, beside the
    comparisons over a 24-document sample that turns each week (its seed
    the run's ISO year and week, so every document is compared within
    fifteen weeks, and a dispatch that names the seed runs the same sample
    again). The whole run without the readers also holds the committed
    sensitivity effects to its own flips both ways, so an effect no flip
    shows any longer fails the week by name.
  The lane with every reader costs about 300 worker-hours whole, against
  GitHub's free plan of twenty jobs at once and six hours a job, so each
  lane with the readers sizes its shards from its queue
  (`python3 -m proof.lane.plan size`: within two and a half hours a shard,
  fourteen at once). A scheduled night or week that fails opens an issue
  that names each failing group, why, and the command that reruns that
  group alone at the commit the run checked (`python3 -m proof.lane.report`:
  `PROOF_READERS=0 npm run proof -- <its items>` where it failed without the
  readers, `proof/remote/run.sh <host> -- <its items>` where it needs one),
  so whoever fixes it reruns the smallest slice; keep that true when the
  gate's verdict or a lane's labels change. The two profiles are one lane:
  nothing loosens between them, every check that runs holds exactly as it
  does nightly, the gate leaves only the served readers' register entries to
  the nightly, and every key the store keeps names its profile. The nightly
  is the backstop, never the first run: a change to Nova's emission or to
  what a reader observes (`proof/formplayer`, `proof/webapps`,
  `proof/android`, `proof/connect`, `proof/observe/served.py`, a reader's
  judge or register entry, a pin) is proven by running that reader's slice
  with the readers on a proof machine before it is pushed (`proof/README.md`,
  "Proving a reader change before you push"). A test that starts a served
  reader is marked `reader`, by its fixture or by hand, and the readers-off
  run refuses one left unmarked. Every hosted job has four vCPUs, so optimize
  the work, never the parallelism: measure a change in CPU-seconds (the
  harness's and Postgres's container cgroups) and wall time with the worker
  count, per document, per check, per group and per job's fixed cost, and
  refresh `proof/timings.json` from such a run (`node proof/run.mjs
  --timings`), which every plan reads; never buy speed with more workers or
  processes than a four-vCPU job serves, with a seam that computes something
  HQ would not, or by running less.
- **Android runs beside HQ's live unit, and HQ answers its network with its
  own views.** A claim about what a device does is observed on
  commcare-android's own classes (`proof/android`, Robolectric, one JVM and
  one device a request, Android 10 drawing with Robolectric's native
  graphics, a phone and a tablet held in landscape), handed each state a
  shard serves, as Formplayer and the Web Apps client are
  (`proof/android/observe.py`, called from `proof/observe/served.py` and
  `proof4.py`), so the lane's shards run on amd64 (the pull request lane's
  too, which serves no state, so the records the nightly saves are the ones
  it reads), the only Linux Robolectric's native runtime ships for, with the reader's
  runtime and its JDK mounted at the paths it was built at
  (`proof/run.mjs::androidRuntime`). Every request the app's own HTTP client
  makes goes through the reader's loopback proxy (`proof/android/peer.py`:
  `https` through a tunnel whose TLS speaks for the host the app named with a
  certificate of the harness's own authority, the one trust the app's client
  is given, `Peer.java`) and is answered by the view HQ's URLconf names for
  its path, over the state's fork (`proof/android/hq.py`): the worker signs
  in through the app's own sign-in pipeline (`LoginController`, HQ's key
  record and restore views), each form a walk saves is the app's own send to
  HQ's receiver (and Connect's forward behind it), a search goes to HQ's
  search view and real Elasticsearch, a claim to HQ's claim view. The device
  signs in at the state's base and each walk is a fork of the unit, as each
  Formplayer run is; Core's random source is seeded at each walk
  (`Peer.seed`), so what the device sends HQ is the same on every run. Nova's
  local archive names no server (finding 59), so its device meets Android's
  own defaults, and a second device on it, and the device updated from one
  local export to the other, are given the input the lane gives Core over
  that archive (the worker's credentials on every request, HQ's restore
  view's answer for the worker, each form taken by HQ's receiver under the
  app's id, every other request where the archive addressed it): only the
  transport differs, never a reader (`DevicePeer.delivered`; Core's own
  input path is the local restore and the receiver under the app's id). A
  device's network is its configuration's HQ, so a device on the one local
  archive is judged against the same configuration's A. Never cite an
  Android symbol in place of a run (the register's loader refuses an
  `android` field), never copy or rewrite an Android class to observe it
  (call the app's own, by reflection where it is private; where the test
  application stands a mock in for one of the app's own methods, call the
  app's method itself, `ProofApplication.java`), and never answer the
  device's network with anything but HQ's views. Never read the wall clock on
  the device: the app's clock is the lane's fixed instant. A record holds
  nothing two readings of one archive give differently: an id the device
  drew is written by what its case holds, a file Android kept for a capture
  question by the file the walk gave, a widget's answer only where the form
  holds one, and no two forms are given their answer files in one second
  (Android names a form's answer file by the second its load finished in, so
  the next form opens only in a later second). The device's libraries are
  the app's own, ahead of the unit tests' (`reader.init.gradle`): a method
  the unit-test classpath lacks raises on the reader and on no worker's
  device. A walk follows the app's own navigation (a menu's own click, a
  list's own tap, a form's own finish button, a language chosen on home's
  own Change Language dialog); what the walk cannot do as a worker does it
  names and stops at. The walks take the shape every reader's walk takes
  (`proof/observe/walks.py`): every case a list shows and every language the
  app holds, each a walk named by what it chose, in the one device. A
  screen is read once where the device is the same (the walk that ends at a
  list reads it, the walk that ends with a case reads its detail, and a walk
  that goes on records only what it chooses), and each walk's screens end
  with it: every screen is built through `Opened.java`, never with
  Robolectric's builder, which keeps a screen and its themes until its
  controller is closed (`test_screens.py`). A drawn picture is compared only where
  nothing else of what it shows differs, and a tablet's difference only
  where the phone does not show it (`android-tablet@...`): one symptom is
  one difference. An `android@...` entry is held like every other, by the
  check that reports it (`proof/checks/android.py`, called from proofs 1, 3
  and 4). commcare-android's own code is also held
  where its runtime is built or restored, before any shard starts
  (`selfcheck.py`, `predicates.py`, which the lane's pytest does not
  collect); the proxy's transport is held in the lane (`test_peer.py`).
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
  plan, the fix a device's GPS gives the app, ConnectID), and a new
  stand-in is a claim to justify there.
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
