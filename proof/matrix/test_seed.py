"""The case seed of an app made in HQ (``proof/matrix/seed.py::case_seed``), read from A alone.

The contract (``seed.py``'s docstring): every type HQ's app holds but the
user case, parents first, each with the properties HQ's own property map
gives it less ``parent/<property>`` and ``name``, its parent, the identifier
its forms index it under and the relationship its opening action states; each
property typed by the questions that write it; every literal A's expressions
compare with a property; and a database generated from the seed, whatever the
document Nova read holds. The plausible failures: a seed that reads D, so a
reader that drops a literal empties both walks' lists; a compared literal
missed; ``parent/<property>`` or ``name`` written as a case property;
``commcare-user`` or a survey menu's empty type seeded as a type; a child indexed under ``parent`` where its
form names another identifier. The tests of ``compared_literals`` run on the
standard library; the others build planted apps with HQ's own models.
"""

from __future__ import annotations

from proof.matrix import seed


def test_a_literal_beside_a_comparison_is_its_propertys_value():
    assert seed.compared_literals("status = 'open'") == [("status", "open")]
    assert seed.compared_literals("'open' != status") == [("status", "open")]
    assert seed.compared_literals("dob > '2000-01-01' and village = \"north\"") == [
        ("dob", "2000-01-01"),
        ("village", "north"),
    ]
    assert seed.compared_literals("selected(/data/crops, 'maize')") == [("crops", "maize")]


def test_a_cases_path_through_its_root_and_predicates_is_one_operand():
    text = (
        "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/village = 'south'"
    )
    assert seed.compared_literals(text) == [("village", "south")]


def test_an_operand_that_is_no_bare_path_compares_no_property():
    assert seed.compared_literals("a + status = 'x'") == []
    assert seed.compared_literals("status = 'a' + b") == []
    assert seed.compared_literals("count(status) = '1'") == []
    assert seed.compared_literals("concat(status, 'x')") == []


def test_a_session_users_data_names_are_read_from_cores_instance_paths():
    parsed = {
        "instancePaths": [
            {"instance": "commcaresession", "steps": ["session", "user", "data", "district"]},
            {"instance": "commcaresession", "steps": ["session", "data", "case_id"]},
            {"instance": "casedb", "steps": ["casedb", "case", None]},
        ]
    }
    assert seed.session_user_data(parsed) == ["district"]


# Over planted apps HQ's own models make --------------------------------------------------------------------------


def _source(questions):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder("Visit")
    for name, data_type, choices in questions:
        xform.new_question(name, name.title(), data_type, choices=choices)
    return xform.tostring(xml_declaration=True).decode("utf-8")


def _planted(state, *, case_list_filter="status = 'open'", subcases=(), survey=False):
    """An app of one ``household`` menu whose list filter is ``case_list_filter``, with a visit form saving
    ``status`` (a single select) and ``visits`` (an integer), and opening each of ``subcases``
    (``(case type, reference_id, relationship)``) with its ``age``, and a menu of each subcase's type, made with
    HQ's own models. HQ's case types are the ones its menus name (``ModuleBase.get_case_types``), as every base
    that opens a child gives the child a menu of its own, so a type no menu names is none of the app's. With
    ``survey``, a last menu holds no case type."""
    from corehq.apps.app_manager.models import (
        Application,
        ConditionalCaseUpdate,
        FormActionCondition,
        Module,
        OpenSubCaseAction,
        UpdateCaseAction,
    )

    from proof.hq import operations

    with state.operation("seed:planted", repr((case_list_filter, subcases, survey)).encode()):
        app = Application.new_app(state.domain, "Seeded")
        module = app.add_module(Module.new_module("Households", "en"))
        module.case_type = "household"
        module.case_details.short.filter = case_list_filter
        source = _source(
            [
                ("status", "select1", {"open": "Open", "closed": "Closed"}),
                ("visits", "int", None),
                ("age", "int", None),
            ]
        )
        form = app.new_form(0, "Visit", "en", attachment=source)
        form.requires = "case"
        form.actions.update_case = UpdateCaseAction(
            update={
                "status": ConditionalCaseUpdate(question_path="/data/status"),
                "visits": ConditionalCaseUpdate(question_path="/data/visits"),
            },
            condition=FormActionCondition(type="always"),
        )
        for case_type, reference_id, relationship in subcases:
            form.actions.subcases.append(
                OpenSubCaseAction(
                    case_type=case_type,
                    reference_id=reference_id,
                    relationship=relationship,
                    name_update=ConditionalCaseUpdate(question_path="/data/status"),
                    case_properties={"age": ConditionalCaseUpdate(question_path="/data/age")},
                    condition=FormActionCondition(type="always"),
                )
            )
        for case_type in sorted({case_type for case_type, _, _ in subcases}):
            child = app.add_module(Module.new_module(case_type.title(), "en"))
            child.case_type = case_type
        if survey:
            app.add_module(Module.new_module("Surveys", "en"))
        app.save()
        return operations.held_app(state, app._id)


def _types(found):
    return {entry["name"]: entry for entry in found["catalog"]}


def test_a_compared_literal_of_a_planted_app_seeds_its_property(hq, core_runner):
    from proof.hq.check import hq_check
    from proof.hq.configuration import Configuration

    with hq_check(Configuration()) as (state, _):
        found = seed.case_seed(state, _planted(state), core_runner)
        unfiltered = seed.case_seed(state, _planted(state, case_list_filter=""), core_runner)
    assert found["values"] == {"household/status": ["open"]}
    assert unfiltered["values"] == {}
    household = _types(found)["household"]
    by_name = {prop["name"]: prop for prop in household["properties"]}
    assert by_name["status"]["data_type"] == "single_select"
    assert sorted(by_name["status"]["options"]) == ["closed", "open"]
    assert by_name["visits"]["data_type"] == "int"


def test_a_child_is_indexed_as_its_form_names_it_and_holds_no_parent_or_name_property(hq, core_runner):
    from proof.hq.check import hq_check
    from proof.hq.configuration import Configuration

    with hq_check(Configuration(privileges=frozenset({"USERCASE"}))) as (state, _):
        app = _planted(state, subcases=[("member", "household_ref", "extension")], survey=True)
        found = seed.case_seed(state, app, core_runner)
    types = _types(found)
    assert [entry["name"] for entry in found["catalog"]] == ["household", "member"]
    assert seed.USERCASE_TYPE not in types
    member = types["member"]
    assert (member["parent_type"], member["index_identifier"], member["relationship"]) == (
        "household",
        "household_ref",
        "extension",
    )
    names = [prop["name"] for prop in member["properties"]]
    assert "age" in names and "name" not in names and not [name for name in names if "/" in name]


def test_a_type_opened_under_two_relationships_is_refused_by_name(hq, core_runner):
    from proof.hq.check import hq_check
    from proof.hq.configuration import Configuration

    with hq_check(Configuration()) as (state, _):
        app = _planted(state, subcases=[("member", "parent", "child"), ("member", "parent", "extension")])
        try:
            seed.case_seed(state, app, core_runner)
        except seed.SeedRefused as refusal:
            assert "member" in str(refusal)
        else:
            raise AssertionError("case_seed wrote one relationship for a type its forms open under two")


def test_the_database_of_a_seed_holds_its_literal_whatever_d_holds(hq, core_runner):
    """A document made in HQ takes its case database from its seed, so a D whose filter a reader dropped changes
    no byte of it (``proof/observe/casedata.py::document_case_database``)."""
    from proof.hq.check import hq_check
    from proof.hq.configuration import Configuration
    from proof.observe import casedata

    with hq_check(Configuration()) as (state, _):
        found = seed.case_seed(state, _planted(state), core_runner)

    class Authored:
        case_seed = found

        def __init__(self, document):
            self.document = document
            self.edit_document = document

        def derived(self, name, *, edit=False):
            return None

    with_filter = {"doc": {"modules": {"m": {"caseListConfig": {"filter": "status = 'open'"}}}}}
    without_filter = {"doc": {"modules": {"m": {"caseListConfig": {}}}}}
    first = casedata.document_case_database(Authored(with_filter))
    second = casedata.document_case_database(Authored(without_filter))
    assert first == second == casedata.seeded_case_database(found)
    statuses = {
        value
        for case in first.cases
        if case.case_type == "household"
        for name, value in case.properties
        if name == "status"
    }
    assert "open" in statuses
