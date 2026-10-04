"""A built profile's property that no runtime reads.

HQ's app settings save writes every setting the page shows into
``profile.properties`` (``views/settings.py::edit_commcare_profile``), and
HQ's build writes each one it holds into the profile
(``models/applications.py::Application.create_profile``,
``templates/app_manager/profile.xml``). Five of them have no reader in any
runtime: ``log_prop_daily``, ``loose_media``, ``purge-freq``,
``restore-tolerance`` and ``user_reg_server`` appear in no source of
commcare-android, commcare-core or Formplayer at the pins (only in
Android's test fixtures), and Core installs a profile's properties as it
finds them without acting on these (``ProfileParser``,
``Profile.initializeProperties``). Proof 3 compares the properties a
runtime running both builds reads (``proof.checks.proof3.
PROFILE_PROPERTIES``), which these are not.

The rule removes a ``<property>`` with one of those keys from a profile HQ
builds (``profile.xml``, ``profile.ccpr``, ``media_profile.xml``,
``media_profile.ccpr``, and a build profile's own).
"""

from __future__ import annotations

from proof.rules import SpellingRule

UNREAD = frozenset({"log_prop_daily", "loose_media", "purge-freq", "restore-tolerance", "user_reg_server"})


def normalize(root):
    if not isinstance(getattr(root, "tag", None), str) or root.tag != "profile":
        return root
    for prop in [child for child in root if child.tag == "property" and child.get("key") in UNREAD]:
        root.remove(prop)
    return root


RULE = SpellingRule(
    "profile-unread-properties",
    (
        "profile.xml",
        "profile.ccpr",
        "media_profile.xml",
        "media_profile.ccpr",
        "*/profile.xml",
        "*/profile.ccpr",
        "*/media_profile.xml",
        "*/media_profile.ccpr",
    ),
    "A built profile's log_prop_daily, loose_media, purge-freq, restore-tolerance or user_reg_server, which no"
    " runtime reads.",
    normalize,
)
