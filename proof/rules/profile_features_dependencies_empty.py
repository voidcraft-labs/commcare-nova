"""The profile's ``dependencies`` feature as an empty list or unset, which HQ's profile writes as no dependencies.

HQ's app settings page posts every setting it shows, and a multi-select it
shows empty posts ``[]`` (``app_manager/js/settings/bootstrap5/commcare_settings.js``,
``valueToSave``), so in a project space holding App Dependencies a save of the
page writes ``profile.features.dependencies`` ``[]`` where Nova, for an app
that requires no Android app, writes no key
(``views/settings.py::edit_commcare_profile``). HQ's profile template writes
``<dependencies>`` only for a non-empty list (``templates/app_manager/profile.xml``,
``{% if app_profile.features.dependencies.value %}``), and its app strings name
each listed app (``app_strings.py::_create_dependencies_app_strings``), so an
empty list and no key build alike.

Nova's publish over such a save, which owns the list and writes none, leaves HQ
holding an empty ``features``, which the template's loop over the features
also writes as nothing. The rule removes ``dependencies`` where it is an empty
list, and then ``features`` where it holds nothing.
"""

from __future__ import annotations

from proof.rules import SpellingRule


def normalize(app):
    profile = app.get("profile") if isinstance(app, dict) else None
    features = profile.get("features") if isinstance(profile, dict) else None
    if not isinstance(features, dict):
        return app
    if features.get("dependencies") == []:
        del features["dependencies"]
    if not features:
        del profile["features"]
    return app


RULE = SpellingRule(
    "profile-features-dependencies-empty",
    "app.json",
    "The profile's dependencies feature as an empty list or unset, which the profile template writes as no"
    " dependencies (templates/app_manager/profile.xml).",
    normalize,
)
