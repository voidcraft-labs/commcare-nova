"""The pages the driver keeps between operations end every operation as a fresh page's closed context would.

Contract (``driver/driver.mjs``): the driver keeps one page for views and
one Vellum host. Every request either page sends names it, and HQ's origin
serves a request only to an operation of the page that sent it. A request
for HQ that arrives while its page has no operation running (something the
page started outliving its operation) is refused unanswered, reaches neither
Python nor HQ, and fails the operation running then, or the next one, naming
it; the page is loaded afresh before its next use. A view ends with its page
sent to about:blank, and a clean Vellum run ends with the work it left
behind ended (Vellum's shared check for form submissions, and the jQuery
animations the run left running, which the fixed clock never lets finish:
``steps/vellum/end.js``), so the warm host sends nothing once its run is
over, however long it then sits idle (shown on Chromium's virtual time,
which runs every timer the page holds that falls due in that long: the
driver's ``idle`` operation), its next run starts with no animation
running, and asks HQ what a fresh page asks. A page whose operation failed
is replaced, and the next operation on it gives what a fresh page gives; a
page replaced every ``PROOF_EDITORS_RECYCLE_LOADS`` operations keeps its
seed and gives the same runs. The origin's answers for the image's static
files, those it has and those it lacks, stay in a page's cache, and HQ's
answers do not. A section's phase ends only once none of the page's
requests but the held saves is in flight, so a request a save's handler
starts is answered in that section's phase however late it reaches HQ.

The plausible failures: a timer of the warm Vellum host sending HQ a request
during a later view (answered inside that view's fork, or breaking its
writes-alone guard) or during a later Vellum run; an animation of one run
still ticking in a later one; a stray answered rather than refused, or
refused silently; a broken page reused; a replaced page without its seed
script; an HQ answer served from the page's cache; and a follow-up that
reaches HQ after its section's phase has ended, answered in the next
section's fork.
"""

from __future__ import annotations

import subprocess
import sys
from contextlib import nullcontext

import pytest

from proof.editors import pages, seeding, vellum
from proof.editors.client import EditorDriver, EditorDriverError, PageResponse
from proof.editors.conftest import SUITE_APP, first_draw, publish_hq_app
from proof.editors.hq import EditorRunFailed, HQAnswers
from proof.editors.units import CheckUnit
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
# How long a host sits idle: longer than Vellum's check for form submissions
# waits before its trailing call (src/util.js::checkForFormSubmissions,
# `_.throttle(..., 10000)`).
IDLE_VIRTUAL_MS = 11_000
# Leaves Vellum's own check for form submissions waiting on its trailing
# timer, as a run's later validations leave it: the first call, for a form
# that already warns of submissions, runs at once and asks HQ nothing; the
# second, for a form that does not, waits the throttle's 10 s.
PENDING_CHECK = """() => {
    const check = window.proofVellumUtil.checkForFormSubmissions;
    check({ warnWhenChanged: true });
    check({ submissionUrl: "/a/proof/apps/view/waiting/form_has_submissions/waiting/" });
}"""


# A request for HQ sent straight to the driver's origin, as the named page
# (argv[3], empty for none) would send it; prints the origin's status. It runs
# in a process of its own: the harness's network guard refuses this one's
# sockets once HQ has booted (proof.hq.boot).
KNOCK = """
import http.client, sys
port, path, page = int(sys.argv[1]), sys.argv[2], sys.argv[3]
connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
headers = {"Host": "hq.proof.test"}
if page:
    headers["x-proof-page"] = page
connection.request("GET", path, headers=headers)
response = connection.getresponse()
response.read()
print(response.status)
"""


def _knock(driver, path, page):
    """The origin's status for a request for HQ sent to it as the named page would send it (no page when None)."""
    sent = subprocess.run(
        [sys.executable, "-I", "-S", "-c", KNOCK, str(driver.ready["port"]), path, page or ""],
        capture_output=True,
        text=True,
        check=True,
    )
    return int(sent.stdout)


def test_a_request_no_operation_of_its_page_serves_is_refused_and_fails_an_operation():
    asked = []
    knocked = []

    def answer(request):
        asked.append(request.url)
        if not knocked:
            # While this run waits on HQ, the Vellum host (which has no run) asks HQ for something.
            knocked.append(_knock(driver, "/a/proof/apps/view/form_has_submissions/", "vellum"))
        return PageResponse(200, [("Content-Type", "text/html; charset=utf-8")], b"<!doctype html><p>HQ</p>")

    with EditorDriver() as driver:
        with pytest.raises(EditorDriverError) as during:
            driver.run([{"goto": "/a/proof/apps/"}], answer=answer, deadline=20)
        assert during.value.kind == "stray" and knocked == [503]
        assert "the vellum page while the run operation was running" in str(during.value)
        assert during.value.detail["strays"] == [
            {"page": "vellum", "method": "GET", "path": "/a/proof/apps/view/form_has_submissions/", "during": "run"}
        ]

        # Between operations: from the view page, and from nothing the driver keeps.
        assert _knock(driver, "/a/proof/apps/view_module/", "views") == 503
        assert _knock(driver, "/a/proof/apps/", None) == 503
        with pytest.raises(EditorDriverError, match="between operations") as between:
            driver.run([{"goto": "/a/proof/apps/"}], answer=answer, deadline=20)
        assert [(stray["page"], stray["during"]) for stray in between.value.detail["strays"]] == [
            ("views", None),
            (None, None),
        ]
        # Each stray failed one operation; the next runs clean, on the same driver.
        driver.run([{"goto": "/a/proof/apps/"}], answer=answer, deadline=20)
        assert driver.restarts == 0
        assert len(driver.stats()["strays"]) == 3
    # Only the runs' own navigations reached Python: no stray did.
    assert asked == ["http://hq.proof.test/a/proof/apps/"] * 3


def _module_spec(state, app_id):
    module = operations.held_app(state, app_id).modules[0]
    return pages.ViewSpec(
        "view_module", app_id, module.unique_id, sections=(pages.MODULE_SETTINGS, pages.CASE_LIST, pages.CASE_DETAIL)
    )


def _idle(driver, page, script=None):
    """The driver's ``idle`` operation: ``page`` left idle for IDLE_VIRTUAL_MS of virtual time, ``script`` run first."""
    message = {"op": "idle", "page": page, "virtualMs": IDLE_VIRTUAL_MS}
    if script is not None:
        message["eval"] = script
    return driver.operation(message, answer=None, deadline=30)


def test_a_warm_vellum_host_sends_hq_nothing_once_its_run_is_over(hq, core_runner, editor_driver):
    with hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        unit = CheckUnit(state)
        app_id = publish_hq_app(state, SUITE_APP)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
        # Three runs: the second or the third reuses the host (one of them may load it afresh, the host's
        # recycle period spent).
        runs = []
        for _ in range(3):
            with unit.fork():
                runs.append(vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id))
        with unit.fork():
            fresh = vellum.fresh_open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id)
        strays = len(editor_driver.stats()["strays"])
        # Left idle for longer than Vellum's check for submissions waits, the warm host sends nothing.
        idled = _idle(editor_driver, "vellum")
        assert len(editor_driver.stats()["strays"]) == strays
        # The control: a check left waiting on the same throttle is sent as the host idles, and refused.
        with unit.fork():
            assert vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id).saved
        with pytest.raises(EditorDriverError) as waiting:
            _idle(editor_driver, "vellum", PENDING_CHECK)
    assert idled == {"page": "vellum", "virtualMs": IDLE_VIRTUAL_MS}
    assert waiting.value.kind == "stray", waiting.value
    assert waiting.value.detail["strays"] == [
        {
            "page": "vellum",
            "method": "GET",
            "path": "/a/proof/apps/view/waiting/form_has_submissions/waiting/",
            "during": "idle",
        }
    ]
    # The warm run asked HQ what a fresh page asks. (A fresh page's requests for files the image lacks reach
    # HQ's static answer; the origin answers the host's itself.)
    assert all(run.saved for run in runs) and all(run.warm or run.recycled for run in runs[1:])
    warm = next(run for run in reversed(runs) if run.warm)
    assert vellum.vellum_differences(warm, fresh) == []
    assert [e.url for e in warm.exchanges] == [e.url for e in fresh.exchanges if not e.path.startswith("/static/")]


def _animations_left_on_a_fresh_page(driver, unit, app_id, form_id):
    """How many jQuery animations a fresh page's run of the form leaves running once its last step is done."""
    options = vellum.vellum_options(unit.state, app_id, form_id)
    seed = vellum._seed(vellum.vellum_spec(options, load_delay=None))
    start = {"call": "vellum/start", "arg": {"options": options.json, "loadDelay": None, "seed": seed["seed"]}}
    steps = [step if step is not None else start for step in vellum._FRESH_STEPS]
    steps.append({"eval": "() => window.proofVellumHost.jQuery.timers.length"})
    run = driver.run(steps, answer=HQAnswers(unit.state, unit), cookies={"lang": options.lang}, seed=seed)
    return run["outcomes"][-1]["value"]


def test_the_animations_a_warm_host_run_leaves_running_end_with_it(hq, core_runner, editor_driver):
    """Under the fixed clock a jQuery animation never reaches its end: Vellum's fade-in of the messages of a form
    with a parse warning (core.js::_resetMessages) runs until the page goes. A fresh page's run leaves it running
    until its context closes; the warm host ends it with the run (steps/vellum/end.js), so the next run on the host
    finds none running, and the runs still equal a fresh page's."""
    from proof.editors.test_vellum import _with_orphan_bind

    with hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        unit = CheckUnit(state)
        app_id = publish_hq_app(state, SUITE_APP)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
        _with_orphan_bind(state, app_id, form_id)
        runs = []
        for _ in range(3):
            with unit.fork():
                runs.append(vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id))
        with unit.fork():
            left = _animations_left_on_a_fresh_page(editor_driver, unit, app_id, form_id)
        with unit.fork():
            fresh = vellum.fresh_open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id)
    # The control: a fresh page's run leaves the fade-in running when its last step is done.
    assert left >= 1
    # Every run on the host left as many running, and ended them with the run: a run on the warm host found none.
    assert [run.animations_ended for run in runs] == [left] * 3
    warm = [run for run in runs if run.warm]
    assert warm and [run.animations_at_reset for run in warm] == [0] * len(warm)
    assert [run.animations_at_reset for run in runs if not run.warm] == [None] * (3 - len(warm))
    for run in warm:
        assert vellum.vellum_differences(run, fresh) == []


class _NavigationRefused(HQAnswers):
    """HQ's answers, but the view's own navigation answered 500, as a view HQ fails to render."""

    def __call__(self, asked):
        if asked.phase == "load" and asked.headers.get("upgrade-insecure-requests") == "1":
            return PageResponse(500, [("Content-Type", "text/plain")], b"")
        return super().__call__(asked)


def test_a_failed_operation_leaves_its_page_to_be_replaced_and_the_next_gives_what_a_fresh_page_gives(
    hq, core_runner, monkeypatch
):
    """A page whose operation failed is replaced before its next operation, wherever the failure falls in the
    page's recycle period. On a driver of its own, whose pages are replaced every two operations, a view fails in
    each position: at the end of its page's period (the page is replaced once, though the failure and the period
    both ask for it), and as the first operation of a page whose period goes on, where only the failure has the
    page replaced and a broken page reused would show. The view after them, and the Vellum run after a failed one,
    give what a fresh page gives."""
    monkeypatch.setenv("PROOF_EDITORS_RECYCLE_LOADS", "2")
    with EditorDriver() as driver, hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        assert driver.ready["recycleLoads"] == 2
        unit = CheckUnit(state)
        app_id = publish_hq_app(state, SUITE_APP)
        spec = _module_spec(state, app_id)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id

        def view_pages():
            """The view pages opened so far, and the operations on the current one."""
            stats = driver.stats()["views"]
            return stats["pages"], stats["uses"]

        def refused():
            with unit.fork(), pytest.raises(EditorRunFailed, match="answered with status 500"):
                pages.run_view(driver, _NavigationRefused(state, unit), spec, on_section=lambda _i: nullcontext())

        with unit.fork():
            pages.run_view(driver, HQAnswers(state, unit), spec, on_section=lambda _i: unit.fork())
        assert view_pages() == (1, 1)
        # The page's second operation fails, ending its period.
        refused()
        assert view_pages() == (1, 2)
        # The next runs on a page opened once for both reasons, and fails as that page's first operation.
        refused()
        assert view_pages() == (2, 1)
        # Its period goes on, so only the failure has the page replaced: the next view is a new page's first.
        with unit.fork():
            view = pages.run_view(driver, HQAnswers(state, unit), spec, on_section=lambda _i: unit.fork())
        assert view_pages() == (3, 1)
        for index, held in enumerate(view.sections):
            with unit.fork():
                fresh = pages.fresh_section_save(driver, state, spec.sections[index], app_id, spec.target, unit=unit)
            assert pages.section_differences(held, fresh) == [], held.page.name

        # A warm Vellum run that fails once the host is loaded (options the host cannot read).
        with unit.fork():
            assert vellum.open_and_save(driver, HQAnswers(state, unit), app_id, form_id).saved
        broken = vellum.DesignerOptions(json="{not the designer's options", lang="en")
        with unit.fork(), pytest.raises(EditorRunFailed, match="open and save"):
            vellum.open_and_save(driver, HQAnswers(state, unit), app_id, form_id, broken)
        with unit.fork():
            after = vellum.open_and_save(driver, HQAnswers(state, unit), app_id, form_id)
        with unit.fork():
            fresh = vellum.fresh_open_and_save(driver, HQAnswers(state, unit), app_id, form_id)
    # The run after the failure loaded the host afresh because the host had failed, not because its period had
    # ended (a host kept for reuse across a failure would be reported recycled here, its period spent).
    assert not after.warm and not after.recycled
    assert vellum.vellum_differences(after, fresh) == []


def test_pages_replaced_every_recycle_loads_operations_keep_their_seed_and_give_the_same_runs(
    hq, core_runner, monkeypatch
):
    monkeypatch.setenv("PROOF_EDITORS_RECYCLE_LOADS", "2")
    with EditorDriver() as driver, hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        assert driver.ready["recycleLoads"] == 2
        unit = CheckUnit(state)
        app_id = publish_hq_app(state, SUITE_APP)
        spec = _module_spec(state, app_id)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
        views, forms, statics = [], [], []
        for _ in range(3):
            with unit.fork():
                views.append(pages.run_view(driver, HQAnswers(state, unit), spec, on_section=lambda _i: unit.fork()))
            statics.append(driver.stats()["views"]["statics"])
            with unit.fork():
                forms.append(vellum.open_and_save(driver, HQAnswers(state, unit), app_id, form_id))
        stats = driver.stats()
    # Three views on two pages (the third replaced the first), each seeded: the same run three times.
    assert stats["views"]["pages"] == 2 and stats["views"]["uses"] == 1
    assert [view.page_clock for view in views] == [seeding.epoch_ms()] * 3
    assert len({view.transcript.canonical() for view in views}) == 1
    # Vellum: a fresh load, a warm run, then (the page due for replacement) a fresh load of a new page, each
    # with the clock and the first draw its seed fixes as Vellum starts.
    assert [run.warm for run in forms] == [False, True, False] and stats["vellum"]["pages"] == 2
    assert [run.recycled for run in forms] == [False, False, True]
    assert len({run.transcript.canonical() for run in forms}) == 1
    seed = forms[0].seed["seed"]
    assert [(run.page_clock, run.page_draw) for run in forms] == [(seeding.epoch_ms(), first_draw(seed))] * 3
    assert stats["strays"] == []
    # The origin answers the image's static files, those it has and those it lacks (HQ's stylesheets, a 404), as
    # never to be asked again: a page asks for each once, its next load asks for none, and a new page (a context of
    # its own, with a cache of its own) asks for them all again. HQ's answers are not kept: every load asked HQ for
    # its page.
    first, second, third = statics
    assert first["editors"] > 0 and first["missing"] > 0
    assert second == first
    assert third == {kind: 2 * count for kind, count in first.items()}
    assert [[e.url_name for e in view.exchanges].count("view_module") for view in views] == [1, 1, 1]


def test_a_request_a_saves_handler_starts_is_answered_in_its_sections_phase_however_late_it_reaches_hq(
    hq, core_runner, monkeypatch
):
    # Every request the page sends reaches HQ 300 ms after the page starts it: a section's bar leaves "Saving",
    # and the build errors its handler asks for (app_manager.js::updateDOM) are still on their way.
    monkeypatch.setenv("PROOF_EDITORS_LATENCY_MS", "300")
    with EditorDriver() as driver, hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        assert driver.ready["latencyMs"] == 300
        unit = CheckUnit(state)
        app_id = publish_hq_app(state, SUITE_APP)
        spec = _module_spec(state, app_id)
        with unit.fork():
            view = pages.run_view(driver, HQAnswers(state, unit), spec, on_section=lambda _i: unit.fork())
    for index, section in enumerate(view.sections):
        asked = [(e.phase, e.url_name) for e in section.exchanges if e.phase != "load"]
        assert asked == [
            (f"section:{index}", section.page.save),
            (f"followup:{index}", "validate_module_for_build"),
        ], section.page.name
        assert section.bar_state == "savebtn-bar-saved"
