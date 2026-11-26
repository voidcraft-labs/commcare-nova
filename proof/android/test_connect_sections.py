"""The Android worker pages and the Learn activity addresses are both part of a released form."""

import pytest
from lxml import etree

from proof.android import observe
from proof.formplayer import apps
from proof.formplayer import hq as hq_forms
from proof.hq import operations
from proof.observe.record import Blobs


@pytest.mark.parametrize("activity_only", [False, True], ids=["two-pages", "activity-only-page"])
def test_worker_pages_keep_all_submitted_learn_activities_in_order(android_documents, hq, activity_only):
    from corehq.apps.app_manager.xform import XForm

    document = android_documents["targeted-connect-section-order"]
    answers = {"/data/practice/reflection": ["Practised together"], "/data/follow_up/next_step": ["Return tomorrow"]}
    with apps.published(document, None) as published:
        app = operations.held_app(published.unit, published.app_id)
        source = app.get_module(0).get_form(0).source
        questions = XForm(source, domain=app.domain).get_questions(["en"], include_groups=True)
        paths = {q["value"] for q in questions}
        assert set(answers).issubset(paths), paths
        assert {"/data/practice/rehearsal/module/name", "/data/review/module/name"}.issubset(paths), paths
        change = None
        if activity_only:
            # Keep the submitted data and role. Only the worker's first control is removed.
            def leave_role_on_page(source):
                tree = etree.fromstring(source.encode() if isinstance(source, str) else source)
                control, = tree.xpath("//*[local-name()='input' and @ref='/data/practice/reflection']")
                control.getparent().remove(control)
                return etree.tostring(tree, encoding="unicode")
            change = apps.form_written(published, {"0.0": leave_role_on_page})
        with hq_forms.serve(published.unit, document, published.app_id, change=change) as served:
            blobs, sent = Blobs(), []
            found = observe.app(
                served, blobs, label="sectioned-learn", archive=observe.release_archive(served),
                commands=["m0-f0"], questions=answers, views=True, sent=sent,
            )
            walk = blobs.get_json(found["answer"])["walks"]["m0-f0"]

    form, = [step["form"] for step in walk["steps"] if "form" in step and step.get("screen") == "FormEntryActivity"]
    pages = [[entry["given"] for entry in page.get("answered", []) if "given" in entry] for page in form["screens"]]
    assert [page for page in pages if page] == ([["Return tomorrow"]] if activity_only else
                                               [["Practised together"], ["Return tomorrow"]]), form["screens"]
    if activity_only:
        assert not any("/practice" in page["index"] for page in form["screens"]), form["screens"]
    assert form["saved"]["finishing"], form["saved"]
    submission, = sent
    data = etree.fromstring(submission)
    controls = [etree.QName(child).localname for child in data]
    assert [name for name in controls if name != "meta"] == ["lesson_one", "practice", "review", "follow_up", "completion"]
    modules = data.xpath(".//*[local-name()='module' and namespace-uri()='http://commcareconnect.com/data/v1/learn']")
    assert [(etree.QName(module.getparent()).localname, module.get("id")) for module in modules] == [
        ("lesson_one", "lesson_one"), ("rehearsal", "rehearsal"), ("review", "review"), ("completion", "completion"),
    ]
    assert etree.QName(modules[1].getparent().getparent()).localname == "practice"
    assert data.xpath("string(./*[local-name()='follow_up']/*[local-name()='next_step'])") == "Return tomorrow"
