"""The form validation HQ's build asks Formplayer for is answered by Formplayer's own application.

HQ's build sends each form to Formplayer's ``/validate_form``
(``formplayer_api/form_validation.py::validate_form``: the form as XML, the
digest HQ signs it with under the key the two share), and every unit of the
lane answers that request with Formplayer's own controller behind its own
security chain (``proof.hq.seams.formplayer_validation``, the session's
validation Formplayer), HQ's own request and its reading of the answer run
whole.

Contract: the request that reaches Formplayer is the one HQ wrote, its digest
HQ's own, so the same form HQ signs with another key is refused by Formplayer
(the accepted case: HQ's signature under the shared key is answered); a form
Formplayer reads is reported validated, and a form with a calculation it
cannot parse is reported failed by its own message, which HQ then reports as
a build error (``proof/hq/test_build.py``). The plausible failures: a seam
that answers validation itself or re-signs HQ's request (the wrong key would
then pass), a report taken from anything but Formplayer's answer, and a
comparison that passes because nothing was asked.
"""

from __future__ import annotations

import pytest

from proof.formplayer.client import AUTH_KEY, VALIDATE_FORM, FormplayerRunnerError

DOCUMENT = "case-operation-query"


def _sent(document):
    """Each form as HQ's build sends it for validation, and the reports HQ read: the document published as Nova
    publishes it, HQ's ``validate_app`` and ``create_all_files`` run."""
    from proof.rules.conftest import published

    with published(document, None) as app:
        before = len(app.unit.record.form_validations)
        built = app.spell()
        assert not built.build.raised, built.build.raised
        return app.unit.record.form_validations[before:]


def _hq_validates(xml: bytes, *, key: str):
    """HQ's own ``validate_form`` of these bytes inside a unit's seams, with the memo off, HQ signing with ``key``."""
    from corehq.apps.formplayer_api.form_validation import validate_form
    from django.test import override_settings

    from proof.hq.check import hq_check
    from proof.hq.configuration import Configuration
    from proof.hq.seams import FORM_VALIDATIONS

    enabled, FORM_VALIDATIONS.enabled = FORM_VALIDATIONS.enabled, False
    try:
        with hq_check(Configuration(privileges={"CLOUDCARE"})), override_settings(FORMPLAYER_INTERNAL_AUTH_KEY=key):
            return validate_form(xml)
    finally:
        FORM_VALIDATIONS.enabled = enabled


def test_every_form_hqs_build_sends_is_validated_by_formplayer(hq, formplayer_documents):
    sent = _sent(formplayer_documents[DOCUMENT])
    assert sent, "HQ's build sent no form for validation, so nothing was asked"
    assert all(validation.response["validated"] is True for validation in sent), [v.response for v in sent]


def test_formplayer_answers_hqs_own_signature_and_refuses_another_key(hq, formplayer_documents):
    xml = _sent(formplayer_documents[DOCUMENT])[0].xml
    xml = xml if isinstance(xml, bytes) else xml.encode("utf-8")
    assert _hq_validates(xml, key=AUTH_KEY).success is True
    with pytest.raises(FormplayerRunnerError, match="HTTP 40[13]"):
        _hq_validates(xml, key="a key Formplayer was never given")


def test_a_form_formplayer_cannot_parse_is_reported_failed_by_its_own_message(hq, formplayer_documents):
    xml = _sent(formplayer_documents[DOCUMENT])[0].xml
    xml = xml if isinstance(xml, bytes) else xml.encode("utf-8")
    marker = b"<bind "
    assert marker in xml
    broken = xml.replace(marker, b'<bind nodeset="/data/nowhere" calculate="1 +"/><bind ', 1)
    result = _hq_validates(broken, key=AUTH_KEY)
    assert result.success is False and "invalid calculate expression" in (result.fatal_error or ""), result.to_json()


def test_formplayer_refuses_a_validation_request_hq_did_not_sign(hq, formplayer_runner):
    unsigned = formplayer_runner.http(VALIDATE_FORM, b"<h:html/>", headers=(("Content-Type", "application/xml"),))
    assert unsigned.response.status in (401, 403), unsigned.response.status
