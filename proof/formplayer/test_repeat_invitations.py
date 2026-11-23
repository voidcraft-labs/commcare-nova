"""The add button's actual caption changes after Formplayer inserts the first row."""

import pytest
from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import questions


@pytest.mark.parametrize(("language", "first", "later"), [
    ("en", "Record the first visit", "Record another visit"),
    ("es", "Registrar la primera visita", "Registrar otra visita"),
])
def test_formplayer_changes_the_invitation_after_adding_a_visit(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence, language, first, later,
):
    document = formplayer_documents["targeted-repeat-invitations"]
    with apps.published(document, core_runner) as published, apps.served(published, formplayer_runner) as served:
        with served.run("visit-" + language):
            web = apps.web(formplayer_runner, served, locale=language)
            opened = web.navigate(["0", "0"])
            def button(response):
                item, = [node for node in questions(response["tree"])
                         if node.get("repeatable") == "true" and node.get("exists") == "false"]
                return item
            initial = button(opened)
            assert initial["add-choice"] == first, initial
            added = web.form_request("new-repeat", opened["session_id"], ix=initial["ix"])
            next_button = button(added)
            assert next_button["add-choice"] == later, next_button
            row, = [node for node in questions(added["tree"])
                    if node.get("repeatable") == "true" and node.get("exists") == "true"]
            deleted = web.form_request("delete-repeat", opened["session_id"], ix=row["ix"])
            assert button(deleted)["add-choice"] == first, deleted
            before = len(served.hq.submissions)
            empty = web.submit(opened["session_id"], {})
            assert empty["status"] == "success", empty
            empty_instance, = served.hq.submissions[before:]
            assert not etree.fromstring(empty_instance.instance).findall("{*}visit")
            opened = web.navigate(["0", "0"])
            added = web.form_request("new-repeat", opened["session_id"], ix=button(opened)["ix"])
            place, = [node for node in questions(added["tree"]) if node.get("caption") == "Place visited"]
            before = len(served.hq.submissions)
            submitted = web.submit(opened["session_id"], {place["ix"]: "North"})
            assert submitted["status"] == "success", submitted
            received, = served.hq.submissions[before:]
            instance = etree.fromstring(received.instance)
            assert [row.findtext("{*}place") for row in instance.findall("{*}visit")] == ["North"]
            evidence("repeat-invitations-" + language, {"first": initial, "later": next_button, "empty": empty_instance.instance.decode(), "instance": received.instance.decode()})
