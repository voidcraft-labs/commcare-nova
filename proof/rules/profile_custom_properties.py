"""The profile's ``custom_properties`` ``{}`` or unset.

Under ``CUSTOM_PROPERTIES`` HQ's app settings save writes
``profile.custom_properties`` ``{}`` plus what the page lists
(``views/settings.py::edit_commcare_profile``), where Nova writes no such
key. HQ's build copies the map into the profile it renders
(``models/applications.py::Application.create_profile``), and the template
writes the custom properties only where the map holds one
(``templates/app_manager/profile.xml``, ``{% if app_profile.
custom_properties %}``).

The rule removes ``custom_properties`` where it is ``{}``.
"""

from __future__ import annotations

from proof.rules import SpellingRule


def normalize(app):
    profile = app.get("profile") if isinstance(app, dict) else None
    if isinstance(profile, dict) and profile.get("custom_properties") == {}:
        del profile["custom_properties"]
    return app


RULE = SpellingRule(
    "profile-custom-properties",
    "app.json",
    "The profile's custom_properties {} or unset, which the profile template writes only when it holds one"
    " (templates/app_manager/profile.xml).",
    normalize,
)
