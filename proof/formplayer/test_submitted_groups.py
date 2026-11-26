"""An installed Web Apps form displays the screen order and sends the saved data order to HQ."""

from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import questions as walk_questions, screen_kind


def test_formplayer_submits_answers_under_their_data_groups(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    document = formplayer_documents["targeted-submitted-groups"]
    with apps.published(document, core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            with served.run("household"):
                web = apps.web(formplayer_runner, served)
                web.navigate(["0"])
                form = web.navigate(["0", "0"])
                assert screen_kind(form) == "form", form
                questions = [node for node in form["tree"] if node["type"] == "question"]
                assert [node["caption"] for node in questions] == [
                    "Who greeted you?", "Household name", "What happens next?"
                ]
                answers = {node["ix"]: value for node, value in zip(questions, ["Jo", "Chen", "Revisit"], strict=True)}
                for index, value in answers.items():
                    response = web.answer(form["session_id"], index, value)
                    assert response["status"] == "accepted", response
                start = len(served.hq.submissions)
                result = web.submit(form["session_id"], answers)
                assert result["status"] == "success", result
                submission, = served.hq.submissions[start:]
    evidence("household", {"screen": form["tree"], "submission": submission.instance.decode()})
    root = etree.fromstring(submission.instance)
    assert [etree.QName(node).localname for node in root if etree.QName(node).localname != "meta"] == [
        "arrival", "next", "household", "visit_note"
    ]
    assert root.findtext("{*}arrival") == "Jo"
    assert root.findtext("{*}household/{*}name") == "Chen"
    assert root.findtext("{*}next") == "Revisit"

def test_crossed_control_and_data_relevance_in_formplayer(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    document = formplayer_documents["targeted-submitted-groups"]
    with apps.published(document, core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            with served.run("relevance"):
                web = apps.web(formplayer_runner, served)
                web.navigate(["0"])
                form = web.navigate(["0", "1"])
                shown = [q for q in walk_questions(form["tree"]) if q["type"] == "question"]
                assert [q["caption"] for q in shown] == ["Include details?"], form
                start = len(served.hq.submissions)
                result = web.submit(form["session_id"], {shown[0]["ix"]: "no"})
                assert result["status"] == "success", result
                submission, = served.hq.submissions[start:]
                evidence("crossed-relevance", {"screen": form["tree"], "submission": submission.instance.decode()})
                root = etree.fromstring(submission.instance)
                assert root.findtext("{*}receipt/{*}result") == "reviewed"
                assert root.find("{*}receipt/{*}notice") is not None and root.findtext("{*}receipt/{*}notice") == ""
                assert root.find("{*}details") is None
