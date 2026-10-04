"""While a part is observed, a read its key does not name is refused, and every read it names is allowed.

Contract (``proof.store.guard``): a stored part stands for any later
observation of its key only if the observation read nothing beyond what the
key names. So while a part's scope is open, the guard refuses a read of a
corpus file outside the part's own roles in the document's ``inputs.json``
and its parents' (another part's request, another document's file), and of
a checkout file outside the observation partition (a judge's module, a
register; the browser's code but in the parts that drive the browser); it
allows the part's declared files, a file of the document's own directory
whose digest an observation hook declares, every partition file and its
bytecode, and everything outside the checkout and the corpus. A hook's
declared digest admits no file outside the document's directory (another
document's, the corpus's index, a register), since the document's key, which
the queue builder reads a document's parts under, names only that
directory's files and the code. A file the observation names to the Core runner to
read is held alike (``named``), each file of a directory. Outside a scope,
and in a process that never installed the hook, nothing is refused. Each
part's scope allows exactly the corpus files and hook-declared digests its
key reads, as ``proof.observe.unit`` derives it; what the keys themselves
are derived from may be any file of the document's own directory and the
browser's code, and nothing else of the corpus or the checkout.

A control (``proof/controls/<id>/``) keeps no ``inputs.json``: its scopes
are computed from its own files, as its keys are
(``proof.observe.unit.input_files``), its corpus is its own directory, so
another control's file is refused as the checkout's, and a part's scope
derived while another part's is open reads what it is derived from as the
guard's own. Every file of a control keys exactly the parts whose scopes
allow it.

The plausible failures: a guard that sees only ``open`` and misses
``io.open_code`` (a module imported mid-observation) or an archive the JVM
opens, one that allows a whole document directory (a ``b_edit`` read during
``a``), one that refuses the bytecode of a partition module, one that stays
on after its scope, a scope that drifts from the key it guards (a role
the key reads refused, or one it does not read allowed), and a hook that
reads a register or another document's file under a digest it declares,
which moves its part's key and not its document's; and, for a control, a
scope computed from other roles than its key (its derived values allowed
where they key nothing, or a body keyed and refused), or a scope whose
derivation inside another part's scope is refused.

Each read is made in a fresh interpreter, since an audit hook stays
installed for the rest of the process that adds it.
"""

from __future__ import annotations

import copy
import inspect
import json
import os
import subprocess
import sys
import textwrap
import zipfile
from types import SimpleNamespace

from proof.checks.corpus import Document, load_controls
from proof.observe import unit
from proof.store import guard
from proof.store.conftest import copied_control, smallest_control, write_corpus

SCRIPT = textwrap.dedent(
    """
    import io, json, sys
    from pathlib import Path
    from types import SimpleNamespace
    from proof.store import guard

    corpus, worktree = Path(sys.argv[1]), Path(sys.argv[2])
    one = SimpleNamespace(id="one", kind="corpus", root=corpus / "one", group="corpus:one")
    declared = corpus / "one" / "declared-by-hook.json"
    hooks = {"A": {"intent": {"expected": sys.argv[3], "elsewhere": sys.argv[4:]}}}
    reads = {
        "own create": corpus / "one/export/minimum/create.body",
        "own republish": corpus / "one/export/minimum/republish.body",
        "own local archive": corpus / "one/local.ccz",
        "other document": corpus / "two/export/minimum/create.body",
        "corpus index": corpus / "index.json",
        "hook declared": declared,
        "partition module": worktree / "proof/observe/record.py",
        "partition bytecode": worktree / "proof/checks/__pycache__/corpus.cpython-313.pyc",
        "edit update": corpus / "one/edit/export/minimum/update.body",
        "edit document": corpus / "one/edit/document.json",
        "document": corpus / "one/document.json",
        "browser file": worktree / "proof/editors/driver/driver.mjs",
        "judge module": worktree / "proof/checks/bar.py",
        "register": worktree / "proof/known-defects.json",
        "image file": Path(sys.executable),
        "hook declared, another document's": corpus / "two/declared-by-hook.json",
        "hook declared, the corpus's index": corpus / "index.json",
        "hook declared, a register": worktree / "proof/known-defects.json",
    }

    def attempt(path, opener):
        try:
            opened = opener(str(path))
            if opened is not None:
                opened.close()
            return "read"
        except guard.UndeclaredRead as refusal:
            return "refused: " + str(refusal)
        except OSError:
            return "read"

    found = {"before install": attempt(reads["judge module"], open)}
    guard.install()
    with guard.observing(one, "minimum", "a", hooks) as scope:
        for name, path in reads.items():
            found[name] = attempt(path, open)
        found["judge module, as code"] = attempt(reads["judge module"], io.open_code)
    with guard.observing(one, "minimum", "b", hooks):
        found["b reads republish"] = attempt(reads["own republish"], open)
        found["b reads the edit's update"] = attempt(reads["edit update"], open)
    with guard.observing(one, "minimum", "b_edit", hooks):
        found["b_edit reads its update"] = attempt(reads["edit update"], open)
        found["b_edit reads D's document"] = attempt(reads["document"], open)
        found["b_edit reads D' document"] = attempt(reads["edit document"], open)
    with guard.observing(one, None, "local"):
        found["local reads its archive"] = attempt(reads["own local archive"], open)
        found["local reads create"] = attempt(reads["own create"], open)
    with guard.observing(one, "minimum", "b"):
        found["b reads the browser"] = attempt(reads["browser file"], open)
    with guard.observing(one, None, "keys"):
        for name in ("edit update", "edit document", "browser file", "other document", "corpus index", "register"):
            found["keys read " + name] = attempt(reads[name], open)
    with guard.observing(one, "minimum", "a"):
        found["Core admits own create"] = attempt(reads["own create"], guard.named)
        found["Core admits the local archive"] = attempt(reads["own local archive"], guard.named)
        found["Core admits the document's directory"] = attempt(corpus / "one" / "export", guard.named)
    found["Core admits after scope"] = attempt(reads["own local archive"], guard.named)
    found["after scope"] = attempt(reads["judge module"], open)
    found["refused"] = scope.refused
    print(json.dumps(found))
    """
)


def _run(tmp_path):
    corpus = write_corpus(tmp_path / "corpus", {"one": {"create": "one"}, "two": {"create": "two"}})
    declared = corpus / "one" / "declared-by-hook.json"
    declared.write_text('{"expected": true}')
    elsewhere = corpus / "two" / "declared-by-hook.json"
    elsewhere.write_text('{"expected": false}')
    digests = [guard._digest(str(path)) for path in (declared, elsewhere, corpus / "index.json")]
    digests.append(guard._digest(str(guard.WORKTREE / "proof" / "known-defects.json")))
    result = subprocess.run(
        [sys.executable, "-c", SCRIPT, str(corpus), str(guard.WORKTREE), *digests],
        capture_output=True,
        text=True,
        timeout=60,
        env={"PYTHONPATH": str(guard.WORKTREE), "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_a_part_reads_only_what_its_key_names_and_every_undeclared_read_is_refused_by_name(tmp_path):
    found = _run(tmp_path)
    allowed = (
        "own create",
        "hook declared",
        "partition module",
        "partition bytecode",
        "b reads the browser",
        "Core admits own create",
        "Core admits after scope",
        "image file",
        "b reads republish",
        "b_edit reads its update",
        "b_edit reads D's document",
        "local reads its archive",
    )
    for name in allowed:
        assert found[name] == "read", (name, found[name])
    # B-edit's key reads D's document through A's, and D''s only as the case database it gives.
    refused = ("own republish", "own local archive", "other document", "corpus index", "local reads create")
    # A hook's declared digest admits only a file of the document's own directory.
    refused += ("hook declared, another document's", "hook declared, the corpus's index")
    # The keys are derived from any file of the document's directory and the browser's code, and nothing else.
    for name in ("edit update", "edit document", "browser file"):
        assert found["keys read " + name] == "read", (name, found["keys read " + name])
    for name in ("other document", "corpus index", "register"):
        assert found["keys read " + name].startswith("refused: While deriving the keys of corpus:one,"), name
    admitted = ("Core admits the local archive", "Core admits the document's directory")
    for name in (*refused, *admitted, "b reads the edit's update", "b_edit reads D' document"):
        assert found[name].startswith("refused: "), (name, found[name])
        assert "inputs.json" in found[name]
    for name in ("judge module", "judge module, as code", "register", "browser file", "hook declared, a register"):
        assert found[name].startswith("refused: "), (name, found[name])
        assert "outside the observation partition" in found[name] and "partition.py" in found[name]
    # The refusal names the file and the part whose observation read it; a directory, the file it refuses.
    assert "two/export/minimum/create.body" in found["other document"]
    assert "one/export/minimum/republish" in found["Core admits the document's directory"]
    assert "corpus:one minimum/a" in found["other document"]
    # Nothing is guarded before the hook is installed or after the scope closes.
    assert found["before install"] == "read" and found["after scope"] == "read"
    assert any(path.endswith("proof/checks/bar.py") for path in found["refused"])


CONTROL_SCRIPT = textwrap.dedent(
    """
    import json, sys
    from pathlib import Path
    from proof.checks.corpus import Document
    from proof.store import guard

    root, other = Path(sys.argv[2]), Path(sys.argv[3])
    one = Document(id=sys.argv[1], source="control", root=root, kind="control")

    def attempt(path):
        try:
            open(path, "rb").close()
            return "read"
        except guard.UndeclaredRead as refusal:
            return "refused: " + str(refusal)

    found = {}
    guard.install()
    with guard.observing(one, "minimum", "a"):
        found["a reads its create"] = attempt(root / "export/minimum/create.body")
        found["a reads the derived values"] = attempt(root / "derived.json")
        found["a reads its republish"] = attempt(root / "export/minimum/republish.body")
        found["a reads another control's create"] = attempt(other / "export/minimum/create.body")
        try:
            with guard.observing(one, "minimum", "b"):
                found["b, scoped inside a, reads its republish"] = attempt(root / "export/minimum/republish.body")
        except guard.UndeclaredRead as refusal:
            found["b, scoped inside a, reads its republish"] = "refused: " + str(refusal)
    with guard.observing(one, None, "local"):
        found["local reads its archive"] = attempt(root / "local.ccz")
        found["local reads the derived values"] = attempt(root / "derived.json")
    with guard.observing(one, None, "keys"):
        found["keys read the batch"] = attempt(root / "edit/batch.json")
        found["keys read another control's"] = attempt(other / "derived.json")
    print(json.dumps(found))
    """
)


def test_a_controls_part_reads_only_its_own_files_and_another_controls_are_refused():
    control = smallest_control()
    other = next(c for c in load_controls() if c.id != control.id and (c.root / "export/minimum/create.body").is_file())
    result = subprocess.run(
        [sys.executable, "-c", CONTROL_SCRIPT, control.id, str(control.root), str(other.root)],
        capture_output=True,
        text=True,
        timeout=60,
        env={"PYTHONPATH": str(guard.WORKTREE), "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert result.returncode == 0, result.stderr
    found = json.loads(result.stdout)
    allowed = (
        "a reads its create",
        "a reads the derived values",
        "b, scoped inside a, reads its republish",
        "local reads its archive",
        "keys read the batch",
    )
    for name in allowed:
        assert found[name] == "read", (name, found[name])
    for name in ("a reads its republish", "local reads the derived values"):
        assert found[name].startswith(f"refused: While observing {control.group} "), (name, found[name])
        assert "a file of the corpus that this part's inputs do not name" in found[name], name
    # Another control's directory is the checkout's, outside the observation partition, in every scope.
    for name in ("a reads another control's create", "keys read another control's"):
        assert found[name].startswith("refused: ") and "outside the observation partition" in found[name], name
        assert str(other.root) in found[name], name


def _rezipped(path):
    """Rewrite the archive at ``path`` with one entry more, so its entries (``unit.archive_digest``) differ."""
    with zipfile.ZipFile(path) as archive:
        entries = [(info, archive.read(info)) for info in archive.infolist()]
    with zipfile.ZipFile(path, "w") as archive:
        for info, content in entries:
            archive.writestr(info, content)
        archive.writestr("edited.txt", b"edited")


def _control_keys(control):
    """Every part key of the control as its files give them now: read afresh, nothing of its files cached."""
    fresh = Document(id=control.id, source="control", root=control.root, kind="control")
    inputs = unit.document_inputs(fresh)
    found = {(None, "local"): unit.local_key(inputs, {}) if LOCAL_HOOKS else unit.local_key(inputs)}
    for name in sorted(inputs["configurations"]):
        found.update({(name, part): key for part, key in unit.part_keys(inputs, name, DATABASES, {}).items()})
    return found


def test_every_file_of_a_control_keys_exactly_the_parts_whose_scopes_allow_it(tmp_path):
    control = copied_control(tmp_path / "controls")
    held = _control_keys(control)
    scopes = {part: guard.part_scope(control, part[0], part[1]) for part in held}
    keyed = set()
    for path in sorted(p for p in control.root.rglob("*") if p.is_file()):
        relative = path.relative_to(control.root).as_posix()
        original = path.read_bytes()
        if path.suffix == ".ccz":
            _rezipped(path)
        else:
            path.write_bytes(original + b"\n")
        try:
            after = _control_keys(control)
        finally:
            path.write_bytes(original)
        changed = {part for part in held if after[part] != held[part]}
        allowed = {part for part, scope in scopes.items() if str(path) in scope.paths}
        assert changed == allowed, relative
        if changed:
            keyed.add(relative)
    # A body, the derived values, the configurations, D's verdict and each archive key parts; what the judges
    # alone read (the edit's footprint) keys none.
    assert {"export/minimum/create.body", "derived.json", "configurations.json", "verdict.json"} <= keyed
    assert {"local.ccz", "local-again.ccz", "edit/local.ccz", "edit/export/minimum/update.body"} <= keyed
    assert "edit/batch.json" not in keyed


def test_a_document_without_an_input_manifest_has_no_scope_and_one_with_it_scopes_each_part(tmp_path):
    corpus = write_corpus(tmp_path / "corpus", {"one": {"create": "one"}, "two": {"create": "two"}})
    one = SimpleNamespace(id="one", kind="corpus", root=corpus / "one", group="corpus:one")
    aligned = guard.part_scope(one, "minimum", "b_aligned")
    assert str(corpus / "one/local.ccz") in aligned.paths and str(corpus / "one/export/minimum/republish.body") in (
        aligned.paths
    )
    assert aligned.corpus == corpus
    (corpus / "two" / "inputs.json").unlink()
    two = SimpleNamespace(id="two", kind="corpus", root=corpus / "two", group="corpus:two")
    assert guard.part_scope(two, "minimum", "a") is None
    # A control keeps none, and is scoped from its own files, its own directory its corpus.
    control = copied_control(tmp_path / "controls")
    assert not (control.root / "inputs.json").exists()
    aligned = guard.part_scope(control, "minimum", "b_aligned")
    assert aligned.corpus == control.root
    named = ("derived.json", "local.ccz", "export/minimum/republish.body", "export/minimum/create.body")
    assert {str(control.root / relative) for relative in named} <= aligned.paths


# The case databases B and B-edit replay over (unit.case_databases), which no corpus file of the part gives.
DATABASES = {"b": "sha256:" + "d" * 64, "b_edit": "sha256:" + "e" * 64}
CONFIGURATION_PARTS = ("a", "b", "b_aligned", "b_edit")


# Whether the unit keys the local part by what its local hooks declare too (proof.observe.unit.local_key).
LOCAL_HOOKS = "hooks" in inspect.signature(unit.local_key).parameters


def _keys(inputs, hooks):
    found = unit.part_keys(inputs, "minimum", DATABASES, hooks)
    found["local"] = unit.local_key(inputs, hooks) if LOCAL_HOOKS else unit.local_key(inputs)
    return found


def _scope(document, part, hooks):
    return guard.part_scope(document, None if part == "local" else "minimum", part, hooks)


def test_each_parts_scope_allows_exactly_the_corpus_files_and_declared_digests_its_key_reads(tmp_path):
    corpus = write_corpus(tmp_path / "corpus", {"one": {"create": "one"}})
    one = SimpleNamespace(id="one", kind="corpus", root=corpus / "one", group="corpus:one")
    manifest = json.loads((one.root / "inputs.json").read_text())
    inputs = unit.document_inputs(one)
    states = ("A", "B", "B-edit", *(("local",) if LOCAL_HOOKS else ()))
    hooks = {state: {"hook": {"read": f"sha256:{n:064x}"}} for n, state in enumerate(states, 1)}
    held = _keys(inputs, hooks)
    parts = (*CONFIGURATION_PARTS, "local")
    atoms = 0
    # Each corpus file a part's key reads, by its role: the parts whose keys change are those whose scopes allow it.
    roles = [
        (("configurations", "minimum", part), entries)
        for part, entries in manifest["configurations"]["minimum"].items()
    ]
    roles.append((("local",), manifest["local"]))
    for where, entries in roles:
        for role, entry in entries.items():
            edited = copy.deepcopy(inputs)
            target = edited
            for step in where:
                target = target[step]
            target[role] = "sha256:" + "f" * 64
            after = _keys(edited, hooks)
            changed = {part for part in parts if after[part] != held[part]}
            path = os.path.abspath(one.root / entry["path"])
            allowed = {part for part in parts if path in _scope(one, part, hooks).paths}
            assert changed == allowed, (where, role)
            atoms += 1
    # Each digest a hook declares for a state: the parts whose keys change are those whose scopes allow it.
    for state, declared in hooks.items():
        after = _keys(inputs, {**hooks, state: {"hook": {"read": "sha256:" + "f" * 64}}})
        changed = {part for part in parts if after[part] != held[part]}
        allowed = {part for part in parts if declared["hook"]["read"] in _scope(one, part, hooks).digests}
        assert changed == allowed, state
        atoms += 1
    assert atoms == sum(len(entries) for _, entries in roles) + len(states)
