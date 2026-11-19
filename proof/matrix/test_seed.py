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
form names another identifier; a case a base names (``Base.cases``) holding a
value A never gives, moving a generated case, or written into the seed of a
base that names none. The tests of ``compared_literals`` and of the cases a
base names run on the standard library; the others build planted apps with
HQ's own models.
"""

from __future__ import annotations

import json

import pytest

from proof.matrix import seed
from proof.matrix.registry import BASES, HQ_APPS


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


def test_a_search_query_rows_csql_is_read_where_its_value_is_one_literal():
    """A search's ``_xpath_query`` default property sends the CSQL its string literal holds, which compares a
    property with a literal HQ's search matches only where some case holds it (hq-search's ``village = 'north'`` on
    the menu whose forms read the search). The plausible failure: the row read as the XPath it is, one string,
    which compares nothing, so HQ's answer to the search is empty on every state and the walk never reaches the
    menu's forms. A value that works anything out at run time sends no fixed text."""
    assert seed._sent_query("\"village = 'north'\"") == ["village = 'north'"]
    assert [pair for text in seed._sent_query("\"village = 'north'\"") for pair in seed.compared_literals(text)] == [
        ("village", "north")
    ]
    assert seed.compared_literals("\"village = 'north'\"") == []
    assert seed._sent_query("concat('village = \"', instance('commcaresession')/session/data/v, '\"')") == []
    assert seed._sent_query("'match-all()'") == ["match-all()"]


def test_a_session_users_data_names_are_read_from_cores_instance_paths():
    parsed = {
        "instancePaths": [
            {"instance": "commcaresession", "steps": ["session", "user", "data", "district"]},
            {"instance": "commcaresession", "steps": ["session", "data", "case_id"]},
            {"instance": "casedb", "steps": ["casedb", "case", None]},
        ]
    }
    assert seed.session_user_data(parsed) == ["district"]


# The cases a base names --------------------------------------------------------------------------------------------

CATALOG = [
    {
        "name": "client",
        "parent_type": None,
        "relationship": None,
        "index_identifier": None,
        "properties": [
            {"name": "district", "data_type": "single_select", "options": ["d1", "d2"]},
            {"name": "standing", "data_type": "text", "options": []},
            {"name": "village", "data_type": "text", "options": []},
        ],
    }
]
VALUES = {"client/standing": ["active", "open"], "client/village": ["north"]}
READ = {"catalog": CATALOG, "values": VALUES, "userData": [], "worker": {"location": None}}


def test_a_named_case_puts_together_values_a_gives_one_by_one():
    """A base names a case holding values A compares or offers (``stated_cases``), and the seed writes it under
    ``cases``. The plausible failure: a named case holding a value A never gives, so the seed carries a value of the
    base's own rather than A's, or a type or property A lacks, which no case of A's could hold."""
    named = [("client", (("village", "north"), ("standing", "open"), ("district", "d2")))]
    assert seed.stated_cases(CATALOG, VALUES, named) == [
        {"type": "client", "properties": {"district": "d2", "standing": "open", "village": "north"}}
    ]
    refused = {
        "a type A lacks": [("household", (("village", "north"),))],
        "a property A does not give the type": [("client", (("age", "7"),))],
        "a value A neither compares nor offers": [("client", (("village", "south"),))],
    }
    for why, cases in refused.items():
        with pytest.raises(seed.SeedRefused):
            seed.stated_cases(CATALOG, VALUES, cases)
            raise AssertionError(f"stated_cases wrote a case naming {why}")


def test_a_base_that_names_no_case_keeps_its_seed_and_its_database():
    """A base that names no case writes no ``cases``, so every other base's ``seed.json`` and the database made from it
    stay as they were. The plausible failure: an empty ``cases`` written into every seed, which moves every retained
    base, or a generation that moves a case where none is named."""
    from proof.observe import casedata

    assert seed.with_stated_cases(READ, ()) == READ and "cases" not in seed.with_stated_cases(READ, ())
    assert casedata.seeded_case_database(READ) == casedata.seeded_case_database({**READ, "cases": []})


def test_a_named_case_follows_its_types_generated_cases_and_moves_none():
    """The named case comes after its type's generated cases and generates as the case at its place would, with the
    values it names in their place. The plausible failure: a generated case moved or renumbered, so every walk of the
    base reads other cases, or a named case holding none of its type's values where it names none."""
    from proof.observe import casedata

    named = seed.with_stated_cases(READ, [("client", (("standing", "open"), ("village", "north")))])
    plain = [case for case in casedata.seeded_case_database(READ).cases if case.case_type == "client"]
    clients = [case for case in casedata.seeded_case_database(named).cases if case.case_type == "client"]
    assert clients[:-1] == plain
    added = clients[-1]
    assert added.case_id == f"client-{len(clients)}" and added.name in casedata.VALUES["text"]
    properties = dict(added.properties)
    assert (properties["standing"], properties["village"]) == ("open", "north")
    assert properties["district"] in {"d1", "d2", *casedata.VALUES["single_select"]}


def test_hq_searchs_inline_search_lists_a_client_its_two_filters_keep():
    """hq-search's ``Visits`` menu lists the results of a search for ``village = 'north'`` under the list filter
    ``standing = 'open'``. Its database (the retained seed with the case the base names) holds a client both keep, so
    a walk past the search reaches the menu's form on A and on B, and a client each filter alone drops, so neither
    keeps every case. The plausible failure: each property's values given one by one, so no client is both and the
    list is empty on A and B alike."""
    from proof.matrix.bases import search
    from proof.observe import casedata

    (base,) = [base for base in BASES if base.id == "hq-search"]
    read = json.loads((HQ_APPS / base.id / "seed.json").read_text(encoding="utf-8"))
    database = casedata.seeded_case_database(seed.with_stated_cases(read, base.cases))
    ((listed, listed_value),) = seed.compared_literals(search.LIST_FILTER)
    ((searched, searched_value),) = [
        pair for text in seed._sent_query(search.JOINED_ROW) for pair in seed.compared_literals(text)
    ]
    kept = [
        (dict(case.properties)[listed] == listed_value, dict(case.properties)[searched] == searched_value)
        for case in database.cases
        if case.case_type == search.CASE_TYPE
    ]
    assert (True, True) in kept and (False, True) in kept and (True, False) in kept, kept


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
