"""``python -m proof.lane.gate``: the proof lane's verdict from every shard's output, on the standard library alone.

    python -m proof.lane.gate OUTPUT... [--early-queue FILE] [--queue FILE] [--store DIR] [--surface FILE]
        [--summary FILE]

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
   control alone, and the section says how many entries it held so. A run
   without the readers (its queues say ``readers: false``,
   ``proof.lane.readers``) leaves the served readers' entries
   (``proof.checks.registers.served_entry``) to the nightly and holds every
   other, and the section says how many it left; every shard must have run
   in the profile its queues were built for (``serve.json``'s ``readers``).
   A pull request's queues may defer groups to the nightly (``deferred``,
   ``proof.lane.plan``): a deferred document is held as an unsampled one is,
   an entry whose control was deferred is held on its document alone, and
   one whose document and control were both deferred is left to the nightly
   and named.
4. Surface: the surface block's extraction (``blocks/<id>/surface/
   surface.json``), or the store's when the queues cache the surface, is byte
   for byte the committed ``lib/commcare/surface/surface.json``. The
   committed surface is another process's extraction (``npm run surface``),
   so this is also what holds the extractor to the same bytes at the same
   pins (``proof/surface/test_extraction.py``).

It prints each section, and every deferred group under a heading of its own
("Deferred to the nightly"), so a reviewer sees what the nightly will cover;
writes the whole as JSON to ``--summary`` when named, and appends it as
Markdown to ``$GITHUB_STEP_SUMMARY`` when that is set. A deferred surface
block leaves the surface section to the nightly. It
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
from proof.checks.differences import SERVED_ARTIFACTS
from proof.lane import blocks as lane_blocks
from proof.lane import reader
from proof.lane import readers as lane_readers

WORKTREE = sharding.PROOF_DIR.parent
COMMITTED_SURFACE = WORKTREE / "lib" / "commcare" / "surface" / "surface.json"
SURFACE = "surface"


def _section(problems, notes=(), **extra) -> dict:
    return {"holds": not problems, "problems": list(problems), "notes": list(notes), **extra}


def _cached_dir(records, directory: Path) -> Path:
    """The cached groups' evidence written as checks write theirs, for the register to read beside the blocks'."""
    for record in records:
        name = f"{record['kind']}-{record['document']}.json"
        path = directory / "checks" / record["check"] / name
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
    deferred = sorted((entry for _, queue in queues for entry in queue.deferred), key=lambda entry: entry.group)
    deferred_documents = frozenset(
        entry.group[len("corpus:") :].partition("@")[0] for entry in deferred if entry.group.startswith("corpus:")
    )
    deferred_controls = frozenset(
        entry.group[len("control:") :] for entry in deferred if entry.group.startswith("control:")
    )
    readers, problems = _profile(queues, outputs)
    entries = registers.load_known_defects()
    records, read_problems = reader.cached_evidence(cached, store)
    problems += read_problems
    with tempfile.TemporaryDirectory(prefix="proof-gate-") as scratch:
        directories = [*verdict.chosen.values(), _cached_dir(records, Path(scratch))]
        problems += registers.verify_evidence(
            directories,
            entries,
            unsampled=unsampled | deferred_documents,
            unrun_controls=deferred_controls,
            readers=readers,
        )
    held = registers.held_entries(entries, readers=readers)
    left = len(entries) - len(held)
    on_control_alone = sum(entry.document in unsampled and entry.control not in deferred_controls for entry in held)
    notes = []
    unnamed = [name for name in lane_readers.READERS if name not in readers]
    if not readers:
        notes.append(
            f"This run handed no state to the readers ({lane_readers.VARIABLE}=0, the pull request lane), so {left}"
            f" of the register's {len(entries)} entries, whose artifacts only the served readers write"
            f" ({', '.join(sorted(SERVED_ARTIFACTS))}), were left to the nightly run with every reader;"
            f" the other {len(held)} were held."
        )
    elif unnamed:
        notes.append(
            f"This run observed {lane_readers.described(readers)} ({lane_readers.VARIABLE}="
            f"{lane_readers.canonical(readers)}), so {left} of the register's {len(entries)} entries, whose"
            f" artifacts {', '.join(unnamed)} write, were left to the nightly run with every reader; the other"
            f" {len(held)} were held."
        )
    if unsampled:
        entries_held = f"the register's {len(held)} entries" if not left else f"the {len(held)} entries it held"
        notes.append(
            f"This run checked a sample of the corpus, leaving {len(unsampled)} documents out, so {on_control_alone}"
            f" of {entries_held} name a document it did not run and were held on their controls alone; the other"
            f" {len(held) - on_control_alone} were held on their documents and controls."
        )
    # Entries a deferral moved off their documents or controls; an entry whose document did not run (deferred, or
    # left out of a sample) and whose control was deferred is held on neither, and named for the nightly.
    unrun = unsampled | deferred_documents
    deferred_both = sorted(entry.id for entry in held if entry.document in unrun and entry.control in deferred_controls)
    deferred_control_alone = sum(
        entry.document in deferred_documents - unsampled and entry.control not in deferred_controls for entry in held
    )
    deferred_document_alone = sum(entry.control in deferred_controls and entry.document not in unrun for entry in held)
    if deferred:
        notes.append(
            f"The pull request's planner deferred {len(deferred)} groups to the nightly so the lane ends within its"
            f" bound ({len(deferred_documents)} documents, {len(deferred_controls)} controls,"
            f" {len(deferred) - len(deferred_documents) - len(deferred_controls)} package groups; listed under"
            f' "Deferred to the nightly"): {deferred_control_alone} entries naming a deferred document were held'
            f" on their controls alone, {deferred_document_alone} naming a deferred control on their documents"
            f" alone, and {len(deferred_both)} whose document and control were both deferred are left to the"
            f" nightly{': ' + ', '.join(deferred_both) if deferred_both else ''}."
        )
    sections["register"] = _section(
        problems,
        notes,
        cached=len(cached),
        unsampled=len(unsampled),
        heldOnControlAlone=on_control_alone,
        readers=lane_readers.to_record(readers),
        leftToNightly=left,
        deferredHeldOnControlAlone=deferred_control_alone,
        deferredHeldOnDocumentAlone=deferred_document_alone,
        deferredLeftToNightly=deferred_both,
    )

    if any(entry.group == SURFACE for entry in deferred):
        sections["surface"] = _section(
            [],
            ["The surface block was deferred to the nightly, which compares its extraction with the committed one."],
            verdict="deferred",
        )
    else:
        sections["surface"] = _surface(queues, verdict, store, committed)
    return {
        "holds": all(section["holds"] for section in sections.values()),
        "sections": sections,
        "deferred": [{"group": entry.group, "estimate": entry.estimate} for entry in deferred],
    }


def _profile(queues, outputs) -> tuple[frozenset, list[str]]:
    """The readers the run handed its states to, as its queues say (``readers``), and why the queues or a shard do
    not agree on them: a shard of another set ran other groups and kept other records."""
    sets = {queue.readers for _, queue in queues}
    problems = []
    if len(sets) > 1:
        built = ", ".join(f"the {phase} queue for {lane_readers.described(queue.readers)}" for phase, queue in queues)
        problems.append(
            f"The queues were built for different readers ({built}); build both with the same {lane_readers.VARIABLE}."
        )
    readers = next(iter(sets)) if len(sets) == 1 else lane_readers.EVERY
    for output in outputs:
        serve = Path(output) / lane_blocks.SERVE
        if not serve.is_file():
            continue
        try:
            ran = lane_readers.from_record(json.loads(serve.read_text(encoding="utf-8")).get("readers"))
        except lane_readers.ReadersError as error:
            problems.append(f"{output}: {error}")
            continue
        if ran != readers:
            problems.append(
                f"{output} ran with {lane_readers.described(ran)} ({lane_readers.VARIABLE}), and its queues were"
                f" built for {lane_readers.described(readers)}, so it ran other groups than they name and kept other"
                " records."
            )
    return readers, problems


TITLES = {
    "exactlyOnce": "Every block ran exactly once",
    "tests": "Every item passed",
    "register": "Every difference holds to the register",
    "surface": "The surface matches the committed one",
}


def _deferred_lines(result: dict) -> list[str]:
    """Each group the planner deferred, with its estimate, for the heading a reviewer reads them under."""
    return [f"{entry['group']} ({entry['estimate']:g} box-seconds)" for entry in result.get("deferred", [])]


def _markdown(result: dict) -> str:
    lines = ["## Proof lane", ""]
    for key, section in result["sections"].items():
        lines.append(f"- {'Holds' if section['holds'] else 'Fails'}: {TITLES[key]}")
        lines += [f"  - Note: {line.strip()}" for line in section["notes"][:20]]
        lines += [f"  - {line.strip()}" for line in section["problems"][:20]]
    deferred = _deferred_lines(result)
    if deferred:
        lines += [
            "",
            "### Deferred to the nightly",
            "",
            f"This pull request's lane left these {len(deferred)} groups to the nightly so it ends within ten"
            " minutes; the nightly observes every group main's store lacks.",
            "",
        ]
        lines += [f"- {line}" for line in deferred]
    return "\n".join(lines) + "\n"


def _queues(arguments, outputs) -> list:
    named = [
        (phase, path)
        for phase, path in (
            ("early", arguments.early_queue),
            ("main", arguments.queue),
        )
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
    deferred = _deferred_lines(result)
    if deferred:
        print(f"Deferred to the nightly ({len(deferred)} groups):")
        for line in deferred:
            print(f"  {line}")
    if arguments.summary is not None:
        lane_blocks.write_json(arguments.summary, result)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as summary:
            summary.write(_markdown(result))
    return 0 if result["holds"] else 1


if __name__ == "__main__":
    sys.exit(main())
