"""The rule ``profile-custom-properties`` is sound: HQ's profile reads an unset ``custom_properties`` and ``{}`` alike.

Contract: the rule erases the app settings save's empty
``profile.custom_properties``, which it writes under ``CUSTOM_PROPERTIES``.
The plausible failures: HQ's profile writing something for an empty map,
and the rule erasing a map that holds a property, which HQ's profile writes
under that flag.

A corpus document is published under its maximum configuration (which
grants ``CUSTOM_PROPERTIES``) with no custom properties, with ``{}`` and
with one property: the first two build alike and the rule erases their
difference; the third builds a different profile, which the rule leaves.
"""

from __future__ import annotations

from proof.rules.conftest import (
    assert_same_build,
    assert_spelled,
    build_differences,
    edited,
    published,
    shown,
    stored_differences,
)
from proof.rules.profile_custom_properties import RULE

DOCUMENT = "arithmetic"
CONFIGURATION = "maximum"


def _custom(value):
    return edited(lambda doc: doc.setdefault("profile", {}).update(custom_properties=value))


def test_hq_writes_empty_custom_properties_as_it_writes_none(rule_documents, hq, core_runner):
    document = rule_documents[DOCUMENT]
    assert "CUSTOM_PROPERTIES" in document.exports[CONFIGURATION].configuration.flags
    with published(document, core_runner, CONFIGURATION) as app:
        nova = app.spell()
        assert "custom_properties" not in (nova.stored["doc"].get("profile") or {})
        saved = app.spell(doc=_custom({}))
        held = app.spell(doc=_custom({"proof-custom": "yes"}))

    assert_spelled(nova, saved, RULE, lambda path: path.startswith("/profile"))
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, held.stored, rules=(RULE,)))
    assert build_differences(nova.build, held.build), "HQ's profile writes a custom property as it writes none"
