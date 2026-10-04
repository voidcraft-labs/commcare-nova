"""The app's add-on switches (``add_ons``), which no build step reads.

HQ's add-ons save writes every add-on the page shows, ``false`` for each
it shows off (``views/apps.py::edit_add_ons``, from
``add_ons.py::get_dict``), where Nova writes the ones it uses: the slugs
Nova leaves out are added as ``false``, and an add-on the project's
privileges do not grant reads as off on the page and is written ``false``
(``add_ons.py::show`` answers false without the privilege before it reads
``app.add_ons``). Only HQ's app-manager pages read ``add_ons``, through
``add_ons.show`` and ``get_dict`` (``views/view_generic.py``,
``views/modules.py``, ``views/formdesigner.py``); no build step, validator
or runtime reads it, so what HQ builds from the app is the same whatever it
holds. What an add-on changes in HQ's editors shows in proof 4 through the
saves those editors make.

The rule removes ``add_ons`` from HQ's app document.
"""

from __future__ import annotations

from proof.rules import SpellingRule


def normalize(app):
    if isinstance(app, dict):
        app.pop("add_ons", None)
    return app


RULE = SpellingRule(
    "add-ons",
    "app.json",
    "The app's add_ons, which only HQ's app-manager pages read (add_ons.py::show, get_dict).",
    normalize,
)
