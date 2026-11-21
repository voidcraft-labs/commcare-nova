"""What the lane retains of HQ, written to the run's output as it is made, then the committed tree held to it.

Two trees are written so and held byte for byte: ``proof/hq-reads/<group>/``,
HQ's answers to the reads Nova's tests are served
(``proof/hq/test_retained_reads.py``), and ``proof/hq-apps/<base>/``, the
apps HQ's own pages and models made and HQ's answers about each
(``proof/matrix/test_retained.py``). A ``Retained`` is one group or one base:
each file is written to ``$PROOF_OUT/<tree>/<name>/`` when it is made (a base
once its reading came in, ``held``), so a run that fails its hold still
leaves what HQ made for ``python3 -m proof.matrix.adopt`` to copy, and
``hold`` (or ``differences``) then compares the committed directory with what
was made. Each comparison also writes, under
``$PROOF_OUT/retained-held/<tree>/<name>/<test>.json``, the committed files of
its own that it did not make (``extra``): one record a comparing test, named
by that test's node id, which only that test writes and no other reads, so two
tests comparing one directory on two workers of one block
(``proof/hq/test_retained_reads.py`` and
``proof/editors/test_retained_reads.py`` both compare ``shell/``) never write
over each other's record, and each record is written whole before it takes
its name, so no reader meets one half written. Adopting takes the union of
every record of a directory: a file is taken out of a retained tree only
where a test that writes it reached its comparison and did not make it, so
adopting never removes the files another test writes into the same
directory (``proof/editors/test_retained_reads.py``'s saves under
``navigation-base/`` and ``shell/``) or those of a test that stopped first.

It is a helper both test modules import, and not a test module (nothing
imports a test module, ``proof/store/test_partition.py``). It sits in
``proof/matrix`` and not in ``proof/hq``, whose every file is in the
observation partition (``proof/observe/partition.py::OBSERVATION_DIRECTORIES``).
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
from urllib.parse import quote

import pytest


def text_of(value) -> str:
    """A retained JSON file's text: tab-indented, its non-ASCII characters as they are, one newline at the end."""
    return json.dumps(value, indent="\t", ensure_ascii=False) + "\n"


# Under a block's output: what each comparison found committed and not made (``Retained.held_record``).
HELD = "retained-held"
# Under a block's output: where a held directory's files are written before the directory takes its name
# (``Retained.settle``), which no tree adopted reads.
SETTLING = "retained-settling"
# The longest record name written as the test's quoted node id; a longer one is named by its digest.
RECORD_NAME_MAX = 200


def write_whole(path: Path, data: bytes):
    """``data`` written at ``path`` so that a reader of ``path`` meets the old file or the whole new one, never part
    of one: written beside it under a name no reader reads, then renamed over it (``os.replace``)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    # Made as any other file of the run's output is (mkstemp's is its owner's alone), one a process.
    partial = path.with_name(f".{path.name}.{os.getpid()}.partial")
    try:
        partial.write_bytes(data)
        os.replace(partial, path)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def comparing_test() -> str:
    """The node id of the test running now (pytest's ``PYTEST_CURRENT_TEST``, its phase left off), which names the
    held record its comparisons write; a comparison outside a test fails by name."""
    current = os.environ.get("PYTEST_CURRENT_TEST")
    if not current:
        pytest.fail(
            "A retained directory's comparison writes its held record under the test that compares it, and"
            " PYTEST_CURRENT_TEST is not set, so this comparison runs in no test. Compare inside a test."
        )
    return current.rsplit(" (", 1)[0]


def record_name(test: str) -> str:
    """The file name of ``test``'s held record: its node id quoted to one path segment, or, where that is longer than
    ``RECORD_NAME_MAX``, the id's SHA-256. Two tests never share one."""
    quoted = quote(test, safe="")
    if len(quoted) > RECORD_NAME_MAX:
        quoted = hashlib.sha256(test.encode("utf-8")).hexdigest()
    return f"{quoted}.json"


def output_root() -> Path:
    """``$PROOF_OUT``, where the run writes what HQ made; a test fails by name without it."""
    out = os.environ.get("PROOF_OUT")
    if not out:
        pytest.fail(
            "What the lane retains of HQ is written under $PROOF_OUT, and PROOF_OUT is not set. Run the tests"
            " through the proof harness (npm run proof -- <test file>), which sets it to /out."
        )
    return Path(out)


class Retained:
    """One group's or one base's files: each written to the run's output as it is made, then the committed files
    held to them.

    ``keep`` writes a JSON file (``<name>.json``) and ``made`` holds each by
    the name without its suffix, as the groups of ``proof/hq-reads/`` name
    theirs; ``keep_bytes`` writes any other file under its own relative path
    (``media/0.png``), held in ``files``.

    With ``held=True`` nothing is written until ``settle`` writes every file
    made under the directory, or ``moved`` writes them under another tree:
    a base's directory under ``hq-apps/`` is written only once its reading
    came in, and ``settle`` gives it its name only once every file is whole,
    so ``python3 -m proof.matrix.adopt`` and the gate never meet one half
    made (its ``expected.json`` beside the rest or nothing)."""

    def __init__(self, group, *, tree="hq-reads", held=False):
        self.group = group
        self.tree = tree
        self.held = held
        self.made: dict[str, str] = {}
        self.files: dict[str, bytes] = {}
        self.out = output_root() / tree / group

    def _write(self, relative: str, data: bytes):
        if self.held:
            return
        write_whole(self.out / relative, data)

    def settle(self):
        """Every file made written under the directory, and each one made after it as it is made.

        The files are written into a directory of their own under ``$PROOF_OUT/retained-settling/``, which no tree
        adopted reads, and that directory is then renamed to the directory's own path (``os.replace``, one rename on
        one file system): a run stopped while settling, or a write that raises, leaves no directory under the tree
        at all, never one holding some of its files beside a marker of the rest (a base's ``expected.json``)."""
        # A directory made as any other of the run's output is (mkdtemp's is its owner's alone), one a process.
        staging = output_root() / SETTLING / self.tree / f"{self.group}.{os.getpid()}"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        try:
            for relative, data in sorted(self.all_made().items()):
                path = staging / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            if self.out.exists():
                shutil.rmtree(self.out)
            self.out.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging, self.out)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        self.held = False

    def moved(self, tree):
        """A ``Retained`` of the same group under ``tree``, holding and writing every file made here."""
        other = Retained(self.group, tree=tree)
        other.made = dict(self.made)
        other.files = dict(self.files)
        for relative, data in sorted(other.all_made().items()):
            other._write(relative, data)
        return other

    def keep(self, name, value):
        """``value`` (an ``HqAnswer``, written as its ``retained()``, or any JSON value) written as ``<name>.json``;
        returns ``value``."""
        retained = getattr(value, "retained", None)
        text = text_of(retained() if callable(retained) else value)
        if name in self.made:
            raise AssertionError(f"The {self.group} {self._noun()} made {name} twice.")
        self.made[name] = text
        self._write(f"{name}.json", text.encode("utf-8"))
        return value

    def keep_bytes(self, relative: str, data: bytes):
        """The file ``relative`` (a path under the directory with its suffix, never ``.json``) written as
        ``data``."""
        if relative.endswith(".json"):
            raise ValueError(f"{relative} is a JSON file, which keep writes; keep_bytes writes every other file.")
        if relative in self.files:
            raise AssertionError(f"The {self.group} {self._noun()} made {relative} twice.")
        self.files[relative] = bytes(data)
        self._write(relative, bytes(data))

    def _noun(self):
        return "group" if self.tree == "hq-reads" else "base"

    def all_made(self) -> dict[str, bytes]:
        """Every file made, by its path under the directory with its suffix."""
        return {
            **{f"{name}.json": text.encode("utf-8") for name, text in self.made.items()},
            **self.files,
        }

    def differences(self, committed: Path) -> tuple[list[str], list[str], list[str]]:
        """``(missing, stale, extra)`` between every file under ``committed`` and every file made, each a sorted
        list of paths under the directory: made and not committed, committed with other bytes, committed and not
        made."""
        held = {
            path.relative_to(committed).as_posix(): path.read_bytes()
            for path in sorted(committed.rglob("*"))
            if path.is_file()
        }
        made = self.all_made()
        missing = sorted(set(made) - set(held))
        stale = sorted(name for name in set(made) & set(held) if held[name] != made[name])
        extra = sorted(set(held) - set(made))
        self.record_held(extra)
        return missing, stale, extra

    def held_record(self) -> Path:
        """Where the test running now writes what its comparisons of this directory found committed and not made:
        its own record, which no other test writes or reads (the module's docstring)."""
        return output_root() / HELD / self.tree / self.group / record_name(comparing_test())

    def record_held(self, extra):
        """``extra`` (paths under the directory, with their suffixes) added to this test's held record of the
        directory: the files it compared, found committed and did not make, which adopting removes where no block of
        the run wrote them. Only this test's comparisons, one after another in its one process, read the record
        and write it again."""
        path = self.held_record()
        known = set(json.loads(path.read_text(encoding="utf-8"))["extra"]) if path.is_file() else set()
        write_whole(path, text_of({"extra": sorted(known | set(extra))}).encode("utf-8"))

    def hold(self, committed: Path, *, ignore=(), others=lambda name: False):
        """The committed JSON files are exactly those made, byte for byte (each ``ignore``d subtree, and each file
        ``others`` says another test writes, left out)."""
        held = {
            path.relative_to(committed).with_suffix("").as_posix(): path.read_text(encoding="utf-8")
            for path in sorted(committed.rglob("*.json"))
            if not any(path.relative_to(committed).as_posix().startswith(prefix) for prefix in ignore)
            and not others(path.relative_to(committed).with_suffix("").as_posix())
        }
        missing = sorted(set(self.made) - set(held))
        stale = sorted(name for name in set(self.made) & set(held) if held[name] != self.made[name])
        extra = sorted(set(held) - set(self.made))
        self.record_held(f"{name}.json" for name in extra)
        assert not (missing or stale or extra), (
            f"proof/{self.tree}/{self.group}/ is not what HQ answers at its pin: missing {missing}, changed {stale},"
            f" made by nothing {extra}. HQ's answers are written to {self.out}; copy them into"
            f" proof/{self.tree}/{self.group}/ and read what changed."
        )
