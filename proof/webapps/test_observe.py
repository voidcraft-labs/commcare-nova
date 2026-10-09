"""A document's Web Apps observation (``proof.webapps.observe``): whole, replayable and the same on every run.

Contracts:

- **Every run of Formplayer's walk is replayed whole, and the page is read
  after every step that leads somewhere.** The record holds, per run, the
  app's first screen, one screen per choice (and a case's detail where the
  client opens one), and, where the walk reached a form, the form as the
  worker leaves it, answered through its widgets, and the screen Submit
  lands on. Each step waits for the client's own arrival where it leads,
  never a time, so a screen is never read before the client drew it. The
  plausible failures are a replay that reads ahead of the client (the
  screen before the choice read twice), a detail's Continue clicked while
  the dialog is still opening (Bootstrap ignores it, and the dialog stays
  over every later screen), or a run cut short.
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
    from proof.formplayer.walk import Walk

    with webapps_hq.project(webapps_documents[document]) as project:
        with project.released(formplayer_runner) as release:
            walk = Walk(release.runner, release.hq, domain=release.domain, app_id=release.build_id, scope=release.run)
            walked = walk.run()
            first = observe.shown(release, editor_driver, walked)
            second = observe.observe(release, editor_driver)
    evidence("observation", first)
    assert first["runs"], "Formplayer's walk of the build made no run, so there is nothing a worker reaches."
    for run, each in zip(first["runs"], walked["runs"], strict=True):
        assert "stopped" not in run, run
        assert len(run["screens"]) == observe._expected_screens(each)
        # The app's first screen is its menu, and no two screens in a row are the same screen read twice.
        assert "commands" in run["screens"][0]
        for before, after in zip(run["screens"], run["screens"][1:], strict=False):
            assert before != after
        assert not any(screen.get("detail") and screen.get("form") for screen in run["screens"])
    assert _canonical(first) == _canonical(second)
    # Where the walk reaches a form, the client shows it, the worker answers it through its widgets and submits
    # it, and the screen the client lands on is no longer that form.
    reached = [run for run in first["runs"] if any("form" in screen for screen in run["screens"])]
    assert bool(reached) is reaches_a_form
    for run in reached:
        assert run["submit"] == "submitted", run
        assert run["answers"] and all(said == "answered" for said in run["answers"]), run["answers"]
        assert "form" in run["screens"][-2] and "form" not in run["screens"][-1]


def test_a_choice_the_replay_has_no_click_for_is_refused_and_a_known_one_is_replayed():
    known = {"script": [{"menu": 1}], "steps": [{"request": {}, "response": {"type": "commands"}}]}
    replayed = observe.clicks(known)
    assert replayed[0]["arg"]["selector"].endswith("tr:nth-child(2)")
    unknown = {"script": [{"swipe": "left"}], "steps": [{"request": {}, "response": {"type": "commands"}}]}
    with pytest.raises(observe.Unreplayable, match="swipe"):
        observe.clicks(unknown)
