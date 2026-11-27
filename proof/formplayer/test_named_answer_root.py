"""Formplayer submits the questionnaire, its case creation and metadata under the form's own name."""

from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind


def test_formplayer_submits_a_registration_under_its_own_root(hq, core_runner, formplayer_documents, formplayer_runner, evidence):
    doc = formplayer_documents["targeted-named-answer-root"]
    with apps.published(doc, core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            with served.run("named-root-register"):
                web = apps.web(formplayer_runner, served)
                form = web.navigate(["0", "0"])
                assert screen_kind(form) == "form", form
                question, = [item for item in form["tree"] if item["type"] == "question"]
                assert question["caption"] == "Household name"
                before = len(served.hq.submissions)
                sent = web.submit(form["session_id"], {question["ix"]: "Chen"})
                assert sent["status"] == "success", sent
                submission, = served.hq.submissions[before:]
    evidence("named-root-register", {"instance": submission.instance.decode()})
    root = etree.fromstring(submission.instance)
    assert etree.QName(root).localname == "survey"
    assert root.findtext("{*}name") == "Chen"
    case = root.find("{http://commcarehq.org/case/transaction/v2}case")
    assert case is not None and case.get("case_id")
    assert case.findtext("{*}create/{*}case_name") == "Chen"
    assert root.findtext("{*}meta/{*}instanceID")


UNICODE_ROOT = "survéy"


def set_named_answer_root(published, name):
    """Keep the stock registration and change only its primary XML root and references."""
    from proof.hq import operations

    model = operations.held_app(published.unit, published.app_id)
    form = model.modules[0].forms[0]
    tree = etree.fromstring(form.source.encode())
    root, = tree.xpath("//*[local-name()='model']/*[local-name()='instance' and not(@id)]/*")
    assert etree.QName(root).localname == "survey"
    root.tag = f"{{{etree.QName(root).namespace}}}{name}"
    for element in tree.iter():
        for key, value in list(element.attrib.items()):
            if "/survey/" in value:
                element.set(key, value.replace("/survey/", f"/{name}/"))
    write = form.actions.open_case.name_update
    assert write.question_path == "/survey/name"
    write.question_path = f"/{name}/name"
    form.source = etree.tostring(tree, encoding="unicode")
    model.save()


def test_formplayer_cannot_open_a_unicode_primary_root(hq, core_runner, formplayer_documents, formplayer_runner, evidence):
    doc = formplayer_documents["targeted-named-answer-root"]
    with apps.published(doc, core_runner) as published:
        set_named_answer_root(published, UNICODE_ROOT)
        with apps.served(published, formplayer_runner) as served:
            with served.run("unicode-answer-root"):
                web = apps.web(formplayer_runner, served)
                form = web.navigate(["0", "0"])
                assert form.get("status") == "error", form
                assert "SAXParseException" in form.get("exception", ""), form
                assert not served.hq.submissions
                evidence("unicode-answer-root-cannot-open", {"root": UNICODE_ROOT, "error": form["exception"]})
