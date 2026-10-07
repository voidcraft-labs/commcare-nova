"""Formplayer's walk: the same inputs give the same bytes, and a trace shows exactly what differs.

Contracts (``proof.formplayer.walk``, ``proof.formplayer.canonical``):

- **The same inputs give the same bytes.** Two walks of one build over one
  restore give one canonical trace, though Formplayer draws fresh session ids
  each time and the second walk meets an app Formplayer already installed.
  Plausible failure: an id or an install-dependent field left unmarked, or a
  run that saw the cases an earlier run's submission made.
- **A script replays.** The script a derived walk ran, replayed, gives the
  derived trace's runs. Plausible failure: a replay that reads its choices
  out of step with the screens (a search, an action).
- **A trace is faithful.** Two builds that differ in one thing Formplayer
  reads give traces that differ exactly there. Plausible failure: a walk
  that summarizes Formplayer's answers and loses the difference, or one
  whose runs differ where the builds do not.

The document has a case list, a case detail, a form that writes a case and a
second menu (``case-operation-query``); the two builds are the search
description's (``search-browse``, finding 54).
"""

from __future__ import annotations

from proof.formplayer import apps, canonical
from proof.formplayer.walk import screen_kind, script_of


def _differences(before, after, path=""):
    """The JSON paths at which two values differ."""
    if type(before) is not type(after):
        return [path]
    if isinstance(before, dict):
        found = []
        for key in sorted(set(before) | set(after)):
            if key not in before or key not in after:
                found.append(f"{path}/{key}")
            else:
                found += _differences(before[key], after[key], f"{path}/{key}")
        return found
    if isinstance(before, list):
        if len(before) != len(after):
            return [path]
        return [d for index, pair in enumerate(zip(before, after, strict=True)) for d in _differences(*pair, f"{path}/{index}")]
    return [] if before == after else [path]


def _at(value, path):
    for part in path.split("/")[1:]:
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def test_two_walks_of_one_build_give_one_trace_and_its_script_replays(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    with apps.published(formplayer_documents["case-operation-query"], core_runner) as published:
        session = apps.installed(published)
        first = apps.walked(formplayer_runner, session)
        second = apps.walked(formplayer_runner, session)
        # The walk reached what the document holds: a list, a detail, a submitted form.
        kinds = {screen_kind(step.get("response")) for run in first["runs"] for step in run["steps"]}
        assert {"commands", "entities", "form"} <= kinds
        assert "submitted" in {run["end"] for run in first["runs"]}
        assert first["generated"] > 0
        assert canonical.encode(first) == canonical.encode(second)

        replayed = apps.walked(formplayer_runner, session, script_of(first))
        assert replayed["derived"] is False
        assert canonical.encode(replayed["runs"]) == canonical.encode(first["runs"])


def test_two_builds_that_differ_in_one_reading_give_traces_that_differ_exactly_there(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    with apps.published(formplayer_documents["search-browse"], core_runner) as published:

        def save_empty_description(doc):
            (module,) = [module for module in doc["modules"] if module["search_config"]["properties"]]
            module["search_config"]["description"] = {"en": ""}

        saved = apps.spelled(published, save_empty_description)
        nova = apps.installed(published)
        other = apps.installed(published, saved.files)
        before = apps.walked(formplayer_runner, nova)
        after = apps.walked(formplayer_runner, other)
        differing = _differences(before, after)
        # Each build's own id and the app's version (every save of an app in HQ moves it on), which every answer
        # names, and the search description, which the search screens do.
        named = {path.rsplit("/", 1)[1] for path in differing}
        assert named == {"appId", "appVersion", "description"}
        # The description differs wherever Formplayer answers with the search screen: as the screen itself, and
        # as the screen a list of results carries (``EntityListResponse.queryResponse``), and reads there as each
        # build holds it.
        descriptions = [path for path in differing if path.endswith("/description")]
        screens = [
            step for run in before["runs"] for step in run["steps"] if screen_kind(step.get("response")) == "query"
        ]
        assert screens and len(descriptions) >= len(screens)
        assert {(_at(before, path), _at(after, path)) for path in descriptions} == {("", "\u00a0")}
