"""The rule ``profile-unread-properties`` is sound: Core runs a build alike whatever the profile's unread
properties hold.

Contract: the rule erases, in a built profile, the properties no runtime
reads (``log_prop_daily``, ``loose_media``, ``purge-freq``,
``restore-tolerance``, ``user_reg_server``), which HQ's app settings save
writes and HQ's build then carries. The plausible failures: one of them
read by Core (so the save would change what a device does), and the rule
erasing a property a runtime reads.

A corpus document is published with no such property (Nova's) and with the
five as the app settings save writes them: HQ's two builds differ by those
property elements alone, which the rule erases, and Core's sessions on both
compare equal as proof 3 compares them. With ``cc-fuzzy-search-enabled``
written as well, the traces differ, and the rule leaves it.

The save also stores the five in the app, with ``log_prop_weekly`` at
``log_short`` (``SAVED_WITH_WEEKLY``): the stored apps differ by those six
keys alone, which the rule erases, and HQ's build of the app holding
``log_short`` is the build of the app holding no ``log_prop_weekly``, profile
for profile. Stored at ``log_full``, the build writes another value, and the
rule leaves the stored key.
"""

from __future__ import annotations

from proof.rules.conftest import build_differences, edited, published, runs_alike, shown, stored_differences
from proof.rules.profile_unread_properties import BUILT_WHEN_ABSENT, RULE, UNREAD

DOCUMENT = "arithmetic"
SAVED = {
    "log_prop_daily": "log_never",
    "loose_media": "no",
    "purge-freq": "0",
    "restore-tolerance": "loose",
    "user_reg_server": "required",
}
SAVED_WITH_WEEKLY = {**SAVED, **BUILT_WHEN_ABSENT}


def _properties(values):
    return edited(lambda doc: doc.setdefault("profile", {}).setdefault("properties", {}).update(values))


def test_core_runs_a_build_alike_whatever_its_unread_profile_properties(rule_documents, hq, core_runner):
    assert set(SAVED) == UNREAD
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        saved = app.spell(doc=_properties(SAVED))
        fuzzy = app.spell(doc=_properties({**SAVED, "cc-fuzzy-search-enabled": "yes"}))
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build)
        _, _, read = runs_alike(app, core_runner, nova.build, fuzzy.build)

    built = shown(build_differences(nova.build, saved.build))
    assert built, "HQ built no unread property into the profile"
    assert all("property[@key=" in path and path.split("=")[1].rstrip("]") in UNREAD for _, path, _ in built), built
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert any("cc-fuzzy-search-enabled" in path for _, path, _ in shown(read)), shown(read)
    assert build_differences(nova.build, fuzzy.build, rules=(RULE,))


def test_a_stored_weekly_log_at_its_build_default_builds_as_none(rule_documents, hq):
    assert BUILT_WHEN_ABSENT == {"log_prop_weekly": "log_short"}
    with published(rule_documents[DOCUMENT], None) as app:
        nova = app.spell()
        weekly = app.spell(doc=_properties({"log_prop_weekly": "log_short"}))
        saved = app.spell(doc=_properties(SAVED_WITH_WEEKLY))
        full = app.spell(doc=_properties({"log_prop_weekly": "log_full"}))

    assert shown(build_differences(nova.build, weekly.build)) == []
    stored = shown(stored_differences(nova.stored, saved.stored))
    assert {path.rsplit("/", 1)[1] for _, path, _ in stored} == set(SAVED_WITH_WEEKLY), stored
    assert all(path.startswith("/profile/properties/") for _, path, _ in stored), stored
    assert stored_differences(nova.stored, saved.stored, rules=(RULE,)) == []
    assert any("log_prop_weekly" in path for _, path, _ in shown(build_differences(nova.build, full.build)))
    left = shown(stored_differences(nova.stored, full.stored, rules=(RULE,)))
    assert [path for _, path, _ in left] == ["/profile/properties/log_prop_weekly"], left
