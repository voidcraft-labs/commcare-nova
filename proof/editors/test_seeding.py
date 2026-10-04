"""A page's clock and randomness are fixed by its run's spec, and fixing them changes nothing an editor shows.

Contract (``driver/steps/page/seed.js``): a seeded page reads the HQ pin's
epoch from ``Date`` and draws ``Math.random`` and ``crypto.getRandomValues``
from a generator seeded by its run's spec, the same draws for the same seed
and others for another; timers and ``performance`` stay the browser's, and
the page keeps the API its origin gives it (no ``crypto.randomUUID``: the
origin is not a secure context). A seeded Vellum run, on a host loaded for
it or on the warm host, restarts the generator from its own seed as Vellum
starts (``steps/vellum/start.js``): it reads the epoch and its seed's first
draw (computed apart from the page, ``conftest.first_draw``), and an
unseeded run reads neither. Seeding is an input, not an observation:
every fixture view and form, run seeded and unseeded, records the same:
what the browser showed (every section's Save button and alerts, the page's
requests, errors, console errors and dialogs, Vellum's record of the form,
its save and its state after) and every request HQ answered, byte for byte,
with HQ's answer. The plausible failures: a seed that never reaches the page
(the init script dropped on the reused page or the Vellum host, a warm
host's generator never restarted, a warm host of one seededness reused for
a run of the other), one that reaches it too late
(after the page's own scripts drew), a clock that freezes timers, a seed
that changes what a save sends, and a frozen clock that changes what a page
shows or asks (a debounce or an animation that never ends, which
``steps/page/seed.js`` describes).
"""

from __future__ import annotations

from proof.editors import pages, seeding, transcripts, vellum
from proof.editors.client import EditorDriver, PageResponse
from proof.editors.conftest import (
    TWO_LANGUAGE_APP,
    advanced_app,
    app_views,
    first_draw,
    publish_hq_app,
    suite_app,
    user_properties_form,
)
from proof.editors.hq import HQAnswers, request_digest
from proof.editors.units import CheckUnit
from proof.editors.vellum import HOST_PAGE
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
USERCASE_CONFIGURATION = Configuration(privileges={"CLOUDCARE", "USERCASE"})

EPOCH = 1790374313000
DRAWS = """() => ({
    now: Date.now(),
    made: new Date().getTime(),
    random: [Math.random(), Math.random()],
    bytes: Array.from(crypto.getRandomValues(new Uint8Array(6))),
    randomUUID: typeof crypto.randomUUID,
    timerRan: null,
})"""
# A timer still runs on the browser's own clock: a zero-delay timeout fires.
TIMER = """() => new Promise((resolve) => setTimeout(() => resolve(true), 0))"""


def _nothing_from_hq(request):
    return PageResponse(404, [("Content-Type", "text/plain")], b"")


def _draws(driver, seed):
    run = driver.run(
        [
            {"goto": HOST_PAGE},
            {"waitFor": "document.readyState === 'complete' && !!window.proofVellumHost"},
            {"eval": DRAWS},
            {"eval": TIMER},
        ],
        answer=_nothing_from_hq,
        seed=seed,
    )
    draws = run["outcomes"][2]["value"]
    draws["timerRan"] = run["outcomes"][3]["value"]
    return draws


def test_a_seeded_page_reads_the_epoch_and_draws_from_its_seed():
    one = {"seed": "0123456789abcdef0123456789abcdef", "epoch": EPOCH}
    other = {"seed": "fedcba9876543210fedcba9876543210", "epoch": EPOCH}
    with EditorDriver() as driver:
        first, again, different = _draws(driver, one), _draws(driver, one), _draws(driver, other)
        unseeded, unseeded_again = _draws(driver, None), _draws(driver, None)
    assert first == again
    assert first["now"] == first["made"] == EPOCH
    assert different["now"] == EPOCH and different["random"] != first["random"] and different["bytes"] != first["bytes"]
    assert all(0 <= value < 1 for value in first["random"])
    assert unseeded["now"] != EPOCH and unseeded["random"] != unseeded_again["random"]
    assert first["randomUUID"] == unseeded["randomUUID"] == "undefined"
    assert first["timerRan"] is True and unseeded["timerRan"] is True


def _view_record(view):
    """What a view run records: what the browser showed (its outputs), and every request HQ answered and its answer."""
    return {
        "outputs": view.outputs,
        "exchanges": [
            (e.phase, e.method, e.url, request_digest(e.method, e.url, e.headers, e.body).hex(), e.response_digest)
            for e in view.exchanges
        ],
    }


def _vellum_record(run):
    """What a Vellum run records: its outputs (the parse's own scheduling left out, which depends on when HQ's
    data sources arrive: vellum._comparable_events), and every request HQ answered and its answer."""
    outputs = dict(run.outputs)
    outputs["after"] = {key: value for key, value in outputs["after"].items() if key != "events"}
    outputs["events"] = vellum._comparable_events(run.events)
    return {
        "outputs": outputs,
        "exchanges": [
            (e.phase, e.method, e.url, request_digest(e.method, e.url, e.headers, e.body).hex(), e.response_digest)
            for e in run.exchanges
        ],
    }


def _seeded_and_unseeded(run):
    """``run(seeded)`` for both, each in a fork of the same state."""
    return {seeded: run(seeded) for seeded in (True, False)}


def _views_seeded_and_unseeded(driver, unit, specs):
    compared = 0
    for spec in specs:

        def view(seeded, spec=spec):
            variant = pages.ViewSpec(spec.view, spec.app_id, spec.target, spec.cookies, spec.sections, seeded)
            with unit.fork():
                return pages.run_view(driver, HQAnswers(unit.state, unit), variant, on_section=lambda _i: unit.fork())

        runs = _seeded_and_unseeded(view)
        assert runs[True].page_clock == seeding.epoch_ms() != runs[False].page_clock
        for seeded, unseeded in zip(runs[True].sections, runs[False].sections, strict=True):
            assert pages.section_differences(seeded, unseeded) == [], seeded.page.name
        assert _view_record(runs[True]) == _view_record(runs[False]), spec
        compared += len(spec.sections)
    return compared


def _forms_seeded_and_unseeded(driver, unit, forms):
    """Every form unseeded, then every form seeded, each in a fork of the same state.

    The first seeded run loads the host afresh (the host's document was not
    seeded) and the rest reuse it, so seeded runs on a fresh host and on the
    warm host are both compared.
    """
    runs = {}
    for seeded in (False, True):
        for app_id, form_id, lang in forms:
            with unit.fork():
                runs[seeded, form_id] = vellum.open_and_save(
                    driver, HQAnswers(unit.state, unit), app_id, form_id, lang=lang, seeded=seeded
                )
    seeded_runs = [runs[True, form_id] for _, form_id, _ in forms]
    # The rest reuse the host, or would but for its recycle period, and so at least two do.
    assert not seeded_runs[0].warm and all(run.warm or run.recycled for run in seeded_runs[1:])
    assert sum(run.warm for run in seeded_runs) >= len(forms) - 2
    for _, form_id, _ in forms:
        seeded, unseeded = runs[True, form_id], runs[False, form_id]
        assert seeded.saved and vellum.vellum_differences(seeded, unseeded) == [], form_id
        assert _vellum_record(seeded) == _vellum_record(unseeded), form_id
        # The seeded run's page read the epoch and its own seed's first draw as Vellum started; the seed is
        # its spec's. The unseeded run's read the browser's clock and randomness.
        assert seeded.seed == {"seed": transcripts.digest(seeded.spec)[:32], "epoch": seeding.epoch_ms()}
        assert (seeded.page_clock, seeded.page_draw) == (seeding.epoch_ms(), first_draw(seeded.seed["seed"]))
        assert unseeded.seed is None and unseeded.page_clock != seeding.epoch_ms()
        assert unseeded.page_draw != first_draw(seeded.seed["seed"])
    # Each run read a draw of its own: no two seeds, and no unseeded runs, drew alike.
    assert len({run.page_draw for run in runs.values()}) == len(runs)


def test_seeded_and_unseeded_runs_record_the_same_on_every_fixture(hq, core_runner, editor_driver):
    """Every fixture view (basic and advanced modules, case search, UI translations, a second display language,
    user properties) and their forms in Vellum, seeded and unseeded: the same outputs and the same HQ exchanges."""
    sections = 0
    with hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        unit = CheckUnit(state)
        suite = operations.held_app(state, suite_app(state))
        advanced = operations.held_app(state, advanced_app(state))
        bilingual = operations.held_app(state, publish_hq_app(state, TWO_LANGUAGE_APP))
        specs = (
            app_views(state, suite)
            + app_views(state, advanced, modules={1}, forms={(1, 0)})
            + app_views(state, bilingual, cookies={"lang": "es"})
        )
        sections += _views_seeded_and_unseeded(editor_driver, unit, specs)
        _forms_seeded_and_unseeded(
            editor_driver,
            unit,
            [
                (suite._id, suite.modules[0].forms[0].unique_id, None),
                (suite._id, suite.modules[0].forms[1].unique_id, None),
                (advanced._id, advanced.modules[1].forms[0].unique_id, None),
                (bilingual._id, bilingual.modules[0].forms[0].unique_id, "es"),
            ],
        )
    with hq_check(USERCASE_CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        unit = CheckUnit(state)
        app_id, form_id = user_properties_form(state)
        spec = pages.ViewSpec("view_form", app_id, form_id, sections=(pages.USER_PROPERTIES,))
        sections += _views_seeded_and_unseeded(editor_driver, unit, [spec])
    names = {page.name for spec in specs for page in spec.sections} | {pages.USER_PROPERTIES.name}
    assert names == {page.name for page in pages.PAGES} - {pages.CASE_SEARCH.name}, names
    assert sections >= 20, sections
