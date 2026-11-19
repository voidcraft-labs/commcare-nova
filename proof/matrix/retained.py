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
was made.

It is a helper both test modules import, and not a test module (nothing
imports a test module, ``proof/store/test_partition.py``). It sits in
``proof/matrix`` and not in ``proof/hq``, whose every file is in the
observation partition (``proof/observe/partition.py::OBSERVATION_DIRECTORIES``).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest


def text_of(value) -> str:
    """A retained JSON file's text: tab-indented, its non-ASCII characters as they are, one newline at the end."""
    return json.dumps(value, indent="\t", ensure_ascii=False) + "\n"


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
    came in, so ``python3 -m proof.matrix.adopt`` never meets one half made."""

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
        path = self.out / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def settle(self):
        """Every file made written under the directory, and each one made after it as it is made."""
        self.held = False
        for relative, data in sorted(self.all_made().items()):
            self._write(relative, data)

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
        return missing, stale, extra

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
        assert not (missing or stale or extra), (
            f"proof/{self.tree}/{self.group}/ is not what HQ answers at its pin: missing {missing}, changed {stale},"
            f" made by nothing {extra}. HQ's answers are written to {self.out}; copy them into"
            f" proof/{self.tree}/{self.group}/ and read what changed."
        )
