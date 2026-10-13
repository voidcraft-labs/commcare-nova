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
- **Every search a worker can send.** A search screen's run branches as a
  list's does, a run for each way a worker sends the search (a script's
  choice ``{"search": <key>}``, with ``"prompts"`` where the worker changed
  them first): the prompts as the screen shows them, which carries each
  default as the client's Search sends it; ``"cleared"``, emptied by the
  screen's own Clear, where a default fills a prompt; and ``"typed"``, with
  the answer table's search answers typed in
  (``proof.formplayer.walk.search_ways``). A default keeps cases out of the
  list that a cleared search lists, and each case either lists is a run.
- **Every location the client can give.** The Web Apps client answers a
  location question with its map's centre (``entries.js::GeoPointEntry``),
  which a worker moves by dragging the map toward the answer table's place,
  so the place it gives is the one a drag of whole pixels brings the map to,
  never the table's place itself. The client gives it first, on the walk as
  derived; the walk is then derived again with each run's places
  (``Walk.places``), and a run that reached a form with one keeps them as
  its script's last choice, with the table's places the worker dragged
  toward to give each (``{"places": {<question index>: [<latitude>,
  <longitude>]}, "toward": {<question index>: [<the table's place>, ...]}}``),
  so every state's walk gives the client's own places and every replay of
  it makes the same drags. A drag aimed at the place a drag gave would not
  do: Leaflet rounds the map's pixel origin (``Map.js::_getNewPixelOrigin``),
  so its centre sits up to half a pixel from where the place it opened on
  projects, and an aim at a place a drag gave can fall on that half pixel
  and round the other way. A phone's map is laid out at another size,
  and a drag of the same pixels brings it to a place a fraction of a pixel
  away (Leaflet divides the pointer's travel by the map's own scale, its
  laid-out width over its whole pixels): where a phone's places differ, the
  run is walked again with them (``{"places": {...}, "toward": {...},
  "window": "small"}``), and the phone replays that run in its place.

Standard library only: the Android stage reads it outside the image.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, NamedTuple

# A script's choice of a language, made at the app's first screen.
LANGUAGE = "language"
# How a script's choice of a search fills the screen's prompts before its Search: left out, as the screen shows
# them; ``CLEARED``, emptied by the screen's own Clear; ``TYPED``, with the answer table's search answers typed in.
PROMPTS = "prompts"
CLEARED = "cleared"
TYPED = "typed"
# A script's last choice where its run reached a form with a location question: the place the client's map gave
# each one, by the question's index, and beside them (``TOWARD``) the answer table's places the worker dragged the
# map toward to give it, in order.
PLACES = "places"
TOWARD = "toward"
# Where a run's places are a window's own, the window (``"small"``, a phone's): the run that window replays in place
# of the one whose places are a desktop's.
WINDOW = "window"


class Places(NamedTuple):
    """The place the client's map gave each location question of each run, by the run (``run_key``) and the
    question's index: on a desktop, and on a phone where a phone's differ; and the answer table's places the
    worker dragged its map toward to give it (the same in every window)."""

    desktop: Mapping[str, Mapping[str, Any]]
    small: Mapping[str, Mapping[str, Any]]
    toward: Mapping[str, Mapping[str, Sequence[str]]]


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


def run_key(script: Sequence[Mapping[str, Any]]) -> str:
    """A run named by what it chose up to its form, but the places it gave there: the key its places are kept by."""
    import json

    return json.dumps(navigation(script), sort_keys=True)


def navigation(script: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """A script's choices a worker makes on the app's screens: all of them but the places it gave at its form."""
    return [choice for choice in script if PLACES not in choice]


def places_of(script: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    """The places a run gave its form's location questions (empty where it gave none)."""
    return next((choice[PLACES] for choice in script if PLACES in choice), {})


def places_choice(places: Mapping[str, Any], toward: Mapping[str, Sequence[str]], window: str | None = None) -> dict:
    """The script's last choice for a run that gives ``places``, dragged ``toward`` the table's, in ``window``."""
    choice: dict[str, Any] = {PLACES: dict(places), TOWARD: {ix: list(values) for ix, values in toward.items()}}
    if window is not None:
        choice[WINDOW] = window
    return choice


def window_of(script: Sequence[Mapping[str, Any]]) -> str | None:
    """The window whose places a run gave (None for a desktop's, and for a run that gave none)."""
    return next((choice.get(WINDOW) for choice in script if PLACES in choice), None)


def runs_for(runs: Sequence[Mapping[str, Any]], window: str | None) -> list[tuple[int, Mapping[str, Any]]]:
    """The runs a window replays, each with its place in the walk: a desktop's, every run but those given a
    phone's places; a window's own, its runs in place of those of the same choices given a desktop's."""
    own = {run_key(run["script"]) for run in runs if window is not None and window_of(run["script"]) == window}
    return [
        (index, run)
        for index, run in enumerate(runs)
        if window_of(run["script"]) == window
        or (window_of(run["script"]) is None and window is not None and run_key(run["script"]) not in own)
    ]
