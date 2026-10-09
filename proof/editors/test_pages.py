"""Every covered page saves HQ's own app through HQ's own views, and a second save changes nothing.

Contract: each covered app-manager page is rendered by HQ's page view, its
JavaScript makes its save request from the page's own state, and HQ's save
view (decorators and all) applies it. Each save here is made as proof 4
makes it, from a load of its view on the driver's reused page
(``pages.run_view``); ``test_view_equivalence.py`` holds that equal to a
fresh page's save. The plausible failures: a save that
never reaches HQ's view (a page whose JavaScript did not run, a button the
driver cannot reach), a save made from something other than the page's state
(the driver's own change to a control left behind), and a save that fails in
HQ where HQ's own page would succeed. The module pages are HQ's templates for
a basic module and for an advanced module (``module_view_advanced.html``),
which render different panels; the form pages likewise.

The apps are HQ's own test apps (``corehq/apps/app_manager/tests/data``),
which HQ's editors built, so each page's unchanged save should leave HQ's
build as it was. Where HQ's first save of a page rewrites an app HQ built
before the page existed in its current form, the files that rewrite reaches
are named per page with the source that does it, nothing else may change,
and what did change must run the same in Core (the traces of the scripted
sessions over the build before and after the save are equal, over case data
holding a case of each case type the app lists); the settings page's rewrite
is the settings it posted, which HQ now writes into the profile. The second
save, over what the first left, must change nothing at all, which is what
shows the driver adds nothing of its own.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field

import pytest

from proof.editors import compare, pages
from proof.editors.conftest import ADVANCED_APP, SUITE_APP, publish_hq_app, record_timing, save_section, write_evidence
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})

# suite/app.json's case list has a column of the legacy ``filter`` format.
# details/bootstrap3/screen.js leaves such columns out of the page ("Filters
# are a type of DetailColumn on the server. Don't display them with the other
# columns"), so the first Case List save posts the columns without it and
# views/modules.py::edit_module_detail_screens rebuilds the list without it:
# the columns after it get new positions, and so new header ids in the suite
# and the app strings.
CASE_LIST_REWRITE = frozenset({"suite.xml", "default/app_strings.txt", "en/app_strings.txt"})

# settings/bootstrap5/commcare_settings.js::serialize posts every setting,
# views/settings.py::edit_commcare_settings stores each one in app.profile,
# and the profile HQ builds (Application.create_profile) writes each stored
# setting whose value is set; suite/app.json stores none.
PROFILE_REWRITE = frozenset({"profile.xml", "profile.ccpr", "media_profile.xml", "media_profile.ccpr"})


@dataclass(frozen=True)
class CaseData:
    """The case data the Core traces run over: cases, and the call-center indicators they show."""

    # Each (case_id, case_type, name, properties).
    cases: tuple
    # Per case id, the call-center indicators HQ's restore carries in its
    # indicators fixture (corehq/apps/callcenter/fixturegenerators.py).
    indicators: dict = field(default_factory=dict)

    def restore(self):
        import datetime
        from types import SimpleNamespace
        from xml.etree import ElementTree

        from corehq.apps.callcenter.fixturegenerators import gen_fixture

        fixtures = []
        if self.indicators:
            indicator_set = SimpleNamespace(
                name="call-center", get_data=lambda: self.indicators, reference_date=datetime.date(2026, 1, 15)
            )
            user = SimpleNamespace(user_id=compare.restore_user_id())
            fixtures.append(ElementTree.tostring(gen_fixture(user, indicator_set)))
        return compare.case_restore(self.cases, fixtures)


# A case of each case type the apps' modules list. suite/app.json's case
# passes its case list's filter (``filter = 'danny'``), and that case list
# shows a call-center indicator, which Core reads from the indicators fixture.
SUITE_DATA = CaseData(
    cases=(
        (
            "suite-case",
            "suite_test",
            "Danny",
            {"filter": "danny", "plain": "Plain text", "phone": "5550100", "enum": "yes", "address": "Main Street"},
        ),
    ),
    indicators={"suite-case": {"activeClientsLast30Day": "3"}},
)
ADVANCED_DATA = CaseData(
    cases=(
        ("clinic-case", "clinic", "North clinic", {"name": "North clinic"}),
        ("requisition-case", "requisition", "First requisition", {}),
    ),
)


def _no_preparation(state, app_id):
    return None


def _translations(state, app_id):
    # UI translation overrides, set as views/apps.py::edit_app_ui_translations sets them.
    app = operations.held_app(state, app_id)
    app.set_translations("en", {"cchq.case": "Client", "forms.start": "Begin"})
    app.save()


def _case_list_label(index):
    # suite-advanced.json shows module 1's case list in the menu with no label,
    # which HQ's module settings save refuses ("A label is required for
    # case_list", views/modules.py::edit_module_attr); the label is set as that
    # view stores it (module.case_list.label[lang]).
    def prepare(state, app_id):
        app = operations.held_app(state, app_id)
        app.modules[index].case_list.label["en"] = "Clinics"
        app.save()

    return prepare


def _case_search(index):
    # Case search on for the project space, and a search by name on the
    # module, as HQ's Case List save stores one: its title and description
    # keyed by the page's language, empty until a person writes them
    # (views/modules.py::_gather_and_update_search_properties). A search made
    # without them gets an empty description from its first save, which HQ's
    # build then emits (remote_requests.py::build_remote_request_queries emits
    # a description whenever the stored one is not {}).
    def prepare(state, app_id):
        from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty
        from corehq.apps.case_search.models import CaseSearchConfig

        CaseSearchConfig.objects.create(domain=state.domain, enabled=True)
        app = operations.held_app(state, app_id)
        app.modules[index].search_config = CaseSearch(
            properties=[CaseSearchProperty(name="name", label={"en": "Name"})],
            title_label={"en": ""},
            description={"en": ""},
        )
        app.save()

    return prepare


@dataclass(frozen=True)
class PageCase:
    id: str
    page: pages.EditorPage
    app: str
    target: Callable
    prepare: Callable = _no_preparation
    # The built files HQ's first save of the page rewrites on this app (see above).
    first_save_rewrites: frozenset = field(default_factory=frozenset)
    data: CaseData = SUITE_DATA


def _app(app):
    return None


def _module(index):
    return lambda app: app.modules[index].unique_id


def _form(module, form):
    return lambda app: app.modules[module].forms[form].unique_id


CASES = [
    PageCase("app settings", pages.APP_SETTINGS, SUITE_APP, _app, first_save_rewrites=PROFILE_REWRITE),
    PageCase("add-ons", pages.ADD_ONS, SUITE_APP, _app),
    PageCase("UI translations", pages.UI_TRANSLATIONS, SUITE_APP, _app, prepare=_translations),
    PageCase("module settings", pages.MODULE_SETTINGS, SUITE_APP, _module(0)),
    PageCase("case list", pages.CASE_LIST, SUITE_APP, _module(0), first_save_rewrites=CASE_LIST_REWRITE),
    PageCase(
        "case search",
        pages.CASE_SEARCH,
        SUITE_APP,
        _module(0),
        prepare=_case_search(0),
        first_save_rewrites=CASE_LIST_REWRITE,
    ),
    PageCase(
        "module settings (advanced)",
        pages.MODULE_SETTINGS,
        ADVANCED_APP,
        _module(1),
        prepare=_case_list_label(1),
        data=ADVANCED_DATA,
    ),
    PageCase("case list (advanced)", pages.CASE_LIST, ADVANCED_APP, _module(1), data=ADVANCED_DATA),
    PageCase(
        "case search (advanced)",
        pages.CASE_SEARCH,
        ADVANCED_APP,
        _module(1),
        prepare=_case_search(1),
        data=ADVANCED_DATA,
    ),
    PageCase("form settings", pages.FORM_SETTINGS, SUITE_APP, _form(0, 0)),
    PageCase("case management", pages.CASE_MANAGEMENT, SUITE_APP, _form(0, 0)),
    PageCase(
        "case management (advanced)",
        pages.ADVANCED_CASE_MANAGEMENT,
        ADVANCED_APP,
        _form(1, 0),
        data=ADVANCED_DATA,
    ),
]


def _without_profile_properties(trace):
    """The trace with the profile's properties left out, which the settings page's rewrite changes on purpose."""
    trace = json.loads(json.dumps(trace))
    trace["profile"].pop("properties", None)
    return trace


def _settings_rewrite(before, after, posted):
    """What the settings save changed in the profile, and what the posted settings say it should be."""
    changed, expected = {}, {}
    for kind in ("properties", "features"):
        was, now = before[kind], after[kind]
        changed[kind] = {key: now.get(key) for key in set(was) | set(now) if was.get(key) != now.get(key)}
        # Application.create_profile writes a stored setting only when its value is set.
        expected[kind] = {
            key: str(value) for key, value in posted.get(kind, {}).items() if value and was.get(key) != str(value)
        }
    return changed, expected


@pytest.mark.parametrize("case", CASES, ids=[case.id for case in CASES])
def test_a_covered_page_saves_hqs_own_app_through_hqs_views(hq, core_runner, editor_driver, case):
    restore = case.data.restore()
    with hq_check(CONFIGURATION) as (state, record):
        app_id = publish_hq_app(state, case.app)
        case.prepare(state, app_id)
        target = case.target(operations.held_app(state, app_id))
        before = compare.build(state, app_id, record)
        first = save_section(editor_driver, state, case.page, app_id, target)
        after_first = compare.build(state, app_id, record, version=before.app.version)
        second = save_section(editor_driver, state, case.page, app_id, target)
        after_second = compare.build(state, app_id, record, version=before.app.version)

    for saved in (first, second):
        record_timing(f"page_save:{case.id}", saved.seconds)
        # The save reached HQ's save view: the page's own script made it.
        assert saved.save.url_name == case.page.save
        assert saved.save.status == 200 and not saved.refused, saved.save.response
        assert saved.bar_state == "savebtn-bar-saved"
        assert not saved.run["pageErrors"]

    first_changes = compare.differences(before.files, after_first.files)
    second_changes = compare.differences(after_first.files, after_second.files)
    diffs = {
        path: compare.file_diff(before.files, after_first.files, path)
        for path, what in first_changes
        if what.endswith("differ") or what.endswith("differs") or "differ at" in what
    }
    write_evidence(
        f"page-{case.id.replace(' ', '-')}",
        {
            "first_save_changes": first_changes,
            "first_save_diffs": diffs,
            "second_save_changes": second_changes,
            "request": first.save.body,
        },
    )
    assert {path for path, _ in first_changes} <= case.first_save_rewrites, diffs
    assert second_changes == []
    assert after_first.errors == after_second.errors == before.errors == []

    if first_changes:
        traces = [compare.core_trace(core_runner, built, restore) for built in (before, after_first)]
        # The sessions reached the app's case list and listed the case there,
        # so the comparison covers what the rewrite could change.
        assert compare.listed_cases(traces[0]) == {case_id for case_id, *_ in case.data.cases}, traces[0]["runs"]
        if case.page is pages.APP_SETTINGS:
            changed, expected = _settings_rewrite(
                compare.profile_settings(before.files),
                compare.profile_settings(after_first.files),
                json.loads(first.save.body),
            )
            assert changed == expected
            traces = [_without_profile_properties(trace) for trace in traces]
        assert compare.first_difference(*traces) is None
