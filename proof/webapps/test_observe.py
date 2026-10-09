"""A document's Web Apps observation (``proof.webapps.observe``): whole, replayable and the same on every run.

Contracts:

- **Every run of Formplayer's walk is replayed, and the page is read after
  every click.** The record holds, per run, the app's first screen and one
  screen per choice, and each screen is the one Formplayer's walk reached:
  where the walk's run ended at a form, the last screen shows that form. The
  plausible failure is a replay that clicks ahead of the client (a screen
  read before the click's answer rendered would repeat the screen before
  it) or skips a run.
- **The same inputs give the same bytes.** Two observations of one released
  build, each from a fresh page and a worker who cleared their data, are
  equal as canonical JSON: the record holds no id Formplayer drew, no time
  and no path. The plausible failure is a value the page writes from its
  clock or an id drawn outside an operation reaching a screen.
- **A choice the replay has no click for is refused by name**, never
  skipped, so a walk that grows a new kind of choice ends the observation
  instead of thinning it.
"""

from __future__ import annotations

import json

import pytest

from proof.webapps import hq as webapps_hq
from proof.webapps import observe

# Each document, and whether some run of its walk reaches a form (the second is a case list with no form).
DOCUMENTS = (("targeted-custom-tile", True), ("case-list-browse", False))


def _canonical(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


@pytest.mark.under_determinism
@pytest.mark.parametrize(("document", "reaches_a_form"), DOCUMENTS, ids=[name for name, _ in DOCUMENTS])
def test_a_documents_web_apps_observation_reads_every_screen_of_the_walk_and_is_the_same_twice(
    document, reaches_a_form, hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents[document]) as project:
        with project.released(formplayer_runner) as release:
            first = observe.observe(release, editor_driver)
            second = observe.observe(release, editor_driver)
    evidence("observation", first)
    assert first["runs"], "Formplayer's walk of the build made no run, so there is nothing a worker reaches."
    for run in first["runs"]:
        assert len(run["screens"]) == 1 + len(run["script"])
        # The app's first screen is its menu, and no two screens in a row are the same screen read twice.
        assert "commands" in run["screens"][0]
        for before, after in zip(run["screens"], run["screens"][1:], strict=False):
            assert before != after
    assert _canonical(first) == _canonical(second)
    # Where the walk reaches a form, the client shows that form.
    assert any("form" in run["screens"][-1] for run in first["runs"]) is reaches_a_form


def test_a_choice_the_replay_has_no_click_for_is_refused_and_a_known_one_is_replayed():
    known = {"script": [{"menu": 1}], "steps": [{"request": {}, "response": {"type": "commands"}}]}
    replayed = observe.clicks(known)
    assert replayed[0]["arg"]["selector"].endswith("tr:nth-child(2)")
    unknown = {"script": [{"swipe": "left"}], "steps": [{"request": {}, "response": {"type": "commands"}}]}
    with pytest.raises(observe.Unreplayable, match="swipe"):
        observe.clicks(unknown)
