"""Vellum, HQ's form builder, opening and saving a form as HQ's form designer does.

The form designer page (``views/formdesigner.py::form_source``) hands Vellum
the options ``_get_form_designer_view`` builds from four helpers:
``_get_base_vellum_options``, ``_get_vellum_core_context``,
``_get_vellum_plugins`` and ``_get_vellum_features``. ``vellum_options``
calls those same helpers, in the same order and with the same arguments,
through the HQ package, and serializes the result as the page's template does
(``hq_shared_tags.py::JSON``). The host page (the image's editor build) runs
HQ's vendored Vellum with HQ's own jQuery, Bootstrap 3, select2 and
underscore, and adds to the options what HQ's form designer page adds
(``form_designer.js``, taken from it at image build time).

A run waits on Vellum's own events, never a fixed time
(``driver/steps/vellum/*.js``): the form's load (``core.formLoadedCallback``,
which fires on success and failure), its readiness (``core.onReady``) and the
data sources' arrival (the ``vellum.datasources`` ``change`` event). It
records the parse errors, every question's messages and the serialization
warnings, then saves as a person does (Vellum's Save button, turned to
"Save" first) unless Vellum would refuse to serialize the form, or the data
sources did not reach Vellum before it parsed the form.

Vellum asks HQ for the data sources when it starts and parses the form on a
timer (``core.js::loadXFormOrError``: ``window.setTimeout`` with
``core.loadDelay``, scheduled right after ``formLoadingCallback``), and the
hashtags it writes depend on which came first
(``datasources.js::getHashtagMap``). On HQ's page the sources arrive first;
here HQ answers them from Python, which can take longer than the timer. So
the driver holds that one timer's callback until the sources have arrived
(``change``) or failed (``error``), and runs it then: the parse always comes
after the sources, as HQ's form designer sees it. Vellum's save request goes
to HQ's own view (``views/forms.py::patch_xform``, or ``edit_form_attr`` for
a full save), and the run waits until the save is over: Vellum's
``core.onFormSave`` has fired, its Save button has left "Saving", and no
request of Vellum's is in flight (Vellum sends a full save of its own after
a save whose answer holds no matching ``sha1``, ``core.js::fn.send``, and
calls ``onFormSave`` for each), or Vellum shows a refusal (its Save button
offers "Try Again", or a modal). Every request Vellum makes (the data
sources from ``get_form_data_schema``, ``form_has_submissions``) is answered
by HQ's own views (``proof.editors.hq``). The browser holds the ``lang``
cookie HQ's form designer page sets (``_get_form_designer_view``:
``set_lang_cookie`` with the display language), so HQ's save view writes the
form's name in the display language, as it does for a person.

Two ways to run it:

- ``open_and_save`` uses the driver's warm Vellum host when it has one, as
  Vellum's own tests reuse their instance (``tests/utils.js::init``): the
  instance destroyed, the modals and backdrops removed, the container
  emptied, the location's hash and the page's storage cleared, and Vellum
  started again with HQ's options at a load delay of 0 (Vellum's
  ``tests/options.js``), the parse still held for the data sources
  (``driver/steps/vellum/reset.js``). A seeded run's page clock is the
  host's (a host is reused only for runs seeded alike, at the same epoch),
  and the generator behind Math.random restarts from the run's own seed as
  Vellum starts, on a warm host and on a host loaded for the run alike
  (``driver/steps/vellum/start.js``, which reports the clock and first draw
  it read: ``VellumRun.page_clock``, ``page_draw``). Vellum keeps an
  instance's state in the instance (``this.data``). What an instance leaves
  outside it:

  - the listeners it binds on the document and window and never removes
    (``core.js``: keydown hotkeys, a click on ``.jstree-hover``,
    ``hashchange``, ``beforeunload``; ``window.js``: resize and scroll;
    ``copy-paste.js``: cut, copy, paste and keydown; ``databrowser.js``:
    scroll; ``richText.js``: ``selectionchange``, one per rich text editor),
    which answer only to typing, clicks, clipboard use, hash changes,
    leaving the page, resizing and scrolling, none of which a run does (the
    hash is reset without an event), and to selection changes, where an old
    instance's handler touches only its own editor, no longer on the page.
    They keep their instances alive, about 0.9 MB a run, so the driver loads
    the host afresh every 50 runs (``driver.mjs``, ``VELLUM_RECYCLE_RUNS``);
  - one piece of module state every instance shares and that acts on its
    own: the check for form submissions (``util.js::checkForFormSubmissions``,
    one ``_.throttle`` with a 10 s wait, called by every question's
    ``validate``, ``mugs.js``). On a fresh page its first call is made at
    once and the next ones leave a trailing call 10 s on, which the closing
    context never lets run; on a kept page that trailing call would send
    the form's ``form_has_submissions`` request after the run, into whatever
    operation runs then, and the next form's first call would not be made
    at once. So the driver finds Vellum's util module when it loads the host
    (``driver.mjs::exposeVellumModules``: the module is inside the vendored
    build's own scope, which the inspector reaches through the core plugin's
    closures) and cancels the throttle at the end of every clean run and
    again at the reset (``driver/steps/vellum/end.js``), which puts it back
    as a fresh page starts it;
  - the mug types and property specs of Vellum's mugs module, which every
    instance's plugins write into in place (``core.js::getMugTypes`` and
    ``getMugSpec`` return the module's own ``baseMugTypes`` and
    ``baseSpecs``; ``commcareConnect.js``, ``commtrack.js``,
    ``saveToCase.js`` and the other plugins add their types and properties
    to them), and ``mugs.js::MugTypesManager`` gives each type its valid
    child types only where it has none yet. HQ chooses the plugins per
    project (``views/formdesigner.py::_get_vellum_plugins``), so a kept host
    would give a form the types of the instances before it, and a question
    tree whose root admits only the children the host's first instance
    knew: a Connect learn module after a form of a project without Connect
    is left out of the tree, so Vellum never validates it
    (``core.js::_populateTree``) and its id's error is missing. The driver
    keeps every plain object reachable from the module as the freshly
    loaded host holds it (``driver/steps/vellum/shared.js``) and the reset
    puts each back (``VellumRun.shared_at_reset``, how many it found
    changed);
  - the host's jQuery animations. Under the run's fixed clock an animation
    never reaches its end (Vellum fades its messages in when a form it loads
    has errors, ``core.js::_resetMessages``): on a fresh page it ticks until
    the context closes, on a kept page it would tick on every animation
    frame for as long as the host lives, each run adding its own. The end of
    every clean run and the reset end them as a closing context does: off
    jQuery's list of running animations, its frame loop stopped, their
    callbacks never called (``VellumRun.animations_ended``,
    ``animations_at_reset``).

  After a run that did not end clean (its load failed, the page raised an
  error, a modal showed, HQ answered a request with an error status, or
  its Save button did not end "Saved") the host page leaves for
  about:blank, and the next form gets a fresh load of it; so it does after
  a clean run whose page loaded an image from HQ (the thumbnail Vellum shows
  of a form's image, ``templates/multimedia_existing_image.html``): a
  document shows an image it has loaded again without asking HQ (the HTML
  standard's list of available images, which nothing in the page clears),
  where a fresh page asks HQ for it (``VellumRun.kept``,
  ``driver.mjs::runVellum``). Any request for HQ the host page sends while
  it has no run (something a run started outliving it) is refused
  unanswered and fails the operation then running, or the next one
  (``driver.mjs::refuseStray``).
- ``fresh_open_and_save`` loads the host page in a fresh browser context for
  one form, at HQ's own load delay, as the driver always did; the warm run is
  proven equal to it (``test_vellum_warm_equivalence.py``), and the in-band
  audit (``PROOF_EDITOR_AUDIT``) reruns a form with it and requires the same
  outcome, a failure included.

A warm run leaves a transcript (``proof.editors.transcripts``), and
``replay`` stands for a live run when HQ answers every recorded request as it
did. ``round_trips`` opens and saves a form, then does it again on the source
HQ stored, with the options recomputed from HQ's state after the first save.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from proof.editors import seeding, transcripts
from proof.editors.client import EditorDriver, EditorDriverError, cookie_list
from proof.editors.hq import EditorRunFailed, Exchange, HQAnswers, HQRefusedPageRequest
from proof.editors.pages import AUDIT_ENVIRONMENT, audit_selection, page_console_errors, page_requests
from proof.hq import requests as hq_requests

HOST_PAGE = "/static/vellum/host.html"
# Where the editors' static files are served (the driver's origin answers them, ``driver.mjs``).
STATIC_PREFIX = "/static/"
# HQ's own load delay (core.js's default, which HQ's options keep): a fresh
# page runs at it; a warm instance at 0, as Vellum's own tests do.
WARM_LOAD_DELAY = 0


class VellumSourcesRefused(AssertionError):
    """Vellum did not get HQ's data sources before it parsed the form."""


@dataclass
class VellumRun:
    """One open and save of a form in Vellum, and what HQ did with it."""

    form_unique_id: str
    source: str
    loaded: bool
    load_error: str | None
    form_errors: list
    questions: list
    serialization_warnings: list
    pre_save_alerts: list
    case_references: dict | None
    created_xml: str | None
    sources_before_parse: bool | None
    saved: bool
    save_refusal: str | None
    # Every save request Vellum sent HQ, in order, and the last of them.
    saves: list[Exchange]
    save: Exchange | None
    # The form's source as HQ holds it after the run (None where the caller did not ask for it).
    stored_source: str | None
    events: list
    save_button: str | None
    # jQuery's count of Vellum's requests still in flight when the run ended.
    requests_in_flight: int
    last_saved_is_created: bool
    modals: list
    exchanges: list[Exchange]
    page_errors: list
    seconds: dict = field(default_factory=dict)
    # Whether the run reused the driver's warm Vellum host, came from a
    # replayed transcript, and its transcript (None for a fresh-page run).
    warm: bool = False
    # Whether the host could have been reused and was loaded afresh because
    # it had served its recycle period (driver.mjs, VELLUM_RECYCLE_RUNS).
    recycled: bool = False
    # Whether the host stayed for the next form after the run: a clean run
    # whose page loaded no image from HQ (driver.mjs::runVellum); None for a
    # run on a fresh page, and for a replay.
    kept: bool | None = None
    replayed: bool = False
    transcript: transcripts.Transcript | None = None
    # What the browser showed (the transcript's outputs).
    outputs: dict = field(default_factory=dict)
    # The run's spec (``vellum_spec``), the seed the page's clock and
    # randomness were fixed with (``{seed, epoch}``, None when they were the
    # browser's own), and what the page read as Vellum started
    # (``driver/steps/vellum/start.js``): Date.now() and Math.random's first
    # value. A replay has the spec and seed and no page.
    spec: dict | None = None
    seed: dict | None = None
    page_clock: int | None = None
    page_draw: float | None = None
    # The host's jQuery animations still running when the warm host was reset
    # for this run (None for a host loaded for it), and those the run left
    # running when it ended clean, which the driver ended as a closing
    # context ends them (``driver/steps/vellum/end.js``; None when it did not
    # end clean, the host then left for about:blank). Under the fixed clock
    # an animation never reaches its end on its own.
    animations_at_reset: int | None = None
    animations_ended: int | None = None
    # How many of the objects Vellum's instances share (its mugs module's
    # types and specs) the warm host's reset found changed by the instances
    # before and put back (``driver/steps/vellum/shared.js``); None for a host
    # loaded for this run.
    shared_at_reset: int | None = None
    # Vellum's events as the page noted them, each with the milliseconds since
    # Vellum started (``at``), which the run's outputs leave out; None for a
    # replay, which has no page.
    timed_events: list | None = None

    def event_names(self):
        return [event["name"] for event in self.events]

    def form_saves(self):
        """The answers Vellum took as saved (its ``core.onFormSave`` calls), in order."""
        return [event.get("detail") for event in self.events if event["name"] == "onFormSave"]

    def question_errors(self):
        return [
            (question["path"], message)
            for question in self.questions
            for message in question["messages"]
            if message["level"] == "error"
        ]


@dataclass(frozen=True)
class DesignerOptions:
    """What HQ's form designer page gives Vellum and the browser."""

    # Vellum's options, as the page's template serializes them.
    json: str
    # The display language, which the page's response sets as the lang cookie.
    lang: str
    # The form's source as HQ held it when the options were computed (the options' ``core.form``), or None
    # where the options were given without it, and a run reads it from HQ.
    source: str | None = None


def vellum_options(state, app_id, form_unique_id, *, lang=None) -> DesignerOptions:
    """The options HQ's form designer page gives Vellum, and the display language it sets.

    ``views/formdesigner.py::_get_form_designer_view``'s own composition: the
    app manager's base context gives the display language (``lang`` is the
    language the person asked for, as the page's ``lang`` cookie or query
    carries it), then the four helpers, each called through the HQ package.
    """
    from corehq.apps.app_manager.dbaccessors import get_app
    from corehq.apps.app_manager.views import formdesigner
    from corehq.apps.app_manager.views.apps import get_apps_base_context
    from corehq.apps.hqwebapp.templatetags.hq_shared_tags import JSON
    from django.urls import reverse

    path = reverse("form_source", args=[state.domain, app_id, form_unique_id])
    request = hq_requests.get(state, path, lang=lang)
    app = get_app(state.domain, app_id)
    form = app.get_form(form_unique_id)
    module = form.get_module()
    context = get_apps_base_context(request, state.domain, app)
    options = formdesigner._get_base_vellum_options(request, state.domain, form, context["lang"])
    options["core"] = formdesigner._get_vellum_core_context(request, state.domain, app, module, form, context["lang"])
    options["plugins"] = formdesigner._get_vellum_plugins(state.domain, form, module, options)
    options["features"] = formdesigner._get_vellum_features(request, state.domain, app)
    return DesignerOptions(json=JSON(options), lang=context["lang"], source=form.source)


def _without_times(events):
    """Vellum's events as a run's outputs keep them: each event's name and detail, not when it happened."""
    return [{key: value for key, value in event.items() if key != "at"} for event in events or []]


def _outputs(record, saved, after, run) -> dict:
    """What the browser showed in a Vellum run: the transcript's outputs (no times)."""
    record = dict(record or {})
    if "events" in record:
        record["events"] = _without_times(record["events"])
    after = dict(after or {})
    after["events"] = _without_times(after.get("events"))
    return {
        "record": record,
        "save": saved,
        "after": after,
        "requests": page_requests(run.get("requests", [])),
        "pageErrors": [entry["error"] if isinstance(entry, dict) else entry for entry in run.get("pageErrors", [])],
        "consoleErrors": [entry["error"] for entry in page_console_errors(run.get("consoleErrors", []))],
        "dialogs": [{key: value for key, value in entry.items() if key != "phase"} for entry in run.get("dialogs", [])],
    }


def _source(state, app_id, form_unique_id):
    from corehq.apps.app_manager.dbaccessors import get_app

    return get_app(state.domain, app_id).get_form(form_unique_id).source


def _vellum_run(state, app_id, form_unique_id, source, outputs, exchanges, *, read_stored=True, **extra) -> VellumRun:
    """A Vellum run from what the browser showed and HQ's exchanges; fails where Vellum parsed without the sources.

    With ``read_stored`` the form's source as HQ holds it after the run is
    read (``VellumRun.stored_source``); a caller that reads HQ's stored app
    itself passes False, and the run's ``stored_source`` is None.
    """
    record, saved, after = outputs["record"], outputs["save"], outputs["after"]
    events = after["events"]
    if any(event["name"] == "datasources:error" for event in events):
        raise VellumSourcesRefused(
            f"Vellum could not load the data sources for form {form_unique_id} from HQ's get_form_data_schema,"
            " so the driver did not save it (HQ holds the form as it was); see the run's exchanges for HQ's answer."
        )
    if record["loaded"] and not record["sourcesBeforeParse"]:
        # The driver holds Vellum's parse until the sources have arrived
        # (driver/steps/vellum/start.js), so this is the hold failing: Vellum
        # scheduled its parse some other way.
        raise VellumSourcesRefused(
            f"HQ's data sources for form {form_unique_id} reached Vellum only after it parsed the form, which is"
            " not the order HQ's form designer sees, so the driver did not save it (HQ holds the form as it was)."
            " The driver holds the first timer Vellum sets after formLoadingCallback (core.js::loadXFormOrError);"
            f" check that Vellum still parses on that timer. Events: {[e['name'] for e in events]}"
        )
    saves = [e for e in exchanges if e.method == "POST" and e.url_name in ("patch_xform", "edit_form_attr")]
    stored = _source(state, app_id, form_unique_id) if read_stored else None
    return VellumRun(
        form_unique_id=form_unique_id,
        source=source,
        loaded=record["loaded"],
        load_error=record.get("loadError"),
        form_errors=record.get("formErrors", []),
        questions=record.get("questions", []),
        serialization_warnings=record.get("serializationWarnings", []),
        pre_save_alerts=record.get("preSaveAlerts", []),
        case_references=record.get("caseReferences"),
        created_xml=record.get("xml"),
        sources_before_parse=record.get("sourcesBeforeParse"),
        saved=saved["saved"],
        save_refusal=saved.get("reason"),
        saves=saves,
        save=saves[-1] if saves else None,
        stored_source=stored,
        events=events,
        save_button=after["saveButton"],
        requests_in_flight=after["requestsInFlight"],
        last_saved_is_created=after["lastSavedIsCreated"],
        modals=after["modals"],
        exchanges=list(exchanges),
        page_errors=list(outputs["pageErrors"]),
        outputs=outputs,
        **extra,
    )


def _answers(answers_or_state) -> HQAnswers:
    return answers_or_state if isinstance(answers_or_state, HQAnswers) else HQAnswers(answers_or_state)


def _designer_options(state, app_id, form_unique_id, options, lang) -> tuple[DesignerOptions, float]:
    if isinstance(options, DesignerOptions):
        return options, 0.0
    if isinstance(options, str):
        return DesignerOptions(json=options, lang=lang), 0.0
    started = time.perf_counter()
    computed = vellum_options(state, app_id, form_unique_id, lang=lang)
    return computed, time.perf_counter() - started


def vellum_spec(options: DesignerOptions, *, load_delay, seeded=True) -> dict:
    """Everything the browser is given for one Vellum run: the run spec its transcript is keyed by."""
    return {
        "kind": "vellum",
        "host": HOST_PAGE,
        "options": options.json,
        "loadDelay": load_delay,
        "cookies": [["lang", options.lang]],
        "epoch": seeding.epoch_ms() if seeded else None,
    }


def _seed(spec):
    return None if spec["epoch"] is None else {"seed": transcripts.digest(spec)[:32], "epoch": spec["epoch"]}


def open_and_save(
    driver: EditorDriver,
    answers,
    app_id,
    form_unique_id,
    options=None,
    *,
    lang=None,
    deadline=120.0,
    seeded=True,
    read_stored=True,
) -> VellumRun:
    """Opens the form HQ holds in Vellum on the driver's warm host and saves it through HQ's view.

    ``answers`` is the run's ``HQAnswers`` (or an HQ state, answered by a new
    one); ``options`` is HQ's form designer options for the form
    (``DesignerOptions``, or their JSON with ``lang`` the display language),
    computed from HQ's state when not given. Fails when a request Vellum made
    reached something the harness refuses or broke an HQ view
    (``HQRefusedPageRequest``), and when the driver could not finish the run
    (``EditorRunFailed``). ``read_stored`` is ``_vellum_run``'s.

    When the in-band audit chooses the form (``PROOF_EDITOR_AUDIT``), it is
    first run on a fresh page at HQ's own load delay in a fork of the unit,
    and the two runs must end the same way: the same run
    (``vellum_differences``), or the same failure with the same HQ views
    failing (``outcome_differences``). Then the warm run's own outcome is
    the call's.
    """
    answers = _answers(answers)
    state = answers.state
    options, options_seconds = _designer_options(state, app_id, form_unique_id, options, lang)
    audited = None
    if audit_selection(1):
        if answers.unit is None:
            raise ValueError(f"{AUDIT_ENVIRONMENT} reruns a form in a fork of the unit, and these answers have none.")
        with answers.unit.fork():
            audited = _outcome(
                lambda: fresh_open_and_save(
                    driver,
                    HQAnswers(state, answers.unit),
                    app_id,
                    form_unique_id,
                    options,
                    deadline=deadline,
                    seeded=seeded,
                )
            )
    warm = _outcome(
        lambda: _warm_open_and_save(
            driver,
            answers,
            app_id,
            form_unique_id,
            options,
            options_seconds,
            deadline=deadline,
            seeded=seeded,
            read_stored=read_stored,
        )
    )
    if audited is not None:
        found = outcome_differences(warm, audited)
        if found:
            raise VellumAuditMismatch(
                f"Vellum's run of form {form_unique_id} on the warm host differs from a fresh page's at HQ's own"
                f" load delay over the same state: {found}"
            )
    run, error = warm
    if error is not None:
        raise error
    return run


def _warm_open_and_save(
    driver, answers, app_id, form_unique_id, options, options_seconds, *, deadline, seeded, read_stored=True
) -> VellumRun:
    """One run of the form on the driver's warm host (``open_and_save`` without the audit)."""
    state = answers.state
    source = options.source if options.source is not None else _source(state, app_id, form_unique_id)
    spec = vellum_spec(options, load_delay=WARM_LOAD_DELAY, seeded=seeded)
    message = {
        "op": "vellum",
        "options": options.json,
        "loadDelay": WARM_LOAD_DELAY,
        "cookies": cookie_list({"lang": options.lang}),
        "seed": _seed(spec),
        "deadlineMs": int(deadline * 1000),
    }
    first = len(answers.exchanges)
    started = time.perf_counter()
    try:
        result = driver.operation(message, answer=answers, deadline=deadline)
    except EditorDriverError as error:
        raise EditorRunFailed(f"Vellum's open and save of form {form_unique_id}", error, answers) from error
    seconds = time.perf_counter() - started
    answers.check()
    exchanges = answers.exchanges[first:]
    outputs = _outputs(result.get("record"), result.get("save"), result.get("after"), result)
    page = result.get("started") or {}
    reset, ended = result.get("reset"), result.get("ended")
    timed_events = list((result.get("after") or {}).get("events") or [])
    return _vellum_run(
        state,
        app_id,
        form_unique_id,
        source,
        outputs,
        exchanges,
        read_stored=read_stored,
        warm=result["warm"],
        recycled=result["recycled"],
        kept=result["kept"],
        transcript=transcripts.from_exchanges(spec, exchanges, outputs),
        spec=spec,
        seed=_seed(spec),
        page_clock=page.get("clock"),
        page_draw=page.get("draw"),
        animations_at_reset=None if reset is None else reset["animations"],
        shared_at_reset=None if reset is None else reset["shared"],
        animations_ended=None if ended is None else ended["animations"],
        timed_events=timed_events,
        seconds={
            "options": round(options_seconds, 3),
            "open": result["stages"].get("open", 0.0),
            "save": result["stages"].get("save", 0.0),
            "run": round(seconds, 3),
        },
    )


def _outcome(run):
    """``run()``'s outcome: ``(run, None)``, or ``(None, failure)`` when it failed as a Vellum run fails.

    A run fails when the driver could not finish it (``EditorRunFailed``), a
    request reached something the harness refuses or broke an HQ view
    (``HQRefusedPageRequest``), or Vellum parsed the form without HQ's data
    sources (``VellumSourcesRefused``).
    """
    try:
        return run(), None
    except (EditorRunFailed, HQRefusedPageRequest, VellumSourcesRefused) as failure:
        return None, failure


def _failed_views(failure):
    """The HQ requests a failure names as failed: (method, view, status, what the view raised), in order."""
    return [
        (exchange.method, exchange.url_name, exchange.status, exchange.raised)
        for exchange in getattr(failure, "exchanges", [])
        if exchange.error or exchange.refusal
    ]


def outcome_differences(warm, fresh) -> list[str]:
    """Where a warm run's outcome differs from a fresh page's: each ``(run, failure)`` (``_outcome``).

    Two runs are compared by ``vellum_differences``; two failures by their
    kind and the HQ requests each names as failed; a run and a failure always
    differ.
    """
    (warm_run, warm_failure), (fresh_run, fresh_failure) = warm, fresh
    if warm_failure is None and fresh_failure is None:
        return vellum_differences(warm_run, fresh_run)
    if warm_failure is None or fresh_failure is None:
        failed, succeeded = ("warm", "fresh") if warm_failure is not None else ("fresh", "warm")
        failure = warm_failure if warm_failure is not None else fresh_failure
        return [f"the {failed} run failed and the {succeeded} run did not ({type(failure).__name__}: {failure})"]
    found = []
    if type(warm_failure) is not type(fresh_failure):
        found.append(f"how the runs failed ({type(warm_failure).__name__} and {type(fresh_failure).__name__})")
    if _failed_views(warm_failure) != _failed_views(fresh_failure):
        found.append(f"HQ's failed answers ({_failed_views(warm_failure)} and {_failed_views(fresh_failure)})")
    return found


class VellumAuditMismatch(AssertionError):
    """A warm Vellum run differs from a fresh page's run of the same form over the same state."""


def _comparable_record(record):
    """Vellum's record of a form as compared: its events left out (their times, and the parse's wait for the
    data sources, depend on the load delay)."""
    return {key: value for key, value in (record or {}).items() if key != "events"}


def _record_differences(warm, fresh) -> list[str]:
    """The entries of Vellum's record (``driver/steps/vellum/record.js``) in which two runs differ, by name."""
    warm, fresh = _comparable_record(warm), _comparable_record(fresh)
    return sorted(key for key in warm.keys() | fresh.keys() if warm.get(key) != fresh.get(key))


def _comparable_events(events):
    """Vellum's events as compared: their names, the parse's own scheduling (``parse:*``) left out."""
    return [event["name"] for event in events if not event["name"].startswith("parse:")]


def _asked(run: VellumRun) -> list:
    """Every request the page had HQ answer, by method, path and query, in a fixed order, but for the editors'
    static files: the warm host's origin answers those itself, and a fresh page asks HQ for one the editors' static
    directory lacks; whether the page asks for one at all depends on Chromium's cache (``pages.page_requests``
    leaves them out of a run's outputs too)."""
    return sorted(
        (exchange.method, exchange.path, exchange.query)
        for exchange in run.exchanges
        if not exchange.path.startswith(STATIC_PREFIX)
    )


def vellum_differences(warm: VellumRun, fresh: VellumRun) -> list[str]:
    """Where a warm run of a form differs from a fresh page's run of it.

    Compared: Vellum's record of the form (its load failure or its parse
    errors, question messages, serialization warnings, pre-save alerts, case
    references and the XML it creates), its save and every save body it sent
    HQ with HQ's answers, every request the page had HQ answer (by its
    method, path and query, in any order: requests in flight together reach
    HQ in either order), its state after the save, its events but for the
    parse's scheduling, and the page's errors and dialogs.
    """
    found = []
    differing = _record_differences(warm.outputs["record"], fresh.outputs["record"])
    if differing:
        found.append(f"Vellum's record of the form ({', '.join(differing)})")
    if warm.created_xml != fresh.created_xml:
        found.append("the XML Vellum creates")
    if warm.outputs["save"] != fresh.outputs["save"]:
        found.append(f"the save ({warm.outputs['save']} and {fresh.outputs['save']})")
    if [(e.url_name, e.body, e.status, e.response) for e in warm.saves] != [
        (e.url_name, e.body, e.status, e.response) for e in fresh.saves
    ]:
        found.append("the save requests or HQ's answers to them")
    if _asked(warm) != _asked(fresh):
        found.append(f"the requests HQ answered ({_asked(warm)} and {_asked(fresh)})")
    warm_after = {key: value for key, value in warm.outputs["after"].items() if key != "events"}
    fresh_after = {key: value for key, value in fresh.outputs["after"].items() if key != "events"}
    if warm_after != fresh_after:
        found.append(f"the state after the save ({warm_after} and {fresh_after})")
    if _comparable_events(warm.events) != _comparable_events(fresh.events):
        found.append(f"events ({_comparable_events(warm.events)} and {_comparable_events(fresh.events)})")
    if warm.page_errors != fresh.page_errors:
        found.append(f"page errors ({warm.page_errors} and {fresh.page_errors})")
    if warm.outputs["dialogs"] != fresh.outputs["dialogs"]:
        found.append(f"dialogs ({warm.outputs['dialogs']} and {fresh.outputs['dialogs']})")
    return found


def replay(
    transcript: transcripts.Transcript,
    answers,
    app_id,
    form_unique_id,
    options=None,
    *,
    lang=None,
    seeded=True,
    read_stored=True,
) -> VellumRun | None:
    """The Vellum run a transcript stands for, when HQ answers every recorded request as it did; else None.

    ``read_stored`` is ``_vellum_run``'s.
    """
    answers = _answers(answers)
    state = answers.state
    options, _ = _designer_options(state, app_id, form_unique_id, options, lang)
    source = options.source if options.source is not None else _source(state, app_id, form_unique_id)
    if transcript.spec != vellum_spec(options, load_delay=WARM_LOAD_DELAY, seeded=seeded):
        return None
    first = len(answers.exchanges)
    started = time.perf_counter()
    try:
        transcripts.replay(transcript, answers)
    except transcripts.ReplayMismatch:
        return None
    answers.check()
    return _vellum_run(
        state,
        app_id,
        form_unique_id,
        source,
        transcript.outputs,
        answers.exchanges[first:],
        read_stored=read_stored,
        replayed=True,
        transcript=transcript,
        spec=transcript.spec,
        seed=_seed(transcript.spec),
        seconds={"replay": round(time.perf_counter() - started, 3)},
    )


# The fresh page's steps: the host page loaded, Vellum started at HQ's own load
# delay, then the same steps the warm run takes.
_FRESH_STEPS = (
    {"goto": HOST_PAGE},
    {"until": "vellum/host_ready"},
    None,  # start, with the run's options
    {"until": "vellum/loaded"},
    {"until": "vellum/settled"},
    {"call": "vellum/record"},
    {"call": "vellum/save"},
    {"until": "vellum/saved"},
    {"call": "vellum/after_save"},
)


def fresh_open_and_save(
    driver: EditorDriver,
    answers,
    app_id,
    form_unique_id,
    options=None,
    *,
    lang=None,
    deadline=120.0,
    seeded=True,
) -> VellumRun:
    """Opens and saves the form in a fresh browser context, at HQ's own load delay (no transcript)."""
    answers = _answers(answers)
    state = answers.state
    options, options_seconds = _designer_options(state, app_id, form_unique_id, options, lang)
    source = options.source if options.source is not None else _source(state, app_id, form_unique_id)
    spec = vellum_spec(options, load_delay=None, seeded=seeded)
    seed = _seed(spec)
    start = {
        "call": "vellum/start",
        "arg": {"options": options.json, "loadDelay": None, "seed": None if seed is None else seed["seed"]},
    }
    steps = [step if step is not None else start for step in _FRESH_STEPS]
    first = len(answers.exchanges)
    try:
        run = driver.run(steps, answer=answers, deadline=deadline, cookies={"lang": options.lang}, seed=seed)
    except EditorDriverError as error:
        raise EditorRunFailed(f"Vellum's open and save of form {form_unique_id}", error, answers) from error
    answers.check()
    outcomes = run["outcomes"]
    outputs = _outputs(outcomes[5]["value"], outcomes[6]["value"], outcomes[8]["value"], run)
    page = outcomes[2]["value"] or {}
    timed_events = list((outcomes[8]["value"] or {}).get("events") or [])
    return _vellum_run(
        state,
        app_id,
        form_unique_id,
        source,
        outputs,
        answers.exchanges[first:],
        spec=spec,
        seed=seed,
        page_clock=page.get("clock"),
        page_draw=page.get("draw"),
        timed_events=timed_events,
        seconds={
            "options": round(options_seconds, 3),
            "open": round(sum(outcomes[i]["seconds"] for i in range(0, 5)), 3),
            "save": round(sum(outcomes[i]["seconds"] for i in range(6, 8)), 3),
            "run": run["seconds"],
        },
    )


def round_trips(driver: EditorDriver, state, app_id, form_unique_id, *, count=2, lang=None) -> list[VellumRun]:
    """Opens and saves the form ``count`` times, each on the source HQ stored the time before."""
    return [open_and_save(driver, state, app_id, form_unique_id, lang=lang) for _ in range(count)]
