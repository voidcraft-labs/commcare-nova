"""The lane server's one validation Formplayer answers every worker as a Formplayer of its own would.

Contract (``proof.formplayer.shared``): a host started outside the server writes its Formplayer's address once
it is up; a worker's ``Validator`` waits for it, posts HQ's request to Formplayer's own web server, and gets
Formplayer's own report, the same for the same bytes however many workers ask at once, since Formplayer's
validation keeps no state between requests; a request HQ did not sign is refused; a host that ends, or never
starts, fails the validation that needed it by name rather than answering. The plausible failures: answers
crossed between concurrent requests, a report the client made rather than Formplayer, a signature the client
adds where HQ's own was refused, and a worker that waits forever on a host that is gone.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from proof.formplayer import shared
from proof.formplayer.client import FormplayerRunnerError

FORM = b"""<?xml version="1.0"?>
<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml"
        xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <h:title>Shared</h:title>
    <model>
      <instance>
        <data xmlns="http://openrosa.org/formdesigner/shared" uiVersion="1" version="1" name="Shared"><q/></data>
      </instance>
      <bind nodeset="/data/q" type="xsd:string"/>
    </model>
  </h:head>
  <h:body><input ref="/data/q"><label>Q</label></input></h:body>
</h:html>
"""
BROKEN = FORM.replace(b"<bind ", b'<bind nodeset="/data/q" calculate="1 +"/><bind ', 1)


def test_one_formplayer_answers_every_workers_validation_and_refuses_what_hq_did_not_sign(tmp_path):
    host = shared.Host(tmp_path)
    host.start()
    try:
        validator = shared.Validator(host.ready)
        valid = json.loads(validator.validate_form(FORM))
        broken = json.loads(validator.validate_form(BROKEN))
        assert valid["validated"] is True, valid
        assert broken["validated"] is False and "invalid calculate expression" in broken["fatal_error"], broken
        # Each of many concurrent requests gets its own form's report, from validators of their own as workers
        # hold them.
        forms = [FORM, BROKEN] * 8
        with ThreadPoolExecutor(max_workers=8) as pool:
            answers = list(pool.map(lambda xml: shared.Validator(host.ready).validate_form(xml), forms))
        assert [json.loads(answer)["validated"] for answer in answers] == [True, False] * 8
        assert {answer for answer, xml in zip(answers, forms, strict=True) if xml == FORM} == {
            validator.validate_form(FORM)
        }
        # A request HQ did not sign reaches Formplayer's security chain as sent, and is refused there.
        with pytest.raises(FormplayerRunnerError, match="HTTP 40[13]"):
            validator.validate_form(FORM, headers=(("Content-Type", "application/xml"),))
    finally:
        said = host.close()
    assert said is not None and said["address"] == f"{validator.host}:{validator.port}" and said["seconds"] > 0
    # The host's Formplayer ended with it: a later request is refused by name, not answered.
    with pytest.raises(FormplayerRunnerError, match="did not answer HQ's form validation request"):
        validator.validate_form(FORM)


def test_a_worker_whose_host_failed_or_never_started_is_told_so(tmp_path, monkeypatch):
    ready = tmp_path / "validation-formplayer.json"
    ready.write_text(json.dumps({"error": "Formplayer did not come up"}))
    with pytest.raises(FormplayerRunnerError, match="did not start .*Formplayer did not come up"):
        shared.Validator(ready).validate_form(FORM)
    monkeypatch.setattr(shared, "START_SECONDS", 0.3)
    with pytest.raises(FormplayerRunnerError, match="wrote nothing within"):
        shared.Validator(tmp_path / "never.json").validate_form(FORM)
