"""Move the retained trees between a checkout's ``proof/`` and an artifact that carries them, through the layout.

    python3 -m proof.matrix.place pack PROOF STAGING --report FILE
    python3 -m proof.matrix.place unpack ARTIFACT PROOF

``pack`` (the weekly pin pull request's ``retained`` job, after
``python3 -m proof.matrix.adopt``) reads ``proof/hq-apps/`` and
``proof/hq-reads/`` and the adopt report, and writes them into STAGING, a new
or empty directory, which then holds exactly what the artifact
``upstream-retained`` carries: ``hq-apps/``, ``hq-reads/`` and
``adopt-report.txt``.

``unpack`` (each job of ``proof-lane.yml`` that puts the candidate's surface
in place, and ``proof/upstream/pins.mjs report``, the job that commits) reads
a downloaded artifact whole and only then replaces each tree of the
checkout's ``proof/`` with the members it read, every one written fresh as a
plain file (mode 0644); it prints ``{"placed": [...], "report": [...]}``,
the report's lines.

An artifact is data another job wrote, so nothing in it is trusted to be
what its name says. Its top level holds those three names and nothing else;
each tree is read by ``proof.matrix.layout``, which opens each member
without following a link and refuses every name, type and size outside the
retained layout; the report is a plain file within its bound whose every
line is one of adopt's own sentences (``adopt.is_report_line``), so nothing
but adopt's words and the layout's names can reach a pull request's
description. A refusal names every entry outside the layout and changes
nothing under the destination. Exit status: 0 placed, 1 refused, 2 when the
call itself is wrong.

The check in ``pins.mjs report`` is the one that carries the security claim:
it runs main's code in the job that holds the write token, over whatever the
artifact holds, whatever ran before it.

Standard library only, on Python 3.12: the jobs that run it have no image.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
from pathlib import Path

from proof.matrix import adopt, layout

REPORT = "adopt-report.txt"


class PlaceRefused(ValueError):
    """The trees cannot be moved as they stand."""


def report_lines(directory: Path, retained: layout.Layout) -> list[str]:
    """The adopt report's lines in ``directory``, each one of adopt's own sentences;
    ``PlaceRefused`` where it is anything but such a file within its bound."""
    fd = layout.open_directory(Path(directory))
    if fd is None:
        raise PlaceRefused(f"{directory} does not exist, so it holds no retained trees.")
    try:
        try:
            os.stat(REPORT, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError as error:
            raise PlaceRefused(
                f"{directory / REPORT} is missing. Write it with python3 -m proof.matrix.adopt --report."
            ) from error
        try:
            data = layout.read_bounded(fd, REPORT, retained.report_bound, Path(directory, REPORT))
        except layout.LayoutRefused as refusal:
            raise PlaceRefused(str(refusal)) from refusal
    finally:
        os.close(fd)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PlaceRefused(f"{Path(directory, REPORT)} is not UTF-8 text ({error}).") from error
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    foreign = [index + 1 for index, line in enumerate(lines) if not adopt.is_report_line(line, retained.bases)]
    if foreign:
        shown = ", ".join(str(number) for number in foreign[:10])
        raise PlaceRefused(
            f"{Path(directory, REPORT)} holds lines that are not adopt's own sentences (line {shown}), so the report"
            " cannot be carried into a pull request. The retained job writes it with python3 -m proof.matrix.adopt"
            " --report; look at that step's log."
        )
    return lines


def _top_level(directory: Path, retained: layout.Layout) -> None:
    """Refuse an artifact whose top level holds anything but the trees and the report."""
    fd = layout.open_directory(Path(directory))
    if fd is None:
        raise PlaceRefused(f"{directory} does not exist, so it holds no retained trees.")
    try:
        with os.scandir(fd) as entries:
            named = sorted((entry.name, entry.stat(follow_symlinks=False).st_mode) for entry in entries)
    finally:
        os.close(fd)
    refusals = []
    for name, mode in named:
        if name not in retained.artifact:
            refusals.append(f"{Path(directory, name)} is not part of the retained artifact. {layout.NAME_IT}")
        elif name == REPORT and not stat.S_ISREG(mode):
            refusals.append(f"{Path(directory, name)} is {layout.kind_of(mode)}, and the adopt report is a plain file.")
        elif name != REPORT and not stat.S_ISDIR(mode):
            refusals.append(f"{Path(directory, name)} is {layout.kind_of(mode)}, and a retained tree is a directory.")
    if refusals:
        raise PlaceRefused(str(layout.LayoutRefused(refusals)))


def read_trees(directory: Path, retained: layout.Layout) -> dict[str, dict[str, dict[str, bytes]]]:
    """Each retained tree ``directory`` holds, read through the layout."""
    found = {}
    for tree in layout.TREES:
        try:
            members = layout.read_tree(Path(directory), tree, tree=tree, layout=retained)
        except layout.LayoutRefused as refusal:
            raise PlaceRefused(str(refusal)) from refusal
        if not any(members.values()):
            raise PlaceRefused(
                f"{directory / tree} holds no retained files. A complete artifact carries both retained trees."
            )
        found[tree] = members
    return found


def _write(path: Path, data: bytes) -> None:
    """``data`` as a new plain file at ``path``, mode 0644, never through a link."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        os.fchmod(fd, 0o644)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view) :]
    finally:
        os.close(fd)


def _remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def write_trees(trees: dict[str, dict[str, dict[str, bytes]]], destination: Path) -> list[str]:
    """Each retained tree of ``destination`` replaced by the validated members of ``trees``; the trees written."""
    for tree in layout.TREES:
        _remove(destination / tree)
        for directory, members in sorted(trees[tree].items()):
            for name, data in sorted(members.items()):
                _write(destination / tree / directory / name, data)
    return list(layout.TREES)


def pack(proof: Path, staging: Path, report: Path) -> list[str]:
    """The checkout's trees and the adopt report at ``report`` written into ``staging``, a new or empty
    directory; the trees written."""
    retained = layout.load()
    if staging.exists() and (staging.is_symlink() or not staging.is_dir() or any(staging.iterdir())):
        raise PlaceRefused(f"{staging} is not a new or empty directory, and the artifact holds only what pack writes.")
    if report.name != REPORT:
        raise PlaceRefused(f"--report names {report}; adopt's report is written as {REPORT}.")
    trees = read_trees(proof, retained)
    lines = report_lines(report.parent, retained)
    staging.mkdir(parents=True, exist_ok=True)
    placed = write_trees(trees, staging)
    _write(staging / REPORT, "".join(f"{line}\n" for line in lines).encode("utf-8"))
    return placed


def unpack(artifact: Path, proof: Path) -> dict:
    """The artifact at ``artifact`` read whole through the layout, then each tree of ``proof`` replaced by it;
    what was placed and the report's lines."""
    retained = layout.load()
    _top_level(artifact, retained)
    trees = read_trees(artifact, retained)
    lines = report_lines(artifact, retained)
    return {"placed": write_trees(trees, proof), "report": lines}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python3 -m proof.matrix.place",
        description="Move the retained trees between a checkout's proof/ and an artifact, through the layout.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    packing = commands.add_parser("pack", help="write the checkout's trees and the adopt report into a staging dir")
    packing.add_argument("proof", type=Path)
    packing.add_argument("staging", type=Path)
    packing.add_argument("--report", type=Path, required=True)
    unpacking = commands.add_parser("unpack", help="replace the checkout's trees with an artifact's")
    unpacking.add_argument("artifact", type=Path)
    unpacking.add_argument("proof", type=Path)
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "pack":
            placed = pack(arguments.proof, arguments.staging, arguments.report)
            print(json.dumps({"placed": placed}))
        else:
            print(json.dumps(unpack(arguments.artifact, arguments.proof)))
    except (PlaceRefused, layout.LayoutRefused) as refusal:
        print(refusal, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
