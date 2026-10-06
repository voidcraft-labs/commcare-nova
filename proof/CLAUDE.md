# proof: the proof harness

The proof lane holds every Nova export to CommCare's own code at pinned
upstream commits: HQ's import, build, case processing and editors, and
CommCare Core's runtime, over a reproducible corpus, on every pull request.
`proof/README.md` says what it proves, how to run it and read a failure, how
to add a document, a targeted document, a spelling rule, a register entry and
its control, and how a pin changes. These are the rules every change to the
harness keeps, each with its reason.

- **HQ's real code produces every observation.** The lane's claims are about
  what HQ and Core do, so a stand-in proves only the stand-in. HQ runs its own
  views, decorators, templates and models over a real Postgres (HQ's own
  migrated schema) and its own in-memory Couch; the seams answer only what HQ
  reads from outside its state (flags, privileges, project settings,
  Formplayer's form validation through the Core runner, the previous build,
  resource overrides, Elasticsearch as an empty index), each recorded, and
  every other read is HQ's. A speed seam computes exactly what HQ computes and
  can be switched off to compare (`PROOF_HQ_SPEED=0`). `DEBUG` stays on, since
  HQ branches on it in what it does; HQ's soft assertions are noted as
  production notes them, never raised, and each one is evidence. A view or
  Couch query the harness does not answer raises rather than returning empty.
- **Observation is separate from judgment.** The observation partition
  (`proof/observe/partition.py::observes`: `proof/observe`, `proof/hq`,
  `proof/core`, `proof/editors` with its driver fingerprinted apart as the
  browser's, `proof/lane`, `proof/store`, the comparators, the few checks
  files it runs, the session's fixtures and the gate entries) runs HQ, Core
  and the browser and writes records; the judges (the rest of `proof/checks`,
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
  lane pass. A spelling rule erases exactly one spelling, and its own test
  builds or runs both spellings to show HQ's build output or Core's trace does
  not depend on it; a difference no such test can settle (its reader is
  Android, Web Apps' client or Connect) is a register entry, never a rule,
  marked `equivalence` with those readers where it is no harm, so the
  register never presents it as one.
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
  (`proof/pins.json`; the image holds the same trees at `/opt/hq`, `/opt/core`
  and `/opt/android`), cite `file::symbol`, search every reader of a value and
  its enclosing condition, and execute where reading leaves doubt. Never
  switch a shared checkout, never read one through `git show <commit>:<path>`
  or raw URLs. A fact a brief or plan states and the source contradicts is
  reported with the evidence, never coded around.
- **Never read XPath or XML with regular expressions.** XML is parsed with
  lxml; XPath is read through Core's own parser (the Core runner's
  `xpathParse`, `xpathStrings`, `xpathSame`), HQ's (eulxml, js-xpath), or
  `proof/rules/_xpath.py`, the port of Core's lexer that its test holds to
  Core. The surface extractor matches no source text by pattern either.
- **The lane shares CI's five-minute target.** Every hosted job has four
  vCPUs, so optimize the work, never the parallelism: measure a change in
  CPU-seconds (the harness's and Postgres's container cgroups) and wall time
  with the worker count, per document, per check, per group and per job's
  fixed cost. Never buy speed with more shards, workers or processes than a
  four-vCPU job serves, and never with a seam that computes something HQ would
  not.
- **Android is cited, not run** (step 1's decision 18). The Android classes a
  harm rests on run only inside a running CommCare app, so an entry whose harm
  is on Android observes the artifact through Core's parse and names the
  Android predicate in its `android` field.
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
  virtualenv, no new dependencies
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
- **The repository is public.** Nothing here describes an HQ route usable
  without a credential or any other HQ weakness, holds client data, or
  references a scratch directory or private script.
