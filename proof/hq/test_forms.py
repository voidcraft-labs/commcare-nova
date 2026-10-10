"""A form HQ's page draws, read as a person's browser posts it (``proof.hq.forms.posted``).

Contract: what the harness posts to one of HQ's pages is the form that page
draws, every control as the browser sends it: a box's own value, a check box
ticked by its own initial value (and sending nothing unticked), the option a
select draws selected, and what the person typed or chose in
place of a control's value. The plausible failures: a control the page
draws left out (HQ then reads its default where a person's browser sent the
page's value), a value given for a control the page does not draw, or a
choice a select does not offer, each of which no browser could send and so
must raise.
"""

from __future__ import annotations

import pytest

from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE", "DATA_FORWARDING"})
TOKEN = "proof-csrf-token-0123456789abcdef"


def test_a_page_form_posts_what_it_draws_with_what_a_person_typed_and_refuses_what_it_does_not_draw(hq):
    from corehq.motech.forms import ConnectionSettingsForm

    from proof.hq.forms import NotDrawn, posted

    with hq_check(CONFIGURATION) as (unit, _):
        with unit.committing(), unit.request(b"\x07" * 32):
            form = ConnectionSettingsForm(domain=unit.domain, initial={}, prefix=None, instance=None)
            untouched = posted(form, {}, TOKEN)
            typed = posted(form, {"name": "Typed", "auth_preset": "CUSTOM", "skip_cert_verify": True}, TOKEN)
            with pytest.raises(NotDrawn):
                posted(form, {"no_such_control": "x"}, TOKEN)
            with pytest.raises(NotDrawn):
                posted(form, {"auth_preset": "NO_SUCH_PRESET"}, TOKEN)
    names = [name for name, _ in untouched]
    assert names[0] == "csrfmiddlewaretoken" and dict(untouched)["csrfmiddlewaretoken"] == TOKEN, untouched
    # Every field the page's layout draws is sent, and an unticked box sends nothing.
    for name in ("name", "notify_addresses_str", "url", "auth_type", "username", "client_id", "token_url"):
        assert name in names, (name, untouched)
    assert "skip_cert_verify" not in names, untouched
    # A select sends the option the page selects: the preset's initial None is drawn as the selected "(Not
    # Applicable)", whose value is empty, and not the first preset the select lists.
    assert dict(untouched)["auth_preset"] == "" != form.fields["auth_preset"].choices[0][0], untouched
    assert dict(typed)["name"] == "Typed" and dict(typed)["auth_preset"] == "CUSTOM", typed
    assert dict(typed)["skip_cert_verify"] == "on", typed
