"""A menu media map that holds no path, written ``{}`` or with ``""`` for each language.

HQ's module and form settings saves write each menu media map from the
page's fields, a language with no file as ``""``
(``views/media_utils.py::handle_media_edits``, called by
``views/modules.py::edit_module_attr`` and ``views/forms.py``), where Nova
writes ``{}``: a module's and a form's
``media_image`` and ``media_audio``, and those of the module's case list
menu item (``case_list``) and of its registration action from the case list
(``case_list_form``). HQ reads each map through
``NavMenuItemMediaMixin._get_media_by_language``, which answers None for
``{}``, and for a map whose every value is ``""`` answers ``""`` (the
language's value, or the first value), and every caller reads that answer
as "no media" (``app_strings.py`` and the suite's menus and entries test it
before they write a reference). A map that holds a path in any language is
another matter: a ``""`` beside it changes which path the fallback finds,
so the rule leaves it.

The rule makes each of those maps ``{}`` where every value it holds is
``""``.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import blank_to_empty, forms, modules

_MEDIA = ("media_image", "media_audio")


def normalize(app):
    for module in modules(app):
        holders = [module, *forms(module)]
        holders += [module[key] for key in ("case_list", "case_list_form") if isinstance(module.get(key), dict)]
        for holder in holders:
            for key in _MEDIA:
                blank_to_empty(holder, key)
    return app


RULE = SpellingRule(
    "empty-media-maps",
    "app.json",
    'A menu media map holding no path, {} or "" for each language, which HQ reads as no media'
    " (models/mixins.py::NavMenuItemMediaMixin._get_media_by_language).",
    normalize,
)
