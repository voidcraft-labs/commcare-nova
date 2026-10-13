"""A transcript stands for a browser run only when HQ, really re-run, answers every recorded request as it did.

Contract (``proof.editors.transcripts``): replaying a view's or a Vellum
run's transcript has HQ answer each recorded request again, in its phase and
inside the caller's fork for a section, built exactly as the page sent it;
when every answer's digest matches, the replay gives the run the live run
gave (the same sections, the same outputs, the same state left in each
fork); at the first answer that differs it gives None, having answered
nothing after it, and the section's fork sees the mismatch, so a live run
after it starts from the state the replay started from and equals the run
the transcript recorded. The plausible failures: a replay that trusts a
recorded output HQ would no longer produce (a mismatch not checked, or
checked after the fact), a request applied twice (by the replay and by the
live run after it, or replayed outside its fork), a replay that drops a
request so its fork reads a different state, and a navigation answered
ahead of the page that the page then asks HQ for again.

Contract (``proof.editors.hq.csrf_drawn_from``): under HQ's determinism, a
page HQ renders alike in two states whose entropy differs (B and B-edit, or
two runs whose state keys moved) carries the same CSRF token and sends it
back in the same save bodies, so its transcript replays in either; tokens
still differ between requests, and Django's own draw is back once a request
is answered. With the determinism off (``PROOF_HQ_DETERMINISM=0``) Django
draws every CSRF string itself, as it draws every other value then. The
plausible failures: the token drawn from the state's entropy, which makes
every view's first answer differ wherever the state's key does, and the
seam left on with the determinism off, which keeps the audit that compares
the lane with and without it from ever running Django's own draw.

HQ runs under its determinism here (``proof.editors.units``), as the lane
runs it, so the same requests over the same state give the same bytes. With
it off (``PROOF_HQ_DETERMINISM=0``) no request is answered alike twice, so
the tests of a replay that goes through are skipped (``under_determinism``,
``proof/conftest.py``).
"""

from __future__ import annotations

import copy
import json
from contextlib import contextmanager

import pytest

from proof.editors import pages, transcripts, vellum
from proof.editors.conftest import SUITE_APP, publish_hq_app
from proof.editors.hq import HQAnswers, csrf_drawn_from
from proof.editors.units import CheckUnit
from proof.hq import determinism, operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})


def _stored(state, app_id):
    """HQ's stored app, as its Couch document."""
    return json.dumps(state.couch.mock_docs[app_id], sort_keys=True)


def _forking(unit, app_id, stored):
    """``on_section``: each section in its own fork, HQ's stored app read inside it before it ends."""

    @contextmanager
    def on_section(index):
        with unit.fork():
            yield
            stored[index] = _stored(unit.state, app_id)

    return on_section


def _module_view(app_id, app):
    module = app.modules[0]
    return pages.ViewSpec(
        "view_module",
        app_id,
        module.unique_id,
        sections=(pages.MODULE_SETTINGS, pages.CASE_LIST, pages.CASE_DETAIL),
    )


def _same_sections(one, other):
    assert [saved.page for saved in one.sections] == [saved.page for saved in other.sections]
    for a, b in zip(one.sections, other.sections, strict=True):
        assert pages.section_differences(a, b) == [], a.page.name
        assert [e.response_digest for e in a.exchanges] == [e.response_digest for e in b.exchanges]


@pytest.fixture
def suite(hq, core_runner):
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        app_id = publish_hq_app(state, SUITE_APP)
        yield unit, app_id


@pytest.mark.under_determinism
def test_a_replayed_view_is_the_live_run_and_a_navigation_answered_ahead_is_not_asked_again(suite, editor_driver):
    unit, app_id = suite
    state = unit.state
    spec = _module_view(app_id, operations.held_app(state, app_id))

    live_stored = {}
    with unit.fork():
        live = pages.run_view(
            editor_driver, HQAnswers(state, unit), spec, on_section=_forking(unit, app_id, live_stored)
        )
    assert live.transcript is not None and live.transcript.spec == spec.canonical(state.domain)
    assert [e.phase for e in live.exchanges][:1] == ["load"]
    assert sorted(live_stored) == [0, 1, 2]

    replayed_stored = {}
    answers = HQAnswers(state, unit)
    with unit.fork():
        replayed = pages.replay_view(live.transcript, answers, spec, on_section=_forking(unit, app_id, replayed_stored))
    assert replayed is not None and replayed.replayed
    _same_sections(replayed, live)
    assert replayed.outputs == live.outputs
    assert replayed_stored == live_stored
    # Every recorded request was answered once, in the order it was recorded, and nothing else.
    recorded = [(e.phase, e.method, e.url) for e in live.transcript.exchanges]
    assert [(e.phase, e.method, e.url) for e in answers.exchanges] == recorded

    # The navigation answered ahead of the page: its answer is the transcript's first, and the page,
    # live or replayed, is served from it rather than asking HQ again.
    for replay in (False, True):
        answers = HQAnswers(state, unit)
        with unit.fork():
            navigation = pages.navigate(editor_driver, answers, spec)
            assert navigation.response_digest == live.transcript.first
            on_section = _forking(unit, app_id, {})
            if replay:
                run = pages.replay_view(live.transcript, answers, spec, on_section=on_section, navigation=navigation)
            else:
                run = pages.run_view(editor_driver, answers, spec, on_section=on_section, navigation=navigation)
        assert run is not None
        assert [e for e in answers.exchanges if e.url_name == "view_module"] == [navigation]
        assert run.exchanges[0] is navigation
        _same_sections(run, live)
        if not replay:
            assert run.transcript.canonical() == live.transcript.canonical()


def _with_changed_answer(transcript, index):
    """The transcript with HQ's answer to request ``index`` recorded differently, as if HQ had answered so."""
    changed = copy.deepcopy(transcript.to_json())
    changed["exchanges"][index]["response"] = "0" * 64
    if index == 0:
        changed["first"] = "0" * 64
    return transcripts.Transcript.from_json(changed)


@pytest.mark.under_determinism
def test_a_changed_answer_ends_the_replay_at_that_request_and_the_live_run_after_it_is_the_recorded_one(
    suite, editor_driver
):
    unit, app_id = suite
    state = unit.state
    spec = _module_view(app_id, operations.held_app(state, app_id))
    with unit.fork():
        live = pages.run_view(editor_driver, HQAnswers(state, unit), spec, on_section=_forking(unit, app_id, {}))
    before = _stored(state, app_id)
    # The case list section's held save: a section's request, answered inside its fork.
    index = next(i for i, e in enumerate(live.transcript.exchanges) if e.phase == "section:1")

    answers = HQAnswers(state, unit)
    entered, left = [], []

    @contextmanager
    def on_section(section):
        entered.append(section)
        with unit.fork():
            yield
            left.append(section)

    changed = _with_changed_answer(live.transcript, index)
    with unit.fork():
        assert pages.replay_view(changed, answers, spec, on_section=on_section) is None
    # HQ answered up to and including that request, and nothing after it.
    assert len(answers.exchanges) == index + 1
    # The section it belongs to saw the mismatch: its fork restored, the caller's reading after it skipped.
    assert entered == [0, 1] and left == [0]
    # Then, the view's state restored, the live run: the run the transcript recorded.
    with unit.fork():
        fallback = pages.run_view(editor_driver, HQAnswers(state, unit), spec, on_section=_forking(unit, app_id, {}))
    assert fallback.transcript.canonical() == live.transcript.canonical()
    assert _stored(state, app_id) == before

    # A real change in HQ: the module renamed. Its view answers differently from the first request on, and
    # nothing after the navigation is asked.
    app = operations.held_app(state, app_id)
    app.modules[0].name["en"] = "Renamed in HQ"
    app.save()
    answers = HQAnswers(state, unit)
    with unit.fork():
        assert pages.replay_view(live.transcript, answers, spec, on_section=_forking(unit, app_id, {})) is None
    assert len(answers.exchanges) == 1 and answers.exchanges[0].url_name == "view_module"


@pytest.mark.under_determinism
def test_a_replayed_vellum_run_is_the_live_run_and_a_changed_answer_ends_it(suite, editor_driver):
    unit, app_id = suite
    state = unit.state
    form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
    with unit.fork():
        live = vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id)
        live_stored = _stored(state, app_id)
    assert live.saved and live.transcript is not None

    answers = HQAnswers(state, unit)
    with unit.fork():
        replayed = vellum.replay(live.transcript, answers, app_id, form_id)
        replayed_stored = _stored(state, app_id)
    assert replayed is not None and replayed.replayed
    assert replayed.outputs == live.outputs
    assert replayed_stored == live_stored
    assert replayed.stored_source == live.stored_source
    assert [e.response_digest for e in replayed.exchanges] == [e.response_digest for e in live.exchanges]

    last = len(live.transcript.exchanges) - 1
    answers = HQAnswers(state, unit)
    with unit.fork():
        assert vellum.replay(_with_changed_answer(live.transcript, last), answers, app_id, form_id) is None
    assert len(answers.exchanges) == last + 1


@pytest.mark.under_determinism
def test_a_view_rendered_alike_under_other_entropy_replays_its_transcript(suite, editor_driver):
    unit, app_id = suite
    state = unit.state
    spec = _module_view(app_id, operations.held_app(state, app_id))
    with unit.fork():
        live = pages.run_view(editor_driver, HQAnswers(state, unit), spec, on_section=_forking(unit, app_id, {}))
    # The same HQ state under another key: every entropy draw HQ makes in a request differs.
    other = CheckUnit(state, root_key=b"another state key, the same HQ state")
    answers = HQAnswers(state, other)
    with other.fork():
        navigation = pages.navigate(editor_driver, answers, spec)
        assert b"csrfmiddlewaretoken" in navigation.response
        assert navigation.response_digest == live.transcript.first
        replayed = pages.replay_view(
            live.transcript, answers, spec, on_section=_forking(other, app_id, {}), navigation=navigation
        )
    assert replayed is not None
    _same_sections(replayed, live)


def _tokens(digest):
    """Two tokens HQ's page would carry from one request inside ``csrf_drawn_from(digest)``, and their secret."""
    from django.middleware import csrf
    from django.test import RequestFactory

    with csrf_drawn_from(digest):
        request = RequestFactory().get("/")
        return csrf.get_token(request), csrf.get_token(request), request.META["CSRF_COOKIE"]


def test_csrf_strings_are_drawn_from_the_request_and_djangos_draw_is_put_back(hq, monkeypatch):
    from django.middleware import csrf

    held = csrf._get_new_csrf_string
    monkeypatch.setattr(determinism, "ENABLED", True)
    first, again, secret = _tokens(b"one request")
    assert _tokens(b"one request") == (first, again, secret)
    # Each draw in a request is its own (a token's mask), and another request draws others.
    assert first != again and csrf._unmask_cipher_token(first) == csrf._unmask_cipher_token(again) == secret
    other = _tokens(b"another request")
    assert other[2] != secret and other[0] != first
    assert len(secret) == csrf.CSRF_SECRET_LENGTH and set(secret) <= set(csrf.CSRF_ALLOWED_CHARS)
    assert csrf._get_new_csrf_string is held

    # With HQ's determinism off the block draws as Django does: the same request gives other strings.
    monkeypatch.setattr(determinism, "ENABLED", False)
    drawn = []
    monkeypatch.setattr(csrf, "_get_new_csrf_string", lambda: drawn.append(held()) or drawn[-1])
    off = _tokens(b"one request")
    assert len(drawn) == 3 and off[2] == drawn[0] and off[2] != secret
    assert _tokens(b"one request")[2] != off[2]


def test_a_transcript_reads_back_as_written_and_refuses_another_format():
    exchange = transcripts.TranscriptExchange(
        phase="load", method="GET", url="http://hq.proof.test/a/", headers={"accept": "*/*"}, body=None, response="ab"
    )
    transcript = transcripts.Transcript(spec={"kind": "view"}, first="ab", exchanges=(exchange,), outputs={"x": 1})
    assert transcripts.Transcript.from_json(json.loads(transcript.canonical())) == transcript
    with pytest.raises(transcripts.TranscriptInvalid, match="format"):
        transcripts.Transcript.from_json({**transcript.to_json(), "format": 0})
    with pytest.raises(transcripts.TranscriptInvalid, match="first"):
        transcripts.Transcript.from_json({**transcript.to_json(), "first": "cd"})
