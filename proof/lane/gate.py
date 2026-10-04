"""``python -m proof.lane.gate``: the proof lane's verdict from every shard's output, on the standard library alone.

    python -m proof.lane.gate OUTPUT... [--early-queue FILE] [--queue FILE] [--store DIR]
        [--surface FILE] [--summary FILE]

It runs where the shards' outputs and the queues were downloaded, on the
runner's own Python (3.12 or later) with no image: everything it imports is
the standard library or the proof's own standard-library modules
(``proof.lane.blocks``, ``proof.lane.reader``, ``proof.checks.sharding``,
``proof.checks.registers``, ``proof.checks.differences``). With no queue
named, it reads the ``queue.json`` a run on one machine writes into its
output. Four sections, each with its problems:

1. Exactly once (``proof.checks.sharding.verify``): every queued block ran
   exactly once (a block two shards ran fails, whatever they wrote), every
   group ran every item its worker collected, cached groups ran nowhere, and
   the shards collected alike. Each block's first run counts.
2. Tests: every item the counted runs ran passed, was skipped, or failed as
   it is marked to.
3. Register (``proof.checks.registers.verify_evidence``): the evidence of
   every counted block, with the cached groups' evidence read from the store
   (``proof.lane.reader``), held to ``proof/known-defects.json``. A run over
   a sample of the corpus (its main queue names the documents the sample
   leaves out, ``unsampled``) holds each entry naming one of those on its
   control alone, and the section says how many entries it held so.
4. Surface: the surface block's extraction (``blocks/<id>/surface/
   surface.json``), or the store's when the queues cache the surface, is byte
   for byte the committed ``lib/commcare/surface/surface.json``. The
   committed surface is another process's extraction (``npm run surface``),
   so this is also what holds the extractor to the same bytes at the same
   pins (``proof/surface/test_extraction.py``).

It prints each section, writes the whole as JSON to ``--summary`` when named,
and appends it as Markdown to ``$GITHUB_STEP_SUMMARY`` when that is set. It
exits 0 when every section holds, 1 when one does not, and 2 when its
arguments cannot be read.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from proof.checks import registers, sharding
from proof.lane import blocks as lane_blocks
from proof.lane import reader

WORKTREE = sharding.PROOF_DIR.parent
COMMITTED_SURFACE = WORKTREE / "lib" / "commcare" / "surface" / "surface.json"
SURFACE = "surface"


def _section(problems, notes=(), **extra) -> dict:
    return {"holds": not problems, "problems": list(problems), "notes": list(notes), **extra}


def _cached_dir(records, directory: Path) -> Path:
    """The cached groups' evidence written as checks write theirs, for the register to read beside the blocks'."""
    for record in records:
        path = directory / "checks" / record["check"] / f"{record['kind']}-{record['document']}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
    return directory


def _surface(queues, verdict, store, committed: Path) -> dict:
    queued = [block.id for _, queue in queues for block in queue.blocks if SURFACE in block.names]
    cached = next((entry for _, queue in queues for entry in queue.cached if entry.group == SURFACE), None)
    try:
        expected = committed.read_bytes()
    except OSError as error:
        return _section([f"The committed surface {committed} could not be read ({error})."], verdict="unread")
    if queued:
        directory = verdict.chosen.get(queued[0])
        if directory is None:
            return _section(["No shard ran the surface block, so nothing shows the surface matches."], verdict="unrun")
        extracted = directory / "surface" / "surface.json"
        if not extracted.is_file():
            return _section(
                [f"The surface block ran ({directory}) and wrote no surface/surface.json, so its extraction failed."],
                verdict="missing",
            )
        actual, source = extracted.read_bytes(), str(extracted)
    elif cached is not None:
        actual, why = reader.surface_extraction(store, cached.judgments.get("outcome"))
        if actual is None:
            return _section([f"The surface could not be read: {why}."], verdict="missing")
        source = f"the store at {store}"
    else:
        return _section(["The queues neither run the surface block nor read it from the store."], verdict="absent")
    if actual == expected:
        return _section([], verdict="equal", source=source)
    expected_lines = expected.decode("utf-8", "replace").splitlines()
    actual_lines = actual.decode("utf-8", "replace").splitlines()
    first = next(
        (index for index, (a, b) in enumerate(zip(expected_lines, actual_lines, strict=False)) if a != b),
        min(len(expected_lines), len(actual_lines)),
    )
    return _section(
        [
            f"The surface extracted at the pins ({source}) differs from the committed {committed.name} from line"
            f" {first + 1}. Regenerate it with `npm run surface` and commit it; if the committed file is already what"
            " `npm run surface` gives at these pins, two extractions of the same pins differ, so look for what in the"
            " extractor is not deterministic."
        ],
        verdict="differs",
        source=source,
    )


def gate(outputs, queues, *, store=None, committed: Path = COMMITTED_SURFACE) -> dict:
    """The verdict over ``outputs`` (each shard's output directory) and ``queues`` (``(phase, Queue)`` pairs)."""
    verdict = sharding.verify(queues, outputs)
    sections = {"exactlyOnce": _section(verdict.problems, verdict.notes, blocks=len(verdict.chosen))}

    failing, ran = [], 0
    for directory in verdict.chosen.values():
        record = json.loads((directory / lane_blocks.MANIFEST).read_text(encoding="utf-8"))
        ran += sum(len(group["outcomes"]) for group in record["groups"])
        failing += lane_blocks.failing_items(record)
    sections["tests"] = _section(
        [f"{len(failing)} of the {ran} items run failed:"] + [f"  {item}" for item in failing[:50]] if failing else [],
        items=ran,
    )

    cached = [entry for _, queue in queues for entry in queue.cached if entry.group != SURFACE]
    unsampled = frozenset(document for _, queue in queues for document in queue.unsampled)
    entries = registers.load_known_defects()
    records, problems = reader.cached_evidence(cached, store)
    with tempfile.TemporaryDirectory(prefix="proof-gate-") as scratch:
        directories = [*verdict.chosen.values(), _cached_dir(records, Path(scratch))]
        problems += registers.verify_evidence(directories, entries, unsampled=unsampled)
    on_control_alone = sum(entry.document in unsampled for entry in entries)
    notes = (
        [
            f"This run checked a sample of the corpus, leaving {len(unsampled)} documents out, so {on_control_alone}"
            f" of the register's {len(entries)} entries name a document it did not run and were held on their"
            f" controls alone; the other {len(entries) - on_control_alone} were held on their documents and controls."
        ]
        if unsampled
        else []
    )
    sections["register"] = _section(
        problems, notes, cached=len(cached), unsampled=len(unsampled), heldOnControlAlone=on_control_alone
    )

    sections["surface"] = _surface(queues, verdict, store, committed)
    return {"holds": all(section["holds"] for section in sections.values()), "sections": sections}


TITLES = {
    "exactlyOnce": "Every block ran exactly once",
    "tests": "Every item passed",
    "register": "Every difference holds to the register",
    "surface": "The surface matches the committed one",
}


def _markdown(result: dict) -> str:
    lines = ["## Proof lane", ""]
    for key, section in result["sections"].items():
        lines.append(f"- {'Holds' if section['holds'] else 'Fails'}: {TITLES[key]}")
        lines += [f"  - Note: {line.strip()}" for line in section["notes"][:20]]
        lines += [f"  - {line.strip()}" for line in section["problems"][:20]]
    return "\n".join(lines) + "\n"


def _queues(arguments, outputs) -> list:
    named = [
        (phase, path)
        for phase, path in (("early", arguments.early_queue), ("main", arguments.queue))
        if path is not None
    ]
    if not named:
        found = sorted(
            {path.read_bytes() for path in (Path(output, "queue.json") for output in outputs) if path.is_file()}
        )
        if len(found) == 1:
            return [("main", lane_blocks.parse_queue(json.loads(found[0]), "the run's queue.json", check_names=False))]
        raise lane_blocks.QueueError(
            "Name the queues the shards ran (--early-queue, --queue); the outputs hold no single queue.json of"
            " their own."
        )
    return [(phase, lane_blocks.load_queue(path)) for phase, path in named]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m proof.lane.gate", description=__doc__.splitlines()[0])
    parser.add_argument("outputs", nargs="+", type=Path, help="every shard's output directory")
    parser.add_argument("--early-queue", type=Path, help="the early queue the shards ran")
    parser.add_argument("--queue", type=Path, help="the main queue the shards ran")
    parser.add_argument("--store", type=Path, help="the evidence store, for the groups the queues cache")
    parser.add_argument("--surface", type=Path, default=COMMITTED_SURFACE, help="the committed surface to compare")
    parser.add_argument("--summary", type=Path, help="where to write the verdict as JSON")
    arguments = parser.parse_args(argv)
    try:
        queues = _queues(arguments, arguments.outputs)
    except lane_blocks.QueueError as error:
        print(error, file=sys.stderr)
        return 2
    result = gate(arguments.outputs, queues, store=arguments.store, committed=arguments.surface)
    for key, section in result["sections"].items():
        print(f"{'holds' if section['holds'] else 'FAILS'}: {TITLES[key]}")
        for note in section["notes"]:
            print(f"  note: {note}")
        for problem in section["problems"]:
            print(f"  {problem}")
    if arguments.summary is not None:
        lane_blocks.write_json(arguments.summary, result)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as summary:
            summary.write(_markdown(result))
    return 0 if result["holds"] else 1


if __name__ == "__main__":
    sys.exit(main())
