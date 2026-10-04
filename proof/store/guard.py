"""The observation's read guard: while a part is observed, every file it reads must be one its key names.

A stored part is reused only while its key covers everything that decided
its record, so the guard holds the observation to that: an audit hook
(``sys.addaudithook``) sees every ``open`` the observation's process makes,
``io.open_code`` (each module it imports) included, and while a scope is
open (``observing``) it refuses, with ``UndeclaredRead``, a read of

- a file of the checkout (the worktree, ``/work`` in the lane's containers,
  and the image's links into it, ``/opt/proof-py/proof``) outside the
  observation partition (``proof.observe.partition.observes``, the lane's
  container files), whose fingerprint the part's storage key names
  (``proof.store.keys.record_scope``), and, in the parts that drive the
  browser (``b`` and ``b_edit``: proof 4's observation, whose declared inputs
  name the browser's code), the browser's (``proof/editors/driver/``);
- a file of the corpus outside the inputs the part's key names: its own
  roles and its parents' (``part_scope``), as the document's ``inputs.json``
  names them or, for a control (``proof/controls/<id>/``, a corpus of its
  own, which keeps no ``inputs.json``), as its files give them, the way its
  keys are computed (``input_files``), but a B's or B-edit's document and
  verdict, which its key does not read; or a file of the document's own
  directory whose sha256 is one the observation hooks declare for its state
  (``proof.observe.unit.hook_inputs``).

A hook's declared digest admits no file outside the document's directory,
of the corpus or of the checkout: the document's key
(``proof.store.keys.document_key``), from which the queue builder learns a
document's parts without running the observation, names that directory's
files and the observation's and the browser's code, so a part may read
nothing else.

Everything else is the image or the run's own: the image's trees, ``/tmp``,
and ``/out``. A module's bytecode is read for its source, so a ``.pyc`` of
a partition module is the module's. A read the guard refuses names the file
and the list to add it to, and the observation fails there.

What another process reads is not a Python ``open``, so the guard holds it
where the observation names the file to that process: the Core runner's JVM
reads the archive or directory its ``admit`` is sent by path, which the
client holds to the open scope first (``named``, called by
``proof.core.client.CoreRunner.admit``). The rest reads no file the
observation names: the editor driver (node and Chromium) runs the browser
partition's files and serves only the image's ``/opt/editors/static`` and
what this process hands it (HQ's JavaScript catalog), the Core runner's JVM
loads the image and the classes compiled from ``proof/core/src`` (observation
partition), and ``psql`` reads the image's
schema dump. A file's existence (``os.stat``) and a directory's listing
raise no ``open`` event and are not guarded; the corpus's layout reaches the
keys through ``inputs.json``, which names each file the export holds (a
control's through its files: each sidecar names what else its request sent).
What the keys are derived from (the document's ``inputs.json`` or a control's
files, its documents for the case databases, what each hook declares it
reads) is read in a scope of its own (``KEYS``) that allows only what the
document's key names: the document's own directory, the observation's code
and the browser's; what a part's scope is derived from is the guard's own
read (``_own``). What
``proof.checks.corpus.Document`` reads as it loads is read before any scope
opens, and a part that uses a value read then is not seen reading it again.
Threads the observation starts are guarded alike: the scope is the
process's while it is open.

The hook is installed once per process (``install``) by the store that
needs it (``proof.store.runtime``), and inert outside a scope: a lane run
with the store off installs nothing.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
from collections.abc import Iterable
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from proof.hq.boot import HarnessRefusal
from proof.observe import unit
from proof.observe.partition import observes
from proof.store.fingerprints import BROWSER_DIRECTORY, LANE_FILES

WORKTREE = Path(__file__).resolve().parents[2]
# Where the image links the checkout's ``proof`` package from (``PYTHONPATH``), read as the checkout's own.
LINKED = {"/opt/proof-py/proof": str(WORKTREE / "proof")}
INPUTS = "inputs.json"
# Each part's own roles in inputs.json and those of the parts its key is made under (proof.observe.unit.part_keys;
# test_guard holds the two alike).
CHAINS = {
    "configuration": ("a",),
    "a": ("a",),
    "b": ("a", "b"),
    "b_aligned": ("a", "b"),
    "b_edit": ("a", "b_edit"),
}
# Each part's hook states (proof.observe.unit.HOOKS, hook_inputs): the one it runs its hooks at and those of its
# parents; the local hooks declare what they read under the state "local" (proof.observe.unit.local_key).
STATES = {
    "configuration": ("A",),
    "a": ("A",),
    "b": ("A", "B"),
    "b_aligned": ("A", "B"),
    "b_edit": ("A", "B-edit"),
    "local": ("local",),
}
# What the document's keys are derived from (proof.observe.unit.observe_document: document_inputs,
# case_databases, hook_inputs), read before any part: the document's own directory and the code the document key
# names (proof.store.keys.document_scope), proof 4's declaration hashing the browser's.
KEYS = "keys"
# The parts that drive the browser: proof 4's observation, at B and B-edit (proof.observe.unit.BContext). The keys'
# derivation reads the browser's code too (KEYS).
BROWSER_PARTS = frozenset({"b", "b_edit"})


class UndeclaredRead(HarnessRefusal):
    """The observation read a file its part's key does not name."""


@dataclass
class Scope:
    """What one part's observation may read beyond the observation partition: its declared files, by path, the
    files of its document's directory (``root``) by digest (every one of them, with ``directory``, as the keys'
    derivation may), and the browser partition where the part drives the browser. ``label`` says what is being
    done, for a refusal's message."""

    label: str
    corpus: Path
    root: Path
    paths: frozenset[str]
    digests: frozenset[str] = frozenset()
    browser: bool = False
    directory: bool = False
    refused: list = field(default_factory=list)


_installed = False
_scope: Scope | None = None
_inside = threading.local()


def install() -> None:
    """Install the hook in this process, once; it guards nothing until a scope opens."""
    global _installed
    if not _installed:
        sys.addaudithook(_hook)
        _installed = True


def _normal(path) -> str | None:
    if isinstance(path, bytes):
        path = os.fsdecode(path)
    if not isinstance(path, str):
        return None
    path = os.path.abspath(path)
    for link, target in LINKED.items():
        if path == link or path.startswith(link + os.sep):
            path = target + path[len(link) :]
    return path


def _source(relative: str) -> str:
    """A module's source for its bytecode (``<dir>/__pycache__/<name>.<tag>.pyc`` is ``<dir>/<name>.py``)."""
    parent, _, name = relative.rpartition("/")
    if parent.endswith("__pycache__") and name.endswith(".pyc"):
        directory = parent.removesuffix("__pycache__").rstrip("/")
        return f"{directory}/{name.split('.', 1)[0]}.py" if directory else f"{name.split('.', 1)[0]}.py"
    return relative


def _digest(path: str) -> str | None:
    try:
        with open(path, "rb") as handle:
            return "sha256:" + hashlib.file_digest(handle, "sha256").hexdigest()
    except OSError:
        return None


def checked(path: str, scope: Scope) -> str | None:
    """Why ``scope`` refuses a read of ``path`` (absolute, normalized), or None when it allows it."""
    worktree = str(WORKTREE)
    corpus = str(scope.corpus)
    under_corpus = path == corpus or path.startswith(corpus + os.sep)
    if not under_corpus and not path.startswith(worktree + os.sep):
        return None
    if path in scope.paths:
        return None
    if under_corpus:
        what = "a file of the corpus that this part's inputs do not name"
    else:
        relative = _source(path[len(worktree) + 1 :])
        if observes(relative) or relative in LANE_FILES:
            return None
        if relative.startswith(BROWSER_DIRECTORY) and scope.browser:
            return None
        what = "a file of the checkout outside the observation partition"
    if os.path.isdir(path):
        return None
    root = str(scope.root)
    if path.startswith(root + os.sep) and (scope.directory or (scope.digests and _digest(path) in scope.digests)):
        return None
    return (
        f"While {scope.label}, the observation read {path}, {what}, so the part's key would not change"
        " when it does and a stored part could stand for an observation that reads it differently. Name it: a"
        " corpus file in the document's inputs.json (proof/corpus/inputs.ts) under this part's role, a hook's"
        " read of a file of the document's own directory in its inputs(document, state), or a file of the"
        " checkout in proof/observe/partition.py."
    )


@contextmanager
def _own():
    """The guard's own reads while the block runs, which no scope holds: a file read to decide a read, or to derive
    a scope from, is no read of the observation's."""
    held = getattr(_inside, "active", False)
    _inside.active = True
    try:
        yield
    finally:
        _inside.active = held


def _refuse(path: str, scope: Scope) -> None:
    """Raise ``UndeclaredRead`` when ``scope`` refuses a read of ``path``; the guard's own reads are not held."""
    with _own():
        problem = checked(path, scope)
    if problem is not None:
        scope.refused.append(path)
        raise UndeclaredRead(problem)


def _hook(event, arguments):
    if event != "open" or _scope is None or getattr(_inside, "active", False):
        return
    path = _normal(arguments[0] if arguments else None)
    if path is not None:
        _refuse(path, _scope)


def named(path) -> None:
    """Hold a file the observation names to another process to read (the archive or directory the Core runner's
    JVM admits) to the open scope, as if the observation read it: each file of a directory. Nothing outside a
    scope."""
    scope = _scope
    path = _normal(path)
    if scope is None or path is None:
        return
    if not os.path.isdir(path):
        _refuse(path, scope)
        return
    for directory, _, files in sorted(os.walk(path)):
        for name in sorted(files):
            _refuse(os.path.join(directory, name), scope)


@contextmanager
def scoped(scope: Scope):
    """Guard every read while the block runs (no guarding until ``install``); scopes nest, the inner one holds."""
    global _scope
    if not _installed:
        yield scope
        return
    outer, _scope = _scope, scope
    try:
        yield scope
    finally:
        _scope = outer


def holds(document) -> bool:
    """Whether the guard can hold the document's observation to its keys: a control, whose input files its own
    files give, or a corpus document with an ``inputs.json`` (``input_files``)."""
    return document.kind == "control" or (Path(document.root) / INPUTS).is_file()


def input_files(document) -> dict | None:
    """Each part's input files, by role, as paths relative to the document's directory
    (``proof.observe.unit.input_files``' layout): a control's computed from its own files, as its keys are (it keeps
    no ``inputs.json``, ``proof.checks.controls``, so no manifest can go stale beside an edit of it), a corpus
    document's from its ``inputs.json``; None for a corpus document without one. Read as the guard's own (``_own``):
    a part's scope may be derived inside another part's."""
    if not holds(document):
        return None
    with _own():
        if document.kind == "control":
            return unit.input_files(document)
        manifest = json.loads((Path(document.root) / INPUTS).read_text(encoding="utf-8"))

    def paths(entries):
        return {role: entry["path"] for role, entry in (entries or {}).items()}

    return {
        "configurations": {
            name: {part: paths(roles) for part, roles in parts.items()}
            for name, parts in manifest["configurations"].items()
        },
        "local": paths(manifest.get("local")),
    }


def _hook_digests(hooks, states: Iterable[str]) -> frozenset[str]:
    found = set()

    def walk(value):
        if isinstance(value, str):
            if value.startswith("sha256:"):
                found.add(value)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for state in states:
        walk((hooks or {}).get(state, {}))
    return frozenset(found)


def part_scope(document, configuration: str | None, part: str, hooks=None) -> Scope | None:
    """The scope of one part's observation: the files its key names, by its roles and its parents'
    (``input_files``), and the digests its hooks declare (``hooks``: ``proof.observe.unit.hook_inputs``).

    ``part`` is ``a``, ``b``, ``b_aligned``, ``b_edit``, ``local``,
    ``configuration`` for what a configuration's observation reads before
    its parts (A's inputs), or ``keys`` for what the document's keys are
    derived from (``KEYS``: any file of the document's own directory, and the
    browser's code). None for a corpus document without an inputs.json,
    which the store neither reads nor keeps (``proof.store.runtime``).
    """
    if not holds(document):
        return None
    root = Path(os.path.abspath(document.root))
    corpus = root if document.kind == "control" else root.parent
    if part == KEYS:
        label = f"deriving the keys of {document.kind}:{document.id}"
        return Scope(label, corpus, root, frozenset({str(root / INPUTS)}), browser=True, directory=True)
    files = input_files(document)
    if part == "local":
        roles = [files["local"]]
    else:
        parts = files["configurations"][configuration]
        roles = [
            {
                role: path
                for role, path in (parts.get(name) or {}).items()
                if name == "a" or role not in unit.B_UNREAD_ROLES
            }
            for name in CHAINS[part]
        ]
        if part == "b_aligned" and files["local"].get("local"):
            roles.append({"local": files["local"]["local"]})
    paths = {str(root / INPUTS)}
    for entries in roles:
        paths.update(os.path.abspath(root / path) for path in entries.values())
    label = f"observing {document.kind}:{document.id}" + (f" {configuration}/{part}" if configuration else f" {part}")
    return Scope(label, corpus, root, frozenset(paths), _hook_digests(hooks, STATES[part]), part in BROWSER_PARTS)


@contextmanager
def observing(document, configuration: str | None, part: str, hooks=None):
    """Guard the reads of one part's observation (``part_scope``); nothing is guarded until ``install``."""
    scope = part_scope(document, configuration, part, hooks) if _installed else None
    if scope is None:
        yield None
        return
    with scoped(scope):
        yield scope
