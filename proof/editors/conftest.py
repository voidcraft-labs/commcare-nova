"""Fixtures for the editor driver's own tests.

- ``hq`` and ``network`` are the whole harness's (``proof/conftest.py``): HQ
  booted once for the session, and every test failing if HQ reached for the
  network.
- ``record_timing`` keeps what the editors cost (each page save, each
  Vellum open and save, the driver's start), printed at the end of the session
  and written to ``$PROOF_OUT/editor-timings.json`` when ``PROOF_OUT`` names a
  directory.
- ``write_evidence`` writes a run's record under ``$PROOF_OUT/editors/``.
- ``publish_hq_app`` puts one of HQ's own test apps
  (``corehq/apps/app_manager/tests/data``) into the check's HQ through HQ's
  import API, as Nova's publish does, and gives every module the unique id
  HQ's module page would give it.
- ``save_section`` saves one section from a load of its view on the driver's
  reused page (``pages.run_view``), its save applied to the check's HQ.
- ``first_draw`` is the first value a page seeded with a seed draws
  (``driver/steps/page/seed.js``), computed apart from the page.
- The editors' fixture apps, shared by the equivalence and seeding tests:
  ``suite_app`` (HQ's suite app with UI translations and case search, its
  follow-up form as HQ's editor writes it), ``advanced_app`` (its advanced
  modules), ``user_properties_form`` (the follow-up form writing a user
  property, under USERCASE), ``proof4_offers`` (the sections proof 4 offers
  for an entity) and ``app_views`` (an app's views with the sections offered).
- Views whose saves HQ does not take: ``form_view_hq_raises_on`` (a form
  view whose form settings save HQ's view raises on) and
  ``module_view_hq_refuses`` (a module view whose case list save HQ's view
  refuses, with an alert).
"""

from __future__ import annotations

import json
import os
from contextlib import nullcontext
from pathlib import Path

import pytest

from proof.hq.conftest import HQ_ROOT, nova_shaped_upload

HQ_TEST_DATA = HQ_ROOT / "corehq/apps/app_manager/tests/data"
# HQ's own test apps the editors open: one basic module whose case list,
# forms and case actions HQ's suite tests build, and advanced modules.
SUITE_APP = "suite/app.json"
ADVANCED_APP = "suite/suite-advanced.json"
# HQ's two-language test app (en and es).
TWO_LANGUAGE_APP = "yesno.json"

_TIMINGS: dict[str, list[float]] = {}


@pytest.fixture(autouse=True)
def _no_inband_audit(monkeypatch):
    """The lane's in-band audit (``PROOF_EDITOR_AUDIT``, CI's sample of the corpus's editor runs) reruns a run in a
    fork of the document's unit; a package test's own answers fork nothing, so a test here runs without it unless
    it sets it itself (the equivalence tests do)."""
    monkeypatch.delenv("PROOF_EDITOR_AUDIT", raising=False)


def record_timing(name: str, seconds: float) -> None:
    _TIMINGS.setdefault(name, []).append(round(seconds, 3))


def write_evidence(name: str, record) -> None:
    out = os.environ.get("PROOF_OUT")
    if not out:
        return
    directory = Path(out, "editors")
    directory.mkdir(parents=True, exist_ok=True)
    Path(directory, f"{name}.json").write_text(json.dumps(record, indent="\t", sort_keys=True, default=str) + "\n")


def publish_hq_app(state, name=SUITE_APP):
    """Publishes one of HQ's test apps into the check's HQ and returns HQ's app id."""
    from proof.hq import operations

    source = json.loads((HQ_TEST_DATA / name).read_text())
    app_id, _ = operations.publish(state, [nova_shaped_upload(source, Path(name).stem)])
    # view_generic gives a module without a unique id one (and saves) when its
    # page is opened by index; the pages here are opened by unique id.
    operations.held_app(state, app_id).ensure_module_unique_ids(should_save=True)
    return app_id


def save_section(driver, state, page, app_id, target=None):
    """``page`` saved from a load of its view on the driver's reused page, straight into the check's HQ."""
    from proof.editors import pages
    from proof.editors.hq import HQAnswers

    spec = pages.ViewSpec(page.view, app_id, target, sections=(page,))
    view = pages.run_view(driver, HQAnswers(state), spec, on_section=lambda _index: nullcontext())
    return view.sections[0]


def first_draw(seed: str) -> float:
    """The first value ``Math.random`` gives on a page seeded with ``seed`` (32 hex digits), as seed.js draws it.

    seed.js's generator is sfc32, its four words the seed's, run twelve
    times before its first value; each value is a 32-bit word over 2**32.
    """
    mask = 0xFFFFFFFF
    state = [int(seed[i * 8 : i * 8 + 8], 16) for i in range(4)]

    def advance():
        word = (((state[0] + state[1]) & mask) + state[3]) & mask
        state[3] = (state[3] + 1) & mask
        state[0] = state[1] ^ (state[1] >> 9)
        state[1] = (state[2] + (state[2] << 3)) & mask
        state[2] = ((state[2] << 21) | (state[2] >> 11)) & mask
        state[2] = (state[2] + word) & mask
        return word

    for _ in range(12):
        advance()
    return advance() / 2**32


# The editors' fixture apps --------------------------------------------------------------------------


def followup_as_hqs_editor_writes_it(app):
    """The suite app's follow-up form as HQ's editor writes it.

    suite/app.json stores the follow-up form's unused open_case name as null,
    which HQ's form page script cannot read (case_config_ui.js::
    to_case_transaction maps name_update_multi's question paths) and HQ's
    editor never writes: a form it makes holds an empty ConditionalCaseUpdate.
    """
    from corehq.apps.app_manager.models import ConditionalCaseUpdate

    app.modules[0].forms[1].actions.open_case.name_update = ConditionalCaseUpdate()


def suite_app(state):
    """HQ's suite app with UI translations and case search on its module, as HQ's own views store them."""
    from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty
    from corehq.apps.case_search.models import CaseSearchConfig

    from proof.hq import operations

    app_id = publish_hq_app(state, SUITE_APP)
    app = operations.held_app(state, app_id)
    followup_as_hqs_editor_writes_it(app)
    app.set_translations("en", {"cchq.case": "Client", "forms.start": "Begin"})
    CaseSearchConfig.objects.create(domain=state.domain, enabled=True)
    app.modules[0].search_config = CaseSearch(
        properties=[CaseSearchProperty(name="name", label={"en": "Name"})],
        title_label={"en": ""},
        description={"en": ""},
    )
    app.save()
    return app_id


def advanced_app(state):
    """HQ's advanced suite app, its shown case list labelled (HQ's module settings save refuses one without)."""
    from proof.hq import operations

    app_id = publish_hq_app(state, ADVANCED_APP)
    app = operations.held_app(state, app_id)
    app.modules[1].case_list.label["en"] = "Clinics"
    app.save()
    return app_id


def user_properties_form(state):
    """The suite app's follow-up form writing a user property from its answer, as HQ's User Properties tab stores one.

    The tab is on the form page only when the project has USERCASE
    (form_view.html). Returns (app id, the form's unique id).
    """
    from corehq.apps.app_manager.models import ConditionalCaseUpdate

    from proof.hq import operations

    app_id = publish_hq_app(state, SUITE_APP)
    app = operations.held_app(state, app_id)
    followup_as_hqs_editor_writes_it(app)
    form = app.modules[0].forms[1]
    form.actions.usercase_update.update = {"proof_last_name": ConditionalCaseUpdate(question_path="/data/rename")}
    form.actions.usercase_update.condition.type = "always"
    app.save()
    return app_id, form.unique_id


def proof4_offers(state, app, scope, entity):
    """The sections HQ offers for an entity, as proof 4's observation decides them."""
    from proof.editors import pages
    from proof.observe import proof4

    offered = (proof4.OFFERED, None)

    def kept(*pairs):
        return tuple(page for page, (status, _reason) in pairs if status == proof4.OFFERED)

    if scope == "app":
        return kept(
            (pages.APP_SETTINGS, offered),
            (pages.ADD_ONS, proof4.add_ons_offer(state, app)),
            (pages.UI_TRANSLATIONS, proof4.ui_translations_offer(state, app)),
        )
    if scope == "module":
        return kept(
            (pages.MODULE_SETTINGS, offered),
            (pages.CASE_LIST, proof4.case_list_offer(entity)),
            (pages.CASE_DETAIL, proof4.case_detail_offer(entity)),
        )
    advanced = entity.get_module().doc_type == "AdvancedModule"
    return kept(
        (pages.FORM_SETTINGS, offered),
        (
            pages.ADVANCED_CASE_MANAGEMENT if advanced else pages.CASE_MANAGEMENT,
            proof4.case_management_offer(state, app, entity),
        ),
        (pages.USER_PROPERTIES, proof4.user_properties_offer(state, app, entity)),
    )


def app_views(state, app, offers=proof4_offers, *, modules=None, forms=None, cookies=()):
    """Each view of the app with the sections ``offers`` keeps, in HQ's order: app settings, modules, forms.

    ``modules`` (indexes) and ``forms`` (``(module, form)`` indexes) narrow
    the module and form views to those named; ``cookies`` are the browser's
    for every view.
    """
    from proof.editors import pages

    found = [pages.ViewSpec("app_settings", app._id, None, cookies, offers(state, app, "app", None))]
    for m, module in enumerate(app.get_modules()):
        if modules is None or m in modules:
            sections = offers(state, app, "module", module)
            found.append(pages.ViewSpec("view_module", app._id, module.unique_id, cookies, sections))
    for m, module in enumerate(app.get_modules()):
        for f, form in enumerate(module.get_forms()):
            if forms is None or (m, f) in forms:
                sections = offers(state, app, "form", form)
                found.append(pages.ViewSpec("view_form", app._id, form.unique_id, cookies, sections))
    return [spec for spec in found if spec.sections]


def form_view_hq_raises_on(state):
    """The suite app's follow-up form view, its form settings and case management offered; HQ raises on the first.

    A multi-select case list whose follow-up form returns to the previous
    screen: HQ's form page offers no "Previous Screen" for a multi-select
    module (views/forms.py::get_form_view_context), so the form settings'
    workflow control holds 'error', which its save posts and HQ's
    edit_form_attr raises on (jsonobject's BadValueError), and the page
    shows that its save failed. The case management save is HQ's to take.
    """
    from proof.editors import pages
    from proof.hq import operations

    app_id = publish_hq_app(state, SUITE_APP)
    app = operations.held_app(state, app_id)
    followup_as_hqs_editor_writes_it(app)
    app.modules[0].case_details.short.multi_select = True
    app.modules[0].forms[1].post_form_workflow = "previous_screen"
    app.save()
    form = operations.held_app(state, app_id).modules[0].forms[1]
    return pages.ViewSpec("view_form", app_id, form.unique_id, sections=(pages.FORM_SETTINGS, pages.CASE_MANAGEMENT))


def module_view_hq_refuses(state):
    """The suite app's module view, its settings, case list and case detail offered; HQ refuses the case list's.

    The module's case search shows its button on a condition that does not
    parse ('count('). The Case List's save carries the search
    (details/bootstrap3/screen.js::serialize, for the short screen only:
    screen_config.js ``containsSearchConfiguration``), and
    views/modules.py::_gather_and_update_search_properties answers 400 with
    HQ's XPath error, which the page shows as an alert. The module settings
    and the Case Detail's save, to the same view as the Case List's, are
    HQ's to take.
    """
    from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty
    from corehq.apps.case_search.models import CaseSearchConfig

    from proof.editors import pages
    from proof.hq import operations

    CaseSearchConfig.objects.create(domain=state.domain, enabled=True)
    app_id = publish_hq_app(state, SUITE_APP)
    app = operations.held_app(state, app_id)
    app.modules[0].search_config = CaseSearch(
        properties=[CaseSearchProperty(name="name", label={"en": "Name"})],
        search_button_display_condition="count(",
    )
    app.save()
    module = operations.held_app(state, app_id).modules[0]
    return pages.ViewSpec(
        "view_module", app_id, module.unique_id, sections=(pages.MODULE_SETTINGS, pages.CASE_LIST, pages.CASE_DETAIL)
    )


def pytest_terminal_summary(terminalreporter):
    if not _TIMINGS:
        return
    terminalreporter.section("Editor timings (seconds)")
    for name, values in sorted(_TIMINGS.items()):
        terminalreporter.write_line(f"{name}: {values}")
    out = os.environ.get("PROOF_OUT")
    if out:
        Path(out, "editor-timings.json").write_text(json.dumps(_TIMINGS, indent="\t", sort_keys=True) + "\n")
