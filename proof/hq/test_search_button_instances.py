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
    from proof.core.artifacts import BASIC_RESTORE
    from proof.core.test_session import person_cases
    from proof.observe.build import arrange

    def archive(domain, name, condition, unexpected_session):
        app = _search_app(domain, condition=condition)
        app._id = f"search-count-{name}"
        with patch_get_xform_resource_overrides():
            suite = etree.fromstring(app.create_suite())
            files = app.create_all_files()
        action, entry = _action_and_entry(suite)
        assert action.get("relevant") == condition
        assert {instance.get("id") for instance in entry.iter("instance")} == {"casedb"}
        assert _verdict(suite, action) is unexpected_session
        return arrange(files, tmp_path / name)

    def restore(ids):
        return person_cases(BASIC_RESTORE.read_bytes(), ids).replace(
            b"<case_type>person</case_type>", b"<case_type>client</case_type>"
        )

    def walk(path, ids):
        report = core_runner.admit(path)
        assert report["admitted"], report["problems"]
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
    assert all(not step.get("actions") for step in one), one
    assert any(step.get("actions") for step in two), two
    blocked = walk(undeclared, ["one", "two"])
    assert "XPathMissingInstanceException" in str(blocked), blocked
