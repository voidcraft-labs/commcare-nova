"""The rule ``profile-features-dependencies-empty`` is sound: HQ builds an empty ``dependencies`` and none alike.

Contract: the rule erases the app settings save's ``profile.features.dependencies``
``[]`` where Nova writes no dependencies. The plausible failures: HQ's
profile or app strings writing something for an empty list (so the save
would change the build), and the rule erasing a list that names an app,
which HQ writes into the profile.

A document whose project space holds App Dependencies is published with no
dependencies (Nova's), with ``[]`` (the save's) and with one app: the first
two build alike and the rule erases their difference; the third builds a
different profile, which the rule leaves. On the parsed app document, the
rule leaves a ``features`` that holds another feature, and removes one left
empty, as Nova's publish over the save leaves it.
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
from proof.rules.profile_features_dependencies_empty import RULE, normalize

# Its configurations grant APP_DEPENDENCIES, without which HQ's build drops the list.
DOCUMENT = "targeted-hq-side-owned"


def _dependencies(value):
    def change(doc):
        doc.setdefault("profile", {}).setdefault("features", {})["dependencies"] = value

    return edited(change)


def test_hq_builds_an_empty_dependencies_list_as_it_builds_none(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        features = (nova.stored["doc"].get("profile") or {}).get("features") or {}
        assert "dependencies" not in features, "Nova's app holds a dependencies list already"
        saved = app.spell(doc=_dependencies([]))
        one = app.spell(doc=_dependencies(["org.commcare.dalvik.reminders"]))

    assert_spelled(nova, saved, RULE, lambda path: path.startswith("/profile"))
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, one.stored, rules=(RULE,)))
    assert build_differences(nova.build, one.build), "HQ's profile writes a named app as it writes none"


def test_the_rule_removes_only_an_empty_list():
    assert normalize({"profile": {"features": {"dependencies": ["a"]}}}) == {
        "profile": {"features": {"dependencies": ["a"]}}
    }
    assert normalize({"profile": {"features": {"dependencies": [], "users": "false"}}}) == {
        "profile": {"features": {"users": "false"}}
    }
    assert normalize({"profile": {"features": {"dependencies": []}}}) == {"profile": {}}
    assert normalize({"profile": {"features": {}}}) == {"profile": {}}
