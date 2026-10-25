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

- **A run goes on wherever a worker goes on.** A search screen gives each
  search a worker can send from it a run of its own: the prompts as the
  screen shows them (its defaults sent, as the client's Search sends an
  untouched screen), cleared, and typed; a search the client would keep back
  (a required prompt left empty, an answer the screen refuses) is never
  sent, and a refused answer is typed again with the table's next one. In a
  form, a question that refuses every answer the table holds is cleared, and
  a repeat a worker adds to is added to. Plausible failures: a search sent
  with nothing where the client sends the defaults (the list then shows
  other cases than a worker sees), a run that ends at a validation message a
  worker would get past, so the rest of it is seen by no check, and a repeat
  whose repetition, with the case it creates, is never submitted.

- **A bound is a safety net, never a run's end.** A walk that reaches one
  (more runs, screens or answers than any app the lane walks comes near)
  fails by the bound's name. Plausible failure: a run cut short at a bound
  and recorded as ended, alike on both sides of every comparison.

That a trace shows exactly where two states differ is
``proof/checks/test_served.py``'s planted difference.

The first document has a case list, a case detail, a form that writes a case
and a second menu (``case-operation-query``).
"""

from __future__ import annotations

import pytest
from lxml import etree

from proof.formplayer import apps, canonical
from proof.formplayer import walk as walk_module
from proof.formplayer.walk import REPEAT, questions, screen_kind, script_of, shown_inputs
from proof.observe import walks


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


def _walked(document, core_runner, formplayer_runner):
    with apps.published(document, core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            return apps.walked(formplayer_runner, served)


def _with_starting_answer(source, value):
    """A form with text followed by an integer's starting answer, written through HQ's own app and save."""
    xforms = "{http://www.w3.org/2002/xforms}"
    root = etree.fromstring(source.encode())
    (instance,) = [node for node in root.iter(f"{xforms}instance") if node.get("id") is None]
    namespace = etree.QName(instance[0]).namespace
    return f'''<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml"
        xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:jr="http://openrosa.org/javarosa">
      <h:head><h:title>Starting answers</h:title><model>
        <instance><data xmlns="{namespace}"><text/><number>{value}</number></data></instance>
        <bind nodeset="/data/text" type="xsd:string"/><bind nodeset="/data/number" type="xsd:int"/>
      <itext><translation lang="en" default=""><text id="text"><value>Text</value></text>
        <text id="number"><value>Number</value></text></translation></itext>
      </model></h:head><h:body>
        <input ref="/data/text"><label ref="jr:itext('text')"/></input>
        <input ref="/data/number"><label ref="jr:itext('number')"/></input>
      </h:body></h:html>'''


@pytest.mark.parametrize("starting", [7, 3])
def test_a_question_already_holding_the_tables_answer_sends_nothing(
    starting, hq, core_runner, formplayer_runner, formplayer_documents
):
    """An unchanged widget sends no request. Sending the same integer again would make Formplayer reread the
    earlier padded text and make the walk reconcile it to trimmed text, unlike the client's unchanged widget.
    A different starting integer still takes the table's answer and causes that ordinary reconciliation."""
    with apps.published(formplayer_documents["xpath-context"], core_runner) as published:
        change = apps.form_written(published, {"0.0": lambda source: _with_starting_answer(source, starting)})
        with apps.served(published, formplayer_runner, change=change) as served:
            walked = apps.walked(formplayer_runner, served)
    [run] = walked["runs"]
    assert run["end"] == "submitted", run
    [opened] = [step["response"] for step in run["steps"] if screen_kind(step.get("response")) == "form"]
    nodes = {node["caption"]: node for node in questions(opened["tree"]) if node.get("type") == "question"}
    number, text = nodes["Number"]["ix"], nodes["Text"]["ix"]
    assert nodes["Number"]["answer"] == starting
    [filled] = [step for step in run["steps"] if "answers" in step]
    sent_number = [attempt["value"] for attempt in filled["answers"] if attempt["ix"] == number]
    assert sent_number == ([] if starting == 7 else ["7"])
    assert filled["submitted"]["answers"][number] == 7
    assert filled["submitted"]["answers"][text] == ("  proof  " if starting == 7 else "proof")
    assert [entry["value"] for entry in filled["resent"] if entry["ix"] == text] == ([] if starting == 7 else ["proof"])


def _search(run):
    """A run's search choice, the screen it was made on, what was typed (each validating request's prompt, the
    value sent and the error Formplayer answered for it) and each search sent (its prompts' values)."""
    choice = next(choice for choice in run["script"] if "search" in choice)
    requests = [step for step in run["steps"] if "request" in step]
    screen = next(step["response"] for step in requests if screen_kind(step.get("response")) == "query")
    typed, sent = [], []
    for step in requests:
        entry = (step["request"].get("query_data") or {}).get(choice["search"])
        if entry is None:
            continue
        prompt = step["request"].get("validating")
        if prompt is not None:
            errors = {each["id"]: each.get("error") for each in step["response"].get("displays") or ()}
            typed.append((prompt, entry["inputs"][prompt], errors.get(prompt)))
        elif entry.get("execute") and (not sent or sent[-1] != entry["inputs"]):
            sent.append(entry["inputs"])
    return choice, screen, typed, sent


def _by_way(walked):
    """Each run of a walk that searches, by how its search's prompts were filled (``walks.PROMPTS``; None as the
    screen shows them), with what ``_search`` reads of it."""
    by_way = {}
    for run in walked["runs"]:
        if any("search" in choice for choice in run["script"]):
            choice, screen, typed, sent = _search(run)
            by_way.setdefault(choice.get(walks.PROMPTS), []).append((run, screen, typed, sent))
    return by_way


def test_each_search_a_worker_can_send_from_a_screen_is_a_run_of_its_own(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    """A search screen whose prompts hold defaults (``search-remote-defaults``): sent as shown it carries the
    defaults, as the client's Search does; cleared it carries nothing and lists the cases, each then walked;
    typed it carries the table's answers, each one validated as the client validates a field that changes."""
    walked = _walked(formplayer_documents["search-remote-defaults"], core_runner, formplayer_runner)
    by_way = _by_way(walked)
    assert set(by_way) == {None, walks.CLEARED, walks.TYPED}

    [(run, screen, typed, sent)] = by_way[None]
    defaults = shown_inputs(screen["displays"])
    assert defaults and sent == [defaults] and not typed
    for _run, _screen, typed, sent in by_way[walks.CLEARED]:
        assert sent == [{}] and not typed
    # Cleared, the search finds the cases the defaults kept out, and each is a run that goes on to its form.
    assert len(by_way[walks.CLEARED]) > 1
    assert {run["end"] for run, *_ in by_way[walks.CLEARED]} == {"submitted"}
    [(run, screen, typed, sent)] = by_way[walks.TYPED]
    assert typed and all(error is None for _prompt, _value, error in typed)
    assert sent == [{**defaults, **{prompt: value for prompt, value, _error in typed}}]
    # No run ends where the client would have gone on: each ends where the app ends it.
    assert {run["end"] for run in walked["runs"]} <= {"submitted", "empty-list", "empty-menu"}


def test_a_search_the_client_keeps_back_is_never_sent_and_a_refused_answer_is_typed_again(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    """A search screen with a required prompt and one that validates its answer (``prompt-widgets``): as shown
    the client keeps the search back (the required prompt is empty), so the walk sends none and says which
    prompts held it; typed, the answer the screen refuses is typed again with the table's next one, which it
    takes, and the search is sent with that."""
    walked = _walked(formplayer_documents["prompt-widgets"], core_runner, formplayer_runner)
    by_way = _by_way(walked)
    [(run, screen, typed, sent)] = by_way[None]
    assert run["end"] == "search-refused" and not sent and not typed
    [unsent] = [step["unsent"] for step in run["steps"] if "unsent" in step]
    required = [each["id"] for each in screen["displays"] if each.get("required")]
    assert required and set(required) <= set(unsent["prompts"])

    assert by_way[walks.TYPED]
    for run, _screen, typed, sent in by_way[walks.TYPED]:
        refused = [(prompt, value) for prompt, value, error in typed if error]
        assert refused, "No typed answer was refused, so nothing shows a refused answer is typed again."
        for prompt, value in refused:
            again = [(later, error) for name, later, error in typed if name == prompt and later != value]
            assert again and again[-1][1] is None, (prompt, typed)
        assert run["end"] != "search-refused" and len(sent) == 1
        last = {prompt: value for prompt, value, _error in typed}
        assert all(sent[0][prompt] == value for prompt, value in last.items())


def test_a_form_is_filled_as_far_as_a_worker_fills_it_a_refused_question_cleared_and_a_repeat_added_to(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    """A question whose validation no answer of the table meets (``targeted-save-to-case-read``: it must equal
    what an earlier form saved to the case) is cleared after the table's values, and the form is then submitted;
    a repeat a worker adds to (``case-capture-repeat``) is added to once, its questions answered, and the
    submission holds the repetition with the case it creates."""
    walked = _walked(formplayer_documents["targeted-save-to-case-read"], core_runner, formplayer_runner)
    cleared = []
    for run in walked["runs"]:
        for step in run["steps"]:
            attempts = step.get("answers") or ()
            for position, attempt in enumerate(attempts):
                if REPEAT not in attempt and attempt["value"] is None:
                    before = [each for each in attempts[:position] if each["ix"] == attempt["ix"]]
                    cleared.append((run["end"], [each["response"]["status"] for each in before], attempt))
    assert cleared, "No question refused every answer of the table, so nothing shows one is cleared."
    for end, before, attempt in cleared:
        assert before and set(before) == {"validation-error"}
        assert attempt["response"]["status"] == "accepted" and end == "submitted"

    walked = _walked(formplayer_documents["case-capture-repeat"], core_runner, formplayer_runner)
    added = [
        (run, step, attempt)
        for run in walked["runs"]
        for step in run["steps"]
        for attempt in step.get("answers") or ()
        if attempt.get(REPEAT) == "add"
    ]
    assert added, "No run added to a repeat."
    for run, step, attempt in added:
        within = [key for key in step["submitted"]["answers"] if key.startswith(f"{attempt['ix']},")]
        assert within, step["submitted"]
        assert run["end"] == "submitted"
        [submission] = step["submissions"]
        # The repetition's own case block is in what HQ received.
        assert submission["instance"].count("case_type>wound<") == 1


@pytest.mark.parametrize("bound", ["MAX_RUNS", "MAX_SCREENS"])
def test_a_walk_that_reaches_a_bound_fails_by_the_bounds_name(
    bound, hq, core_runner, formplayer_runner, formplayer_documents, monkeypatch
):
    """With a bound set under what the document's walk needs, the walk raises, naming the bound, and records no
    run as ended there."""
    with apps.published(formplayer_documents["case-operation-query"], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            monkeypatch.setattr(walk_module, bound, 1)
            with pytest.raises(walk_module.WalkBound, match=bound):
                apps.walked(formplayer_runner, served)


def test_the_clients_placeholder_is_held_only_in_an_app_that_declares_web_apps():
    """Where the app declares Web Apps the client draws no widget for a date and time question, holds its
    unsupported entry's text and submits it (finding 74); where it declares none, no worker meets the client, so the
    walk answers the question as Core's session does and never sends the text. Plausible failures: a walk that
    submits the client's text for an app no client opens, or one that loses finding 74 where Web Apps is
    declared."""
    when = {"type": "question", "ix": "0", "datatype": "datetime", "answer": "2001-02-03T04:05:06.000Z"}
    name = {"type": "question", "ix": "1", "datatype": "str", "answer": "Ada"}
    tree = [when, name]

    def held(web_apps):
        return {node["ix"]: walk_module.drawn_with(node, web_apps=web_apps) for node in tree}

    assert not walk_module.answerable(when) and walk_module.answerable(name)
    assert held(True) == {"0": walk_module.UNSUPPORTED, "1": "Ada"}
    assert walk_module.submission(tree, set(), held(True))["answers"] == {"0": walk_module.UNSUPPORTED, "1": "Ada"}

    assert walk_module.answerable(when, web_apps=False) and walk_module.answerable(name, web_apps=False)
    assert held(False) == {"0": "2001-02-03T04:05:06.000Z", "1": "Ada"}
    sent = walk_module.submission(tree, set(), held(False))["answers"]
    assert sent == {"0": "2001-02-03T04:05:06.000Z", "1": "Ada"}
    assert walk_module.UNSUPPORTED not in sent.values()
