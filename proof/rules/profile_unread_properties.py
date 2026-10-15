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

The same save stores them in the app (``profile.properties`` of
``app.json``), beside a sixth: ``log_prop_weekly`` at ``log_short``. HQ's
build writes ``log_prop_weekly`` ``log_short`` where the app holds no value
for it, since its ``commcare_default`` differs from its ``default``
(``Application.create_profile``, over
``static/app_manager/json/commcare-profile-settings.yml``), so a stored
``log_short`` and no value build the same profile. Nova writes none of the
six.

The rule removes a ``<property>`` with one of the five keys from a profile
HQ builds (``profile.xml``, ``profile.ccpr``, ``media_profile.xml``,
``media_profile.ccpr``, and a build profile's own), and from the stored
app's ``profile.properties`` the five and ``log_prop_weekly`` where it is
``log_short``.
"""

from __future__ import annotations

from proof.rules import SpellingRule

UNREAD = frozenset({"log_prop_daily", "loose_media", "purge-freq", "restore-tolerance", "user_reg_server"})
# A stored setting HQ's build writes at this value where the app holds none.
BUILT_WHEN_ABSENT = {"log_prop_weekly": "log_short"}


def normalize(root):
    if isinstance(root, dict):
        profile = root.get("profile")
        properties = profile.get("properties") if isinstance(profile, dict) else None
        if isinstance(properties, dict):
            for key in [key for key in properties if key in UNREAD or BUILT_WHEN_ABSENT.get(key) == properties[key]]:
                del properties[key]
        return root
    if not isinstance(getattr(root, "tag", None), str) or root.tag != "profile":
        return root
    for prop in [child for child in root if child.tag == "property" and child.get("key") in UNREAD]:
        root.remove(prop)
    return root


RULE = SpellingRule(
    "profile-unread-properties",
    (
        "app.json",
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
    " runtime reads, and the same five stored in the app with log_prop_weekly at log_short, which HQ's build writes"
    " where the app holds none.",
    normalize,
)
