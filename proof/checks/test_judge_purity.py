"""Judgment is pure, and observation is closed: judges run without HQ, and records depend on observation code only.

Contract (observation is split from judgment): the checks' judges read
records only, so a judgment can be made again, or cached, without HQ. In a
fresh interpreter whose import system refuses HQ's packages (``corehq``,
``django``, and every module under HQ's checkout, such as ``casexml``, but
HQ's own reader of app strings files, which imports neither), every judge
module imports, and the judges give a document's records, written to
disk and read back, the same differences they give them here.

And the other way: what a record holds is decided by the observation
partition alone (``proof.observe.partition``), the files the observation
fingerprint covers, so a stored part is reused only while none of the code
that wrote it changed. Every module the observation may import, at module
level or when a function runs, is in that partition.

The plausible failures: a judge that imports HQ at module level, directly
or through a helper it imports; a judge that reaches HQ only when it runs
(a lazy import inside a function), which an import alone would not show;
a judgment that reads something the records do not hold (a live object,
a temporary file), which differs once the records are read back; and an
observation that calls a judge's helper (a script, a flip plan, a build
comparison), so editing the judge changes records under unchanged keys. The
refusal itself is paired with an accepted import: the same interpreter
refuses ``import corehq`` and imports ``lxml``; the closure is paired with
one that a function's import reaches outside the partition.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap

from proof.checks import cases, observations, sharding
from proof.hq.boot import HQ_ROOT

# Every module that judges records, or that a judge imports: from the checks, and the observation's own
# readers of what a record holds.
JUDGES = (
    "proof.checks.bar",
    "proof.checks.cases",
    "proof.checks.compare.app_json",
    "proof.checks.compare.app_strings",
    "proof.checks.compare.build_files",
    "proof.checks.compare.json_tree",
    "proof.checks.compare.names",
    "proof.checks.compare.spelling",
    "proof.checks.compare.trace",
    "proof.checks.compare.versions",
    "proof.checks.compare.xml_tree",
    "proof.checks.corpus",
    "proof.checks.differences",
    "proof.checks.hqbuild",
    "proof.checks.identity",
    "proof.checks.intent",
    "proof.checks.manifest_usage",
    "proof.checks.manifest_value_classes",
    "proof.checks.observations",
    "proof.checks.proof1",
    "proof.checks.proof2",
    "proof.checks.proof3",
    "proof.checks.proof4",
    "proof.checks.proof5",
    "proof.checks.registers",
    "proof.checks.sensitivity",
    "proof.observe.alignment",
    "proof.observe.builds",
    "proof.observe.identity",
    "proof.observe.intent",
    "proof.observe.manifest",
    "proof.observe.outcome",
    "proof.observe.proof4",
    "proof.observe.record",
    "proof.observe.runs",
    "proof.observe.sensitivity",
    "proof.rules",
)

REFUSING = textwrap.dedent(
    """
    import importlib.abc, importlib.machinery, sys

    REFUSED = ("corehq", "django")
    # HQ's reader of its own app strings files: one module of HQ's checkout that imports neither HQ nor Django
    # and needs no boot (proof/checks/compare/app_strings.py reads it from there).
    READER = "commcare_translations"
    HQ_ROOT = sys.argv[1].rstrip("/") + "/"

    class RefuseHQ(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path=None, target=None):
            if name.split(".")[0] in REFUSED:
                raise ImportError(f"judgment imported {name}, a part of HQ")
            spec = importlib.machinery.PathFinder.find_spec(name, path)
            if spec is not None and name != READER and (spec.origin or "").startswith(HQ_ROOT):
                raise ImportError(f"judgment imported {name} from HQ's checkout ({spec.origin})")
            return None

    sys.meta_path.insert(0, RefuseHQ())
    """
)


def _refusing(script, *arguments):
    """``script`` run after ``REFUSING`` in a fresh interpreter of the harness's own Python."""
    return subprocess.run(
        [sys.executable, "-c", REFUSING + textwrap.dedent(script), HQ_ROOT, *arguments],
        capture_output=True,
        text=True,
        timeout=300,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def test_every_judge_imports_where_hq_cannot_be_imported():
    ran = _refusing(
        """
        import importlib, json, sys
        loaded = {}
        for name in sys.argv[2:]:
            try:
                importlib.import_module(name)
                loaded[name] = None
            except ImportError as error:
                loaded[name] = str(error)
        refused = {}
        for name in ("corehq", "casexml.apps.case.xform"):
            try:
                importlib.import_module(name)
                refused[name] = None
            except ImportError as error:
                refused[name] = str(error)
        import lxml.etree
        hq = sorted(m for m in sys.modules if m.startswith(("corehq", "django")))
        print(json.dumps({"loaded": loaded, "refused": refused, "hq": hq}))
        """,
        *JUDGES,
    )
    assert ran.returncode == 0, ran.stderr
    found = json.loads(ran.stdout)
    assert found["loaded"] == dict.fromkeys(JUDGES), {k: v for k, v in found["loaded"].items() if v}
    assert all(found["refused"].values()), found["refused"]
    assert found["hq"] == []


def _cheapest_edited(check=None):
    """The cheapest edited corpus document (``proof/timings.json``); with ``check``, the cheapest one a register
    entry of that check names, on which the lane holds the entry's difference, so the check's judge gives one."""
    estimate = sharding.estimate(sharding.load_timings())
    edited = [document for document in cases.load_corpus().emitted if document.edit is not None]
    if check is not None:
        named = {entry.document for entry in cases.load_register() if entry.check == check}
        edited = [document for document in edited if document.id in named]
    assert edited, f"The corpus holds no edited document{f' the register names for {check}' if check else ''}."
    return min(edited, key=lambda document: (estimate(document.group), document.id))


JUDGMENTS = textwrap.dedent(
    """
    import json, sys
    from proof.checks import bar, corpus, observations, proof1, proof2, proof3, proof4, proof5, sensitivity
    from proof.observe.record import DocumentRecords

    records = DocumentRecords.load(sys.argv[2])
    document = corpus.load(corpus.corpus_root()).document(sys.argv[3])
    views = [
        sensitivity.judged(document.id, observations.sensitivity_view(records, name), document.verdict)
        for name in sorted(document.exports)
    ]
    found = {
        "bar": bar.document_bar(document, records),
        "proof1": proof1.document_identity(document, records),
        "proof2": proof2.document_build_equivalence(document, records),
        "proof3": proof3.document_behavior(document, records),
        "proof4": proof4.document_editability(document, records)[0],
        "proof5": proof5.locality(document, local=records.local)[0],
        "sensitivity": [d for view in views for flip in view.flips for d in flip.differences],
    }
    print(json.dumps({check: sorted(json.dumps(d.as_json(), sort_keys=True) for d in differences)
                      for check, differences in found.items()}))
    """
)


def test_each_judge_gives_records_read_back_where_hq_cannot_be_imported_what_it_gives_them_here(
    hq, core_runner, editor_driver, tmp_path
):
    from proof.checks import bar, proof1, proof2, proof3, proof4, proof5, sensitivity

    document = _cheapest_edited()
    records = observations.records_for(document, core_runner, editor_driver=editor_driver)
    views = [
        sensitivity.judged(document.id, observations.sensitivity_view(records, name), document.verdict)
        for name in sorted(document.exports)
    ]
    here = {
        "bar": bar.document_bar(document, records),
        "proof1": proof1.document_identity(document, records),
        "proof2": proof2.document_build_equivalence(document, records),
        "proof3": proof3.document_behavior(document, records),
        "proof4": proof4.document_editability(document, records)[0],
        "proof5": proof5.locality(document, local=records.local)[0],
        "sensitivity": [d for view in views for flip in view.flips for d in flip.differences],
    }
    expected = {
        check: sorted(json.dumps(d.as_json(), sort_keys=True) for d in differences)
        for check, differences in here.items()
    }
    ran = _refusing(JUDGMENTS, str(records.save(tmp_path / "records")), document.id)
    assert ran.returncode == 0, ran.stderr
    assert json.loads(ran.stdout) == expected
    # The comparison means something: the document's judgments are not all empty.
    assert any(expected.values()), f"{document.id} gives no judge any difference, so nothing is compared."


# The observation's closure ----------------------------------------------------------


def test_every_module_the_observation_may_import_is_in_the_observation_partition():
    from proof.observe import partition

    closure = partition.import_closure()
    outside = [path for path in closure if not partition.observes(path)]
    assert outside == [], (
        f"The observation may run {outside}, which the observation fingerprint does not cover, so an edit there"
        " would change records while their keys stay the same. Move what the observation calls into"
        " proof/observe/, or add the file to proof/observe/partition.py (and so to the fingerprint)."
    )
    # It is the observation's whole closure: it reaches HQ's operations, the Core runner and the corpus reader.
    reached = {"proof/observe/unit.py", "proof/hq/operations.py", "proof/core/client.py", "proof/checks/corpus.py"}
    assert reached <= set(closure)


def test_the_closure_follows_an_import_a_function_makes_and_a_package_that_runs_code(tmp_path):
    from proof.observe import partition

    files = {
        "proof/__init__.py": '"""The package."""\n',
        "proof/observe/__init__.py": '"""Observation."""\n',
        "proof/observe/unit.py": "def observe():\n    from proof.checks import judge\n\n    return judge.verdict()\n",
        "proof/checks/__init__.py": '"""Checks."""\n',
        "proof/checks/judge.py": "def verdict():\n    return 1\n",
        "proof/rules/__init__.py": "RULES = ()\n",
        "proof/rules/rule.py": '"""A rule."""\n',
    }
    for path, text in files.items():
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_text(text)
    assert partition.import_closure(("proof.observe.*",), tmp_path) == [
        "proof/checks/judge.py",
        "proof/observe/unit.py",
    ]
    # A package whose __init__ runs code is in the closure of every module under it.
    assert partition.import_closure(("proof.rules.rule",), tmp_path) == [
        "proof/rules/__init__.py",
        "proof/rules/rule.py",
    ]
    assert not partition.observes("proof/checks/judge.py") and partition.observes("proof/observe/unit.py")
    assert not partition.observes("proof/editors/driver/page.mjs") and partition.observes("proof/editors/client.py")
