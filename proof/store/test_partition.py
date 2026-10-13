"""A test module is no part of the observation, and nothing the observation runs can come from one.

Contract (``proof.observe.partition``, ``proof.store.fingerprints``): a pytest test module (``test_*.py``) is in
no observation, so an edit to one moves no document's key and observes no document again; a ``conftest.py`` and
every other module of the observation's directories stay in it. That is exact only while no module the
observation can import, directly or through any module under ``proof/``, is a test module, which is held here
over the observation's whole import closure, read from the sources with ``ast``. A test module's items run in its
package's group, whose key names every file of the harness; the items that run in a document's group are part of
that group's outcome, which the store keeps under the judge's fingerprint, so every module that collects one is
the judge's: the checks' own, and the one module outside them, HQ's branch proof.

The plausible failures: an observation module, or a helper it imports, that comes to import a test module for a
constant or a helper (its edit would then change records under unchanged keys); a test module added where the
observation loads every module (``proof/observe/``); and a test module outside the checks that comes to
parametrize over documents, whose items would then run in documents' groups under a key that does not name it,
so a cached group would keep an outcome its changed test never gave.

Standard library and the proof's own standard-library modules; the last test reads the session's collection.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from proof.checks import sharding
from proof.lane import blocks as lane_blocks
from proof.observe import partition
from proof.store import fingerprints


def test_no_module_the_observation_can_import_is_a_test_module():
    led = partition.imported_by()
    tests = {path: importer for path, importer in led.items() if partition.is_test_module(path)}
    assert tests == {}, (
        "The observation can import these test modules (each with the module that imports it): "
        f"{tests}. A test module is in no observation fingerprint, so an edit to one would change records under"
        " unchanged keys. Move what is imported into a module that is not a test (a helper beside it), and import"
        " that; proof/observe/ itself holds no test module, since the observation loads every module there."
    )
    # It is the observation's whole closure: it reaches HQ's operations, the Core runner and the corpus reader.
    assert {"proof/observe/unit.py", "proof/hq/operations.py", "proof/core/client.py"} <= set(led)


def test_a_test_module_reached_through_a_helper_is_found_with_what_imports_it(tmp_path):
    files = {
        "proof/__init__.py": '"""The package."""\n',
        "proof/observe/__init__.py": '"""Observation."""\n',
        "proof/observe/unit.py": "def observe():\n    from proof.hq import helper\n\n    return helper.value()\n",
        "proof/hq/__init__.py": '"""HQ."""\n',
        "proof/hq/helper.py": "from proof.hq.test_units import VALUE\n\n\ndef value():\n    return VALUE\n",
        "proof/hq/test_units.py": "from proof.hq import test_other\n\nVALUE = test_other.VALUE\n",
        "proof/hq/test_other.py": "VALUE = 1\n",
        "proof/hq/test_apart.py": "VALUE = 2\n",
    }
    for path, text in files.items():
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_text(text)
    led = partition.imported_by(("proof.observe.*",), tmp_path)
    assert {path: importer for path, importer in led.items() if partition.is_test_module(path)} == {
        "proof/hq/test_units.py": "proof/hq/helper.py",
        "proof/hq/test_other.py": "proof/hq/test_units.py",
    }
    assert led["proof/hq/helper.py"] == "proof/observe/unit.py" and led["proof/observe/unit.py"] is None
    # A test module nothing imports is no part of the closure.
    assert "proof/hq/test_apart.py" not in led


def test_a_test_module_is_in_no_observation_and_a_conftest_and_a_helper_stay():
    for path in ("proof/lane/test_plan.py", "proof/hq/test_branches.py", "proof/checks/compare/test_trace.py"):
        assert not partition.observes(path) and not fingerprints.in_observation(path), path
    for path in ("proof/lane/plan.py", "proof/hq/conftest.py", "proof/conftest.py", "proof/android/selfcheck.py"):
        assert partition.observes(path) and fingerprints.in_observation(path), path
    # Every one is still a file of the harness, which each package group's key names.
    assert all(fingerprints.in_harness(path) for path in ("proof/lane/test_plan.py", "proof/hq/test_branches.py"))
    # HQ's branch proof runs in documents' groups, so it is the judge's; a lane test is no judge's.
    assert fingerprints.in_judge("proof/hq/test_branches.py") and not fingerprints.in_judge("proof/lane/test_plan.py")
    assert fingerprints.in_judge("proof/checks/test_bar.py") and fingerprints.in_judge("proof/rules/test_rule.py")


def _document_group_modules(items, proof_dir: Path = sharding.PROOF_DIR) -> set[str]:
    """The repository-relative modules that collected an item of a document's or a control's group."""
    return {
        "proof/" + Path(str(item.path)).relative_to(proof_dir).as_posix()
        for item in items
        if sharding.item_group(item, proof_dir).startswith(lane_blocks.DOCUMENT_KINDS)
    }


def test_every_item_of_a_documents_group_is_collected_from_a_module_of_the_judges(request, tmp_path):
    outside = sorted(
        module for module in _document_group_modules(request.session.items) if not fingerprints.in_judge(module)
    )
    assert outside == [], (
        f"{outside} collect items that run in a document's group, and the judge's fingerprint does not name them, so"
        " a cached group would keep the outcome of a test that has since changed. Name each in"
        " proof.store.fingerprints.DOCUMENT_GROUP_TESTS."
    )

    # The reading itself: an item whose parameter carries a document's group is its module's, wherever it is.
    def item(module, group=None):
        params = {"document": SimpleNamespace(group=group)} if group else {}
        return SimpleNamespace(path=tmp_path / module, callspec=SimpleNamespace(params=params), nodeid=module)

    items = [
        item("hq/test_branches.py", "corpus:a"),
        item("hq/test_branches.py"),
        item("editors/test_new.py", "control:b"),
        item("lane/test_plan.py"),
    ]
    assert _document_group_modules(items, tmp_path) == {"proof/hq/test_branches.py", "proof/editors/test_new.py"}
    assert not fingerprints.in_judge("proof/editors/test_new.py")
