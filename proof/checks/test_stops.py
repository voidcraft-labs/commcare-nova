"""Walk stops: every run of a reader's walk reaches its end, or stops where ``proof/walk-stops.json`` holds it.

Contract (``proof.checks.stops``): on every baseline state a document's unit
serves (A, and proof 4's B and B-edit), each run of Formplayer's walk ends
where the app ends it (a form submitted, a menu or a list that offers
nothing) and the Web Apps client's replay of it follows it there, in a
desktop's window, a phone's and App Preview; a run that ends anywhere else is
a stop, and the list holds it by its document, reader and cause, with the
reason the reader ends there. Proofs 3 and 4 compare two states' walks and
pass a run both sides cut short alike; this check reads each walk on its own,
so a stop is never silent: one the list does not hold fails here by name, and
so does an entry no run of its document shows any more. A held stop moves to
its control with its fix: an entry names a document or a control, a
``control`` entry holds that control's walks alone and must show there, and
every control the list or either register names is read.

The plausible failures each test here catches:

- a run cut short on both sides of every comparison (an answer the lane does
  not give, a choice the client shows nothing to click for, an error
  Formplayer answers on A and B alike) passing every check with the rest of
  the run unseen;
- a held stop that a fix removed left in the list, where it would hold the
  next walk that stops for another reason of the same name;
- a cause named by what the app authored (a question's index, a form's
  name), so one reader's limit is a class a document, and a list no one can
  read;
- a client run that stopped read as one that followed the walk, or a stop in
  App Preview, which shows a form one question a screen, read as Web Apps'
  own;
- a control whose document's stop a fix removed, whose walks still stop on
  the pre-fix bytes, failing as a stop no entry holds, or read by no item at
  all where only the list or the fixed register names it.
"""

from __future__ import annotations

import pytest

from proof.checks import cases, corpus, observations, stops


def _controls():
    """The controls a run queues (``proof.store.queue.control_groups``): those a held entry of either register
    names, of any check, each observed whole by the check its entry names, and those the list's ``control``
    entries name whose reader the run observes, which only this check reads."""
    from proof.lane import readers

    named = {entry.control for entry in (*cases.load_register(), *cases.load_fixed())}
    named |= stops.control_names(stops.held_entries(stops.load(), readers=readers.named()))
    return [
        pytest.param(document, id=f"control-{document.id}")
        for document in corpus.load_controls()
        if document.id in named
    ]


def document_stops(records) -> tuple[list[stops.Stop], list[stops.Stop]]:
    """The stops of one document's walks, from its records: every baseline served state of every configuration
    (``stops.served_states``), Formplayer's trace and the client's screens of each opened from the records'
    blobs; and beside them the runs App Preview's one-question form ended early that the replay then showed
    whole (``stops.state_whole``)."""
    found, whole = [], []
    for name, held in sorted(records.configurations.items()):
        # A B-edit that is B (``{"same_as": ...}``) is B's state, read once.
        edit = held.b_edit if held.b_edit is not None and "same_as" not in held.b_edit else None
        for state, served in stops.served_states(name, {"a": held.a, "b": held.b, "b_edit": edit}):
            trace = records.blobs.get_json(served["formplayer"]["trace"])
            screens = records.blobs.get_json(served["webapps"]) if served.get("webapps") else None
            found += stops.state_stops(state, trace, screens)
            whole += stops.state_whole(state, screens)
    return stops.classed(found), stops.classed(whole)


@pytest.mark.parametrize("document", cases.document_params() + _controls())
def test_every_walk_reaches_its_end_or_a_held_stop(document, hq, core_runner, editor_driver):
    from proof.lane import readers

    shown, whole = document_stops(observations.records_for(document, core_runner, editor_driver=editor_driver))
    cases.evidence(
        stops.CHECK,
        document,
        [],
        stops=[stop.as_json() for stop in shown],
        replayedWhole=[stop.as_json() for stop in whole],
        configurations=sorted(document.exports),
    )
    entries = stops.held_entries(stops.load(), readers=readers.named())
    classes = [(stop.reader, stop.cause) for stop in shown]
    control = document.kind == "control"
    # A document entry shows on its document and need not on the control of its name, which retains inputs of
    # another day; a control entry shows on its control.
    problems = stops.unheld(document.id, classes, entries, control=control)
    problems += stops.unshown(document.id, classes, entries, control=control)
    assert not problems, "\n".join(
        [*problems, "The stops this document's walks showed:", *(f"  {stop.as_json()}" for stop in shown)]
    )


# The judge ----------------------------------------------------------------------------------


def _run(end, *steps, script=({"menu": 0},)):
    return {"script": list(script), "steps": list(steps), "end": end}


def test_a_run_ends_where_the_app_ends_it_and_every_other_end_is_a_stop_named_by_what_formplayer_said():
    said = {"exception": "Unable to find lookup table: jr://fixture/locations", "status": "error"}
    refused = {"submit": {"status": "error", "notification": {"message": "No submission address"}}}
    assert [stops.formplayer_cause(_run(end)) for end in ("submitted", "empty-menu", "empty-list")] == [None] * 3
    assert stops.formplayer_cause(_run("notification", {"response": said})) == (
        "notification:unable-to-find-lookup-table"
    )
    assert stops.formplayer_cause(_run("submit-refused", refused)) == "submit-refused:no-submission-address"
    assert stops.formplayer_cause(_run("submit-refused", {"submit": {"status": "validation-error"}})) == (
        "submit-refused:validation-error"
    )
    assert stops.formplayer_cause(_run("search-refused")) == "search-refused"
    assert stops.formplayer_cause(_run("refused", {"refused": {"status": 500}})) == "refused:500"


def test_a_cause_is_the_readers_words_without_the_index_the_form_or_the_value_the_app_authored():
    assert {
        stops.said(f"Cannot get question prompts from a non-field-list group at index {index} for form {form}")
        for index, form in (("1_0", "Assess"), ("0_0", "F"), ("4_0", "Form 0-0"))
    } == {"cannot-get-question-prompts-from-a-non-field-list-group"}
    assert {stops.said(f"Index -1 out of bounds for length {length}") for length in (0, 1, 2)} == {
        "index-n-out-of-bounds"
    }
    assert stops.said("Please check the following fields:NameName check") == "please-check-the-following-fields"
    # A clock's colons are not where a reader's words end, and the value HQ names first is the app's.
    assert stops.said("at 09:00:00 the view answered: no") == "at-n-n-n-the-view-answered"
    assert {
        stops.said(f"{value} is not a correctly formatted date or datetime.") for value in ("09:00:00", "tomorrow")
    } == {"value-is-not-a-correctly-formatted-date-or-datetime"}
    assert stops.said("org.commcare.resources.model.UnresolvedResourceException: Question bound to X: [/d]") == (
        "question-bound-to-x"
    )
    # Core names the value and the question inside what it says; the class is what it says of them.
    assert {
        stops.said(f"value {value} could not be loaded into question {name}.  Check to see if value {value} is a valid")
        for value, name in (("a", "input-label"), ("b c", "instance/input/optn-label"))
    } == {"value-could-not-be-loaded-into-question"}
    assert stops.said(None) == stops.said("  ") == "nothing"


def _client(script, at, *, alerts=(), viewport=None, answers=None, searches=None):
    run = {"script": list(script), "screens": [{}], "stopped": {"at": at, "screen": {"alerts": list(alerts)}}}
    if viewport:
        run["viewport"] = viewport
    if answers is not None:
        run["answers"] = answers
    if searches is not None:
        run["searches"] = searches
    return run


def test_a_client_run_that_followed_the_walk_is_no_stop_and_one_that_stopped_is_named_by_where():
    script = [{"menu": 0}, {"entity": "visit-3"}, {"menu": 0}]
    assert stops.client_cause({"script": script, "screens": [{}] * 4}) is None
    # No row for the case the run takes: the choice at the script's second place.
    assert stops.client_cause(_client(script, 1)) == "case-not-listed"
    assert stops.client_cause(_client(script, 0)) == "command-not-listed"
    assert stops.client_cause(_client(script, "start")) == "app-not-opened"
    # In the form: held (a Next the client keeps from being pressed), or with the alert it shows.
    assert stops.client_cause(_client(script, "form", answers=["answered", "held"])) == "form-held"
    assert stops.client_cause(_client(script, "form", answers=["answered"])) == "form-stopped"
    assert stops.client_cause(_client(script, "form", alerts=["Index -1 out of bounds for length 0"])) == (
        "alert:index-n-out-of-bounds"
    )
    assert stops.client_cause(_client([{"search": "k"}], 0, searches=["refused"])) == "search-refused"
    # The places a run gave its form's map are no choice a worker makes on the app's screens.
    assert stops.client_cause(_client([{"places": {}}, {"menu": 0}], 0)) == "command-not-listed"
    assert stops.client_reader(_client(script, 1)) == stops.WEBAPPS
    assert stops.client_reader(_client(script, 1, viewport="small")) == stops.WEBAPPS
    assert stops.client_reader(_client(script, 1, viewport="preview")) == stops.PREVIEW


def test_a_run_app_preview_then_showed_whole_is_no_stop_and_is_kept_beside_the_stops():
    """App Preview's one-question form ended early and the replay went on with the form shown whole: the run
    reached its end, so it is no stop, and where the one-question form ended is listed beside them; the whole
    replay's own stop is the run's."""
    said = "Cannot get question prompts from a non-field-list group at index 1_0 for form Assess"
    ended = _client([{"menu": 0}], "form", alerts=[said])
    whole = {"script": [{"menu": 0}], "screens": [{}] * 4, "viewport": "preview", "oneQuestion": ended}
    assert stops.client_cause(whole) is None
    assert stops.one_question_cause(whole) == "alert:cannot-get-question-prompts-from-a-non-field-list-group"
    assert stops.state_stops("minimum/A", None, {"runs": [whole]}) == []
    [kept] = stops.state_whole("minimum/A", {"runs": [whole, {"script": [], "screens": []}]})
    assert (kept["reader"], kept["cause"]) == ("preview", stops.one_question_cause(whole))
    still = {**whole, "stopped": {"at": "form", "screen": {}}, "submit": "held"}
    assert stops.client_cause(still) == "form-held"


def test_the_baseline_states_are_a_and_proof_4s_b_and_b_edit_where_each_was_served():
    served = {"formplayer": {"trace": "sha256:t"}}
    parts = {
        "a": {"hooks": {"served": {"served": True, "A": served}}},
        "b": {"proof4": {"served": {"served": True, **served}}},
        "b_edit": {"proof4": {"served": {"served": False}}},
    }
    assert [state for state, _ in stops.served_states("minimum", parts)] == ["minimum/A", "minimum/B"]
    assert stops.served_states("minimum", {"a": {"hooks": {}}, "b": None, "b_edit": None}) == []
    assert stops.served_states("minimum", {"a": None}) == []


def test_stopped_runs_are_one_stop_a_reader_and_cause_with_how_many_and_where():
    trace = {"runs": [_run("submitted"), _run("search-refused"), _run("search-refused")]}
    screens = {"runs": [_client([{"menu": 0}, {"entity": "c"}], 1, viewport="preview")]}
    found = stops.classed(stops.state_stops("minimum/A", trace, screens) + stops.state_stops("maximum/A", trace, None))
    assert [(stop.reader, stop.cause, stop.runs, stop.states) for stop in found] == [
        ("formplayer", "search-refused", 4, ("maximum/A", "minimum/A")),
        ("preview", "case-not-listed", 1, ("minimum/A",)),
    ]


# The list -----------------------------------------------------------------------------------


def _entry(document="doc", reader="preview", cause="form-held", reason="Because."):
    return {"document": document, "reader": reader, "cause": cause, "reason": reason}


def _list(tmp_path, entries):
    import json

    path = tmp_path / "walk-stops.json"
    path.write_text(json.dumps(entries), encoding="utf-8")
    return path


def test_the_committed_list_loads_and_names_documents_the_corpus_holds_and_controls_proof_controls_holds():
    documents = {document.id for document in cases.load_corpus().emitted}
    stops.load(documents=documents, controls={control.id for control in corpus.load_controls()})


def test_the_list_refuses_an_entry_it_could_not_hold_a_stop_to(tmp_path):
    assert [entry.key for entry in stops.load(_list(tmp_path, [_entry("a"), _entry("b")]))] == [
        ("a", "preview", "form-held"),
        ("b", "preview", "form-held"),
    ]
    for entries, why in (
        ([{**_entry(), "extra": 1}], "exactly one of document, control"),
        ([_entry(reader="android")], "reader is one of"),
        ([_entry(reason="Two\nlines.")], "one line"),
        ([_entry(), _entry()], "the same stop"),
        ([_entry("b"), _entry("a")], "by the document or control each names"),
        ([_entry(reason="")], "non-empty"),
    ):
        with pytest.raises(stops.StopsError, match=why):
            stops.load(_list(tmp_path, entries))
    with pytest.raises(stops.StopsError, match="corpus does not hold"):
        stops.load(_list(tmp_path, [_entry("gone")]), documents={"doc"})


def _on_control(control="doc-after", reader="preview", cause="form-held", reason="Because."):
    return {"control": control, "reader": reader, "cause": cause, "reason": reason}


def test_an_entry_names_a_document_or_a_control_and_one_stop_once(tmp_path):
    """An entry names where its stop shows by exactly one of ``document`` and ``control``; a control names a
    directory ``proof/controls/`` holds; and a ``control`` entry beside the ``document`` entry of the same name,
    reader and cause would hold one stop twice, since the document's entry already holds its namesake control."""
    loaded = stops.load(_list(tmp_path, [_entry("a"), _on_control("b")]), documents={"a"}, controls={"b"})
    assert [(entry.document, entry.control, entry.key) for entry in loaded] == [
        ("a", None, ("a", "preview", "form-held")),
        (None, "b", ("b", "preview", "form-held")),
    ]
    assert stops.control_names(loaded) == {"b"}
    for entries, why in (
        ([{**_entry(), "control": "doc"}], "exactly one of document, control"),
        ([{key: value for key, value in _entry().items() if key != "document"}], "exactly one of document, control"),
        ([_on_control(reason="")], "non-empty"),
        ([_entry("doc"), _on_control("doc")], "already holds that stop on the control of its name"),
        ([_on_control("b"), _entry("a")], "by the document or control each names"),
    ):
        with pytest.raises(stops.StopsError, match=why):
            stops.load(_list(tmp_path, entries))
    with pytest.raises(stops.StopsError, match="proof/controls/ holds no directory of"):
        stops.load(_list(tmp_path, [_on_control("gone")]), controls={"doc-after"})


def test_a_control_entry_holds_its_controls_stop_and_no_documents_and_must_show_there():
    """A ``control`` entry holds the walks of its control alone, strict both ways there: a stop of the control no
    entry holds fails by name, and so does a ``control`` entry its control's run did not show. A ``document``
    entry holds its namesake control's walks and need not show there, so a control stops, held, while its
    document's entry stands, and by its own once a fix moves the entry to it."""
    moved = (stops.Held(None, "formplayer", "c", "Because.", control="doc"),)
    stopped = [("formplayer", "c")]
    assert stops.unheld("doc", stopped, moved, control=True) == []
    assert stops.unshown("doc", stopped, moved, control=True) == []
    # The document of the same name is no control: the moved entry holds nothing there and need not show there.
    (unheld,) = stops.unheld("doc", stopped, moved)
    assert "Formplayer's walk stops for c" in unheld and "add the entry with its reason" in unheld
    assert stops.unshown("doc", [], moved) == []
    # A control's stop no entry holds, and a control entry no run of its control showed.
    (stray,) = stops.unheld("doc", [*stopped, ("webapps", "case-not-listed")], moved, control=True)
    assert stray.startswith("doc: a run of the Web Apps client stops for case-not-listed")
    assert "add an entry naming the control" in stray
    (stale,) = stops.unshown("doc", [], moved, control=True)
    assert stale == (
        "doc: proof/walk-stops.json holds a stop of Formplayer's walk for c, and no run of the control stops so now."
        " Remove the entry."
    )
    # While the document's entry stands it holds the control's stop and need not show there; once the fix moves
    # it, the control is held by its own entry.
    standing = (stops.Held("doc", "formplayer", "c", "Because."),)
    assert stops.unheld("doc", stopped, standing, control=True) == []
    assert stops.unshown("doc", [], standing, control=True) == []
    assert stops.unheld("doc", stopped, (), control=True) != []


def test_a_whole_run_holds_each_control_entry_on_its_controls_record_by_its_group(tmp_path):
    """Over a run's evidence a ``control`` entry is held to its control's record, each problem named by the group
    a rerun shows it under (``control:<id>``), and a selection that did not run the control leaves it."""
    entries = (
        stops.Held("doc", "preview", "form-held", "Because."),
        stops.Held(None, "formplayer", "c", "R.", control="kept"),
    )
    _evidence(tmp_path, "corpus", "doc", [("preview", "form-held")])
    _evidence(tmp_path, "control", "kept", [("formplayer", "c")])
    assert stops.held_evidence([tmp_path], entries) == []
    _evidence(tmp_path, "control", "kept", [])
    [(problem, groups)] = stops.held_evidence([tmp_path], entries)
    assert groups == ("control:kept",) and "no run of the control stops so now" in problem
    _evidence(tmp_path, "control", "kept", [("formplayer", "c"), ("formplayer", "d")])
    [(problem, groups)] = stops.held_evidence([tmp_path], entries)
    assert groups == ("control:kept",) and problem.startswith("kept: a run of Formplayer's walk stops for d")
    (tmp_path / "checks" / stops.CHECK / "control-kept.json").unlink()
    [(problem, groups)] = stops.held_evidence([tmp_path], entries)
    assert groups == ("control:kept",) and "holds stops of this control, and no shard ran the stops check" in problem
    assert stops.held_evidence([tmp_path], entries, unrun_controls={"kept"}) == []
    assert stops.held_evidence([tmp_path], entries, readers=frozenset({"webapps"})) == []


def test_a_stop_no_entry_holds_and_an_entry_no_run_shows_each_fail_by_name():
    entries = (stops.Held("doc", "preview", "form-held", "Because."),)
    assert stops.unheld("doc", [("preview", "form-held")], entries) == []
    assert stops.unshown("doc", [("preview", "form-held")], entries) == []
    (missing,) = stops.unheld("doc", [("preview", "form-held"), ("webapps", "case-not-listed")], entries)
    assert "doc" in missing and "the Web Apps client stops for case-not-listed" in missing
    (stale,) = stops.unshown("doc", [], entries)
    assert "doc" in stale and "App Preview for form-held" in stale and "Remove the entry" in stale
    # Another document's entry holds nothing here, and is not this document's to show.
    assert stops.unheld("other", [("preview", "form-held")], entries) != []
    assert stops.unshown("other", [], entries) == []


def test_a_run_holds_the_entries_of_the_readers_it_observes():
    entries = tuple(stops.Held("doc", reader, "c", "Because.") for reader in stops.READERS)
    assert stops.held_entries(entries) == entries
    assert stops.held_entries(entries, readers=False) == ()
    assert [entry.reader for entry in stops.held_entries(entries, readers={"formplayer"})] == ["formplayer"]
    assert [entry.reader for entry in stops.held_entries(entries, readers={"formplayer", "webapps"})] == [
        "formplayer",
        "webapps",
        "preview",
    ]


def _evidence(directory, kind, document, shown):
    import json

    path = directory / "checks" / stops.CHECK / f"{kind}-{document}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {"check": stops.CHECK, "document": document, "kind": kind, "differences": []}
    record["stops"] = [{"reader": reader, "cause": cause} for reader, cause in shown]
    path.write_text(json.dumps(record), encoding="utf-8")


def test_a_whole_run_holds_every_documents_and_controls_stops_and_shows_every_entry(tmp_path):
    entries = (stops.Held("doc", "preview", "form-held", "Because."),)
    _evidence(tmp_path, "corpus", "doc", [("preview", "form-held")])
    _evidence(tmp_path, "control", "doc", [("preview", "form-held")])
    assert stops.verify_evidence([tmp_path], entries) == []
    # A control's stop no entry holds, and an entry the document's run did not show.
    _evidence(tmp_path, "control", "doc", [("webapps", "case-not-listed")])
    _evidence(tmp_path, "corpus", "doc", [])
    problems = stops.verify_evidence([tmp_path], entries)
    assert len(problems) == 2 and "case-not-listed" in problems[0] and "Remove the entry" in problems[1]
    # A document whose check never ran shows nothing, unless the run left it out; a run without the reader
    # holds none of its entries.
    (unran,) = stops.verify_evidence([tmp_path / "none"], entries)
    assert "no shard ran the stops check" in unran
    assert stops.verify_evidence([tmp_path / "none"], entries, unrun={"doc"}) == []
    assert stops.verify_evidence([tmp_path / "none"], entries, readers=frozenset({"formplayer"})) == []
