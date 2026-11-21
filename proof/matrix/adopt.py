"""Adopt what a run made of HQ into the retained trees:
``python3 -m proof.matrix.adopt <output>... [--report --corpus <corpus>]``.

A run's tests write what HQ made under each block's output before they hold
the committed trees to it (``proof/matrix/retained.py``):
``<output>/blocks/<block>/hq-apps/<base>/`` (``proof/matrix/test_retained.py``)
and ``<output>/blocks/<block>/hq-reads/<group>/``
(``proof/hq/test_retained_reads.py``, ``proof/editors/test_retained_reads.py``).
A sharded run leaves one output a shard, and two blocks of one run, on two
shards, can write files of one retained directory (both of those
``hq-reads`` tests write ``navigation-base/`` and ``shell/``), so adopting
takes every output of the run at once and merges by file: each file any
block wrote is written over ``proof/hq-apps/`` and ``proof/hq-reads/``, and
two blocks that wrote one file differently are refused, by name. A committed
file the run did not write is removed only where a test that owns it reached
its comparison and did not make it: each comparison records the committed
files of its own it did not make (``<output>/blocks/<block>/retained-held/``,
``retained.Retained.record_held``), so a file another test writes, or one of
a test that stopped before comparing, is kept. A directory the run did not
write is left as it is. A base the run wrote no ``expected.json`` for is one
whose reading did not come in, and is left out, by name; what a run kept of
such a base sits under ``<output>/blocks/<block>/hq-apps-unread/``, which is
no tree adopted.

With ``--report`` it prints each base whose stored app (``app.json``) or
whose answers changed, and each base whose reading changed: the reader
bundle of a corpus made on this machine (``--corpus``, whose
``native/reader/reader.mjs`` is run; never one inside any of the run's
outputs, which the run's containers wrote) reads the old answers and the new
ones (``proof.matrix.lane_input``), and a base whose two answers differ is
named.

A run's output is data a container wrote, so it is read through the
retained layout (``proof.matrix.layout``) and nothing else: each block's
trees and held records are opened without following a link, every name is
checked against the layout before a byte is read, and a run that wrote
anything outside it, in any of its outputs, is refused whole, by name,
before anything under ``proof/`` changes. A held record can name only a file
its tree's directory may hold, so what adopting removes is a member of the
layout too. Each line of the report is one of this module's own sentences
(``report_line``), with names the layout admits, so ``proof.matrix.place``
can hold an artifact's report to them before a pull request carries it.

It runs on the standard library, with no image: a pin pull request, a person
moving a pin by hand and a round that authors bases again
(``proof/README.md``, "Authoring bases again") run it over every output of
the run whose ``test_retained.py`` failed. Adopting one shard's output alone
loses nothing another shard wrote, but only the outputs together refuse two
blocks that answered one file apart.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

from proof.matrix import lane_input, layout

PROOF = Path(__file__).resolve().parents[1]
TREES = ("hq-apps", "hq-reads")
READING_DEADLINE = 600.0


class AdoptRefused(ValueError):
    """The run's output cannot be adopted as it stands."""


def blocks_of(output: Path) -> list[str]:
    """The name of each block directory of the run's ``output``, its ``blocks/`` opened without following a link;
    an output with no ``blocks/`` is refused, and so is a block that is a link."""
    try:
        blocks = layout.open_directory(Path(output), "blocks")
    except layout.LayoutRefused as refusal:
        raise AdoptRefused(str(refusal)) from refusal
    if blocks is None:
        raise AdoptRefused(
            f"{output} holds no blocks/ directory, so it is no run's output. Name every output of the run."
        )
    try:
        with os.scandir(blocks) as entries:
            named = sorted((entry.name, entry.stat(follow_symlinks=False).st_mode) for entry in entries)
    finally:
        os.close(blocks)
    refusals = [
        f"{Path(output, 'blocks', name)} is a link, and a run writes each block's output as a directory."
        for name, mode in named
        if stat.S_ISLNK(mode)
    ]
    if refusals:
        raise AdoptRefused(str(layout.LayoutRefused(refusals)))
    return [name for name, mode in named if stat.S_ISDIR(mode)]


def written(outputs, tree: str, retained: layout.Layout | None = None) -> dict[str, dict[str, bytes]]:
    """Every file the run's blocks, across every output of the run, wrote under ``tree``, by its directory (a base
    or a group) and then its path under that directory, each block's tree read through the retained layout; two
    blocks that wrote one file differently are refused, and so is a block that wrote anything the layout does not
    name, or a link anywhere on the way."""
    retained = retained or layout.load()
    found: dict[str, dict[str, bytes]] = {}
    where: dict[tuple[str, str], Path] = {}
    for output in outputs:
        for block in blocks_of(output):
            try:
                made = layout.read_tree(Path(output), "blocks", block, tree, tree=tree, layout=retained)
            except layout.LayoutRefused as refusal:
                raise AdoptRefused(str(refusal)) from refusal
            for directory, members in made.items():
                # A directory holding only an unfinished write (``layout.PARTIAL``) is none the run made.
                if not members:
                    continue
                files = found.setdefault(directory, {})
                for name, data in members.items():
                    if name in files and files[name] != data:
                        raise AdoptRefused(
                            f"Two blocks wrote {tree}/{directory}/{name} differently ({where[directory, name]} and"
                            f" {Path(output, 'blocks', block)}), so the run did not make one answer for it. Look at"
                            " why HQ answered two blocks apart."
                        )
                    files[name] = data
                    where[directory, name] = Path(output, "blocks", block)
    return found


def unmade(outputs, tree: str, retained: layout.Layout | None = None) -> dict[str, set[str]]:
    """The committed files of ``tree`` that a comparison of the run found and did not make, by directory: the union
    of every block's held records, one a comparing test (``retained-held/<tree>/<directory>/<test>.json``), each
    read through the retained layout, so a record names only a directory the tree may hold and files that directory
    may hold. A record's file written beside it and never renamed (``.<name>.<pid>.partial``,
    ``retained.write_whole``) is no record; any other file that is no record of a directory is refused by name."""
    retained = retained or layout.load()
    found: dict[str, set[str]] = {}
    for output in outputs:
        for block in blocks_of(output):
            try:
                records = layout.read_held(
                    Path(output), "blocks", block, retained.held, tree, tree=tree, layout=retained
                )
            except layout.LayoutRefused as refusal:
                raise AdoptRefused(str(refusal)) from refusal
            for directory, extra in records.items():
                found.setdefault(directory, set()).update(extra)
    return found


def held(root: Path, retained: layout.Layout | None = None) -> dict[str, dict[str, bytes]]:
    """Every file of a committed tree, by its directory and its path under it, read through the retained layout."""
    root = Path(root)
    try:
        return layout.read_tree(root.parent, root.name, tree=root.name, layout=retained)
    except layout.LayoutRefused as refusal:
        raise AdoptRefused(str(refusal)) from refusal


def merged(before: dict[str, bytes], made: dict[str, bytes], removed: set[str]) -> dict[str, bytes]:
    """A directory's files once adopted: ``before``'s, less each file ``removed`` names that ``made`` does not hold,
    with ``made``'s written over them."""
    return {**{name: data for name, data in before.items() if name not in removed or name in made}, **made}


def _write_member(target: Path, name: str, data: bytes) -> None:
    """``data`` as a new plain file at ``target/name``, mode 0644, never written through a link: whatever is at the
    file's path, and a link or a file where a directory on the way down from ``target`` should be, is taken out
    first."""
    directory = target
    for part in ("", *Path(name).parts[:-1]):
        directory = directory / part if part else directory
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            directory.unlink()
    path = target / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or path.exists():
        path.unlink()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        os.fchmod(fd, 0o644)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view) :]
    finally:
        os.close(fd)


def adopt_tree(made: dict[str, dict[str, bytes]], root: Path, removed: dict[str, set[str]] | None = None) -> list[str]:
    """Each file of ``made`` written over ``root``, each a new plain file, and each file ``removed`` names that
    ``made`` does not hold taken out of it (a directory left empty with it); the directories adopted."""
    removed = removed or {}
    for directory in sorted(set(made) | set(removed)):
        target = root / directory
        files = made.get(directory, {})
        for name in sorted(removed.get(directory, set()) - set(files)):
            path = target / name
            if path.is_symlink() or path.is_file():
                path.unlink()
                for parent in path.parents:
                    if parent == target.parent or not parent.is_dir() or any(parent.iterdir()):
                        break
                    parent.rmdir()
        for name, data in sorted(files.items()):
            _write_member(target, name, data)
    return sorted(made)


# The report's sentences, each a template of names the layout admits; ``report_line`` and ``is_report_line`` are the
# one place a line is written and the one place an artifact's line is recognised.
LEFT_OUT = (
    "Left out {base}: the run wrote no expected.json for it, so Nova's reading of it did not come in. What HQ made"
    " of it is under blocks/<block>/hq-apps-unread/{base}/ where the run kept it."
)
ADOPTED = "Adopted {count} director{plural} of proof/{tree}/."
NEW = "{base}: new."
CHANGED = "{base}: its {what} changed."
READING = "{base}: Nova's reading of it changed."
CHANGE_KINDS = ("stored app", "answers", "stored app and its answers")
COUNT = re.compile(r"(?:0|[1-9][0-9]{0,5})")


def report_line(kind: str, **names) -> str:
    """One line of the report: ``kind`` one of ``left-out``, ``adopted``, ``new``, ``changed``, ``reading``."""
    if kind == "adopted":
        count = names["count"]
        return ADOPTED.format(count=count, plural="y" if count == 1 else "ies", tree=names["tree"])
    template = {"left-out": LEFT_OUT, "new": NEW, "changed": CHANGED, "reading": READING}[kind]
    return template.format(**names)


def is_report_line(line: str, bases) -> bool:
    """Whether ``line`` is one of the report's own sentences, every name in it a base of ``bases``."""
    head, _, rest = line.partition(" ")
    if head == "Adopted":
        count = rest.partition(" ")[0]
        return COUNT.fullmatch(count) is not None and any(
            line == report_line("adopted", count=int(count), tree=tree) for tree in TREES
        )
    if head == "Left":
        base = rest.removeprefix("out ").partition(":")[0]
        return base in bases and line == report_line("left-out", base=base)
    base = line.partition(":")[0]
    if base not in bases:
        return False
    return line in (
        report_line("new", base=base),
        report_line("reading", base=base),
        *(report_line("changed", base=base, what=what) for what in CHANGE_KINDS),
    )


def changes(before: dict[str, dict[str, bytes]], after: dict[str, dict[str, bytes]]) -> dict[str, list[str]]:
    """For each base ``after`` holds, what changed from ``before``: ``"stored app"`` where ``app.json`` differs,
    ``"answers"`` where any other file does, and ``"new"`` for a base ``before`` lacks."""
    found = {}
    for base, files in sorted(after.items()):
        old = before.get(base)
        if old is None:
            found[base] = ["new"]
            continue
        what = []
        if old.get("app.json") != files.get("app.json"):
            what.append("stored app")
        others = set(old) | set(files)
        others.discard("app.json")
        if any(old.get(name) != files.get(name) for name in others):
            what.append("answers")
        if what:
            found[base] = what
    return found


def bundle(corpus: Path) -> Path:
    """The reader bundle the corpus carries; refused by name where it carries none."""
    reader = corpus / "native" / "reader" / "reader.mjs"
    if not reader.is_file():
        raise AdoptRefused(
            f"The report reads each base with Nova's reader from the corpus (native/reader/reader.mjs), and"
            f" {corpus} holds none. The corpus job builds it (node proof/reader/build.mjs); look at"
            " native/produced.json and native/logs/reader.log for why it was not written, or name the corpus with"
            " --corpus."
        )
    return reader


def read_with_bundle(reader: Path, requests: list[dict]) -> dict[str, dict]:
    """The bundle's answers to ``requests``, by id, through ``proof/processes.py``."""
    from proof import processes

    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        asked = scratch / "requests.json"
        answered = scratch / "answers.json"
        asked.write_text(json.dumps({"requests": requests}), encoding="utf-8")
        with open(scratch / "reader.log", "wb") as log:
            status = processes.run(
                ["node", str(reader), str(asked), str(answered)], timeout=READING_DEADLINE, stdout=log, stderr=log
            )
        if status != 0:
            tail = (scratch / "reader.log").read_text(encoding="utf-8", errors="replace")[-2000:]
            raise AdoptRefused(f"Nova's reader exited with {status} reading the bases' answers:\n{tail}")
        answers = json.loads(answered.read_text(encoding="utf-8"))["answers"]
    return {answer["id"]: answer for answer in answers}


def reading_changes(before: dict[str, dict], after: dict[str, dict]) -> list[str]:
    """Each base whose first reading's answer differs between ``before`` and ``after`` (each by base), its id
    aside; a base read on one side only is one whose reading changed."""
    found = []
    for base in sorted(set(before) | set(after)):
        old = {key: value for key, value in (before.get(base) or {}).items() if key != "id"}
        new = {key: value for key, value in (after.get(base) or {}).items() if key != "id"}
        if old != new:
            found.append(base)
    return found


def readings(reader: Path, bases: dict[str, dict[str, bytes]]) -> dict[str, dict]:
    """The bundle's first reading of each base of ``bases`` (its members, as the layout read them) that holds a
    ``base.json``, by base."""
    requests = [
        {"id": base, "mode": "first-read", "input": lane_input.input_of(members)}
        for base, members in sorted(bases.items())
        if "base.json" in members
    ]
    return read_with_bundle(reader, requests) if requests else {}


def unread_bases(made: dict[str, dict[str, bytes]]) -> list[str]:
    """Each base of a run's ``hq-apps/`` that holds no ``expected.json``: one whose reading did not come in, which a
    run writes under ``hq-apps-unread/`` instead (``proof/matrix/retain.py``), or a run's output from before it
    did. None is adopted."""
    return sorted(base for base, files in made.items() if "expected.json" not in files)


def report_reader(outputs, corpus: Path | None) -> Path:
    """The reader bundle the report runs: the one a corpus made on this machine carries. A corpus inside any of the
    run's outputs was written by the run's container, and the host runs nothing a container wrote, so it is
    refused."""
    if corpus is None:
        raise AdoptRefused(
            "--report reads each base with Nova's reader, which it takes from a corpus made on this machine: name it"
            " with --corpus (the corpus the run was given, PROOF_CORPUS, or a directory holding the reader alone,"
            " built with node proof/reader/build.mjs --out <directory>/native/reader)."
        )
    inside = Path(os.path.realpath(corpus))
    for output in outputs:
        real = Path(os.path.realpath(output))
        if inside == real or real in inside.parents:
            raise AdoptRefused(
                f"--corpus names {corpus}, which is inside the run's output {output}, so the run's container wrote it"
                " and the report will not run it. Name a corpus made on this machine, as --report's help says."
            )
    return bundle(Path(corpus))


def adopt(outputs, *, proof: Path = PROOF, report: bool = False, corpus: Path | None = None) -> list[str]:
    """Adopt the run whose outputs are ``outputs`` (one a shard; one ``Path`` for a run on one machine) into
    ``proof``'s trees; with ``report``, the lines of the report. A base the run wrote no ``expected.json`` for is
    left out, by name. Everything is read and checked, and the report's readings made, before anything under
    ``proof`` changes, so a refusal leaves it as it was."""
    outputs = [Path(outputs)] if isinstance(outputs, (str, Path)) else [Path(output) for output in outputs]
    retained = layout.load()
    made = {tree: written(outputs, tree, retained) for tree in TREES}
    removed = {tree: unmade(outputs, tree, retained) for tree in TREES}
    left_out = unread_bases(made["hq-apps"])
    for base in left_out:
        del made["hq-apps"][base]
        removed["hq-apps"].pop(base, None)
    left_lines = [report_line("left-out", base=base) for base in left_out]
    if not any(made.values()):
        if left_out:
            raise AdoptRefused(
                f"The run wrote no base whose reading came in, so there is nothing to adopt: {' '.join(left_lines)}"
            )
        raise AdoptRefused(
            f"No block of {', '.join(map(str, outputs))} wrote hq-apps/ or hq-reads/, so there is nothing to adopt."
            " Run the tests that write them (proof/matrix/test_retained.py, proof/hq/test_retained_reads.py,"
            " proof/editors/test_retained_reads.py) into it."
        )
    lines = list(left_lines)
    reported: list[str] = []
    if report:
        reader = report_reader(outputs, corpus)
        before = held(proof / "hq-apps", retained)
        after = {
            base: merged(before.get(base, {}), files, removed["hq-apps"].get(base, set()))
            for base, files in made["hq-apps"].items()
        }
        old_readings = readings(reader, {base: before[base] for base in made["hq-apps"] if base in before})
        new_readings = readings(reader, after)
        for base, what in changes(before, after).items():
            if what == ["new"]:
                reported.append(report_line("new", base=base))
            else:
                reported.append(report_line("changed", base=base, what=" and its ".join(what)))
        for base in reading_changes(old_readings, new_readings):
            reported.append(report_line("reading", base=base))
    for tree in TREES:
        adopted = adopt_tree(made[tree], proof / tree, removed[tree])
        lines.append(report_line("adopted", count=len(adopted), tree=tree))
    return lines + reported


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python3 -m proof.matrix.adopt",
        description="Read what a run made of HQ through the retained layout and write it over proof/hq-apps/ and"
        " proof/hq-reads/.",
    )
    parser.add_argument(
        "outputs",
        nargs="+",
        type=Path,
        help="every output directory of the run (one a shard; .proof/out on one machine)",
    )
    parser.add_argument("--report", action="store_true", help="name each base whose files or reading changed")
    parser.add_argument(
        "--corpus",
        type=Path,
        help="with --report, a corpus made on this machine (never one inside an output) whose reader reads the bases",
    )
    arguments = parser.parse_args(argv)
    try:
        lines = adopt(arguments.outputs, report=arguments.report, corpus=arguments.corpus)
    except AdoptRefused as refusal:
        print(refusal, file=sys.stderr)
        return 1
    for line in lines:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
