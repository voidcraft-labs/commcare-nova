"""The gate's one way to the evidence store: the judgments and the surface of groups the queues cache.

Standard library only. The store's own reader (``proof.store.reader``)
provides two functions this module calls, each over the store directory the
gate restored:

- ``cached_evidence(groups, store) -> list[dict]``: for each cached group
  (``proof.lane.blocks.CachedGroup``, with the judgment key of each check),
  the evidence records its checks wrote when they ran, in the shape
  ``proof.checks.cases.evidence`` writes (``check``, ``document``, ``kind``,
  ``differences``);
- ``surface_extraction(store, key) -> bytes | None``: the surface extraction
  the store holds under ``key``, the cached surface group's ``outcome``
  (the key the queue names for the image, the harness and the extractor).

The store's reader raises ``StoreIncomplete`` for a cached group it cannot
give whole (a judgment it lacks, or an outcome that did not pass), which is a
problem the gate reports.

A queue that caches nothing needs neither. In a checkout without
``proof/store/reader.py``, a queue that caches a group is a problem the gate
reports: nothing could hold that group's judgments to the register.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path


def _store_reader():
    try:
        from proof.store import reader
    except ImportError:
        return None
    return reader


def cached_evidence(groups: Sequence, store: Path | None) -> tuple[list[dict], list[str]]:
    """The cached groups' evidence records, and why any could not be read."""
    if not groups:
        return [], []
    reader = _store_reader()
    if reader is None:
        return [], [
            f"The queues read {len(groups)} groups' judgments from the evidence store ({_names(groups)}), and this"
            " checkout has no store reader (proof/store/reader.py), so nothing holds them to the register."
        ]
    if store is None or not Path(store).is_dir():
        return [], [
            f"The queues read {len(groups)} groups' judgments from the evidence store ({_names(groups)}), and no"
            f" store directory was given or found ({store}); restore the store and pass it with --store."
        ]
    try:
        return list(reader.cached_evidence(list(groups), Path(store))), []
    except reader.StoreIncomplete as error:
        return [], [str(error)]


def surface_extraction(store: Path | None, key: str | None = None) -> tuple[bytes | None, str | None]:
    """The cached surface extraction, or why it could not be read."""
    reader = _store_reader()
    if reader is None:
        return None, "the queues read the surface from the evidence store, and this checkout has no store reader"
    if store is None or not Path(store).is_dir():
        return None, f"the queues read the surface from the evidence store, and no store was given or found ({store})"
    extraction = reader.surface_extraction(Path(store), key)
    if extraction is None:
        return None, f"the store at {store} holds no surface extraction under the queue's key {key}"
    return extraction, None


def _names(groups) -> str:
    names = sorted(group.group for group in groups)
    return ", ".join(names[:4]) + (f" and {len(names) - 4} more" if len(names) > 4 else "")
