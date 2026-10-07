"""Formplayer's own start: the real application, at its pin, on its real services.

Contracts (``proof.formplayer.client``):

- **What runs is Formplayer at the pin, with the Core it vendors.** The plausible
  failure is an image built from another commit, or a runner that started
  something other than Formplayer's own application.
- **Formplayer's own security chain answers.** A request with no session is
  refused by Formplayer and an open route is served, so what answers is
  Formplayer's filter chain and controllers, not a bare servlet.
"""

from __future__ import annotations

import json
from pathlib import Path

from proof.formplayer.client import vendored_core_commit

PINS = Path(__file__).resolve().parents[1] / "pins.json"


def test_formplayer_starts_at_its_pin_with_the_core_it_vendors(formplayer_runner):
    pins = json.loads(PINS.read_text(encoding="utf-8"))
    ready = formplayer_runner.ready
    assert ready["formplayer"]["commit"] == pins["formplayer"]["commit"]
    assert ready["formplayer"]["core"] == vendored_core_commit()
    assert ready["clockReaders"] == ["XPathNowFunc", "XPathTodayFunc", "Text"]
    assert ready["port"] > 0


def test_formplayer_serves_its_open_route_and_refuses_a_request_with_no_session(formplayer_runner):
    up = formplayer_runner.http("/serverup", method="GET")
    assert up.response.status == 200
    assert up.response.json() == {"status": "ok"}
    assert up.hq == ()
    refused = formplayer_runner.http("/navigate_menu", {"domain": "proof", "username": "worker", "app_id": "a"})
    assert refused.response.status in (401, 403)
    assert refused.hq == ()
