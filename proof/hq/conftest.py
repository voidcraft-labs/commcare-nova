"""Helpers for the HQ package's own tests.

HQ's boot (``hq``), the network watch (``network``) and the HQ timings
(``timed``) are the whole harness's, in ``proof/conftest.py``; ``timed`` is
imported here for the tests that time HQ's operations. This module adds what
only HQ's own tests read: HQ's suite-test app, a Nova-shaped upload of it,
and a form validator that counts what HQ sends it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from proof.conftest import timed  # noqa: F401  (HQ's tests time their operations with it)

HQ_ROOT = Path(os.environ.get("PROOF_HQ", "/opt/hq"))
# An app HQ's own suite tests build (one basic module, two forms with
# update_case actions), read as HQ's import API receives an app file.
HQ_TEST_APP = HQ_ROOT / "corehq/apps/app_manager/tests/data/suite/app.json"


class CountingValidator:
    """The Core runner's form validation, counting the forms HQ sends it."""

    def __init__(self, runner):
        self._runner = runner
        self.calls = 0

    def __call__(self, xml):
        self.calls += 1
        return self._runner.validate_form(xml)


def hq_test_app() -> dict:
    return json.loads(HQ_TEST_APP.read_text())


def nova_shaped_upload(app_json: dict, app_name: str, app_id: str | None = None):
    """A multipart body shaped as Nova's ``importApp`` sends it.

    Fields in Nova's order (``waf_padding`` of 16384 "x", ``app_name``,
    ``app_id`` on an update only, then ``app_file`` named ``app.json`` with
    type ``application/json``), framed by an undici-style boundary.
    """
    from proof.hq.operations import Upload

    boundary = "----formdata-undici-049938641344"
    fields = [("waf_padding", None, b"x" * 16384), ("app_name", None, app_name.encode())]
    if app_id is not None:
        fields.append(("app_id", None, app_id.encode()))
    fields.append(("app_file", "app.json", json.dumps(app_json).encode()))
    body = b""
    for name, filename, content in fields:
        body += f"--{boundary}\r\n".encode()
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"\r\nContent-Type: application/json'
        body += disposition.encode() + b"\r\n\r\n" + content + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return Upload(body, f"multipart/form-data; boundary={boundary}")
