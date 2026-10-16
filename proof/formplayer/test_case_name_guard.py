"""Formplayer refuses a blank or over-long case name at the question, and submits a padded one trimmed.

Nova binds a create's name to a Hidden Value beside the question,
``nova_trimmed_<question>``, whose calculation trims the answer, and names that
node in the form's actions, so HQ's build binds the case block's
``case_name`` to it (``xform.py::XFormCaseBlock.add_create_block``). The
question the worker answers carries the guard as its constraint: the trimmed
answer is at least one character and at most 255
(``lib/commcare/xform/builder.ts``, ``lib/domain/caseScalarTextGuard.ts``).
The document is published as Nova publishes it and released and served by
HQ's own views (``proof.formplayer.hq``), and Formplayer's own application
answers the Web Apps client's requests for it.

Contract, on ``navigation-base``'s form "Register" (the second form of its
one menu), whose ``name`` question names the new patient: a whitespace-only
name and a 256-character name are each answered ``validation-error`` of type
``constraint`` (``JsonActionUtils.questionAnswerToJson``, the answer Core's
``FormEntryController.answerQuestion`` gives a failed constraint); a name with
surrounding spaces is accepted, and the instance Formplayer submits to HQ's
receiver holds the trimmed name in its case block's ``create/case_name``.

The lane's answer table gives no whitespace-only or over-long name, so its
walks never reach the guard. The plausible failures: a guard Formplayer does
not evaluate (the refused names would be accepted and a case made with a
blank or over-long name), a guard that refuses the padded name too, and a
case block that reads the question's raw answer instead of the trimmed node.
"""

from __future__ import annotations

from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind

DOCUMENT = "navigation-base"
# The menu "Patients", then its form "Register" ("Visit" is the first).
REGISTER = ["0", "1"]
CASE = "{http://commcarehq.org/case/transaction/v2}"
PARSER = etree.XMLParser(resolve_entities=False, no_network=True)
REFUSED = {"whitespace": "   ", "over-long": "x" * 256}
PADDED = "  proof  "


def _register(web):
    """The form "Register" opened from the menu, and its questions by caption."""
    web.navigate(REGISTER[:1])
    form = web.navigate(REGISTER)
    assert screen_kind(form) == "form", form
    assert form["title"] == "Register", form["title"]
    return form, {node["caption"]: node for node in form["tree"] if node["type"] == "question"}


def _case_name(instance: bytes) -> str | None:
    """The ``create/case_name`` text of the submission's case block."""
    root = etree.fromstring(instance, PARSER)
    (block,) = root.findall(f"{CASE}case")
    name = block.find(f"{CASE}create/{CASE}case_name")
    return None if name is None else name.text


def test_formplayer_refuses_a_blank_or_over_long_name_and_submits_a_padded_one_trimmed(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            with served.run("refused"):
                web = apps.web(formplayer_runner, served)
                form, questions = _register(web)
                name = questions["Name"]
                refused = {label: web.answer(form["session_id"], name["ix"], text) for label, text in REFUSED.items()}
            with served.run("accepted"):
                web = apps.web(formplayer_runner, served)
                form, questions = _register(web)
                name, external = questions["Name"], questions["External ID"]
                accepted = web.answer(form["session_id"], name["ix"], PADDED)
                before = len(served.hq.submissions)
                submitted = web.submit(form["session_id"], {name["ix"]: PADDED, external["ix"]: "Ext-1"})
                submissions = served.hq.submissions[before:]
    evidence(
        "case-name-guard",
        {
            "refused": {label: (answer.get("status"), answer.get("type")) for label, answer in refused.items()},
            "accepted": accepted["status"],
            "submit": submitted["status"],
            "submitted": [submission.instance.decode("utf-8") for submission in submissions],
        },
    )
    for label, answer in refused.items():
        assert answer["status"] == "validation-error", (label, answer)
        assert answer["type"] == "constraint", (label, answer)
    assert accepted["status"] == "accepted", accepted
    assert submitted["status"] == "success", submitted
    (submission,) = submissions
    assert _case_name(submission.instance) == "proof", submission.instance
