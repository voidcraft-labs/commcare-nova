"""Observation: what HQ, Core and the browser make of a corpus document, written as keyed records.

Everything that runs HQ, Core or Chromium, or imports ``corehq`` or
``django``, lives here, and so does everything that decides what a record
holds; the checks (``proof.checks``) judge the records and import nothing
here that runs HQ.

- ``record``: canonical JSON, blobs, the keys of a unit's parts and the store
  that holds them.
- ``partition``: the files whose code or data decides what a record holds
  (the observation fingerprint's), and the observation's import closure.
- ``unit``: one HQ unit per (document, configuration), the tree every check
  reads, and the records it writes (``observe_document``).
- ``publish``: Nova's publishes applied through HQ's import.
- ``build``: HQ's build of one app state, every step's verdict kept, and
  Core's admission of it; ``outcome``: that build as data and as a record
  holds it.
- ``identity``: proof 1's identities, read from HQ's objects and its build.
- ``alignment``: B's ids and ``xmlns`` mapped to A's, and the aligned copy
  HQ builds; ``builds``: two builds compared, raw to decide whether B's
  sessions run.
- ``sensitivity``: A's plain build, the gates it read, and each flipped.
- ``casedata``: the case database a document's sessions run over, and the
  restore HQ writes for it.
- ``sessions``: proof 3's sessions on each build and HQ's processing of each
  submission; ``runs``: a run as the records hold it, and what decides
  whether it runs.
- ``intent``: the intent check's observation: HQ's data dictionary and Core's
  parse of every form HQ built at each state, Core's parse of every form of
  the local archives, and a targeted document's expectations run through
  Core's evaluate.
- ``manifest``: the manifest check's observation, with the local part: every
  export Nova sends and what HQ's and Core's readers make of it (question
  types, every attribute value through Core's XPath parser, the CSQL a
  search can send and HQ's CSQL parser over it).
- ``proof4``: HQ's editors saving over B and B-edit (``observe_b``, the
  unit's hook), each save in a fork of B, its stored app, build and trace
  against B's, and the browser transcripts it replays.
"""
