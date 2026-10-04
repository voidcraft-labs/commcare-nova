"""The checks over Nova's exports (proof/README.md): the bar, the proofs, and the registers they hold to.

The checks judge records (``proof.observe``: one HQ unit per document and
configuration, observed once for every check), and import neither HQ nor
Django (``test_judge_purity``). What decides a record (the alignment, the
identities read, a session run, the flips built, the raw build comparison)
is the observation's, and the judges read it from there.

- ``corpus``: the corpus on disk (``proof/corpus/emit.ts``'s layout), and the
  controls under ``proof/controls/`` read the same way.
- ``differences``: the ``Difference`` every check reports, the complete set.
- ``compare``: structural comparators over JSON, XML, app strings, Core
  traces and every file HQ's build writes, with proof 2's version clause,
  each applying the spelling rules its caller gives.
- ``hqbuild``: one HQ build's outcome as the judges read it from a record.
- ``observations``: a document's records, made once for its checks, and the
  views each check reads them through (A, B, B aligned to A, B-edit, the
  flips, the local archives), with every soft assertion HQ noted held by the
  check whose operation made it.
- ``identity``: proof 1's identity records compared (a document's modules,
  forms and languages are placed on the wire by what ``document.json``
  records).
- ``bar``, ``sensitivity``, ``intent``, ``proof1``, ``proof2``, ``proof3``,
  ``proof4``, ``proof5``: each check's differences, judged from the records;
  ``manifest_usage``: the manifest check's, judged from the records of every
  export and the manifest, each use placed in the value class its entries
  split its item by (``manifest_value_classes``).
- ``casedata``: the case database a document's sessions run over
  (``proof.observe.casedata``).
- ``registers``: the known-defect and identity-move registers, strict
  matching (decision 12), and the whole run's evidence held to the register
  (``python -m proof.checks.registers verify``).
- ``sharding``: the lane's groups (each group's items run together), what
  each costs in box-seconds, the static bins, and whether a run's blocks ran
  every item exactly once (standard library only; ``proof.lane`` runs them).
- ``cases``: the documents each check runs over, and ``hold``.
- ``suite_app``: a known identity change on HQ's own suite-test app, for the
  framework's own controls.
"""
