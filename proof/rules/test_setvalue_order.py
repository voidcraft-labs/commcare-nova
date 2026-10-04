"""The rule ``setvalue-order`` is sound where it holds: Core runs an event's setvalues of distinct nodes, whose
values read no node, alike in any order within their run.

Contract: the rule erases the order within a run of one event's
consecutive setvalues that each set a node of their own to ``now()``,
``today()``, ``uuid()``, a literal, or ``format-date`` of ``now()`` or
``today()`` and a literal pattern, as Vellum's save writes setvalues in
its own order. HQ's build carries the order, so the proof is Core's. The
conditions are the rule's: a setvalue whose value reads a node, two that
set one node, a calculate that sets a node the run sets, a triggerable the
run sets off that draws a random value, another action of the event
between two setvalues, and a setvalue naming its node by ``bind`` each make
the order tell. The plausible failures: Core running such a run otherwise
for its order (so a save would change the values a form starts with), and
the rule moving a setvalue where one of those conditions makes its place
tell.

A corpus document whose form defaults two date-times to ``now()``, records
the formatted clock and mints a case id with ``uuid()`` at load is published as Nova writes it and with
those setvalues reversed: HQ's builds differ by their order alone, which
the rule erases, and Core's sessions compare equal. A setvalue copying one
of those date-times into a node of its own, written after the setvalue it
reads and before it, submits the date-time in the first and a blank in the
second, and the rule keeps its place. Two node-free setvalues of the
form's ``xforms-revalidate`` event, one setting a node a calculate sets
from the other's node, submit the calculate's value written in one order
and the setvalue's in the other, and the rule keeps their order. The
other conditions are held on the parsed form, the rule leaving each. The
same form records a formatted ``today()`` clock in both orders too. Field
reads, nested calls, arbitrary wrappers and random or uuid arguments keep
their places on the parsed form.
"""

from __future__ import annotations

import pytest
from lxml import etree

from proof.rules.conftest import build_differences, published, rewritten, runs_alike, shown
from proof.rules.setvalue_order import RULE, normalize

DOCUMENT = "case-operation-sequence"
XF = "{http://www.w3.org/2002/xforms}"
HEAD = "{http://www.w3.org/1999/xhtml}head"


def _reversed_setvalues(root):
    model = root.find(HEAD).find(f"{XF}model")
    setvalues = model.findall(f"{XF}setvalue")
    assert len(setvalues) > 1, "the form has fewer than two setvalues"
    copies = [etree.fromstring(etree.tostring(setvalue)) for setvalue in reversed(setvalues)]
    for held, placed in zip(setvalues, copies, strict=True):
        model.replace(held, placed)


COPY = "proof_copy"


def _copy(before):
    """A node of the form's data set at load to the value the first setvalue of the model sets, by a setvalue
    written after that setvalue or ``before`` it."""

    def change(root):
        model = root.find(HEAD).find(f"{XF}model")
        data = model.find(f"{XF}instance")[0]
        read = model.findall(f"{XF}setvalue")[0]
        assert read.get("value") == "now()", read.attrib
        etree.SubElement(data, etree.QName(data, COPY).text)
        path = f"/{etree.QName(data).localname}/{COPY}"
        copying = etree.Element(f"{XF}setvalue", event=read.get("event"), ref=path, value=read.get("ref"))
        if before:
            read.addprevious(copying)
        else:
            read.addnext(copying)

    return change


CALCULATED, READ = "proof_calculated", "proof_read"


def _calculated(calculated_first):
    """Two nodes of the form's data, the first calculated from the second, each set by a node-free setvalue of the
    form's ``xforms-revalidate`` event, the first's written before the second's or after it."""

    def change(root):
        model = root.find(HEAD).find(f"{XF}model")
        data = model.find(f"{XF}instance")[0]
        path = {name: f"/{etree.QName(data).localname}/{name}" for name in (CALCULATED, READ)}
        for name in (CALCULATED, READ):
            etree.SubElement(data, etree.QName(data, name).text)
        model.findall(f"{XF}bind")[-1].addnext(
            etree.Element(f"{XF}bind", nodeset=path[CALCULATED], calculate=path[READ])
        )
        setvalues = [
            etree.Element(f"{XF}setvalue", event="xforms-revalidate", ref=path[CALCULATED], value="'written'"),
            etree.Element(f"{XF}setvalue", event="xforms-revalidate", ref=path[READ], value="'read'"),
        ]
        last = model.findall(f"{XF}setvalue")[-1]
        for setvalue in reversed(setvalues if calculated_first else setvalues[::-1]):
            last.addnext(setvalue)

    return change


def test_core_runs_a_run_of_node_free_setvalues_alike_in_any_order(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        saved = app.spell(sources={"0.0": rewritten(_reversed_setvalues)})
        after = app.spell(sources={"0.0": rewritten(_copy(before=False))})
        before = app.spell(sources={"0.0": rewritten(_copy(before=True))})
        calculated_first = app.spell(sources={"0.0": rewritten(_calculated(calculated_first=True))})
        read_first = app.spell(sources={"0.0": rewritten(_calculated(calculated_first=False))})
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build)
        _, _, copied = runs_alike(app, core_runner, after.build, before.build)
        _, _, overwritten = runs_alike(app, core_runner, calculated_first.build, read_first.build)

    built = shown(build_differences(nova.build, saved.build))
    assert built, "reversing the setvalues changed nothing HQ built"
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert any("/submission/" in path for _, path, _ in shown(copied)), shown(copied)
    assert build_differences(after.build, before.build, rules=(RULE,))
    # Set first, the calculated node takes the calculate's value when the node it reads is set; set last, its own.
    submitted = sorted({(CALCULATED in d.at, d.before, d.after) for d in overwritten if "/submission/" in d.at})
    assert submitted == [(True, "read", "written")], [(d.at, d.before, d.after) for d in overwritten]
    assert build_differences(calculated_first.build, read_first.build, rules=(RULE,))


def _formatted_today(root):
    model = root.find(HEAD).find(f"{XF}model")
    clocks = [action for action in model.findall(f"{XF}setvalue") if action.get("ref") == "/data/recorded_clock"]
    assert len(clocks) == 1, "the form must record its formatted clock"
    assert clocks[0].get("value") == "format-date(now(), '%Y-%m-%d %H:%M:%S %Z')", clocks[0].attrib
    clocks[0].set("value", "format-date(today(), '%Y-%m-%d %H:%M:%S %Z')")


def _reversed_formatted_today(root):
    _formatted_today(root)
    _reversed_setvalues(root)


def test_core_runs_a_formatted_today_clock_alike_before_or_after_the_other_node_free_actions(
    rule_documents, hq, core_runner
):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        first = app.spell(sources={"0.0": rewritten(_formatted_today)})
        second = app.spell(sources={"0.0": rewritten(_reversed_formatted_today)})
        _, _, alike = runs_alike(app, core_runner, first.build, second.build)

    assert build_differences(first.build, second.build), "reversing the formatted clock's run changed no built order"
    assert build_differences(first.build, second.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)


def _form(model):
    return etree.fromstring(
        '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model>'
        f"<instance><data/></instance>{model}</model></h:head></h:html>"
    )


def _setvalue(ref, value, event="xforms-ready"):
    return f'<setvalue event="{event}" ref="{ref}" value="{value}"/>'


def _order(form):
    return [
        action.get("ref") or etree.QName(action).localname
        for action in normalize(form).iter(f"{XF}*")
        if action.get("event")
    ]


RUN = _setvalue("/data/b", "now()") + _setvalue("/data/a", "1")


@pytest.mark.parametrize(
    ("model", "order"),
    [
        # A run of node-free setvalues of distinct nodes takes the order of its refs.
        (RUN, ["/data/a", "/data/b"]),
        (
            _setvalue("/data/b", "format-date(now(), '%Y-%m-%d %H:%M:%S %Z')") + _setvalue("/data/a", "1"),
            ["/data/a", "/data/b"],
        ),
        (
            _setvalue("/data/b", "format-date(today(), '%Y-%m-%d')") + _setvalue("/data/a", "1"),
            ["/data/a", "/data/b"],
        ),
        *[
            (_setvalue("/data/b", value) + _setvalue("/data/a", "1"), ["/data/b", "/data/a"])
            for value in (
                "format-date(/data/clock, '%Y')",
                "format-date(now(), /data/pattern)",
                "format-date(format-date(now(), '%Y'), '%Y')",
                "format-date(now(), format-date(now(), '%Y'))",
                "format-date(format-date(now(), '%Y'), now())",
                "concat(format-date(now(), '%Y'), '')",
                "format-date(random(), '%Y')",
                "format-date(uuid(), '%Y')",
                "format-date(now(1), '%Y')",
                "format-date(now(), '%Y', '%m')",
            )
        ],
        # A calculate that reads no node is never set off by a setvalue: HQ's delayed case id.
        ('<bind nodeset="/data/c" calculate="uuid()"/>' + RUN, ["/data/a", "/data/b"]),
        # A setvalue whose value reads another's node.
        (
            _setvalue("/data/b", "now()") + _setvalue("/data/c", "/data/b") + _setvalue("/data/a", "now()"),
            ["/data/b", "/data/c", "/data/a"],
        ),
        # A node a calculate sets, and a calculate whose node could be any.
        ('<bind nodeset="/data/b" calculate="/data/a"/>' + RUN, ["/data/b", "/data/a"]),
        ('<bind nodeset="/data/c[1]" calculate="/data/a"/>' + RUN, ["/data/b", "/data/a"]),
        # A triggerable reading a node that draws, or that the port cannot read.
        ('<bind nodeset="/data/c" calculate="random() + /data/a"/>' + RUN, ["/data/b", "/data/a"]),
        ('<bind nodeset="/data/c" relevant="if(/data/a = 1, uuid(), 0)"/>' + RUN, ["/data/b", "/data/a"]),
        ('<bind nodeset="/data/c" relevant="/data/é = 1"/>' + RUN, ["/data/b", "/data/a"]),
        # Another action of the event between the two.
        (
            _setvalue("/data/b", "now()") + '<send event="xforms-ready" submission="s"/>' + _setvalue("/data/a", "1"),
            ["/data/b", "send", "/data/a"],
        ),
        # A setvalue naming its node by bind, which Core reads in place of its ref.
        ('<setvalue event="xforms-ready" bind="c" ref="/data/c" value="1"/>' + RUN, ["/data/c", "/data/a", "/data/b"]),
        (RUN.replace('ref="/data/b"', 'bind="b" ref="/data/b"'), ["/data/b", "/data/a"]),
    ],
)
def test_the_rule_leaves_a_run_where_its_order_tells(model, order):
    assert _order(_form(model)) == order
