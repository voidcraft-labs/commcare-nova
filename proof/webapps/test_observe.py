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
- **Every run is replayed on a desktop and on a phone, in every language
  the app holds, for every case of a list**, and the client submits what
  Formplayer's walk submitted (``observe.submitted_alike`` raises
  otherwise). The plausible failures are a replay that never chooses the
  language (its screens the default's), a list whose later cases are not
  walked, a phone's list whose later page is never turned to, and a walk
  that submits what no worker in Web Apps can.
- **Every run is replayed in App Preview too**, the page HQ's app builder
  shows the app in, for the project space's admin, who logs in as the
  worker there and steps each form forward one question a screen by its
  own Next. The plausible failures are a preview that never logs in as the
  worker (its lists empty), an answer given before its question is on the
  screen, and a form submitted before its last screen.
- **A choice the replay has no click for is refused by name**, never
  skipped, so a walk that grows a new kind of choice ends the observation
  instead of thinning it.
"""

from __future__ import annotations

import json

import pytest

from proof.observe import walks
from proof.webapps import hq as webapps_hq
from proof.webapps import observe
from proof.webapps import steps as steps_module

# Each document, and whether some run of its walk reaches a form (the second is a case list with no form; the
# third holds two languages and a case list).
DOCUMENTS = (("targeted-custom-tile", True), ("case-list-browse", False), ("localization-bilingual", True))


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
            walk = Walk.of(release)
            walked = walk.run()
            first = observe.shown(release, editor_driver, walked)
            second = observe.observe(release, editor_driver)
    evidence("observation", first)
    assert first["runs"], "Formplayer's walk of the build made no run, so there is nothing a worker reaches."
    desktop = [run for run in first["runs"] if "viewport" not in run]
    small = [run for run in first["runs"] if run.get("viewport") == observe.SMALL]
    preview = [run for run in first["runs"] if run.get("viewport") == observe.PREVIEW]
    assert len(desktop) == len(small) == len(preview) == len(walked["runs"])
    assert len(first["runs"]) == 3 * len(walked["runs"])
    assert [run["script"] for run in small] == [run["script"] for run in preview] == [run["script"] for run in desktop]
    for run, each in [
        *zip(desktop, walked["runs"], strict=True),
        *zip(small, walked["runs"], strict=True),
        *zip(preview, walked["runs"], strict=True),
    ]:
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
    # Every case each list shows is walked, each in a run of its own, and every language the app holds.
    # A row is the element the client draws for its case, ``row-<case id>`` (``partials/case_list``).
    lists = {
        tuple(sorted(row["id"].removeprefix("row-") for row in screen["list"]["rows"]))
        for run in desktop
        for screen in run["screens"]
        # A search screen beside its list (a desktop's) draws its prompts as rows of its own.
        if isinstance(screen.get("list"), dict) and screen["list"].get("rows") and "query" not in screen
    }
    for listed in lists:
        chosen = {choice["entity"] for run in walked["runs"] for choice in run["script"] if "entity" in choice}
        assert set(listed) <= chosen, (listed, chosen)
    languages = release.languages
    in_languages = {walks.language_of(run["script"]) for run in walked["runs"]}
    assert in_languages == {None, *languages[1:]}, (in_languages, languages)


def test_a_choice_the_replay_has_no_click_for_is_refused_and_a_known_one_is_replayed():
    known = {"script": [{"menu": 1}], "steps": [{"request": {}, "response": {"type": "commands"}}]}
    replayed = observe.clicks(known)
    assert replayed[0]["arg"]["selector"].endswith("tr:nth-child(2)")
    unknown = {"script": [{"swipe": "left"}], "steps": [{"request": {}, "response": {"type": "commands"}}]}
    with pytest.raises(observe.Unreplayable, match="swipe"):
        observe.clicks(unknown)


def test_a_language_is_chosen_from_the_menu_and_a_later_page_is_turned_to_on_a_phone():
    """A language choice opens the menu over the app's screens and clicks that language; on a phone a case past
    the fifth of its list is reached by its page's button, and on a desktop by its row alone."""
    run = {
        "script": [{"language": "es"}, {"menu": 0}, {"entity": "c7"}],
        "steps": [
            {"request": {"selections": []}, "response": {"type": "commands"}},
            {"request": {"selections": []}, "response": {"type": "commands"}},
            {
                "request": {"selections": ["0"]},
                "response": {"type": "entities", "entities": [{"id": f"c{n}"} for n in range(1, 9)]},
            },
            {"request": {"selections": ["0", "c7"]}, "response": {"type": "commands"}},
        ],
    }
    selectors = lambda made: [step["arg"]["selector"] for step in made if step.get("until") == "webapps/click"]  # noqa: E731
    desktop, phone = selectors(observe.clicks(run)), selectors(observe.plan(run, small=True)[0])
    assert desktop[:2] == [steps_module.MENU_DROPDOWN, steps_module.LANGUAGE_OPTION.format("es")]
    assert steps_module.PAGE.format(1) in phone and steps_module.PAGE.format(1) not in desktop
    assert desktop[-1] == phone[-1] == "#menu-region [id='row-c7']"


def test_app_preview_logs_in_as_the_worker_and_brings_each_question_on_screen_before_answering_it():
    """In App Preview a run starts from the app's own first screen: Log in as, the worker's row, the confirmation,
    the app's first language set in Settings, then Start; each question is brought onto the screen by the form's
    Next before its answer, and the form to its last screen before Complete. On Web Apps' own page none of that is
    done."""
    run = {
        "script": [{"menu": 0}],
        "steps": [
            {"request": {"selections": []}, "response": {"type": "commands"}},
            {"request": {"selections": ["0"]}, "response": {"type": "form", "tree": []}},
            {"answers": [{"ix": "0", "value": "a"}, {"ix": "1", "value": "b"}], "submitted": {}},
        ],
    }
    preview, kinds = observe.replay("App", [run], "/home", preview_as="worker", preview_language="en")
    desktop, _ = observe.replay("App", [run], "/home")
    clicked = [step["arg"]["selector"] for step in preview if step.get("until") == "webapps/click"]
    assert clicked[:6] == [
        steps_module.LOG_IN_AS,
        steps_module.USER_ROW.format("worker"),
        steps_module.CONFIRM,
        steps_module.SETTINGS,
        steps_module.SETTINGS_DONE,
        steps_module.START_APP,
    ]
    # App Preview opens in the person's own language; the app's first is set before the run.
    assert [step["arg"]["value"] for step in preview if step.get("until") == "pages/choose"] == ["en"]
    advances = [step["arg"]["ix"] for step in preview if step.get("advance")]
    assert advances == ["0", "1", None]
    answered = [step["arg"]["ix"] for step in preview if step.get("until") == "webapps/answer"]
    assert answered == ["0", "1"]
    # Each answer comes after the Next that brings its question on, and Complete after the last.
    order = [
        ("advance" if step.get("advance") else "answer", step["arg"]["ix"])
        for step in preview
        if step.get("advance") or step.get("until") == "webapps/answer"
    ]
    assert order == [("advance", "0"), ("answer", "0"), ("advance", "1"), ("answer", "1"), ("advance", None)]
    submits = [step["arg"] for step in preview if step.get("until") == "webapps/submit"]
    assert submits == [{"complete": True}]
    assert [kind for kind in kinds if kind and kind[0] == "held"] == [("held", 0, 0), ("held", 0, 1), ("held", 0, None)]
    assert not [step for step in desktop if step.get("advance")]
    assert steps_module.LOG_IN_AS not in [(step.get("arg") or {}).get("selector") for step in desktop]


def test_app_preview_chooses_a_language_in_its_settings_and_web_apps_from_its_menu():
    """In App Preview a language is chosen as a person there chooses it (the app's first screen, Settings, the
    language, Done, Start); on Web Apps' own page, from the menu over the app's screens."""
    run = {
        "script": [{"language": "fra"}, {"menu": 0}],
        "steps": [
            {"request": {"selections": []}, "response": {"type": "commands"}},
            {"request": {"selections": []}, "response": {"type": "commands"}},
            {"request": {"selections": ["0"]}, "response": {"type": "commands"}},
        ],
    }
    preview = observe.plan(run, preview=True)[0]
    desktop = observe.plan(run)[0]
    clicked = [step["arg"]["selector"] for step in preview if step.get("until") == "webapps/click"]
    assert clicked[:4] == [steps_module.HOME, steps_module.SETTINGS, steps_module.SETTINGS_DONE, steps_module.START_APP]
    chosen = [step["arg"] for step in preview if step.get("until") == "pages/choose"]
    assert chosen == [{"selector": steps_module.LANGUAGE_SETTING, "value": "fra"}]
    assert steps_module.MENU_DROPDOWN not in clicked
    assert [step["arg"]["selector"] for step in desktop if step.get("until") == "webapps/click"][0] == (
        steps_module.MENU_DROPDOWN
    )
