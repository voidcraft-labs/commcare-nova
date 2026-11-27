"""The instances HQ's build declares where a case list shows its Search button.

Contract: HQ writes a menu's ``search_button_display_condition`` as the
Search action's ``relevant`` on the list's detail
(``sections/details.py::DetailContributor._get_relevant_expression``) and
declares an entry's instances from what its datums, details and frames read
(``post_process/instances.py::_get_all_xpaths_for_entry``), where a detail's
part (``xml_models.py::Detail.get_all_xpaths``) collects each action's frames
and never its ``relevant``. So a condition reading the session over a list
whose selection reads only the case database leaves ``commcaresession``
undeclared on every entry that shows the list, and Core, which decides the
button in that entry's scope (``Detail.getCustomActions``), throws there.
The same condition is declared where the list's filter reads the session,
and where the form's entry returns to its previous screen with the list's
case, which its stack pushes from the session. Nova's gate (``CASE_SEARCH_BUTTON_DISPLAY_CONDITION_NOT_ON_THE_LIST``,
``lib/commcare/suite/case-search/buttonCondition.ts``) and its reading
(``case-search/search-button-display-condition-reading-what-the-case-list-does-not-load``)
refuse exactly the first, and the manifest's reader of that class
(``manifest_value_classes.search_button_reads_what_the_list_does_not_load``)
reads HQ's own build here to the same verdicts.

The plausible failures: an HQ build that does collect the action's condition
(so Nova would refuse a condition HQ declares), and a list filter whose
session read HQ leaves off the entry (so Nova would admit a condition the
device cannot evaluate).
"""

from __future__ import annotations

from types import SimpleNamespace

from lxml import etree

from proof.checks import manifest_value_classes as classes
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

SESSION_READ = "instance('commcaresession')/session/context/username != 'demo'"
SESSION_FILTER = "@owner_id = instance('commcaresession')/session/context/userid"


def _search_app(domain, list_filter=None, workflow=None, condition=SESSION_READ):
    """HQ authors a Search button on a case list containing one follow-up form."""
    from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty
    from corehq.apps.app_manager.tests.app_factory import AppFactory
    from proof.core.test_evaluate import number_form

    factory = AppFactory(domain=domain, build_version="2.54.0")
    module, form = factory.new_basic_module("clients", "client")
    factory.form_requires_case(form, "client")
    form.source = number_form("true()").decode()
    factory.add_module_case_detail_column(module, "short", "name", "Name")
    if workflow is not None:
        form.post_form_workflow = workflow
    module.search_config = CaseSearch(
        properties=[CaseSearchProperty(name="name", label={"en": "Name"})],
        search_button_display_condition=condition,
    )
    if list_filter is not None:
        module.case_details.short.filter = list_filter
    return factory.app


def _built_suite(domain, list_filter=None, workflow=None):
    from corehq.apps.app_manager.tests.util import patch_get_xform_resource_overrides

    app = _search_app(domain, list_filter, workflow)
    with patch_get_xform_resource_overrides():
        return etree.fromstring(app.create_suite())


def _action_and_entry(suite):
    (action,) = [
        action
        for action in suite.iter("action")
        if any((command.get("value") or "").startswith("'search_command.") for command in action.iter("command"))
    ]
    detail = action.getparent()
    (entry,) = [
        entry
        for entry in suite.iter("entry")
        if any(datum.get("detail-select") == detail.get("id") for datum in entry.iter("datum"))
    ]
    return action, entry


def _verdict(suite, action):
    """The manifest reader's verdict on the action's ``relevant`` in this suite."""
    use = SimpleNamespace(
        at=classes.XmlAt(classes.Runtime(suite, "hq/suite.xml"), action, "relevant"),
    )
    return classes.search_button_reads_what_the_list_does_not_load(use, None)


def test_hq_declares_no_instance_for_what_only_the_search_buttons_condition_reads(hq, core_runner):
    with hq_check(Configuration()) as (state, _):
        bare = _built_suite(state.domain)
        filtered = _built_suite(state.domain, SESSION_FILTER)
        returning = _built_suite(state.domain, workflow="previous_screen")

    action, entry = _action_and_entry(bare)
    assert action.get("relevant") == SESSION_READ
    declared = {instance.get("id") for instance in entry.iter("instance")}
    assert "casedb" in declared and "commcaresession" not in declared, declared
    assert _verdict(bare, action) is True

    action, entry = _action_and_entry(filtered)
    assert action.get("relevant") == SESSION_READ
    declared = {instance.get("id") for instance in entry.iter("instance")}
    assert {"casedb", "commcaresession"} <= declared, declared
    assert _verdict(filtered, action) is False

    # A form returning to its previous screen pushes the list's case from the session, and HQ collects the entry's
    # stack, so the session is declared there.
    action, entry = _action_and_entry(returning)
    declared = {instance.get("id") for instance in entry.iter("instance")}
    assert "commcaresession" in declared, declared
    assert "commcaresession" in etree.tostring(entry.find("stack")).decode()
    assert _verdict(returning, action) is False


COUNT_CASES = "count(instance('casedb')/casedb/case[@case_type = 'client']) > 1"
COUNT_WITH_SESSION = (
    "count(instance('casedb')/casedb/case[@case_type = 'client']"
    "[@owner_id = instance('commcaresession')/session/context/userid]) > 1"
)


def test_the_hq_search_button_counts_restored_cases_without_loading_new_instances(hq, core_runner, tmp_path):
    from corehq.apps.app_manager.tests.util import patch_get_xform_resource_overrides
    from proof.core.artifacts import SESSION_RESTORE
    from proof.core.test_session import CASE_XMLNS, person_cases
    from proof.observe.build import arrange

    def archive(domain, name, condition, unexpected_session):
        app = _search_app(domain, condition=condition)
        app._id = f"search-count-{name}"
        # HQ assigns an integer version when it saves an application. This
        # in-memory app is otherwise still unversioned when HQ builds it.
        app.version = 1
        with patch_get_xform_resource_overrides():
            suite = etree.fromstring(app.create_suite())
            files = app.create_all_files()
        action, entry = _action_and_entry(suite)
        assert action.get("relevant") == condition
        assert {instance.get("id") for instance in entry.iter("instance")} == {"casedb"}
        assert _verdict(suite, action) is unexpected_session
        return arrange(files, tmp_path / name)

    def restore(ids):
        restore = etree.fromstring(person_cases(SESSION_RESTORE.read_bytes(), ids))
        case_ns = f"{{{CASE_XMLNS}}}"
        for case in restore.iter(f"{case_ns}case"):
            if case.get("case_id") in ids:
                case.find(f"{case_ns}create/{case_ns}case_type").text = "client"
        return etree.tostring(restore)

    def walk(path, ids):
        report = core_runner.admit(path)
        assert report["admitted"], {
            key: report.get(key) for key in ("problems", "profile", "versionCheck")
        }
        try:
            return core_runner.session(report["app"], restore=restore(ids))
        finally:
            core_runner.release(report["app"])

    def lists(result):
        return [
            step for run in result["runs"] for step in run["trace"]
            if step.get("screen") == "case-list"
        ]

    with hq_check(Configuration()) as (state, _):
        counted = archive(state.domain, "counted", COUNT_CASES, False)
        undeclared = archive(state.domain, "undeclared", COUNT_WITH_SESSION, True)
    one = lists(walk(counted, ["one"]))
    two = lists(walk(counted, ["one", "two"]))
    assert one and two, (one, two)
    assert {row["caseId"] for step in one for row in step["rows"]} == {"one"}, repr(one)
    assert {row["caseId"] for step in two for row in step["rows"]} == {"one", "two"}, repr(two)
    assert all(not step.get("actions") for step in one), repr(one)
    assert any(step.get("actions") for step in two), repr(two)
    blocked = walk(undeclared, ["one", "two"])
    refused = [
        step["error"] for run in blocked["runs"] for step in run["trace"] if "error" in step
    ]
    assert any(
        error["class"].endswith(".XPathMissingInstanceException") and "commcaresession" in error["message"]
        for error in refused
    ), blocked


def test_the_hq_search_button_orders_worker_text_only_with_a_declared_session(hq, core_runner, tmp_path):
    from corehq.apps.app_manager.tests.util import patch_get_xform_resource_overrides
    from proof.core.artifacts import SESSION_RESTORE
    from proof.core.test_session import CASE_XMLNS, person_cases
    from proof.observe.build import arrange

    worker = "instance('commcaresession')/session/context/username"
    worker_id = "instance('commcaresession')/session/context/userid"
    ordered = f"{worker} > 'm'"
    numeric = f"number({worker}) > number('m')"
    # The case-type arm keeps the same restored list even if the test worker
    # does not own a fixture case. The other arm declares the session.
    filtered = f"{SESSION_FILTER} or @case_type = 'client'"
    case_ns = f"{{{CASE_XMLNS}}}"
    restored = etree.fromstring(person_cases(SESSION_RESTORE.read_bytes(), ["one"]))
    restored.find(f".//{case_ns}create/{case_ns}case_type").text = "client"
    restore = etree.tostring(restored)

    with hq_check(Configuration()) as (state, _):
        for label, condition, list_filter, expected in (
            ("without-session", ordered, None, "missing"),
            ("with-session", ordered, filtered, "hidden"),
            ("numeric-control", numeric, filtered, "hidden"),
            ("worker-id-with-session", f"{worker_id} > 'm'", filtered, "hidden"),
            ("worker-id-without-session", f"{worker_id} > 'm'", None, "missing"),
            ("shown-control", "true()", filtered, "shown"),
        ):
            app = _search_app(state.domain, list_filter, condition=condition)
            app._id = f"search-worker-order-{label}"
            app.version = 1
            with patch_get_xform_resource_overrides():
                suite = etree.fromstring(app.create_suite())
                files = app.create_all_files()
            action, entry = _action_and_entry(suite)
            assert action.get("relevant") == condition
            instance_ids = {instance.get("id") for instance in entry.iter("instance")}
            assert ("commcaresession" in instance_ids) == (list_filter is not None), instance_ids
            assert _verdict(suite, action) is (expected == "missing")
            report = core_runner.admit(arrange(files, tmp_path / label))
            assert report["admitted"], report
            try:
                observed = core_runner.session(report["app"], restore=restore)
            finally:
                core_runner.release(report["app"])

            trace = [step for run in observed["runs"] for step in run["trace"]]
            if expected == "missing":
                assert any(
                    step.get("error", {}).get("class", "").endswith(".XPathMissingInstanceException")
                    and "commcaresession" in step["error"]["message"]
                    for step in trace
                ), observed
            else:
                lists = [step for step in trace if step.get("screen") == "case-list"]
                assert lists and {row["caseId"] for step in lists for row in step["rows"]} == {"case_one"}, observed
                assert all(bool(step.get("actions")) == (expected == "shown") for step in lists), observed


def test_first_case_list_row_already_witnesses_its_restored_case_type(hq, core_runner, tmp_path):
    from corehq.apps.app_manager.models import CaseSearch
    from corehq.apps.app_manager.models.case_list import DetailColumn
    from corehq.apps.app_manager.tests.util import patch_get_xform_resource_overrides

    from proof.core.artifacts import SESSION_RESTORE
    from proof.core.test_session import CASE_XMLNS, person_cases
    from proof.observe.build import arrange

    case_ns = f"{{{CASE_XMLNS}}}"
    def restore_of(clients, *other):
        names = (*clients, *other)
        restored = etree.fromstring(person_cases(SESSION_RESTORE.read_bytes(), names))
        for case in restored.iter(f"{case_ns}case"):
            if case.get("case_id") in clients:
                case.find(f"{case_ns}create/{case_ns}case_type").text = "client"
        return etree.tostring(restored)

    def visible_rows(name, list_filter, restore, *, count_column=False):
        app = _search_app(state.domain, list_filter)
        module = app.modules[0]
        module.search_config = CaseSearch()
        if count_column:
            module.case_details.short.columns.append(DetailColumn(
                header={"en": "Restored clients"}, format="plain", model="case", useXpathExpression=True,
                field=COUNT_CASES.removesuffix(" > 1"),
            ))
        app._id = f"list-count-{name}"
        app.version = 1
        with patch_get_xform_resource_overrides():
            files = app.create_all_files()
        path = arrange(files, tmp_path / name)
        opened = core_runner.admit(path)
        assert opened["admitted"], opened["problems"]
        try:
            walk = core_runner.session(opened["app"], restore=restore)
        finally:
            core_runner.release(opened["app"])
        return {
            row["caseId"]: row["fields"]
            for run in walk["runs"] for step in run["trace"]
            if step.get("screen") == "case-list"
            for row in step["rows"]
        }

    def visible_ids(name, list_filter, restore):
        return set(visible_rows(name, list_filter, restore))

    with hq_check(Configuration()) as (state, _):
        one = restore_of(("one",))
        assert visible_ids("plain", None, one) == {"case_one"}
        assert visible_ids("same-type-exists", COUNT_CASES.replace("> 1", "> 0"), one) == {"case_one"}
        assert visible_ids("another-type-is-not-a-witness", COUNT_CASES, restore_of(("one",), "other")) == set()
        assert visible_ids("another-case-required", COUNT_CASES, one) == set()
        two = restore_of(("one", "two"))
        assert visible_ids("another-case-witnesses-type", COUNT_CASES, two) == {"case_one", "case_two"}

        one_with_neighbor = visible_rows("case-count-one", None, restore_of(("one",), "other"), count_column=True)
        assert {key: fields[-1] for key, fields in one_with_neighbor.items()} == {"case_one": "1"}
        two_clients = visible_rows("case-count-two", None, two, count_column=True)
        assert {key: fields[-1] for key, fields in two_clients.items()} == {"case_one": "2", "case_two": "2"}
