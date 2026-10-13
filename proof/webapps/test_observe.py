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
- **The replay goes on wherever a worker goes on.** A search is sent the
  way the walk sent it (as shown, cleared by the screen's Clear, or typed
  into its prompts, a refused answer typed again), a question the walk
  cleared is cleared through its widget, a repetition the walk added is
  added by the repeat's own Add, and a form App Preview's one-question
  screens cannot carry to its end is replayed with the form shown whole, as
  a person there shows it. The plausible failure is a run that both states
  end early alike, at a place a worker would get past, so every comparison
  of it passes with the rest unseen.
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
    # Nothing is read or clicked in App Preview before it has finished starting (Formplayer's answer to the
    # client's refresh of the app, then the client's own arrival): a Log in as clicked earlier had its list of
    # workers drawn over by the first screen. Web Apps' own page reads its first screen at once.
    assert preview[0] == {"awaitRequest": {"method": "POST", "pathname": steps_module.REFRESH}}
    assert preview.index(steps_module.SCREEN) > 1 and desktop[0] == steps_module.SCREEN
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


def _search_run(choice, *steps, end):
    """A run whose first screen is a search (two prompts, the first holding a default), then ``steps``."""
    displays = [{"id": "name", "value": "Ana", "input": None}, {"id": "village", "value": None, "input": None}]
    opened = {"type": "query", "queryKey": "k", "displays": displays, "selections": ["0"]}
    return {
        "script": [{"menu": 0}, choice],
        "steps": [
            {"request": {"selections": []}, "response": {"type": "commands"}},
            {"request": {"selections": ["0"]}, "response": opened},
            *steps,
        ],
        "end": end,
    }


def _clicked(made):
    return [step["arg"]["selector"] for step in made if step.get("until") == "webapps/click"]


def test_a_search_is_replayed_as_the_walk_sent_it_shown_cleared_or_typed():
    """Each search a walk sends is one a worker can send, and the replay makes it the worker's way: Search
    alone for the prompts as shown, the screen's Clear first for the prompts emptied, and each prompt the walk
    typed filled in the walk's order, one it retyped (the screen refused the first answer) filled again."""
    sent = {"request": {"selections": ["0"], "query_data": {"k": {"execute": True}}}, "response": {"type": "entities"}}
    shown = observe.clicks(_search_run({"search": "k"}, sent, end="empty-list"))
    assert _clicked(shown)[-1] == steps_module.SEARCH_BUTTON
    assert steps_module.CLEAR_BUTTON not in _clicked(shown)
    assert not [step for step in shown if step.get("until") == "webapps/prompt"]

    cleared = observe.clicks(_search_run({"search": "k", "prompts": "cleared"}, sent, end="empty-list"))
    assert _clicked(cleared)[-2:] == [steps_module.CLEAR_BUTTON, steps_module.SEARCH_BUTTON]

    def validating(prompt, inputs):
        asked = {"k": {"inputs": inputs, "execute": False}}
        return {"request": {"selections": ["0"], "query_data": asked, "validating": prompt}, "response": {}}

    typed = observe.clicks(
        _search_run(
            {"search": "k", "prompts": "typed"},
            validating("name", {"name": "proof"}),
            validating("village", {"name": "proof", "village": "proof"}),
            validating("village", {"name": "proof", "village": "Proof"}),
            sent,
            end="empty-list",
        )
    )
    filled = [step["arg"] for step in typed if step.get("until") == "webapps/prompt"]
    assert filled == [
        {"index": 0, "value": "proof"},
        {"index": 1, "value": "proof"},
        {"index": 1, "value": "Proof"},
    ]
    assert _clicked(typed)[-1] == steps_module.SEARCH_BUTTON


def test_a_search_the_client_keeps_back_is_pressed_and_its_refusal_is_the_searchs_outcome():
    """Where the walk holds that the client sends nothing (a required prompt left empty), Search is pressed all
    the same and the step waits for the client's own refusal, never for an arrival the walk did not make."""
    unsent = {"unsent": {"search": "k", "inputs": {}, "prompts": ["village"]}}
    made, kinds = observe.plan(_search_run({"search": "k"}, unsent, end="search-refused"))
    [refusal] = [step for step in made if step.get("until") == "webapps/arrived" and step["arg"].get("search")]
    assert refusal["arg"]["queryData"] == {"k": {"execute": True}} and refusal["arg"]["selections"] == ["0"]
    assert kinds[made.index(refusal)] == ("search",)


def test_a_cleared_answer_and_a_repeats_add_are_replayed_through_the_forms_own_widgets():
    """A question the walk cleared (the form refused every answer) is cleared through its widget, and a
    repetition the walk added is added by the repeat's own Add, by its place among the Adds the form shows."""
    add = {"type": "sub-group", "repeatable": "true", "exists": "false", "ix": "1_0"}
    tree = [{"type": "question", "ix": "0", "datatype": "str"}, add]
    run = {
        "script": [{"menu": 0}],
        "steps": [
            {"request": {"selections": []}, "response": {"type": "commands"}},
            {"request": {"selections": ["0"]}, "response": {"type": "form", "tree": tree}},
            {
                "answers": [
                    {"ix": "0", "value": "proof", "response": {"status": "validation-error"}},
                    {"ix": "0", "value": None, "response": {"status": "accepted", "tree": tree}},
                    {"ix": "1_0", "repeat": "add", "response": {"tree": tree}},
                ],
                "submitted": {},
            },
        ],
    }
    made = observe.clicks(run)
    answered = [step["arg"] for step in made if step.get("until") == "webapps/answer"]
    assert [(arg["ix"], arg["value"]) for arg in answered] == [("0", "proof"), ("0", None)]
    assert [step["arg"] for step in made if step.get("until") == "webapps/repeat"] == [{"index": 0}]


def test_app_preview_shows_a_form_whole_once_the_person_switches_one_question_per_screen_off():
    """With its forms shown whole, App Preview's replay switches "Use one question per screen" off in Settings
    after the language, before Start, and then answers and submits the form as Web Apps' own page does: no Next,
    and Submit in place of Complete."""
    run = {
        "script": [{"menu": 0}],
        "steps": [
            {"request": {"selections": []}, "response": {"type": "commands"}},
            {"request": {"selections": ["0"]}, "response": {"type": "form", "tree": []}},
            {"answers": [{"ix": "0", "value": "a"}], "submitted": {}},
        ],
    }
    whole, kinds = observe.replay("App", [run], "/home", preview_as="worker", preview_language="en", preview_whole=True)
    assert _clicked(whole)[3:9] == [
        steps_module.SETTINGS,
        steps_module.SETTINGS_DONE,
        steps_module.SETTINGS,
        steps_module.ONE_QUESTION_SETTING,
        steps_module.SETTINGS_DONE,
        steps_module.START_APP,
    ]
    assert not [step for step in whole if step.get("advance")]
    assert [step["arg"] for step in whole if step.get("until") == "webapps/submit"] == [{"complete": False}]
    assert not [kind for kind in kinds if kind and kind[0] == "held"]
    # Each screen is placed by the choice it follows, and the form's two by the form.
    assert [kind[2:] for kind in kinds if kind and kind[0] == "screen"] == [(), (0,), ("form",), ("form",)]


def test_app_preview_replays_whole_a_form_its_one_question_screens_cannot_carry_to_its_end(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    """A form with a repeat a worker adds to (``case-capture-repeat``). Shown one question a screen, Formplayer
    answers the Next that reaches the repeat with an error, which is where that way of showing the form ends; a
    person in App Preview switches "Use one question per screen" off, so the run is replayed with the form shown
    whole. Its record keeps where the one-question form ended, and the whole replay follows the walk to its end
    as a desktop's and a phone's do: the repetition added by the repeat's own Add, each answer given, the form
    submitted, and the submission the walk's (``observe.submitted_alike`` holds it, in App Preview too)."""
    from proof.formplayer.walk import REPEAT, Walk

    with webapps_hq.project(webapps_documents["case-capture-repeat"]) as project:
        with project.released(formplayer_runner) as release:
            walked = Walk.of(release).run()
            adding = next(
                run
                for run in walked["runs"]
                if any(attempt.get(REPEAT) for step in run["steps"] for attempt in step.get("answers") or ())
            )
            shown = observe.shown(release, editor_driver, {**walked, "runs": [adding]})
    evidence("observation", shown)
    desktop, small, preview = shown["runs"]
    assert (small.get("viewport"), preview.get("viewport")) == (observe.SMALL, observe.PREVIEW)
    for run in (desktop, small, preview):
        assert "stopped" not in run, run
        assert run["submit"] == "submitted" and set(run["answers"]) == {"answered"}, run
        assert len(run["screens"]) == observe._expected_screens(adding)
    assert observe.ONE_QUESTION not in desktop and observe.ONE_QUESTION not in small
    ended = preview[observe.ONE_QUESTION]["stopped"]
    assert ended["at"] == observe.FORM
    assert any("non-field-list group" in alert for alert in ended["screen"]["alerts"]), ended


def test_the_one_question_form_ended_where_the_client_stopped_in_it_or_at_its_opening_with_formplayers_error():
    """A run is replayed with its form shown whole where the one-question form is what ended it: the client
    stopped in the form, or at the choice that opens it with Formplayer's error on the screen (a form whose first
    screen is a repeat's Add). A case the client lists no row for ends the run whichever way a form is shown, so
    it is not replayed again."""
    walked = {
        "script": [{"menu": 0}, {"entity": "c1"}, {"places": {}}],
        "steps": [{"request": {}, "response": {}}, {"answers": [], "submitted": {}}],
    }
    assert observe.one_question_ended({"stopped": {"at": observe.FORM, "screen": {"alerts": []}}}, walked)
    assert observe.one_question_ended(
        {"stopped": {"at": 1, "screen": {"alerts": ["Cannot get question prompts"]}}}, walked
    )
    assert not observe.one_question_ended({"stopped": {"at": 1, "screen": {"alerts": []}}}, walked)
    assert not observe.one_question_ended({"stopped": {"at": 0, "screen": {"alerts": ["An error"]}}}, walked)
    assert not observe.one_question_ended({"screens": []}, walked)
    # A run that reaches no form has no one-question form to end.
    formless = {"script": [{"menu": 0}], "steps": [{"request": {}, "response": {}}]}
    assert not observe.one_question_ended({"stopped": {"at": 0, "screen": {"alerts": ["An error"]}}}, formless)
