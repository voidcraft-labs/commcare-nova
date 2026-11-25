"""HQ's form builder keeps a submitted value apart from its question, and Core submits it there.

The source is one the form builder saved (``lib/commcare/reader/xform/__tests__/fixtures/vellum-in-between.xml``):
HQ builds it unmodified into a corpus document's app, and Core walks the form and submits it, the data nodes in the
order the saved source holds them. It reads a corpus document, so it runs with the corpus in place.
"""

from __future__ import annotations

from pathlib import Path

from lxml import etree

from proof.core.artifacts import XFORMS


def _form_step(run: dict) -> dict | None:
    forms = [step for step in run["trace"] if step.get("screen") == "form"]
    return forms[-1] if forms else None


def _commands(run: dict) -> list[str]:
    return [step["command"] for step in run["script"] if "command" in step]


def test_vellum_independent_data_order_reaches_core_submission(hq, core_runner):
    """HQ builds the unmodified Vellum source, then Core walks and submits that built form."""
    from proof.checks import casedata, cases
    from proof.rules.conftest import published, restore, run as run_spelling

    fixture = Path(__file__).resolve().parents[2] / "lib/commcare/reader/xform/__tests__/fixtures/vellum-in-between.xml"
    source = fixture.read_text(encoding="utf-8")
    authored = etree.fromstring(source.encode()).find(f".//{{{XFORMS}}}instance")[0]
    expected_nodes = [etree.QName(node).localname for node in authored]
    document = cases.load_corpus().document("targeted-submitted-groups")
    with published(document, core_runner) as app:
        built = app.spell(sources={"0.0": lambda _: source}).build
        assert built.files is not None and not built.raised, built.raised
        database = casedata.case_database(document.document)
        ran = run_spelling(app, core_runner, built, restore(app, database), database)
    assert ran.trace is not None, ran.admission
    run, = [run for run in ran.trace["runs"] if "m0-f0" in _commands(run)]
    assert run["end"] == "submitted", run
    step = _form_step(run)
    paths = ["/data/before-child", "/data/parent/child", "/data/after-child"]
    answers = [e for e in step["events"] if e.get("dataPath") in paths]
    assert [e["dataPath"] for e in answers] == paths
    root = etree.fromstring(step["submission"].encode())
    assert [etree.QName(n).localname for n in root if etree.QName(n).localname in expected_nodes] == expected_nodes
    for event in answers:
        _, _, *parts = event["dataPath"].split("/")
        node = root.find("/".join(f"{{*}}{part}" for part in parts))
        assert node is not None and node.text == event["answer"]
