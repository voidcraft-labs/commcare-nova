"""A transcript the store holds stands for a browser run only where HQ answers alike; otherwise the run goes live.

Contract (``proof.store.runtime.Transcripts`` with ``proof.editors.pages``):
a view's transcript kept by one run and packed into a snapshot is found by a
later run under the same browser start (the view's spec and HQ's first
answer) and replayed: HQ, really run again over the same state, answers
every recorded request alike, and the replay gives the live run's sections.
A transcript under that start that recorded another answer later on (one a
run over another state kept) is found too, and its replay stops at that
answer; the run then goes live from the state the replay started from,
gives what a live run gives, and its transcript replaces the other.

The plausible failures: a store that finds a transcript by its spec alone
(so a run over another first page replays), one that returns a transcript
whose replay it never verifies, and one that keeps the stale transcript
after the live run, so every later run replays into the same mismatch.

HQ runs under its determinism (``proof.editors.units``) and the editor
driver runs Chromium, as the lane runs them.
"""

from __future__ import annotations

import copy
import json
from contextlib import contextmanager

import pytest

from proof.editors import pages, transcripts
from proof.editors.hq import HQAnswers
from proof.editors.units import CheckUnit
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import HQ_ROOT, nova_shaped_upload
from proof.store import pack, runtime
from proof.store.test_runtime import FINGERPRINTS

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
# HQ's suite-test app: one basic module whose case list and detail HQ's suite tests build.
SUITE_APP = "suite/app.json"


def _environ(output, store=None):
    environ = {"PROOF_FINGERPRINTS": json.dumps(FINGERPRINTS), "PROOF_OUT": str(output), "PYTHONHASHSEED": "0"}
    if store is not None:
        environ["PROOF_STORE"] = str(store)
    return environ


def _store(output, store=None):
    """The store a run writing into ``output`` (and reading the snapshot ``store``) observes with."""
    return runtime.session_store(None, _environ(output, store))


@pytest.fixture
def suite(hq, core_runner):
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        source = json.loads((HQ_ROOT / "corehq/apps/app_manager/tests/data" / SUITE_APP).read_text())
        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "app")])
        operations.held_app(state, app_id).ensure_module_unique_ids(should_save=True)
        yield unit, app_id


def _forking(unit, app_id, stored):
    @contextmanager
    def on_section(index):
        with unit.fork():
            yield
            stored[index] = json.dumps(unit.state.couch.mock_docs[app_id], sort_keys=True)

    return on_section


def _same_sections(one, other):
    assert [saved.page for saved in one.sections] == [saved.page for saved in other.sections]
    for a, b in zip(one.sections, other.sections, strict=True):
        assert pages.section_differences(a, b) == [], a.page.name


@pytest.mark.under_determinism
def test_a_held_transcript_replays_where_hq_answers_alike_and_a_stale_one_goes_live_and_is_replaced(
    tmp_path, suite, editor_driver
):
    unit, app_id = suite
    state = unit.state
    module = operations.held_app(state, app_id).modules[0]
    spec = pages.ViewSpec(
        "view_module", app_id, module.unique_id, sections=(pages.MODULE_SETTINGS, pages.CASE_LIST, pages.CASE_DETAIL)
    )
    live_stored = {}
    with unit.fork():
        live = pages.run_view(
            editor_driver, HQAnswers(state, unit), spec, on_section=_forking(unit, app_id, live_stored)
        )
    recorded = live.transcript
    earlier = _store(tmp_path / "earlier")
    earlier.transcripts.put(recorded)
    snapshot = pack.write(pack.gather([tmp_path / "earlier"]), tmp_path / "snapshot")

    later = _store(tmp_path / "later", snapshot)
    held = later.transcripts.get(recorded.spec_digest, recorded.first)
    assert held is not None and held.canonical() == recorded.canonical()
    assert later.transcripts.get(recorded.spec_digest, "0" * 64) is None
    replayed_stored = {}
    with unit.fork():
        replayed = pages.replay_view(
            held, HQAnswers(state, unit), spec, on_section=_forking(unit, app_id, replayed_stored)
        )
    assert replayed is not None and replayed.replayed
    _same_sections(replayed, live)
    assert replayed_stored == live_stored

    # A transcript under the same start that recorded another answer to the last request.
    stale_json = copy.deepcopy(recorded.to_json())
    stale_json["exchanges"][-1]["response"] = "f" * 64
    stale = transcripts.Transcript.from_json(stale_json)
    elsewhere = _store(tmp_path / "elsewhere")
    elsewhere.transcripts.put(stale)
    stale_snapshot = pack.write(pack.gather([tmp_path / "elsewhere"]), tmp_path / "stale-snapshot")
    current = _store(tmp_path / "current", stale_snapshot)
    found = current.transcripts.get(recorded.spec_digest, recorded.first)
    assert found.canonical() == stale.canonical()
    with unit.fork():
        assert pages.replay_view(found, HQAnswers(state, unit), spec, on_section=_forking(unit, app_id, {})) is None
    fallback_stored = {}
    with unit.fork():
        fallback = pages.run_view(
            editor_driver, HQAnswers(state, unit), spec, on_section=_forking(unit, app_id, fallback_stored)
        )
    _same_sections(fallback, live)
    assert fallback_stored == live_stored and fallback.transcript.canonical() == recorded.canonical()
    current.transcripts.put(fallback.transcript)
    assert current.transcripts.get(recorded.spec_digest, recorded.first).canonical() == recorded.canonical()
