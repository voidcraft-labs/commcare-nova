"""HQ's app-manager pages, rendered by HQ's page views and saved by HQ's save views.

Each ``EditorPage`` names a section of an app-manager view: the page view
that renders it (``views/apps.py::app_settings``, ``views/modules.py::
view_module`` or ``views/forms.py::view_form``, each through
``view_generic``), the save view its JavaScript posts to, and how a person
saves it without changing a value. Nothing about a save request is composed
here: the page's own JavaScript makes it from the page's own state, and HQ's
view applies it (``proof.editors.hq``).

A save is made the way a person makes one: the section's Save button starts
out "Saved" (``hqwebapp/js/bootstrap3|5/main.js::makeSaveButton``) and turns
to "Save" only when the page sees a change, so the section is first given the
change event its own listeners watch, with no value changed (``touch``), or,
where the page listens only to its model, a control is changed and changed
back (``revert``) (``driver/steps/pages/armed.js``). Then the Save button is
clicked.

Two ways to save:

- ``run_view`` loads a view once on the driver's reused page and saves every
  section the caller offers from that one load. In HQ's order, each section
  is armed, its state read and its Save clicked, and the save request it
  sends is held by the driver; then the held saves are released one at a
  time, each inside the caller's ``on_section(i)``, which answers it and
  everything the page asks after it (``app_manager.js::updateDOM`` fetching
  the build errors, ``setupValidation``), and the caller reads HQ's state
  there before the section's phase ends. The phase ends once the section's
  Save button has left "Saving" and none of the page's requests but the
  saves still held is in flight: the driver counts them from Chromium's own
  reports, which come as the page starts a request, so a request a success
  handler starts is answered in its section's phase however late it reaches
  HQ. The view ends with the page sent to about:blank, and a request the
  page sends for HQ after its view is refused and fails the driver's next
  operation (``driver.mjs::refuseStray``). Holding is sound because a section
  only ever sends what it held when it was clicked: each SaveButton
  serializes its own form or model when clicked (``main.js::makeSaveButton``
  ``ajax``, ``initForm`` serializing its ``$form``; ``details/bootstrap3/
  screen.js::save`` its own screen), and a success handler touches only its
  own section, the version text (``.variable-version``), the elements HQ's
  answer names under ``update`` and ``#build_errors``
  (``app_manager.js::_initSaveButtons``, ``updateDOM``); the
  ``saved-app-manager-form`` listeners only move the module in the sidebar
  (``app_manager.js``) and recheck the case-type warning
  (``modules/bootstrap3/module_view.js``), and ``updateDOM`` sets values
  without a change event, so no answer arms another section. A section's
  alerts are the ones shown after its release that were not shown just
  before it. A save whose answer navigates the page (HQ's ``redirect``,
  ``views/modules.py::edit_module_attr`` for a shadow module's children) is
  followed as a fresh page follows it, and each section still held is then
  saved from a load of its own inside its ``on_section``. A page may answer a
  section's Save with a dialog and send nothing (HQ's Case List page refuses
  a configuration it finds errors in with an alert,
  ``details/bootstrap3/screen.js::save``): the section is then unsent
  (``PageSave.unsent``, the dialog), no request of it reaches HQ, and its
  state is read where the dialog left the page.
- ``fresh_section_save`` loads the view in a fresh browser context for one
  section, routed through Playwright, as the driver always did, follows a
  save HQ answers with ``redirect`` to the document it names, and reads the
  section's state once the page is quiet; it is what ``run_view`` is proven
  equal to (``test_view_equivalence.py``) and what the in-band audit reruns
  (``PROOF_EDITOR_AUDIT``), both keeping an HQ view that raised as the
  section's answer, as ``run_view`` keeps it. ``save_page`` is the same save
  with the page's clock and randomness left the browser's own, and an HQ
  view that raised fails it.

A view run leaves a transcript (``proof.editors.transcripts``); ``replay_view``
answers a transcript's requests through HQ again and stands for a live run
when every answer matches. ``navigate`` answers a view's navigation ahead of
the page, so a caller can look its transcript up by HQ's first answer; a run
or replay given that answer serves the page from it.
"""

from __future__ import annotations

import itertools
import json
import math
import os
import time
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlsplit

from proof.editors import seeding, transcripts
from proof.editors.client import EditorDriver, EditorDriverError, PageRequest, cookie_list
from proof.editors.hq import EditorRunFailed, Exchange, HQAnswers, editor_build, javascript_catalog

# How a section is given a change (driver/steps/pages/armed.js).
TOUCH = "touch"
REVERT = "revert"

# The views and the order HQ shows their sections in.
VIEWS = ("app_settings", "view_module", "view_form")
_VIEW_SCOPE = {"app_settings": "app", "view_module": "module", "view_form": "form"}

# With PROOF_EDITOR_AUDIT=<fraction>, run_view also saves that fraction of the
# sections it saves (rotating through them) in a fresh browser context, in a
# fork of the same state, and fails on any difference.
AUDIT_ENVIRONMENT = "PROOF_EDITOR_AUDIT"


@dataclass(frozen=True)
class EditorPage:
    """A section of an app-manager view: where HQ renders it, where it saves, and how it is armed."""

    name: str
    # The page view's URL name, and the save view's.
    view: str
    save: str
    # The section's Save button bar (hqwebapp's SaveButton UI).
    bar: str
    # How the section is given a change: (TOUCH or REVERT, selector).
    arm: tuple[str, str]
    # What the page view and the save view are keyed by: "app", "module" or "form".
    scope: str
    # The save view's trailing URL argument, where it takes one (the attribute).
    save_suffix: tuple[str, ...] = ()


APP_SETTINGS = EditorPage(
    name="app settings",
    view="app_settings",
    save="edit_commcare_settings",
    bar="#settings-save-btn .savebtn-bar",
    # commcare_settings.js fires the Save button only when its serialized
    # settings change (``self.serialize.subscribe``), and resets a setting to
    # its computed default when a setting its ``contingent_default`` names
    # changes; Auto Update Frequency (commcare-profile-settings.yml,
    # ``cc-autoup-freq``) is named by none, so changing it and back leaves
    # every setting as it was.
    arm=(REVERT, "#cc-autoup-freq-input"),
    scope="app",
)
ADD_ONS = EditorPage(
    name="add-ons",
    view="app_settings",
    save="edit_add_ons",
    bar="#add-ons .savebtn-bar",
    # add_ons.js fires it when an add-on's observable changes.
    arm=(REVERT, "#add-ons input[type=checkbox]"),
    scope="app",
)
UI_TRANSLATIONS = EditorPage(
    name="UI translations",
    view="app_settings",
    save="edit_app_ui_translations",
    bar="#translations_ui .savebtn-bar",
    # translations.js fires it on a change event from a saved translation's
    # value, a select (hqwebapp's ui-element select, under select2); the
    # first row holds the first saved translation.
    arm=(TOUCH, "#translations_ui .row select"),
    scope="app",
)
MODULE_SETTINGS = EditorPage(
    name="module settings",
    view="view_module",
    save="edit_module_attr",
    bar="#module-settings-form .savebtn-bar",
    # app_manager.js::_initSaveButtons: SaveButton.initForm listens for change
    # on every element of the form.
    arm=(TOUCH, "#module-settings-form .save-button-holder"),
    scope="module",
    save_suffix=("all",),
)
CASE_LIST = EditorPage(
    name="case list",
    view="view_module",
    save="edit_module_detail_screens",
    bar="[data-bind='saveButton: shortScreen.saveButton'] > .savebtn-bar",
    # The Case List tab (case_list.html, which basic and advanced module pages
    # both render) lists the short screen's columns, each column's header an
    # input (hqwebapp's ui-element-input fires its change on the input's
    # change event); details/bootstrap3/column.js passes the header's change
    # to the column, and screen.js the column's to the short screen's Save
    # button. The header's value is unchanged.
    arm=(TOUCH, "#case-detail-screen-config-tab [data-bind='jqueryElement: header.ui'] input"),
    scope="module",
)
# Case search is configured on the Case List tab and saved by its save
# (screen.js::serialize adds the search properties when search is on).
CASE_SEARCH = EditorPage(
    name="case search",
    view="view_module",
    save="edit_module_detail_screens",
    bar=CASE_LIST.bar,
    arm=CASE_LIST.arm,
    scope="module",
)
# The Case Detail tab of a module page (partials/modules/bootstrap3/
# case_detail.html, rendered for each detail whose ``long`` the page context
# holds, views/modules.py::_get_module_details_context). Its Save button is
# the long screen's (details/bootstrap3/screen.js, ``columnKey`` ``long``),
# whose request posts ``long`` and ``tabs``, and
# views/modules.py::edit_module_detail_screens rebuilds the case detail's
# columns from them (DetailColumn.from_json), which the Case List save never
# does. It is armed from a case detail column's header, as the Case List is
# from a case list column's.
CASE_DETAIL = EditorPage(
    name="case detail",
    view="view_module",
    save="edit_module_detail_screens",
    bar="[data-bind='saveButton: longScreen.saveButton'] > .savebtn-bar",
    arm=(TOUCH, "#case-detail-screen-detail-config-tab [data-bind='jqueryElement: header.ui'] input"),
    scope="module",
)
FORM_SETTINGS = EditorPage(
    name="form settings",
    view="view_form",
    save="edit_form_attr",
    bar="#form-settings .savebtn-bar",
    arm=(TOUCH, "#form-settings form.save-button-form .save-button-holder"),
    scope="form",
    save_suffix=("all",),
)
CASE_MANAGEMENT = EditorPage(
    name="case management",
    view="view_form",
    save="edit_form_actions",
    bar="#case-config-ko .savebtn-bar",
    # case_config_ui.js: a change event from a select or hidden input in the
    # case configuration fires the Save button.
    arm=(TOUCH, "#case-config-ko select, #case-config-ko input[type=hidden]"),
    scope="form",
)
ADVANCED_CASE_MANAGEMENT = EditorPage(
    name="case management (advanced)",
    view="view_form",
    save="edit_advanced_form_actions",
    bar="#case-config-ko .savebtn-bar",
    arm=(TOUCH, "#case-config-ko select, #case-config-ko input[type=hidden]"),
    scope="form",
)
# The User Properties tab of a form page (form_view.html,
# ``usercase-configuration``, for a module form when the project has USERCASE
# or the form uses the user case). Its Save button
# (forms/case_config_ui.js::saveUsercaseButton) posts only the user case
# actions (``from_usercase_transaction``: ``usercase_update`` and
# ``usercase_preload``) to views/forms.py::edit_form_actions; it is armed from
# the user case configuration's selects and hidden inputs
# (``$usercaseMgmt.on('change', 'select, input[type="hidden"]', ...)``).
USER_PROPERTIES = EditorPage(
    name="user properties",
    view="view_form",
    save="edit_form_actions",
    bar="[data-bind='saveButton: saveUsercaseButton'] > .savebtn-bar",
    arm=(TOUCH, "#usercase-config-ko select, #usercase-config-ko input[type=hidden]"),
    scope="form",
)

PAGES = (
    APP_SETTINGS,
    ADD_ONS,
    UI_TRANSLATIONS,
    MODULE_SETTINGS,
    CASE_LIST,
    CASE_SEARCH,
    CASE_DETAIL,
    FORM_SETTINGS,
    CASE_MANAGEMENT,
    ADVANCED_CASE_MANAGEMENT,
    USER_PROPERTIES,
)


@dataclass
class PageSave:
    """What one section's save left: every exchange with HQ its page made, and the save's own (None where the page
    sent none, ``unsent``)."""

    page: EditorPage
    path: str
    save_path: str
    exchanges: list[Exchange]
    save: Exchange | None
    bar_state: str
    # The alerts the save added to the page (shown after it, not before).
    alerts: list[str]
    run: dict
    seconds: float
    # The dialog the page answered the Save with when it sent no save ({type, message}), else None.
    unsent: dict | None = None

    @property
    def refused(self):
        """Whether HQ's save view refused the save (a 4xx, or a JSON answer that says so); never one the page
        did not send."""
        if self.save is None:
            return False
        if self.save.status >= 400:
            return True
        return _json(self.save.response).get("success") is False

    @property
    def response(self):
        return {} if self.save is None else _json(self.save.response)


def _added(before, after):
    """The alerts shown after the save that were not shown before it, each as often as it was added."""
    remaining = list(before)
    added = []
    for alert in after:
        if alert in remaining:
            remaining.remove(alert)
        else:
            added.append(alert)
    return added


def _json(body):
    try:
        value = json.loads(body or b"null")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _urls(state, page, app_id, target):
    from django.urls import reverse

    args = [state.domain, app_id] + ([] if page.scope == "app" else [target])
    return reverse(page.view, args=args), reverse(page.save, args=args + list(page.save_suffix))


def _check_target(page, target):
    if (page.scope == "app") != (target is None):
        raise ValueError(
            f"The {page.name} page is keyed by its {page.scope}; pass its unique id only for a module or form."
        )


# One section, saved from a fresh browser context ------------------------------------------------


# Where the fresh page's steps (``_steps``) keep the section's state before
# its save and after it.
_BEFORE_STEP = 3
_AFTER_STEP = 10


def _steps(page, path, save_path):
    action, selector = page.arm
    save = {"method": "POST", "pathname": save_path}
    return [
        {"goto": path},
        {"until": "pages/ready", "arg": {"bar": page.bar}},
        # The page's listeners are bound a turn after its bindings apply
        # (_.defer, setTimeout); the change is repeated until the Save button
        # has taken it.
        {"until": "pages/armed", "arg": {"action": action, "selector": selector, "bar": page.bar}},
        {"call": "pages/save_state", "arg": page.bar},
        {"click": f"{page.bar} > .btn:not(.disabled)"},
        # A page that answers Save with a dialog and sends nothing leaves the
        # save unsent (the step's outcome names the dialog), and the steps of
        # a sent save are skipped (``unlessUnsent``).
        {"awaitRequest": save, "orDialog": True},
        # A save HQ answers with ``redirect`` sends the page elsewhere
        # (app_manager.js::_initSaveButtons): its state is read on the
        # document it was sent to, as run_view reads it.
        {"followRedirect": save, "unlessUnsent": True},
        {"until": "pages/ready", "arg": {"bar": page.bar}},
        {"until": "pages/saved", "arg": page.bar, "unlessUnsent": True},
        # What the save's handlers asked HQ for has been answered (run_view
        # reads a section's state once the page is quiet too).
        {"settle": True},
        {"call": "pages/save_state", "arg": page.bar},
    ]


# The step of ``_steps`` whose outcome names a save the page did not send.
_SAVE_STEP = 5


def fresh_section_save(
    driver: EditorDriver,
    state,
    page: EditorPage,
    app_id: str,
    target: str | None = None,
    *,
    deadline: float = 120.0,
    seeded: bool = True,
    unit=None,
    cookies: Mapping[str, str] | None = None,
    harness_only: bool = False,
) -> PageSave:
    """Renders ``page`` through HQ's page view in a fresh browser context and saves it unchanged.

    ``target`` is the module's or form's unique id for a module or form page.
    With ``seeded`` the page's clock and randomness are fixed from the
    one-section view's spec, as ``run_view`` fixes them. ``unit``, when given,
    is the HQ unit the answers run in. Fails when a request the page made
    reached something the harness refuses, and, unless ``harness_only``, when
    one broke an HQ view; with ``harness_only`` an HQ view that raised stays
    in its exchange (``Exchange.error``), as ``run_view`` keeps it, the page
    having seen it answered 500. A save HQ's view refuses is returned, not
    raised.
    """
    _check_target(page, target)
    path, save_path = _urls(state, page, app_id, target)
    editor_build()
    answers = HQAnswers(state, unit)
    seed = None
    if seeded:
        spec = ViewSpec(page.view, app_id, target, cookies=cookies or {}, sections=(page,))
        seed = spec.seed(spec.canonical(state.domain))
    started = time.perf_counter()
    try:
        run = driver.run(_steps(page, path, save_path), answer=answers, deadline=deadline, cookies=cookies, seed=seed)
    except EditorDriverError as error:
        raise EditorRunFailed(f"The {page.name} page's save", error, answers) from error
    seconds = time.perf_counter() - started
    answers.check(harness_only=harness_only)
    saves = [e for e in answers.exchanges if e.method == "POST" and e.path == save_path]
    unsent = run["outcomes"][_SAVE_STEP].get("unsent")
    if len(saves) != (0 if unsent else 1):
        raise AssertionError(
            f"The {page.name} page sent {len(saves)} save requests to {save_path};"
            f" {'none' if unsent else 'one'} was expected{', as it answered Save with a dialog' if unsent else ''}."
        )
    shown_before = run["outcomes"][_BEFORE_STEP]["value"]["alerts"]
    final = run["outcomes"][_AFTER_STEP]["value"]
    return PageSave(
        page=page,
        path=path,
        save_path=save_path,
        exchanges=answers.exchanges,
        save=saves[0] if saves else None,
        bar_state=final["state"],
        alerts=_added(shown_before, final["alerts"]),
        run=run,
        seconds=seconds,
        unsent=unsent,
    )


def save_page(
    driver: EditorDriver, state, page: EditorPage, app_id: str, target: str | None = None, *, deadline: float = 120.0
) -> PageSave:
    """``fresh_section_save`` with the page's clock and randomness the browser's own.

    An HQ view that raised on what the page sent fails it
    (``HQRefusedPageRequest``), which proof 4 reports as the section broken.
    """
    return fresh_section_save(driver, state, page, app_id, target, deadline=deadline, seeded=False)


# One view, every section saved from one load -----------------------------------------------------


@dataclass(frozen=True)
class ViewSpec:
    """One app-manager view to load and the sections to save from it, in HQ's order.

    ``view`` is the page view's URL name (``app_settings``, ``view_module``
    or ``view_form``), ``target`` the module's or form's unique id (None for
    app settings), ``cookies`` what the browser holds for HQ's origin, and
    ``sections`` the sections the caller offers.
    """

    view: str
    app_id: str
    target: str | None
    cookies: tuple[tuple[str, str], ...] = ()
    sections: tuple[EditorPage, ...] = ()
    seeded: bool = True

    def __post_init__(self):
        if self.view not in VIEWS:
            raise ValueError(f"{self.view} is not an app-manager view the driver saves; it saves {', '.join(VIEWS)}.")
        if (self.view == "app_settings") != (self.target is None):
            raise ValueError(f"The {self.view} view takes a target only for a module or form; got {self.target!r}.")
        cookies = self.cookies.items() if isinstance(self.cookies, Mapping) else self.cookies
        object.__setattr__(self, "cookies", tuple((str(name), str(value)) for name, value in cookies))
        object.__setattr__(self, "sections", tuple(self.sections))
        for page in self.sections:
            if page.view != self.view:
                raise ValueError(f"The {page.name} section is on the {page.view} view, not {self.view}.")

    def path(self, domain: str) -> str:
        from django.urls import reverse

        return reverse(self.view, args=[domain, self.app_id] + ([] if self.target is None else [self.target]))

    def save_path(self, domain: str, page: EditorPage) -> str:
        from django.urls import reverse

        args = [domain, self.app_id] + ([] if self.target is None else [self.target])
        return reverse(page.save, args=args + list(page.save_suffix))

    def canonical(self, domain: str) -> dict:
        """Everything the browser is given for this view: the run spec its transcript is keyed by."""
        return {
            "kind": "view",
            "url": self.path(domain),
            "cookies": [list(cookie) for cookie in self.cookies],
            "sections": [
                {
                    "name": page.name,
                    "savePath": self.save_path(domain, page),
                    "bar": page.bar,
                    "arm": {"action": page.arm[0], "selector": page.arm[1]},
                }
                for page in self.sections
            ],
            "epoch": seeding.epoch_ms() if self.seeded else None,
        }

    def seed(self, canonical: Mapping) -> dict | None:
        """The page's clock and randomness for this view: ``{seed, epoch}``, or None when unseeded."""
        if not self.seeded:
            return None
        return {"seed": transcripts.digest(canonical)[:32], "epoch": canonical["epoch"]}


@dataclass
class ViewRun:
    """One view's sections saved from one load: per section, what today's single-section save gives."""

    spec: ViewSpec
    path: str
    sections: list[PageSave]
    # Every exchange with HQ, in the order HQ answered them.
    exchanges: list[Exchange]
    # What the browser showed (transcript outputs).
    outputs: dict
    transcript: transcripts.Transcript | None
    replayed: bool = False
    # Sections saved from a load of their own after a redirect, by index.
    redone: list[int] = field(default_factory=list)
    seconds: dict = field(default_factory=dict)
    # What the page's Date.now() read after the load (None for a replay).
    page_clock: int | None = None


class ConcurrentWrite(AssertionError):
    """An HQ request wrote while another of the page's requests was in flight."""


class EditorAuditMismatch(AssertionError):
    """A section saved from a view's one load differs from the same section saved from a fresh page."""


def navigate(driver: EditorDriver, answers: HQAnswers, spec: ViewSpec) -> Exchange:
    """Answers the view's navigation as the page will ask for it, ahead of the page.

    The answer's digest (``Exchange.response_digest``) is a transcript's
    ``first``. Pass the exchange to ``run_view`` or ``replay_view`` as
    ``navigation``: the page is then served from it.
    """
    headers = driver.navigation_headers
    if spec.cookies:
        headers["cookie"] = "; ".join(f"{name}={value}" for name, value in spec.cookies)
    url = driver.ready["origin"] + spec.path(answers.state.domain)
    return answers.preanswer(PageRequest(method="GET", url=url, headers=headers, body=None, phase="load"))


def _register_catalog(driver: EditorDriver) -> None:
    """The JavaScript translation catalog, served by the driver's origin as a deployment's static build does."""
    from django.conf import settings
    from statici18n.templatetags.statici18n import statici18n

    driver.register_static(
        statici18n(settings.LANGUAGE_CODE),
        javascript_catalog(settings.LANGUAGE_CODE),
        "text/javascript; charset=utf-8",
    )


# Requests the driver's origin answers from the image's static files: whether
# the page asks for one depends on what Chromium's cache already holds, so a
# run's outputs leave them out.
STATIC_ANSWERS = ("editors", "missing")


def page_requests(requests) -> list[dict]:
    """A run's requests as its outputs keep them: no static file, no tick numbers, in a fixed order.

    The driver records a refused request when Playwright reports it and a
    frame when the origin answers it, which can interleave either way; the
    order HQ answered its requests in is the exchanges'.
    """
    kept = [
        {key: value for key, value in request.items() if key not in ("forwarded", "replied")}
        for request in requests
        if request.get("answeredBy") not in STATIC_ANSWERS
    ]
    return sorted(kept, key=lambda request: json.dumps(request, sort_keys=True))


def page_console_errors(entries) -> list[dict]:
    """A run's console errors as its outputs keep them: ``{error}`` (with its ``phase`` in a view), in order.

    Chromium's own report of a file the origin answers from the image's
    static files failing to load ("Failed to load resource", the file's URL
    as its location) is left out: whether the page asks for the file at all
    depends on what the page or Chromium's cache already holds, as for the
    static requests ``page_requests`` leaves out.
    """
    kept = []
    for entry in entries:
        entry = entry if isinstance(entry, Mapping) else {"error": entry}
        location = urlsplit(entry.get("url") or "")
        if entry["error"].startswith("Failed to load resource") and location.path.startswith("/static/"):
            continue
        kept.append({key: value for key, value in entry.items() if key != "url"})
    return kept


def _view_outputs(result: Mapping) -> dict:
    """What the browser showed in a view run: the transcript's outputs (no times, no tick numbers)."""
    return {
        "url": result["url"],
        "sections": result["sections"],
        "redirected": result["redirected"],
        "requests": page_requests(result["requests"]),
        "pageErrors": result["pageErrors"],
        "consoleErrors": page_console_errors(result["consoleErrors"]),
        "dialogs": result["dialogs"],
    }


def _check_writes_alone(exchanges: list[Exchange], requests: list[Mapping]) -> None:
    """Fails when an HQ request that wrote overlapped another request the driver had forwarded.

    Python answers forwarded requests in the order they reach it, and two in
    flight together can reach it in either order; a write among them would
    then make HQ's state depend on that order.
    """
    spans = {
        request["forwarded"]: (request["forwarded"], request.get("replied", math.inf))
        for request in requests
        if request.get("forwarded") is not None
    }
    for exchange in exchanges:
        if not exchange.wrote or exchange.forwarded not in spans:
            continue
        start, end = spans[exchange.forwarded]
        others = [
            forwarded
            for forwarded, (other_start, other_end) in spans.items()
            if forwarded != exchange.forwarded and other_start < end and start < other_end
        ]
        if others:
            by_number = {request.get("forwarded"): request for request in requests}
            named = "; ".join(
                f"{by_number[number].get('method')} {by_number[number].get('url') or by_number[number].get('path')}"
                f" ({by_number[number].get('phase')}, forwarded {number},"
                f" replied {by_number[number].get('replied', 'never')})"
                for number in sorted(others)
            )
            raise ConcurrentWrite(
                f"HQ's answer to {exchange.method} {exchange.path} ({exchange.phase}, forwarded {start}, replied"
                f" {end}) wrote while {len(others)} other request(s) of the page were in flight, so HQ's state"
                f" would depend on the order those reached it: {named}."
            )


def _phase_errors(entries, index, last):
    """The entries of a run (page errors, console errors, dialogs) a section answers for."""
    phases = {"load", f"arm:{index}", f"section:{index}", f"settled:{index}"}
    if last:
        phases.add("end")
    return [
        {key: value for key, value in entry.items() if key != "phase"} for entry in entries if entry["phase"] in phases
    ]


def _view_run(spec, domain, outputs, exchanges, transcript, *, replayed, seconds, timings, skip=()) -> ViewRun:
    """The view run its outputs and HQ's exchanges show, one ``PageSave`` per section but those ``skip`` names (the
    sections a redirect abandoned, which are saved again from loads of their own)."""
    path = spec.path(domain)
    load = [exchange for exchange in exchanges if exchange.phase == "load"]
    sections = []
    for index, page in enumerate(spec.sections):
        if index in skip:
            continue
        shown = outputs["sections"][index]
        unsent = shown.get("unsent")
        own = [exchange for exchange in exchanges if transcripts.section_of(exchange.phase or "") == index]
        saves = [exchange for exchange in own if exchange.phase == f"section:{index}"]
        if len(saves) != (0 if unsent else 1):
            raise AssertionError(
                f"The {page.name} section's save reached HQ {len(saves)} times;"
                f" {'never, as the page answered Save with a dialog,' if unsent else 'once'} was expected."
            )
        last = index == len(spec.sections) - 1
        requests = [
            request
            for request in outputs["requests"]
            if request["phase"] in ("load", f"section:{index}", f"followup:{index}")
        ]
        errors = [entry["error"] for entry in _phase_errors(outputs["pageErrors"], index, last)]
        sections.append(
            PageSave(
                page=page,
                path=path,
                save_path=spec.save_path(domain, page),
                exchanges=load + own,
                save=saves[0] if saves else None,
                unsent=unsent,
                bar_state=shown["after"]["state"],
                alerts=_added(shown["preRelease"]["alerts"], shown["after"]["alerts"]),
                run={
                    "requests": requests,
                    "pageErrors": errors,
                    "consoleErrors": [entry["error"] for entry in _phase_errors(outputs["consoleErrors"], index, last)],
                    "dialogs": _phase_errors(outputs["dialogs"], index, last),
                },
                seconds=timings.get(index, 0.0),
            )
        )
    return ViewRun(
        spec=spec,
        path=path,
        sections=sections,
        exchanges=list(exchanges),
        outputs=outputs,
        transcript=transcript,
        replayed=replayed,
        seconds=seconds,
    )


_AUDIT_COUNTER = itertools.count()


def audit_selection(count: int) -> list[int]:
    """The sections of this view the in-band audit reruns: a rotating fraction ``PROOF_EDITOR_AUDIT`` of all."""
    raw = os.environ.get(AUDIT_ENVIRONMENT, "")
    if not raw:
        return []
    fraction = float(raw)
    if not 0 <= fraction <= 1:
        raise ValueError(f"{AUDIT_ENVIRONMENT} is a fraction from 0 to 1, not {raw}.")
    chosen = []
    for index in range(count):
        position = next(_AUDIT_COUNTER)
        if math.floor((position + 1) * fraction) > math.floor(position * fraction):
            chosen.append(index)
    return chosen


def run_view(
    driver: EditorDriver,
    answers: HQAnswers,
    spec: ViewSpec,
    *,
    on_section: Callable[[int], AbstractContextManager],
    navigation: Exchange | None = None,
    deadline: float = 120.0,
) -> ViewRun:
    """Loads the view once and saves every section ``spec`` offers from that load.

    Section ``i``'s held save, and every request the page makes after it
    until the section has settled, are answered inside ``on_section(i)``,
    which the caller provides (a fork of HQ's state); the caller reads HQ's
    state inside it before it exits. ``navigation`` is the view's navigation
    answered ahead of the page (``navigate``). Fails when a request reached
    something the harness refuses, when the driver could not finish the view
    (``EditorRunFailed``), and when an HQ request wrote while another was in
    flight (``ConcurrentWrite``). An HQ view that raised on what a section
    sent is that section's to report: it stays in the section's exchanges
    (``Exchange.error``), as the page saw it answered 500.
    """
    state = answers.state
    domain = state.domain
    editor_build()
    _register_catalog(driver)
    canonical = spec.canonical(domain)
    audited = {}
    for index in audit_selection(len(spec.sections)):
        if answers.unit is None:
            raise ValueError(f"{AUDIT_ENVIRONMENT} reruns sections in a fork of the unit, and these answers have none.")
        with answers.unit.fork():
            audited[index] = fresh_section_save(
                driver,
                state,
                spec.sections[index],
                spec.app_id,
                spec.target,
                deadline=deadline,
                seeded=spec.seeded,
                unit=answers.unit,
                cookies=dict(spec.cookies),
                # An HQ view that raised is the section's to report, as below.
                harness_only=True,
            )
    first = len(answers.exchanges) - (1 if navigation is not None else 0)
    message = {
        "op": "view",
        "url": canonical["url"],
        "sections": canonical["sections"],
        "cookies": cookie_list(dict(spec.cookies)),
        "seed": spec.seed(canonical),
        "deadlineMs": int(deadline * 1000),
    }
    contexts: dict[int, AbstractContextManager] = {}
    timings: dict[int, float] = {}
    starts: dict[int, float] = {}

    def on_phase(phase):
        index = transcripts.section_of(phase.name)
        if index is None:
            raise AssertionError(f"The driver announced a phase Python does not know: {phase.name}.")
        if phase.event == "start":
            context = on_section(index)
            context.__enter__()
            contexts[index] = context
            answers.open_section(index)
            starts[index] = time.perf_counter()
        else:
            answers.close_section()
            context = contexts.pop(index)
            context.__exit__(None, None, None)
            timings[index] = round(time.perf_counter() - starts[index], 4)

    def leave_open(error):
        answers.close_section()
        for index in list(contexts):
            contexts.pop(index).__exit__(type(error), error, error.__traceback__)

    started = time.perf_counter()
    try:
        result = driver.operation(message, answer=answers, on_phase=on_phase, deadline=deadline)
    except EditorDriverError as error:
        leave_open(error)
        raise EditorRunFailed(f"The {spec.view} view's saves", error, answers) from error
    except BaseException as error:
        leave_open(error)
        raise
    seconds = {"view": round(time.perf_counter() - started, 4), "driver": result.get("seconds")}
    answers.check(harness_only=True)
    exchanges = answers.exchanges[first:]
    _check_writes_alone(exchanges, result["requests"])
    outputs = _view_outputs(result)
    abandoned = [index for index, shown in enumerate(outputs["sections"]) if shown["abandoned"]]
    redone = {}
    for index in abandoned:
        # HQ's redirect reloaded the page under the sections still held; each
        # is saved from a load of its own, inside its own fork.
        single = ViewSpec(spec.view, spec.app_id, spec.target, spec.cookies, (spec.sections[index],), spec.seeded)
        with on_section(index):
            redo = run_view(
                driver, HQAnswers(state, answers.unit), single, on_section=lambda _i: nullcontext(), deadline=deadline
            )
        redone[index] = redo
    if redone:
        view = ViewRun(
            spec=spec,
            path=spec.path(domain),
            sections=[],
            exchanges=list(exchanges),
            outputs=outputs,
            transcript=None,
            seconds=seconds,
            redone=sorted(redone),
        )
        kept = _view_run(
            spec, domain, outputs, exchanges, None, replayed=False, seconds=seconds, timings=timings, skip=redone
        )
        # Each section in the view's order: those its one load saved (or left unsent), then those saved again.
        held = iter(kept.sections)
        view.sections = [
            redone[index].sections[0] if index in redone else next(held) for index in range(len(spec.sections))
        ]
    else:
        transcript = transcripts.from_exchanges(canonical, exchanges, outputs)
        view = _view_run(spec, domain, outputs, exchanges, transcript, replayed=False, seconds=seconds, timings=timings)
    view.page_clock = result.get("pageClock")
    for index, fresh in audited.items():
        found = section_differences(view.sections[index], fresh)
        if found:
            raise EditorAuditMismatch(
                f"The {spec.sections[index].name} section saved from the {spec.view} view's one load differs from"
                f" the same section saved from a fresh page over the same state: {found}"
            )
    return view


def replay_view(
    transcript: transcripts.Transcript,
    answers: HQAnswers,
    spec: ViewSpec,
    *,
    on_section: Callable[[int], AbstractContextManager],
    navigation: Exchange | None = None,
) -> ViewRun | None:
    """The view run a transcript stands for, when HQ answers every recorded request as it did; else None.

    Every recorded request is answered by HQ again, in its phase (a
    section's inside ``on_section(i)``), built exactly as the page sent it.
    At the first answer whose digest differs it returns None, having
    answered nothing after it; the section's context sees the mismatch as an
    error. ``navigation`` is the view's navigation answered ahead
    (``navigate``), which stands for the recorded first request.
    """
    domain = answers.state.domain
    if transcript.spec != spec.canonical(domain):
        return None
    first = len(answers.exchanges) - (1 if navigation is not None else 0)
    if navigation is not None:
        answers.consume_preanswer()
    started = time.perf_counter()
    try:
        transcripts.replay(transcript, answers, on_section=on_section, skip_first=navigation is not None)
    except transcripts.ReplayMismatch:
        return None
    answers.check(harness_only=True)
    exchanges = answers.exchanges[first:]
    seconds = {"view": round(time.perf_counter() - started, 4)}
    return _view_run(
        spec, domain, transcript.outputs, exchanges, transcript, replayed=True, seconds=seconds, timings={}
    )


# Comparing a held section with a fresh one ---------------------------------------------------------


def _comparable_body(exchange: Exchange | None, mask_csrf: bool):
    """A save's request body as compared: with ``mask_csrf``, a form body's pairs with the CSRF token's value masked."""
    if exchange is None:
        return None
    content_type = (exchange.content_type or "").split(";")[0].strip()
    if mask_csrf and content_type == "application/x-www-form-urlencoded":
        pairs = parse_qsl((exchange.body or b"").decode("utf-8"), keep_blank_values=True)
        return [(name, "<csrf token>" if name == "csrfmiddlewaretoken" else value) for name, value in pairs]
    return exchange.body


def _messages(saved: PageSave):
    return sorted(
        (exchange.url_name or "-", message)
        for exchange in saved.exchanges
        if not exchange.path.startswith("/static/")
        for message in exchange.messages
    )


def section_differences(held: PageSave, fresh: PageSave, *, mask_csrf: bool | None = None) -> list[str]:
    """Where a section saved from a view's one load differs from the same section saved from a fresh page.

    Compared: the save's request body, HQ's answer to it, the Save button's
    end state, the alerts the save added, the page's errors and dialogs, and
    the messages HQ's views left. Under HQ's determinism a page render's
    CSRF token is drawn from the page's request
    (``proof.editors.hq.csrf_drawn_from``), so both pages carry the same one;
    with it off (``PROOF_HQ_DETERMINISM=0``) Django draws the token from the
    system's entropy, and with ``mask_csrf`` (the default then) a form
    body's token is masked.
    """
    if mask_csrf is None:
        from proof.hq import determinism

        mask_csrf = not determinism.ENABLED
    found = []
    if held.unsent != fresh.unsent:
        found.append(f"the dialog the page answered Save with ({held.unsent} and {fresh.unsent})")
    if _comparable_body(held.save, mask_csrf) != _comparable_body(fresh.save, mask_csrf):
        found.append("save request body")

    def answered(saved):
        return None if saved.save is None else (saved.save.status, saved.save.response)

    if answered(held) != answered(fresh):
        found.append("HQ's answer to the save")
    if held.bar_state != fresh.bar_state:
        found.append(f"Save button state ({held.bar_state} and {fresh.bar_state})")
    if held.alerts != fresh.alerts:
        found.append(f"alerts added ({held.alerts} and {fresh.alerts})")
    if list(held.run["pageErrors"]) != list(fresh.run["pageErrors"]):
        found.append(f"page errors ({held.run['pageErrors']} and {fresh.run['pageErrors']})")
    if list(held.run["dialogs"]) != list(fresh.run["dialogs"]):
        found.append(f"dialogs ({held.run['dialogs']} and {fresh.run['dialogs']})")
    if _messages(held) != _messages(fresh):
        found.append(f"HQ's messages ({_messages(held)} and {_messages(fresh)})")
    return found
