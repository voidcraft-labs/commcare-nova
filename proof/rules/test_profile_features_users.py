"""The rule ``profile-features-users`` is sound: HQ's profile reads an unset ``users`` feature and ``"true"`` alike.

Contract: the rule erases the app settings save's ``profile.features.users``
``"true"`` where Nova writes no features. The plausible failures: HQ's
profile writing something else for it (so the save would change the
build), and the rule erasing a ``users`` feature that is not ``"true"``,
which HQ writes into the profile.

A corpus document is published with no features (Nova's), with ``users``
``"true"`` (the save's) and with ``users`` ``"false"``: the first two build
alike and the rule erases their difference; the third builds a different
profile, which the rule leaves. On the parsed app document, the rule leaves
a ``features`` it did not empty, whether empty already or holding another
feature beside ``users``.
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
from proof.rules.profile_features_users import RULE, normalize

DOCUMENT = "arithmetic"


def _users(value):
    def change(doc):
        doc.setdefault("profile", {}).setdefault("features", {})["users"] = value

    return edited(change)


def test_hq_writes_an_unset_users_feature_as_it_writes_true(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        assert "features" not in (nova.stored["doc"].get("profile") or {}), "Nova's app holds features already"
        saved = app.spell(doc=_users("true"))
        off = app.spell(doc=_users("false"))

    assert_spelled(nova, saved, RULE, lambda path: path.startswith("/profile"))
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, off.stored, rules=(RULE,)))
    assert build_differences(nova.build, off.build), "HQ's profile writes users=false as it writes true"


def test_the_rule_removes_only_what_it_empties():
    assert normalize({"profile": {"features": {}}}) == {"profile": {"features": {}}}
    assert normalize({"profile": {"features": {"users": "true", "sense": "true"}}}) == {
        "profile": {"features": {"sense": "true"}}
    }
    assert normalize({"profile": {"features": {"users": "true"}}}) == {"profile": {}}
