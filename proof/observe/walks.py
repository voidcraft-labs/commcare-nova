"""What every reader's walk of an app covers: each language the app holds, and each case a list offers.

Formplayer's walk (``proof.formplayer.walk``), the Web Apps client's replay
of it (``proof.webapps.observe``) and CommCare Android's walk
(``proof/android``) all take the same shape from here, so a judge compares
the same runs on every reader:

- **Every language.** A worker who never chose a language meets an app in
  the one the page starts in: Web Apps sends the worker's own language or,
  with none, the first one the app holds (``cloudcare/views.py::
  FormplayerMain.get_main``, ``request.couch_user.language or
  _default_lang()``), and Android starts in the app's default. Each other
  language the app holds is a run of its own for every run of the walk: the
  worker chooses it at the app's first screen (a script's first choice,
  ``{"language": <code>}``: Web Apps' own menu, ``menus/views.js::
  LanguageOptionView``, after which the client sends that locale on every
  request), then walks as before.
- **Every case.** At a list the walk opens each case it lists, not only the
  first. The case database is made so that no two cases of a type hold the
  same values (``proof.observe.casedata``: case ``n`` takes the ``n``-th value
  of every property, and the property with the most values gives every case
  its own), so each case of a list differs from every other in some property,
  and a form or a list that reads it can show the worker something else. A
  run is named by the case it chose (``{"entity": <case id>}``), so the runs
  of two states line up case by case.

Standard library only: the Android stage reads it outside the image.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

# A script's choice of a language, made at the app's first screen.
LANGUAGE = "language"


def default_language(languages: Sequence[str]) -> str | None:
    """The language a worker who never chose one meets the app in: the first one it holds (None for none)."""
    return languages[0] if languages else None


def chosen(languages: Sequence[str]) -> list[str]:
    """The languages a worker chooses, each a run of its own: every one the app holds but the default."""
    return list(dict.fromkeys(languages))[1:]


def in_every_language(
    scripts: Sequence[Sequence[Mapping[str, Any]]], languages: Sequence[str]
) -> list[list[Mapping[str, Any]]]:
    """Every run of a walk in every language: each script as derived (the default language), then each again
    for each other language, the language chosen first."""
    found = [list(script) for script in scripts]
    for language in chosen(languages):
        found.extend([{LANGUAGE: language}, *script] for script in scripts)
    return found


def language_of(script: Sequence[Mapping[str, Any]]) -> str | None:
    """The language a run chose, or None for a run in the default."""
    return script[0][LANGUAGE] if script and LANGUAGE in script[0] else None


def cases_opened(case_ids: Sequence[str]) -> list[str]:
    """The cases a walk opens at a list showing ``case_ids`` (in the list's order): every one of them."""
    return list(dict.fromkeys(case_ids))
