"""A repeated visit's editable recipient rule during entry and final submit."""

import pytest
from lxml import etree

from proof.connect.recipient_rule import DOCUMENT, source
from proof.formplayer import apps
from proof.formplayer.walk import questions, screen_kind


@pytest.mark.parametrize("skip_unchanged", [False, True], ids=["full", "skip-unchanged"])
def test_each_worker_edit_keeps_the_final_delivery_ids_distinct(
    hq, core_runner, formplayer_runner, formplayer_documents, skip_unchanged
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        change = apps.form_written(published, {"0.0": lambda original: source(original, skip_unchanged)})
        with apps.served(published, formplayer_runner, change=change) as served, served.run("recipients"):
            web = apps.web(formplayer_runner, served)
            web.navigate(["0"])
            form = web.navigate(["0", "0"])
            assert screen_kind(form) == "form", form
            session, tree = form["session_id"], form["tree"]
            entered = []
            for value in ("First", "Second"):
                add = next(
                    node
                    for node in questions(tree)
                    if node.get("exists") == "false" and node.get("repeatable") == "true"
                )
                tree = web.form_request("new-repeat", session, ix=add["ix"])["tree"]
                fields = [node for node in questions(tree) if node.get("type") == "question"]
                assert len(fields) == len(entered) + 1
                index = fields[-1]["ix"]
                if entered:
                    refused = web.answer(session, index, "First")
                    assert refused["status"] == "validation-error", refused
                accepted = web.answer(session, index, value)
                assert accepted["status"] == "accepted", accepted
                entered.append(index)
                tree = accepted["tree"]
            back = web.answer(session, entered[0], "Second")
            assert back["status"] == "validation-error", back
            # A final posted edit to an answered field must also fail.
            before = len(served.hq.submissions)
            duplicate = web.submit(session, dict.fromkeys(entered, "Second"))
            assert duplicate["status"] == "validation-error", duplicate
            assert len(served.hq.submissions) == before
            success = web.submit(session, dict(zip(entered, ("First", "Second"), strict=True)))
            assert success["status"] == "success", success
            instance = etree.fromstring(served.hq.submissions[-1].instance)
            assert instance.xpath("//*[local-name()='entity_id']/text()") == ["First", "Second"]


@pytest.mark.parametrize("skip_unchanged", [False, True], ids=["full", "skip-unchanged"])
@pytest.mark.parametrize("final_value, submitted_id", [("Final", "F"), ("Second", "S")], ids=["colliding", "distinct"])
def test_calculated_recipient_constraints_can_read_the_preceding_answers_at_final_submission(
    hq, core_runner, formplayer_runner, formplayer_documents, skip_unchanged, final_value, submitted_id
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        change = apps.form_written(
            published, {"0.0": lambda original: source(original, skip_unchanged, calculated=True)}
        )
        with apps.served(published, formplayer_runner, change=change) as served, served.run("calculated-recipients"):
            web = apps.web(formplayer_runner, served)
            web.navigate(["0"])
            form = web.navigate(["0", "0"])
            assert screen_kind(form) == "form", form
            session, tree = form["session_id"], form["tree"]
            fields = []
            for value in ("First", "Second"):
                add = next(n for n in questions(tree) if n.get("exists") == "false" and n.get("repeatable") == "true")
                tree = web.form_request("new-repeat", session, ix=add["ix"])["tree"]
                index = [n["ix"] for n in questions(tree) if n.get("type") == "question"][-1]
                entered = web.answer(session, index, value)
                assert entered["status"] == "accepted", entered
                fields.append(index)
                tree = entered["tree"]
            before = len(served.hq.submissions)
            result = web.submit(session, dict(zip(fields, ("First", final_value), strict=True)))
            assert result["status"] == "success", result
            assert len(served.hq.submissions) == before + 1
            instance = etree.fromstring(served.hq.submissions[-1].instance)
            assert instance.xpath("//*[local-name()='recipient']/text()") == ["First", final_value]
            assert instance.xpath("//*[local-name()='entity_id']/text()") == ["F", submitted_id]


@pytest.mark.parametrize("skip_unchanged", [False, True], ids=["full", "skip-unchanged"])
def test_the_web_worker_checks_recipient_width_at_final_submission(
    hq, core_runner, formplayer_runner, formplayer_documents, skip_unchanged
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        change = apps.form_written(published, {"0.0": lambda original: source(original, skip_unchanged, bounded=True)})
        with apps.served(published, formplayer_runner, change=change) as served, served.run("recipient-width"):
            web = apps.web(formplayer_runner, served)
            web.navigate(["0"])
            form = web.navigate(["0", "0"])
            session = form["session_id"]
            add = next(
                n for n in questions(form["tree"]) if n.get("exists") == "false" and n.get("repeatable") == "true"
            )
            tree = web.form_request("new-repeat", session, ix=add["ix"])["tree"]
            (index,) = [n["ix"] for n in questions(tree) if n.get("type") == "question"]
            accepted = "🪶" * 255
            assert web.answer(session, index, accepted)["status"] == "accepted"
            before = len(served.hq.submissions)
            held = web.submit(session, {index: accepted + "🪶"})
            assert held["status"] == "validation-error" and len(served.hq.submissions) == before, held
            success = web.submit(session, {index: accepted})
            assert success["status"] == "success", success
            actual = etree.fromstring(served.hq.submissions[-1].instance)
            assert actual.xpath("//*[local-name()='entity_id']/text()") == [accepted]
