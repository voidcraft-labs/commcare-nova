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
                add = next(node for node in questions(tree) if node.get("exists") == "false" and node.get("repeatable") == "true")
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
