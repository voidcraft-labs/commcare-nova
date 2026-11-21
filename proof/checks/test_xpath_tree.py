"""Two texts of one form's expression read as one expression only where every reader reads them alike.

Contract (``proof.checks.xpath_tree.same``): a string by its value, a number by its value, parentheses the
operators' order already gives, a run of ``and`` or ``or`` regrouped, ``instance('<id>')`` by the source each
form declares, and a path from ``current()`` by the node the slot is about are one expression; another literal,
operator, operand, step, predicate or source is not, nor is a text Core's lexer does not read. The plausible
failures: a respelled calculation reported as a change of the question on every base made in CommCare HQ, and
a changed calculation held as a respelling (``proof.checks.xform_parts``, ``:respelled``).
"""

from __future__ import annotations

import pytest

from proof.checks.xpath_tree import same, tree


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ('if(selected(/data/crops, "corn"), 1, 0)', "if(selected(/data/crops, 'corn'), 1, 0)"),
        (". > 0 and . <= 10.", ". > 0 and . <= 10"),
        (
            "(/data/a = 1 and (/data/b = '1' or /data/b = '2')) or /data/c = 1",
            "/data/a = 1 and (/data/b = '1' or /data/b = '2') or /data/c = 1",
        ),
        ("(/data/a div /data/b) div /data/c", "/data/a div /data/b div /data/c"),
        ("/data/a and (/data/b and /data/c)", "(/data/a and /data/b) and /data/c"),
        ("/data/a*2", "/data/a * 2"),
    ],
)
def test_one_expression_written_another_way_is_the_same(before, after):
    assert same(before, after)


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ("/data/a * 2", "/data/a * 3"),
        ("'corn'", "'rice'"),
        ("/data/a div /data/b div /data/c", "/data/a div (/data/b div /data/c)"),
        ("/data/a - /data/b - /data/c", "/data/a - (/data/b - /data/c)"),
        ("/data/a = 1 and /data/b = 1 or /data/c = 1", "/data/a = 1 and (/data/b = 1 or /data/c = 1)"),
        ("/data/a[. = 1]", "/data/a[. = 2]"),
        ("/data/a", "/data/b"),
        ("count(/data/m[. != ''])", "/data/nova_constraint_m_0"),
    ],
)
def test_another_expression_is_not(before, after):
    assert not same(before, after)


def test_a_question_s_default_read_from_itself_is_the_path_it_names():
    context = ("data", "code_again")
    assert same("/data/code", "current()/../code", context=context)
    assert not same("/data/code", "current()/../other", context=context)
    # With no node to read it from, a path from current() is no path from the root.
    assert not same("/data/code", "current()/../code")
    # Outside a predicate, in a call's argument too, Core reads both against the slot's own node.
    repeat = ("data", "visits", "total")
    assert same("count(/data/visits/crop)", "count(current()/../crop)", context=repeat)


@pytest.mark.parametrize(
    "before, after",
    [
        # A case row filter: the absolute path reads every visit's answer, current() this visit's.
        (
            "instance('casedb')/casedb/case[@case_id = /data/visits/case_ref]/case_name",
            "instance('casedb')/casedb/case[@case_id = current()/../case_ref]/case_name",
        ),
        # A lookup itemset's row filter, the same.
        (
            "instance('t')/t_list/t[parent = /data/visits/crop]/name",
            "instance('t')/t_list/t[parent = current()/../crop]/name",
        ),
        # A filter of the main instance: the absolute path is read against the row being tested.
        ("count(/data/visits[/data/visits/crop = 'corn'])", "count(/data/visits[current()/../crop = 'corn'])"),
    ],
)
def test_inside_a_predicate_a_path_from_current_is_another_expression(before, after):
    # Core contextualizes an absolute main-instance path against the predicate's own context, never the slot's
    # (TreeReference.contextualize, XPathPathExpr.evalRaw): the declared change row-predicate-current is this.
    assert not same(before, after, context=("data", "visits", "total"))
    assert same(before, before, context=("data", "visits", "total"))


def test_an_instance_is_read_by_the_source_its_form_declares():
    src = "jr://fixture/item-list:t"
    instances = ({"item-list:t": src}, {"t": src})
    assert same("instance('item-list:t')/t_list/t", "instance('t')/t_list/t", instances=instances)
    elsewhere = ({"item-list:t": src}, {"t": "jr://fixture/item-list:u"})
    assert not same("instance('item-list:t')/t_list/t", "instance('t')/t_list/t", instances=elsewhere)


def test_a_text_no_reading_reads_is_the_same_as_nothing():
    assert tree("/data/a +") is None
    assert tree("") is None
    assert not same("/data/a +", "/data/a +")
