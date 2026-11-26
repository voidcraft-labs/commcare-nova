"""Each real Formplayer case parser keeps the ordinary answers and the case HQ receives."""
import io
import zipfile

import pytest
from lxml import etree

from proof.formplayer import apps
from proof.formplayer.receiving_answers import with_submitted_answer
from proof.formplayer.walk import screen_kind

BULK = "cc-enable-bulk-performance"


def _questions(nodes):
    for node in nodes:
        if node["type"] == "question":
            yield node
        yield from _questions(node.get("children") or [])


def _select_case_parser(stored, bulk):
    stored.setdefault("profile", {}).setdefault("custom_properties", {})[BULK] = "yes" if bulk else "no"


def _assert_case_parser(served, bulk):
    # Formplayer reads the setting from profile.ccpr. The maximum HQ project also has CUSTOM_PROPERTIES enabled.
    with zipfile.ZipFile(io.BytesIO(served.archive())) as archive:
        profile = etree.fromstring(archive.read("profile.ccpr"))
    assert profile.xpath("//*[local-name()='property' and @key=$key]/@value", key=BULK) == [
        "yes" if bulk else "no"
    ]


@pytest.mark.parametrize("bulk", [False, True], ids=["normal", "bulk"])
def test_formplayer_submits_the_answers_and_hq_stores_the_household(
    hq, core_runner, formplayer_documents, formplayer_runner, evidence, bulk
):
    from corehq.form_processor.models import CaseTransaction, CommCareCase, XFormInstance

    document = formplayer_documents["targeted-receiving-answers"]
    mode = "bulk" if bulk else "normal"

    with apps.published(document, core_runner, "maximum") as published:
        with apps.served(published, formplayer_runner, label=mode,
                         change=lambda stored: _select_case_parser(stored, bulk)) as served:
            _assert_case_parser(served, bulk)
            with served.run(mode):
                web = apps.web(formplayer_runner, served)
                web.navigate(["0"])
                form = web.navigate(["0", "0"])
                assert screen_kind(form) == "form", form
                inputs = {node["caption"]: node["ix"] for node in _questions(form["tree"])}
                assert set(inputs) == {"Household name", "Conversation notes"}, form["tree"]
                before = len(served.hq.submissions)
                reply = web.submit(form["session_id"], {
                    inputs["Household name"]: "Chen", inputs["Conversation notes"]: "Agreed to visit",
                })
                assert reply["status"] == "success", reply
                submission, = served.hq.submissions[before:]
                sent = etree.fromstring(submission.instance)
                instance_id = sent.findtext("{*}meta/{*}instanceID")
                transaction = sent.find("{http://commcarehq.org/case/transaction/v2}case")
                assert instance_id and transaction is not None, submission.instance
                case_id = transaction.get("case_id")
                stored = XFormInstance.objects.get_form(instance_id, served.domain)
                household = CommCareCase.objects.get_case(case_id, served.domain)
                history = [t.form_id for t in CaseTransaction.objects.get_transactions(case_id)]
                assert stored.is_normal and stored.xmlns == etree.QName(sent).namespace
                assert (household.name, household.type) == ("Chen", "household")
                assert history.count(instance_id) == 1
                for root in [sent, etree.fromstring(stored.get_xml())]:
                    assert root.findtext("{*}visit/{*}case_note") == "Chen"
                    assert root.findtext("{*}visit/{*}script") == "Agreed to visit"
                    assert root.find("{*}visit/{urn:receiving-service:household}service_value") is not None
                evidence("household-" + mode, {
                    "instance": submission.instance.decode(), "case": case_id,
                    "stored_form": instance_id, "case_history": history, "parser": mode,
                })


@pytest.mark.parametrize("bulk", [False, True], ids=["normal", "bulk"])
@pytest.mark.parametrize(("name", "reason"), [
    pytest.param("case", "case_id", id="case-lowercase"),
    pytest.param("Case", "case_id", id="case-capitalized"),
    pytest.param("Registration", "username", id="registration"),
    pytest.param("FiXtUrE", "fixture is lacking id attribute", id="fixture"),
    pytest.param("schema", "schema is lacking an 'id' attribute", id="schema"),
    pytest.param("sync", "restore_id", id="sync-namespace"),
])
def test_formplayer_dispatches_an_ordinary_answer_name_before_posting(
    hq, core_runner, formplayer_documents, formplayer_runner, evidence, bulk, name, reason
):
    """HQ can build the form. Formplayer reads the submitted child as an action and never posts the form."""
    document = formplayer_documents["targeted-receiving-answers"]
    mode = "bulk" if bulk else "normal"
    label = f"{mode}-{name}"
    with apps.published(document, core_runner, "maximum") as published:
        write = apps.form_written(published, {"0.0": lambda source: with_submitted_answer(source, name)})

        def change(stored):
            write(stored)
            _select_case_parser(stored, bulk)

        with apps.served(published, formplayer_runner, label=label, change=change) as served:
            _assert_case_parser(served, bulk)
            with served.run(label):
                web = apps.web(formplayer_runner, served)
                web.navigate(["0"])
                form = web.navigate(["0", "0"])
                assert screen_kind(form) == "form", form
                inputs = {node["caption"]: node["ix"] for node in _questions(form["tree"])}
                assert set(inputs) == {"Household name", "Conversation notes"}, form["tree"]
                before = len(served.hq.submissions)
                reply = web.submit(form["session_id"], {
                    inputs["Household name"]: "Chen", inputs["Conversation notes"]: "Ordinary answer",
                })
                evidence("refused-ordinary-answer", {"parser": mode, "answer": name, "reply": reply})
                assert reply["status"] == "error", reply
                assert reason in reply["notification"]["message"], reply
                assert len(served.hq.submissions) == before
