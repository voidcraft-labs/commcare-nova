"""The gate's reader of the evidence store: the cached groups' judgments, and the cached surface extraction.

``proof.lane.reader`` calls it, on the runner's own Python, over the
snapshot the gate restored and merged (``PROOF_STORE`` in the shards):

- ``cached_evidence(groups, store)``: for each group the queues read from the
  store (``proof.lane.blocks.CachedGroup``), the evidence its checks wrote when
  it ran, as ``proof.checks.cases.evidence`` writes it, read under each
  check's judgment key. A group's ``outcome`` key names its outcome, which
  must have run every item without a failure; a judgment the store does not
  hold whole, or evidence naming another document, is a ``StoreIncomplete``,
  never skipped: the register would hold nothing for it.
- ``surface_extraction(store, key)``: the extraction the surface block made
  when it ran under ``key`` (the cached surface group's ``outcome``).

Standard library only.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

from proof.lane import blocks as lane_blocks
from proof.store import disk

OUTCOME = "outcome"


class StoreIncomplete(ValueError):
    """The queues read a group from the store, and the store does not hold what that needs."""


def _outcome_problem(snapshot: disk.Snapshot, group: str, key: str | None) -> str | None:
    if key is None:
        return None
    outcome = snapshot.get("groups", key)
    if outcome is None:
        return f"the store holds no outcome for {group} under {key[:16]}"
    failing = sorted(node for node, result in outcome["items"].items() if result in lane_blocks.FAILING)
    if outcome.get("failure") or failing or not outcome["items"]:
        return f"{group}'s stored outcome under {key[:16]} did not pass ({outcome.get('failure') or failing})"
    return None


def cached_evidence(groups: Sequence, store: Path) -> list[dict]:
    snapshot = disk.Snapshot(store)
    found, problems = [], []
    for cached in groups:
        problem = _outcome_problem(snapshot, cached.group, cached.judgments.get(OUTCOME))
        if problem is not None:
            problems.append(problem)
        # A document's Android group holds its judges' evidence on that document (``android:corpus:<id>``).
        kind, _, document = (lane_blocks.android_document(cached.group) or cached.group).partition(":")
        for check, key in sorted(cached.judgments.items()):
            if check == OUTCOME:
                continue
            held = snapshot.get("judgments", key)
            content = None if held is None else snapshot.blob(held)
            if content is None:
                problems.append(f"the store holds no judgment of {check} on {cached.group} under {key[:16]}")
                continue
            record = json.loads(content)
            if (record.get("check"), record.get("kind"), record.get("document")) != (check, kind, document):
                problems.append(f"the judgment under {key[:16]} is not {check}'s on {cached.group}")
                continue
            found.append(record)
    if problems:
        raise StoreIncomplete(
            f"The queues read {len(groups)} groups from the evidence store at {store}, and it cannot give them all:"
            + "".join(f"\n- {problem}" for problem in problems[:20])
            + "\nRun the lane with the store it was queued from, or queue these groups to run."
        )
    return found


def surface_extraction(store: Path, key: str | None = None) -> bytes | None:
    """The surface extraction the store holds under ``key``, or None (no key, or nothing whole held)."""
    if key is None:
        return None
    snapshot = disk.Snapshot(store)
    if _outcome_problem(snapshot, "surface", key) is not None:
        return None
    held = snapshot.get("groups", key).get("surface")
    return None if held is None else snapshot.blob(held)
