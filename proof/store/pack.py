"""Snapshots of the evidence store: made from lane runs' outputs, merged, and a pull request's own.

    python3 -m proof.store.pack pack --out DIR OUTPUT... [--queue FILE]...
    python3 -m proof.store.pack merge --into DIR [SNAPSHOT]...
    python3 -m proof.store.pack delta --base DIR --scope DIR --out DIR OUTPUT... [--queue FILE]...

``pack`` writes the snapshot (``proof.store.disk``) of what the shard
outputs hold (``gather``): every record part, document and transcript their
runs' deltas kept; every check's evidence on a document whose records the
run kept, as a judgment under its key (``proof.store.keys.group_key``,
``judgment_key``), as the check wrote it; and each group's outcome from the
block manifests: a document's under its group key, a package group's and the
surface block's under the key the queue that ran it names for it
(``--queue``; without one they are not kept), the surface block's with its
extraction.

Outcomes and judgments are kept only from a run of the lane's own
selection: its ``serve.json`` records that the server collected with no
pytest arguments and no ``PYTEST_ADDOPTS`` (``selection``), as a run over
queues does (``proof.lane.serve``). A group's outcome under another
selection holds the items that selection kept, and a queue that read it
would cache the group without the rest; its records are kept all the same,
since a part's record does not depend on which checks read it. A package
group's outcome is kept only from a run in the environment the queue keys it
under (``proof.store.keys.lane_environment``): a document's is keyed by the
environment its run recorded, a package group's by the one the queue assumed.
No outcome is kept from a run that held HQ's branch proof over a list of
documents of its own, or that records no environment
(``proof.store.keys.lane_branches``): the proof's items are in their
documents' groups, so such a run's groups hold other items than the lane's.

``merge`` writes one snapshot of several (a source that does not exist holds
nothing); ``delta`` writes what ``--scope`` (the pull request's snapshot) and
the outputs hold beyond ``--base`` (main's): the entries ``--base`` does not
hold as they are, with every blob they name, so a pull request's snapshot
reads whole beside any later snapshot of main.

Where two sources hold different values under one key, the key is dropped
and named on standard error: a key names every input, so its two values
show an observation that is not a function of them, and neither stands in
for the other. A transcript is the exception, the later one kept, since
either is replayed only where HQ answers alike. An entry naming a blob no
source holds (a snapshot cut short) is dropped and named too, so a reader
misses it rather than the run failing. Blobs are linked from their sources,
unread; every reader verifies a blob against its name, so a damaged one is a
miss where it is read. Every output directory is created with its parents; a
snapshot is written only into a new or empty directory, or over one of its
sources. The same inputs give the same bytes.

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from proof.lane import blocks as lane_blocks
from proof.store import disk, keys

DOCUMENT_KINDS = lane_blocks.DOCUMENT_KINDS
SURFACE = "surface"


class PackError(ValueError):
    """Outputs or snapshots that cannot be packed together."""


@dataclass
class Gathered:
    """An index, where each blob it names is read from, and what was dropped for differing (with the values)."""

    index: dict = field(default_factory=disk.empty_index)
    sources: list = field(default_factory=list)
    conflicted: dict = field(default_factory=lambda: {kind: {} for kind in disk.KINDS})
    notes: list = field(default_factory=list)
    memory: dict = field(default_factory=dict)
    _found: dict = field(default_factory=dict)

    def put(self, kind: str, key: str, value) -> None:
        if key in self.conflicted[kind]:
            self._conflict(kind, key, value)
            return
        held = self.index[kind].get(key)
        if held is None or kind in disk.REPLACEABLE or disk.canonical(held) == disk.canonical(value):
            self.index[kind][key] = value
            return
        del self.index[kind][key]
        self.conflicted[kind][key] = [held]
        self._conflict(kind, key, value)
        self.notes.append(
            f"Dropped the {kind} entry {key[:16]}: one source holds {disk.shown(held)} and another"
            f" {disk.shown(value)} under the same key."
        )

    def _conflict(self, kind: str, key: str, value) -> None:
        values = self.conflicted[kind][key]
        if all(disk.canonical(value) != disk.canonical(other) for other in values):
            values.append(value)

    def keep_blob(self, content: bytes) -> str:
        found = disk.digest_of(content)
        self.memory[found] = content
        return found

    def has_blob(self, found: str) -> bool:
        held = self._found.get(found)
        if held is None:
            held = self._found[found] = found in self.memory or any(s.has_blob(found) for s in self.sources)
        return held

    def blob(self, found: str) -> bytes | None:
        if found in self.memory:
            return self.memory[found]
        for source in self.sources:
            content = source.blob(found)
            if content is not None:
                return content
        return None

    def blob_file(self, found: str):
        """Where a source keeps the blob as a file (none for one held in memory)."""
        if found in self.memory:
            return None
        return next((path for source in self.sources if (path := source.blob_file(found)) is not None), None)

    def complete(self) -> Gathered:
        """Drop each entry naming a blob no source holds, named in a note: a reader misses it."""
        for kind in disk.KINDS:
            for key in sorted(self.index[kind]):
                missing = sorted(d for d in disk.entry_blobs(kind, self.index[kind][key]) if not self.has_blob(d))
                if missing:
                    del self.index[kind][key]
                    self.notes.append(
                        f"Dropped the {kind} entry {key[:16]}: it names the blob {missing[0]}, which no source"
                        " holds, so it is read as a miss."
                    )
        return self


def judged_evidence(content: bytes) -> bytes:
    """An evidence record as a judgment keeps it: the canonical JSON of what its check wrote."""
    return disk.canonical(json.loads(content))


def queue_keys(paths) -> dict[str, str]:
    """The key each queue names for each group it queues (``proof.store.queue``), by group."""
    found = {}
    for path in paths or ():
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        for block in value.get("blocks", []):
            for group in block.get("groups", []):
                if isinstance(group.get("key"), str):
                    found[group["group"]] = group["key"]
    return found


def selection(output: Path) -> dict | None:
    """What the run in ``output`` collected with (its ``serve.json``'s ``selection``), or None when it records
    another than the lane's own: pytest arguments or ``PYTEST_ADDOPTS``."""
    try:
        record = json.loads((Path(output) / lane_blocks.SERVE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    found = record.get("selection")
    if not isinstance(found, dict) or found.get("pytest") != [] or found.get("addopts"):
        return None
    return found


def _lane_environment(found: dict) -> bool:
    recorded = found.get("environment")
    return isinstance(recorded, dict) and keys.lane_environment(recorded)


def _document(name: str):
    kind, _, identifier = name.partition(":")
    return kind, identifier


def gather(outputs, queues=()) -> Gathered:
    """What lane runs' outputs hold for the store (see the module's docstring)."""
    gathered = Gathered()
    package_keys = queue_keys(queues)
    judges = set()
    runs = []
    for output in outputs:
        output = Path(output)
        if not output.is_dir():
            continue
        delta = disk.Delta(output / disk.DELTA)
        written = delta.fingerprints()
        if written is not None:
            judges.add(written["fingerprints"]["judge"])
            gathered.sources.append(delta)
            for kind in ("parts", "documents", "transcripts"):
                for key, value in delta.entries(kind).items():
                    gathered.put(kind, key, value)
        found = selection(output)
        if found is None:
            gathered.notes.append(
                f"Kept no outcome or judgment of {output}: its serve.json does not record the lane's own selection"
                " (no pytest arguments, no PYTEST_ADDOPTS), so its groups may hold only some of their items."
            )
            continue
        recorded = found.get("environment")
        if not isinstance(recorded, dict) or not keys.lane_branches(recorded):
            gathered.notes.append(
                f"Kept no outcome or judgment of {output}: its serve.json does not record HQ's branch proof over"
                f" the lane's documents ({keys.BRANCH_DOCUMENTS} unset or all), so its groups may hold only some of"
                " their items."
            )
            continue
        packages = _lane_environment(found)
        if not packages:
            gathered.notes.append(
                f"Kept no package group's outcome of {output}: its serve.json does not record the environment the"
                " queue keys package groups under (proof.store.keys.lane_environment)."
            )
        runs += [(directory, manifest, packages) for directory, manifest in lane_blocks.read_manifests(output)]
    if len(judges) > 1:
        raise PackError(
            f"The outputs were written under {len(judges)} judge fingerprints; one store holds one tree's runs, so"
            " pack each tree's outputs apart."
        )
    judge = next(iter(judges), None)
    documents = {}
    for key, value in gathered.index["documents"].items():
        documents.setdefault(value["group"], []).append(key)
    for directory, manifest, packages in runs:
        for group in manifest["groups"]:
            name = group["group"]
            outcome = {"group": name, "items": dict(group["outcomes"]), "failure": group["failure"]}
            if name.startswith(DOCUMENT_KINDS):
                held = documents.get(name, [])
                if judge is None or len(held) != 1:
                    continue
                document = held[0]
                parts = gathered.index["documents"][document]["parts"]
                group_key = keys.group_key(document, judge, {part: found for part, (_, found) in parts.items()})
                kind, identifier = _document(name)
                judgments = {}
                for path in sorted(Path(directory, "checks").glob(f"*/{kind}-{identifier}.json")):
                    check = path.parent.name
                    judgment = keys.judgment_key(group_key, check)
                    gathered.put("judgments", judgment, gathered.keep_blob(judged_evidence(path.read_bytes())))
                    judgments[check] = judgment
                outcome["judgments"] = judgments
                gathered.put("groups", group_key, outcome)
            elif name in package_keys and packages:
                if name == SURFACE:
                    extraction = Path(directory, "surface", "surface.json")
                    if extraction.is_file():
                        outcome["surface"] = gathered.keep_blob(extraction.read_bytes())
                gathered.put("groups", package_keys[name], outcome)
    return gathered


def merged(sources) -> Gathered:
    """One index of several snapshots (an absent one holds nothing), later sources read after earlier ones,
    without an entry naming a blob none of them holds (``Gathered.complete``)."""
    gathered = Gathered()
    for source in sources:
        if isinstance(source, Gathered):
            gathered.sources += source.sources
            gathered.memory.update(source.memory)
            gathered.notes += source.notes
            for kind in disk.KINDS:
                for key, values in source.conflicted[kind].items():
                    held = gathered.index[kind].pop(key, None)
                    gathered.conflicted[kind].setdefault(key, [] if held is None else [held])
                    for value in values:
                        gathered.put(kind, key, value)
                for key, value in source.index[kind].items():
                    gathered.put(kind, key, value)
            continue
        held = disk.Snapshot(source) if Path(source).is_dir() else disk.Snapshot(None)
        gathered.sources.append(held)
        for kind in disk.KINDS:
            for key, value in held.index[kind].items():
                gathered.put(kind, key, value)
    return gathered.complete()


def beyond(gathered: Gathered, base: disk.Snapshot) -> Gathered:
    """What ``gathered`` holds that ``base`` does not hold as it is."""
    found = Gathered(sources=gathered.sources, memory=gathered.memory, notes=gathered.notes)
    for kind in disk.KINDS:
        for key, value in gathered.index[kind].items():
            held = base.get(kind, key)
            if held is None or disk.canonical(held) != disk.canonical(value):
                found.index[kind][key] = value
    return found


def write(gathered: Gathered, out: Path, *, sources=()) -> Path:
    """Write ``gathered`` as a snapshot into ``out`` (new, empty, or one of ``sources``) with every blob its
    entries name, linked from its source where it is a file; an entry whose blob no source holds is left out and
    named in a note."""
    out = Path(out)
    if out.exists() and any(out.iterdir()) and all(out.resolve() != Path(s).resolve() for s in sources):
        raise PackError(
            f"{out} already holds files, and a snapshot is written only into a new or empty directory (or over one"
            " of its sources), so nothing of another store is left in it."
        )
    return disk.write_snapshot(out, gathered.complete().index, gathered.blob, held=gathered.blob_file)


def summary(gathered: Gathered) -> str:
    counts = ", ".join(f"{len(gathered.index[kind])} {kind}" for kind in disk.KINDS)
    return f"{counts}; {len(disk.reached_blobs(gathered.index))} blobs"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m proof.store.pack", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("pack", help="a snapshot of lane runs' outputs")
    pack.add_argument("--out", required=True, type=Path)
    pack.add_argument("--queue", action="append", type=Path, default=[], help="a queue the outputs ran")
    pack.add_argument("outputs", nargs="+", type=Path)
    merge = commands.add_parser("merge", help="one snapshot of several")
    merge.add_argument("--into", required=True, type=Path)
    merge.add_argument("sources", nargs="*", type=Path)
    delta = commands.add_parser("delta", help="what a pull request's runs hold beyond main's snapshot")
    delta.add_argument("--base", required=True, type=Path)
    delta.add_argument("--scope", required=True, type=Path)
    delta.add_argument("--out", required=True, type=Path)
    delta.add_argument("--queue", action="append", type=Path, default=[], help="a queue the outputs ran")
    delta.add_argument("outputs", nargs="*", type=Path)
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "pack":
            gathered = gather(arguments.outputs, arguments.queue)
            write(gathered, arguments.out)
        elif arguments.command == "merge":
            gathered = merged(arguments.sources)
            write(gathered, arguments.into, sources=arguments.sources)
        else:
            base = disk.Snapshot(arguments.base) if arguments.base.is_dir() else disk.Snapshot(None)
            combined = merged([arguments.scope, gather(arguments.outputs, arguments.queue)])
            gathered = beyond(combined, base)
            write(gathered, arguments.out)
    except (PackError, disk.StoreFormatError, OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 2
    for note in gathered.notes:
        print(note, file=sys.stderr)
    print(summary(gathered))
    return 0


if __name__ == "__main__":
    sys.exit(main())
