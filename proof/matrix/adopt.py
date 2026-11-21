"""Adopt what a run made of HQ into the retained trees:
``python3 -m proof.matrix.adopt <output>... [--report]``.

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
bundle the run's own corpus carries (``<corpus>/native/reader/reader.mjs``,
``--corpus`` or ``<output>/corpus``) reads the old answers and the new ones
(``proof.matrix.lane_input``), and a base whose two answers differ is named.

It is a file copy on the standard library, with no image: a pin pull request,
a person moving a pin by hand and a round that authors bases again
(``proof/README.md``, "Authoring bases again") run it over every output of
the run whose ``test_retained.py`` failed. Adopting one shard's output alone
loses nothing another shard wrote, but only the outputs together refuse two
blocks that answered one file apart.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from proof.matrix import lane_input

PROOF = Path(__file__).resolve().parents[1]
TREES = ("hq-apps", "hq-reads")
# What each comparison found committed and not made, under a block's output (``proof.matrix.retained.HELD``; this
# module runs on the standard library, which that one, importing pytest, is not).
HELD = "retained-held"
READING_DEADLINE = 600.0


class AdoptRefused(ValueError):
    """The run's output cannot be adopted as it stands."""


def block_roots(outputs, tree: str) -> list[Path]:
    """Each block's ``tree`` directory across every output of the run; an output with no ``blocks/`` is refused."""
    roots = []
    for output in outputs:
        blocks = Path(output) / "blocks"
        if not blocks.is_dir():
            raise AdoptRefused(
                f"{output} holds no blocks/ directory, so it is no run's output. Name every output of the run."
            )
        roots += sorted(blocks.glob(f"*/{tree}"))
    return roots


def written(outputs, tree: str) -> dict[str, dict[str, bytes]]:
    """Every file the run's blocks, across every output of the run, wrote under ``tree``, by its directory (a base
    or a group) and then its path under that directory; two blocks that wrote one file differently are refused."""
    found: dict[str, dict[str, bytes]] = {}
    where: dict[tuple[str, str], Path] = {}
    for root in block_roots(outputs, tree):
        for path in sorted(root.rglob("*")):
            # A file written beside its name and never renamed (``retained.write_whole``) is none the run made.
            if not path.is_file() or path.name.endswith(".partial"):
                continue
            relative = path.relative_to(root)
            if len(relative.parts) < 2:
                raise AdoptRefused(
                    f"{path} is a file at the top of {tree}/, and every file a run writes there sits in a base's or a"
                    " group's directory. Look at which test wrote it (proof/matrix/retained.py writes each under"
                    " its directory)."
                )
            directory, name = relative.parts[0], Path(*relative.parts[1:]).as_posix()
            data = path.read_bytes()
            files = found.setdefault(directory, {})
            if name in files and files[name] != data:
                raise AdoptRefused(
                    f"Two blocks wrote {tree}/{directory}/{name} differently ({where[directory, name]} and {path}),"
                    " so the run did not make one answer for it. Look at why HQ answered two blocks apart."
                )
            files[name] = data
            where[directory, name] = path
    return found


def unmade(outputs, tree: str) -> dict[str, set[str]]:
    """The committed files of ``tree`` that a comparison of the run found and did not make, by directory: the union
    of every block's held records, one a comparing test (``retained-held/<tree>/<directory>/<test>.json``). A
    record's file written beside it and never renamed (``.<name>.<pid>.partial``, ``retained.write_whole``) is no
    record; any other file that is no record of a directory is refused by name."""
    found: dict[str, set[str]] = {}
    for root in block_roots(outputs, f"{HELD}/{tree}"):
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.name.endswith(".partial"):
                continue
            relative = path.relative_to(root)
            if len(relative.parts) != 2 or path.suffix != ".json":
                raise AdoptRefused(
                    f"{path} is no held record: each sits at {HELD}/{tree}/<directory>/<test>.json"
                    " (proof/matrix/retained.py::Retained.held_record)."
                )
            extra = json.loads(path.read_text(encoding="utf-8")).get("extra")
            if not isinstance(extra, list) or not all(isinstance(name, str) and name for name in extra):
                raise AdoptRefused(f"{path} lists no files a comparison found and did not make.")
            found.setdefault(relative.parts[0], set()).update(extra)
    return found


def held(root: Path) -> dict[str, dict[str, bytes]]:
    """Every file of a committed tree, by its directory and its path under it."""
    found: dict[str, dict[str, bytes]] = {}
    if not root.is_dir():
        return found
    for path in sorted(root.rglob("*")):
        if path.is_file():
            relative = path.relative_to(root)
            if len(relative.parts) < 2:
                continue
            found.setdefault(relative.parts[0], {})[Path(*relative.parts[1:]).as_posix()] = path.read_bytes()
    return found


def adopt_tree(made: dict[str, dict[str, bytes]], root: Path, removed: dict[str, set[str]] | None = None) -> list[str]:
    """Each file of ``made`` written over ``root``, and each file ``removed`` names that ``made`` does not hold taken
    out of it (a directory left empty with it); the directories adopted."""
    removed = removed or {}
    for directory in sorted(set(made) | set(removed)):
        target = root / directory
        files = made.get(directory, {})
        for name in sorted(removed.get(directory, set()) - set(files)):
            path = target / name
            if path.is_file():
                path.unlink()
                for parent in path.parents:
                    if parent == target.parent or any(parent.iterdir()):
                        break
                    parent.rmdir()
        for name, data in sorted(files.items()):
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    return sorted(made)


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
    """The reader bundle the run's corpus carries; refused by name where it carries none."""
    reader = corpus / "native" / "reader" / "reader.mjs"
    if not reader.is_file():
        raise AdoptRefused(
            f"The report reads each base with Nova's reader from the run's corpus (native/reader/reader.mjs), and"
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


def readings(reader: Path, root: Path, bases) -> dict[str, dict]:
    """The bundle's first reading of each base of ``bases`` the tree at ``root`` holds, by base."""
    requests = [
        {"id": base, "mode": "first-read", "input": lane_input.first_read_input(root / base)}
        for base in sorted(bases)
        if (root / base / "base.json").is_file()
    ]
    return read_with_bundle(reader, requests) if requests else {}


def unread_bases(made: dict[str, dict[str, bytes]]) -> list[str]:
    """Each base of a run's ``hq-apps/`` that holds no ``expected.json``: one whose reading did not come in, which a
    run writes under ``hq-apps-unread/`` instead (``proof/matrix/retain.py``), or a run's output from before it
    did. None is adopted."""
    return sorted(base for base, files in made.items() if "expected.json" not in files)


def adopt(outputs, *, proof: Path = PROOF, report: bool = False, corpus: Path | None = None) -> list[str]:
    """Adopt the run whose outputs are ``outputs`` (one a shard; one ``Path`` for a run on one machine) into
    ``proof``'s trees; with ``report``, the lines of the report. A base the run wrote no ``expected.json`` for is
    left out, by name."""
    outputs = [Path(outputs)] if isinstance(outputs, (str, Path)) else [Path(output) for output in outputs]
    output = outputs[0]
    made = {tree: written(outputs, tree) for tree in TREES}
    removed = {tree: unmade(outputs, tree) for tree in TREES}
    left_out = unread_bases(made["hq-apps"])
    for base in left_out:
        del made["hq-apps"][base]
        removed["hq-apps"].pop(base, None)
    left_lines = [
        f"Left out {base}: the run wrote no expected.json for it, so Nova's reading of it did not come in. What HQ"
        f" made of it is under blocks/<block>/hq-apps-unread/{base}/ where the run kept it."
        for base in left_out
    ]
    if not any(made.values()):
        if left_out:
            raise AdoptRefused(
                f"The run wrote no base whose reading came in, so there is nothing to adopt: {' '.join(left_lines)}"
            )
        raise AdoptRefused(
            f"No block of {', '.join(map(str, outputs))} wrote hq-apps/ or hq-reads/, so there is nothing to adopt."
            " Run the tests that"
            " write them (proof/matrix/test_retained.py, proof/hq/test_retained_reads.py,"
            " proof/editors/test_retained_reads.py) into it."
        )
    apps_root = proof / "hq-apps"
    lines = list(left_lines)
    if report:
        reader = bundle(corpus if corpus is not None else output / "corpus")
        before = held(apps_root)
        with tempfile.TemporaryDirectory() as old_copy:
            old_root = Path(old_copy)
            adopt_tree(
                {base: files for base, files in before.items() if base in made["hq-apps"]},
                old_root,
            )
            old_readings = readings(reader, old_root, made["hq-apps"])
    for tree in TREES:
        adopted = adopt_tree(made[tree], proof / tree, removed[tree])
        lines.append(f"Adopted {len(adopted)} director{'y' if len(adopted) == 1 else 'ies'} of proof/{tree}/.")
    if report:
        for base, what in changes(before, held(apps_root)).items():
            if base in made["hq-apps"]:
                lines.append(f"{base}: its {' and its '.join(what)} changed." if what != ["new"] else f"{base}: new.")
        new_readings = readings(reader, apps_root, made["hq-apps"])
        for base in reading_changes(old_readings, new_readings):
            lines.append(f"{base}: Nova's reading of it changed.")
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python3 -m proof.matrix.adopt",
        description="Copy what a run made of HQ over proof/hq-apps/ and proof/hq-reads/.",
    )
    parser.add_argument(
        "outputs",
        nargs="+",
        type=Path,
        help="every output directory of the run (one a shard; .proof/out on one machine)",
    )
    parser.add_argument("--report", action="store_true", help="name each base whose files or reading changed")
    parser.add_argument("--corpus", type=Path, help="the corpus whose reader bundle reads the bases")
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
