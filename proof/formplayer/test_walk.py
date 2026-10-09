"""Formplayer's walk: the same inputs give the same bytes, and a script replays.

Contracts (``proof.formplayer.walk``, ``proof.formplayer.canonical``), on a
release HQ's own views serve to Formplayer (``proof.formplayer.hq``):

- **The same inputs give the same bytes.** Two walks of one served state
  give one canonical trace, though Formplayer draws fresh session ids each
  time and the second walk meets an app Formplayer already installed.
  Plausible failure: an id or an install-dependent field left unmarked, or a
  run that saw the cases an earlier run's submission made.
- **A script replays.** The script a derived walk ran, replayed, gives the
  derived trace's runs. Plausible failure: a replay that reads its choices
  out of step with the screens (a search, an action).

That a trace shows exactly where two states differ is
``proof/checks/test_served.py``'s planted difference.

The document has a case list, a case detail, a form that writes a case and a
second menu (``case-operation-query``).
"""

from __future__ import annotations

from proof.formplayer import apps, canonical
from proof.formplayer.walk import screen_kind, script_of


def test_two_walks_of_one_build_give_one_trace_and_its_script_replays(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    with apps.published(formplayer_documents["case-operation-query"], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            first = apps.walked(formplayer_runner, served)
            second = apps.walked(formplayer_runner, served)
            replayed = apps.walked(formplayer_runner, served, script_of(first))
        # The walk reached what the document holds: a list, a detail, a submitted form.
        kinds = {screen_kind(step.get("response")) for run in first["runs"] for step in run["steps"]}
        assert {"commands", "entities", "form"} <= kinds
        assert "submitted" in {run["end"] for run in first["runs"]}
        assert first["generated"] > 0
        assert canonical.encode(first) == canonical.encode(second)

        assert replayed["derived"] is False
        assert canonical.encode(replayed["runs"]) == canonical.encode(first["runs"])
