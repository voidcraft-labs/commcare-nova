"""The evidence store: what the proof lane observed and judged, kept under keys that name every input.

The lane reuses a stored result only where its key covers everything that
could change it, and never trades a correct key for a hit. Four kinds of
result are kept, each under its own key (``keys``):

- record parts (``proof.observe.record``: ``a``, ``b``, ``b_aligned``,
  ``b_edit``, ``local``), by the part's key and the fingerprints of the
  observation code, the image, the Postgres image, the architecture and the
  observation's environment (the parts that drive the browser name its code
  in their own keys);
- judgments, each check's evidence on one document, by the document's
  files, the observation's and the browser's code, the platform, every
  record part it was judged from, and the judge's code;
- browser transcripts (``proof.editors.transcripts``), by the observation's
  and the browser's code (which start the browser, hand it what HQ does not
  answer, and record what it did), the platform, the environment and the
  run's spec and first answer, and replayed only where HQ, really run again,
  answers every recorded request byte for byte;
- package groups' outcomes and the surface extraction, by every file of the
  harness, the image, the environment and the corpus data each group reads.

Modules:

- ``fingerprints``: the partitions of the checkout and what each digest
  covers (standard library and git only).
- ``keys``: every key the store keeps a result under.
- ``disk``: a snapshot's layout (``index.json`` and ``blobs/``) and the delta
  a lane run writes beside its output.
- ``guard``: the audit hook that refuses an observation's read of anything
  its key does not name.
- ``runtime``: the store a lane worker observes with (``Store``,
  ``session_store``), reading a snapshot and writing its delta.
- ``pack``: snapshots made from lane outputs, merged, and a pull request's
  delta (``python3 -m proof.store.pack``).
- ``queue``: the lane's early and main queues (``python3 -m proof.store.queue``).
- ``audit``: fresh records held to the store, and two lane runs held to each
  other (``python3 -m proof.store.audit``).
- ``reader``: the gate's reader of cached judgments and of the surface.

``PROOF_STORE`` names the snapshot a lane run reads (``off`` turns the store
off entirely: nothing is read, written or guarded); ``PROOF_FINGERPRINTS``
carries the fingerprints into the lane's containers, and without them the
store stays off.
"""
