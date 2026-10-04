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
"""

from __future__ import annotations

from proof.rules.conftest import build_differences, edited, published, runs_alike, shown
from proof.rules.profile_unread_properties import RULE, UNREAD

DOCUMENT = "arithmetic"
SAVED = {
    "log_prop_daily": "log_never",
    "loose_media": "no",
    "purge-freq": "0",
    "restore-tolerance": "loose",
    "user_reg_server": "required",
}


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
