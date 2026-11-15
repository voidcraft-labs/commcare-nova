"""A family's HQ step imports only the app sources its producer wrote, whatever a proof wrote beside them.

Contract: ``hq_support.app_sources`` gives a step the files of its family's
directory that match the step's pattern, in name order, and never a proof's
evidence record (``write_evidence``), which a proof writes into the same
directory. The plausible failure: a proof that reads only the family's corpus
(the csql reader parity, the search validation, the quote payload) writes its
evidence before anything runs the family's HQ step, and the step then imports
that record as an app (``Application.from_source``) and fails, or a prefixed
pattern (``endpoint-*.json``, ``nested-menu-*.json``, ``no-matches-*.json``)
takes the family's own evidence (``endpoint-emission.evidence.json``). The
paired case: the same directory's app sources are all taken, under the
default pattern and a prefixed one.
"""

import ast
from pathlib import Path

from proof.native.hq_support import app_sources, write_evidence

STEPS = Path(__file__).parent / "steps"


def test_a_step_takes_its_producers_app_sources_and_never_a_proofs_evidence(tmp_path):
    for name in ("csql-vectors", "endpoint-session", "endpoint-search"):
        (tmp_path / f"{name}.json").write_text('{"modules": []}\n')
        (tmp_path / f"{name}.suite.xml").write_text("<suite/>\n")
    (tmp_path / "csql-reader.jsonl").write_text('{"id": "x"}\n')
    write_evidence(tmp_path, "csql-reader-parity", {"vectors": []})
    write_evidence(tmp_path, "endpoint-emission", {"records": []})

    # The directory holds what the plausible failure takes: both records match both patterns' globs.
    assert {path.name for path in tmp_path.glob("endpoint-*.json")} >= {"endpoint-emission.evidence.json"}
    assert {path.name for path in tmp_path.glob("*.json")} >= {"csql-reader-parity.evidence.json"}

    assert [path.name for path in app_sources(tmp_path)] == [
        "csql-vectors.json",
        "endpoint-search.json",
        "endpoint-session.json",
    ]
    assert [path.name for path in app_sources(tmp_path, "endpoint-*.json")] == [
        "endpoint-search.json",
        "endpoint-session.json",
    ]


def test_no_step_selects_its_sources_by_a_glob_of_its_own():
    globbing = [
        f"{path.name}:{node.lineno}"
        for path in sorted(STEPS.glob("*.py"))
        for node in ast.walk(ast.parse(path.read_text()))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in {"glob", "rglob", "iterdir"}
    ]
    assert globbing == [], f"A step reads its family's directory itself, past app_sources: {globbing}"
