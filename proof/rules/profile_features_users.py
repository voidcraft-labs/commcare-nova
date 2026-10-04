"""The profile's ``users`` feature ``"true"`` or unset, which HQ's profile writes as ``true`` either way.

HQ's app settings save writes ``profile.features.users`` ``"true"`` from the
page (``views/settings.py::edit_commcare_profile``), where Nova writes no
``features``. HQ's profile template writes ``<users active="...">`` from
that feature's value with ``true`` as its default, and its loop over the
other features leaves ``users`` out (``templates/app_manager/profile.xml``;
``models/applications.py::Application.create_profile`` gathers the
features it reads).

The rule removes the ``users`` feature where it is ``"true"``, and
``features`` where that removal leaves nothing in it.
"""

from __future__ import annotations

from proof.rules import SpellingRule


def normalize(app):
    profile = app.get("profile") if isinstance(app, dict) else None
    features = profile.get("features") if isinstance(profile, dict) else None
    if not isinstance(features, dict):
        return app
    if features.get("users") == "true":
        del features["users"]
        if not features:
            del profile["features"]
    return app


RULE = SpellingRule(
    "profile-features-users",
    "app.json",
    'The profile\'s users feature "true" or unset, which the profile template writes as true'
    " (templates/app_manager/profile.xml).",
    normalize,
)
