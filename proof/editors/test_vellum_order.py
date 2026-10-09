"""Vellum parses a form only after HQ's data sources arrive, and saves nothing it parsed without them.

Contract: HQ's form designer gives Vellum its data sources before Vellum
parses the form (Vellum asks for them when it starts and parses on its load
timer, ``core.js::loadXFormOrError``), and the hashtags Vellum writes depend
on that order (``datasources.js::getHashtagMap``). The driver holds Vellum's
parse until the sources have arrived, so the order never depends on how fast
HQ answers; and where the sources fail, it saves nothing, so HQ keeps the form
as it was. The plausible failures: a parse that races the sources (a run that
fails at random under load, or a save whose hashtags HQ's page would not
write), and a save made after the run already knows it is not HQ's.

The first test leaves Vellum no time at all (its load delay set to 0 in the
options HQ computes), so a parse that does not wait for the sources comes
first every time; the second has HQ's own view refuse the sources.

Contract: what a run records does not depend on which came first, Vellum's
parse timer or HQ's answer to the sources (a race the run's spec does not
fix, so a record that tells them apart differs between two runs of one
spec). The plausible failure: the hold noting that it held, which a run whose
sources answered first never notes. The third test runs one form twice over
the same state with the same spec, HQ answering the sources at once in one
run and holding its answer past Vellum's load delay in the other, and reads
from the times the page itself noted (``VellumRun.timed_events``) that the
sources reached Vellum before its parse timer was due in the first run and
only after it was due in the second.
"""

from __future__ import annotations

import json
import time
from unittest import mock

import pytest

from proof.editors import vellum
from proof.editors.conftest import SUITE_APP, publish_hq_app
from proof.editors.hq import HQAnswers
from proof.editors.units import CheckUnit
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})


def test_vellum_parses_after_the_data_sources_even_when_its_timer_fires_first(hq, core_runner, editor_driver):
    computed = vellum.vellum_options

    def without_load_delay(*args, **kwargs):
        options = computed(*args, **kwargs)
        value = json.loads(options.json)
        value["core"]["loadDelay"] = 0
        return vellum.DesignerOptions(json=json.dumps(value), lang=options.lang)

    with (
        hq_check(CONFIGURATION) as (state, _),
        mock.patch.object(vellum, "vellum_options", without_load_delay),
    ):
        app_id = publish_hq_app(state, SUITE_APP)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
        run = vellum.open_and_save(editor_driver, state, app_id, form_id)

    names = run.event_names()
    assert run.loaded and run.saved and run.sources_before_parse, names
    assert names.index("datasources:change") < names.index("parse:run") < names.index("formLoadedCallback"), names
    assert run.save_button == "saved"


def test_a_form_vellum_parsed_without_the_data_sources_is_not_saved(hq, core_runner, editor_driver):
    from corehq.apps.app_manager.exceptions import AppManagerException
    from corehq.apps.app_manager.views import formdesigner

    def refused(form):
        raise AppManagerException("The harness refuses this form's session schema.")

    answered = []

    class Recorded(HQAnswers):
        def __init__(self, state):
            super().__init__(state)
            answered.append(self)

    with hq_check(CONFIGURATION) as (state, _):
        app_id = publish_hq_app(state, SUITE_APP)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
        before = operations.held_app(state, app_id).get_form(form_id).source
        # views/formdesigner.py::get_form_data_schema answers 400 when the session schema raises.
        with (
            mock.patch.object(formdesigner, "get_session_schema", refused),
            mock.patch.object(vellum, "HQAnswers", Recorded),
            pytest.raises(vellum.VellumSourcesRefused),
        ):
            vellum.open_and_save(editor_driver, state, app_id, form_id)
        after = operations.held_app(state, app_id).get_form(form_id).source

    (answers,) = answered
    asked = [(exchange.url_name, exchange.status) for exchange in answers.exchanges if exchange.url_name]
    assert ("get_form_data_schema", 400) in asked, asked
    assert not [name for name, _ in asked if name in ("patch_xform", "edit_form_attr")], asked
    assert after == before


# The load delay both runs of the race test give Vellum, and how long HQ holds its answer to the sources in the late
# run: past the delay by more than the page takes from asking for the sources to scheduling the parse.
RACE_LOAD_DELAY_MS = 1000
LATE_ANSWER_SECONDS = 1.5


def _sources_after_the_timer_was_due(run):
    """Whether the sources reached Vellum after its parse timer was due, by the times the page noted."""
    events = {event["name"]: event for event in run.timed_events}
    scheduled, arrived = events["parse:scheduled"], events["datasources:change"]
    return arrived["at"] > scheduled["at"] + scheduled["detail"]


def test_what_a_run_records_does_not_depend_on_whether_the_sources_beat_the_parse_timer(hq, core_runner, editor_driver):
    class Answers(HQAnswers):
        """HQ's answers, the one to the sources held back past Vellum's load delay when ``late``."""

        def __init__(self, state, unit, late):
            super().__init__(state, unit)
            self.late = late

        def __call__(self, asked):
            if self.late and "/schema/" in asked.url:
                # The delay is the mechanism; the order the page saw is read from its own times.
                time.sleep(LATE_ANSWER_SECONDS)
            return super().__call__(asked)

    with hq_check(CONFIGURATION) as (state, _):
        app_id = publish_hq_app(state, SUITE_APP)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
        unit = CheckUnit(state)
        computed = vellum.vellum_options(state, app_id, form_id)
        value = json.loads(computed.json)
        value["core"]["loadDelay"] = RACE_LOAD_DELAY_MS
        options = vellum.DesignerOptions(json=json.dumps(value), lang=computed.lang, source=computed.source)
        runs = {}
        for late in (False, True):
            with unit.fork():
                runs[late] = vellum.fresh_open_and_save(
                    editor_driver, Answers(state, unit, late), app_id, form_id, options
                )

    scheduled = [e for e in runs[False].timed_events if e["name"] == "parse:scheduled"]
    assert [e["detail"] for e in scheduled] == [RACE_LOAD_DELAY_MS]
    # The sources beat the parse timer in one run, and the timer was due before they came in the other.
    assert not _sources_after_the_timer_was_due(runs[False])
    assert _sources_after_the_timer_was_due(runs[True])
    assert runs[False].saved and runs[False].sources_before_parse
    assert runs[False].outputs == runs[True].outputs
    assert [(e.url_name, e.body, e.response) for e in runs[False].saves] == [
        (e.url_name, e.body, e.response) for e in runs[True].saves
    ]
