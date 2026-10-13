"""CommCare HQ, booted offline for the proof harness.

Every HQ-side check imports this package and nothing repeats it:

- ``boot`` brings HQ up once per process, with every network reach refused
  except the lane's Postgres and every cache in local memory.
- ``configuration`` names the project space a check runs against: its flags,
  privileges, CommCare version and project settings.
- ``state`` opens HQ units (``hq_unit``): one transaction, always rolled
  back, on the worker's clone of the database HQ's migrations create
  (``database``), an in-memory Couch that computes the views those paths
  query (``couch``), a temporary blob store and a recording change feed,
  seeded with the project space. ``branch`` names a unit's state by a key
  that every operation, and every request that writes, moves, and marks and
  restores it exactly.
- ``requests`` builds the requests HQ's views receive.
- ``seams`` answers what HQ reads from outside its state: feature flags,
  privileges, the project settings, Formplayer's form validation (the Core
  runner), the previous build and resource overrides; ``elasticsearch``
  is HQ's own Elasticsearch, one server a process, its indexes written by
  HQ's own code and held to each unit's marks.
- ``speed`` runs HQ at production speed with ``DEBUG`` left on (the cached
  template loader, no query log, the memoized webpack manifest and settings
  YAML, HQ's XPath validator in one long-lived node child), and installs
  ``buildcache``: what HQ's build works out again from the same input
  (eulxml's compiled XPaths, lxml's path selectors, version parses, the
  previous build's files and every other attachment read, a form's
  questions, the language names file), kept once computed; and gives the
  cyclic collector a larger youngest generation.
- ``determinism`` makes an HQ operation's bytes a function of its key:
  seeded entropy and a frozen clock (``operation(key, depth)``).
- ``check.hq_check`` opens a check's unit, keyed by its configuration, and
  its seams together.
- ``operations`` runs HQ's own code for publish, app source, build, case
  processing, case search compilation and the lookup table upload.

Importing the package has no side effects; ``proof.hq.boot.boot()`` runs
before anything imports HQ.
"""
