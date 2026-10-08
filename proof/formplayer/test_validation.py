"""The form validation HQ's build asks Formplayer for, on Formplayer's own controller.

HQ's build sends each form to Formplayer's ``/validate_form``
(``formplayer_api/form_validation.py::validate_form``), and the lane answers
that request with the Core runner (``proof.core``: ``XFormParser`` with
``JSONReporter``, the body of Formplayer's
``UtilController.validateForm``), a seam every build of every document
rests on.

Contract: the Core runner's report for a form is the one Formplayer's own
controller gives the same bytes, sent as HQ sends them (the form as XML,
signed with the key HQ and Formplayer share). The plausible failures: a
request Formplayer's own security chain or content negotiation answers
another way than the seam assumes (a 401, another media type), a report
that differs between the Core the runner compiles and the Core Formplayer
vendors, and a comparison that passes because both said nothing. So every
form HQ's build sends for validation, for each of this package's documents
published as Nova publishes it, is validated both ways and passes on both;
one of them with a calculation neither can parse is refused by both with
the same report; and Formplayer refuses the same request unsigned.
"""

from __future__ import annotations

import json

from proof.formplayer.client import AUTH_KEY

VALIDATE = "/validate_form"


def _sent(document, core_runner):
    """Each form as HQ's build sends it for validation: the document published as Nova publishes it, HQ's
    ``validate_app`` and ``create_all_files`` run, and the bytes of every validation request the build made."""
    from proof.rules.conftest import published

    with published(document, core_runner) as app:
        before = len(app.unit.record.form_validations)
        built = app.spell()
        assert not built.build.raised, built.build.raised
        return [validation.xml for validation in app.unit.record.form_validations[before:]]


def _formplayers(formplayer_runner, xml: bytes):
    """Formplayer's own answer to the request HQ's build sends for these form bytes."""
    from corehq.util.hmac_request import get_hmac_digest

    answered = formplayer_runner.http(
        VALIDATE,
        xml,
        headers=(("Content-Type", "application/xml"), ("X-MAC-DIGEST", get_hmac_digest(AUTH_KEY, xml))),
    )
    assert answered.response.status == 200, (answered.response.status, answered.response.body[:300])
    assert answered.hq == ()
    return answered.response.json()


def test_the_core_runner_reports_each_form_as_formplayers_own_controller_does(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    from proof.formplayer.conftest import DOCUMENTS

    compared = 0
    for document_id in DOCUMENTS:
        for xml in _sent(formplayer_documents[document_id], core_runner):
            xml = xml if isinstance(xml, bytes) else xml.encode("utf-8")
            runners = json.loads(core_runner.validate_form(xml))
            assert _formplayers(formplayer_runner, xml) == runners, document_id
            assert runners["validated"] is True, (document_id, runners)
            compared += 1
    assert compared >= len(DOCUMENTS)


def _without_identity(report):
    """A report with the JVM's own name for an object cut from its message (``...AbstractExpr@766e2a66``): the
    number is the object's address in that process, and each side is a process of its own."""
    return {**report, "fatal_error": (report.get("fatal_error") or "").split("@")[0]}


def test_both_refuse_a_form_neither_can_parse_with_the_same_report(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    xml, *_ = _sent(formplayer_documents["case-operation-query"], core_runner)
    xml = xml if isinstance(xml, bytes) else xml.encode("utf-8")
    marker = b"<bind "
    assert marker in xml
    broken = xml.replace(marker, b'<bind nodeset="/data/nowhere" calculate="1 +"/><bind ', 1)
    runners = json.loads(core_runner.validate_form(broken))
    assert _without_identity(_formplayers(formplayer_runner, broken)) == _without_identity(runners)
    assert runners["validated"] is False and "invalid calculate expression" in runners["fatal_error"], runners


def test_formplayer_refuses_a_validation_request_hq_did_not_sign(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    xml, *_ = _sent(formplayer_documents["case-operation-query"], core_runner)
    xml = xml if isinstance(xml, bytes) else xml.encode("utf-8")
    unsigned = formplayer_runner.http(VALIDATE, xml, headers=(("Content-Type", "application/xml"),))
    assert unsigned.response.status in (401, 403), unsigned.response.status
