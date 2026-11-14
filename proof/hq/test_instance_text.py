"""Text CommCare HQ's build reads as an instance, and the spellings that keep it text.

HQ's build renders each form whole and reads every ``instance(``, quoted
name, ``)`` in the rendered string as an instance read, labels, titles,
attributes and data nodes alike (``models/forms.py::FormBase.add_stuff_to_xform``
-> ``xform.py::XForm.add_missing_instances`` ->
``suite_xml/post_process/instances.py::get_instance_names``). For a name the
form does not declare, it adds the instance where it knows a source for the
name and refuses the build otherwise.

Contract, over HQ's own functions and HQ's own ``Application.create_all_files``
on hand-written control forms (the first form of HQ's suite test app):

- the pattern: for each row of ``fixtures/hq-instance-scan-vectors.json``, the
  text in an element's text and in an attribute, rendered as
  ``WrappedNode.render`` renders, reads as exactly the row's ``hqReads``, and a
  row HQ reads a name in is one Nova refuses (``hqInstanceScan.ts::instanceScanRead``
  answers exactly the refused rows, ``lib/commcare/__tests__/hqInstanceScan.test.ts``);
- a label: written as one text node, ``instance('nova_absent')`` stops the
  build and ``instance('casedb')`` gains a ``casedb`` declaration; written as
  Nova writes it, the bracket a literal ``<output value="'('"/>`` after the
  word (``xform/builder.ts::literalLabelNodes``), both build with no added
  declaration;
- plain text in the form's source, a learn module's description and the
  form's title with its data root's ``name``: ``instance('nova_absent')``
  stops the build naming ``nova_absent``, ``instance('item-list:nova_absent')``
  builds a form that declares ``item-list:nova_absent`` from
  ``jr://fixture/item-list:nova_absent``, which the source did not, and the
  spelling Nova offers, ``instance ('nova_absent')``, builds a form that
  declares nothing the source did not and holds the text as typed.

The two refused texts are the retained controls of ``FORM_TEXT_READ_AS_INSTANCE``:
Nova's gate refuses each, so no corpus document holds one, and a pin that
changed HQ's pattern or what its build does with a match shows here.
Plausible failures: HQ's pattern reading more than Nova refuses; the reading
of ``add_missing_instances`` being wrong; the offered spelling, or a label as
Nova writes it, still read as an instance.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from lxml import etree

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.hq.seams import build_seams

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
VECTORS = json.loads((Path(__file__).parent / "fixtures" / "hq-instance-scan-vectors.json").read_text())["rows"]

XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"
CONNECT = "http://commcareconnect.com/data/v1/learn"
BUILT_FORM = "modules-0/forms-0.xml"
LABEL_ID = "plain-label"

ABSENT = "instance('nova_absent')"
FIXTURE = "instance('item-list:nova_absent')"
OFFERED = "instance ('nova_absent')"
CASEDB = "instance('casedb')"


# The pattern -----------------------------------------------------------------


def _vector_id(text):
    """A vector's text as a test id: each character pytest would escape, and the backslash itself, by its code point.

    pytest escapes an id again on every collection of one process, so an id holding a backslash differs between the
    lane server's collection and a forked worker's, and the lane refuses a collection that depends on the process.
    """
    return "".join(
        character if " " <= character <= "~" and character != "\\" else f"U+{ord(character):04X}" for character in text
    )


@pytest.mark.parametrize("row", VECTORS, ids=[_vector_id(row["text"]) for row in VECTORS])
def test_hqs_pattern_reads_each_vector_as_the_fixture_says(hq, row):
    from corehq.apps.app_manager.suite_xml.post_process.instances import get_instance_names
    from corehq.apps.app_manager.xform import WrappedNode

    in_text = etree.Element("data")
    etree.SubElement(in_text, "description").text = row["text"]
    in_attribute = etree.Element("data", name=row["text"])
    for placed, root in (("text", in_text), ("attribute", in_attribute)):
        rendered = WrappedNode(root).render().decode("utf-8")
        assert get_instance_names(rendered) == set(row["hqReads"]), (placed, rendered)
    if row["hqReads"]:
        assert row["refused"], f"HQ reads {row['hqReads']} in {row['text']!r}, which Nova admits"


# The controls ----------------------------------------------------------------


def _first_form(app_json):
    form = app_json["modules"][0]["forms"][0]
    name = f"{form['unique_id']}.xml"
    return name, etree.fromstring(app_json["_attachments"][name].encode())


def _edited(change):
    """HQ's suite test app with its first form's source changed by ``change(tree)``.

    The form's case actions are turned off, so HQ's build writes no case block
    into it and every secondary instance its built form declares is one the
    instance scan added.
    """
    app_json = hq_test_app()
    actions = app_json["modules"][0]["forms"][0]["actions"]
    for action in ("open_case", "update_case"):
        actions[action]["condition"]["type"] = "never"
    name, tree = _first_form(app_json)
    change(tree)
    app_json["_attachments"][name] = etree.tostring(tree, encoding="unicode")
    return app_json


def _label_value(tree):
    (text,) = [el for el in tree.iter(f"{{{XFORMS}}}text") if el.get("id") == LABEL_ID]
    (value,) = list(text.iter(f"{{{XFORMS}}}value"))
    return value


def _label_as_one_text_node(text):
    def change(tree):
        _label_value(tree).text = text

    return change


def _label_as_nova_writes_it(text):
    """The label as ``literalLabelNodes`` writes it: the word, the bracket as a literal output, the rest."""
    word, rest = text.split("(", 1)
    assert word.endswith("instance"), text

    def change(tree):
        value = _label_value(tree)
        value.text = word
        output = etree.SubElement(value, f"{{{XFORMS}}}output", value="'('")
        output.tail = rest

    return change


def _data_root(tree):
    instance = next(tree.iter(f"{{{XFORMS}}}instance"))
    return instance[0]


def _learn_description(text):
    def change(tree):
        data = _data_root(tree)
        namespace = etree.QName(data).namespace
        block = etree.SubElement(data, f"{{{namespace}}}nova_learn")
        module = etree.SubElement(block, f"{{{CONNECT}}}module", id="nova_learn")
        etree.SubElement(module, f"{{{CONNECT}}}name").text = "Learn"
        etree.SubElement(module, f"{{{CONNECT}}}description").text = text
        etree.SubElement(module, f"{{{CONNECT}}}time_estimate").text = "1"

    return change


def _title_and_name(text):
    def change(tree):
        next(tree.iter(f"{{{XHTML}}}title")).text = text
        _data_root(tree).set("name", text)

    return change


def _built(state, record, app_json):
    """HQ's build of the app, or the exception its form rendering raised."""
    from corehq.apps.app_manager.exceptions import XFormException

    app_id, _ = operations.publish(state, [nova_shaped_upload(app_json, "Instance text")])
    with build_seams():
        try:
            return operations.build(operations.held_app(state, app_id), record)
        except XFormException as refused:
            return refused


def _declared(built):
    """The built first form's secondary instances, as ``{id: src}``."""
    tree = etree.fromstring(built.files[BUILT_FORM])
    return {el.get("id"): el.get("src") for el in tree.iter(f"{{{XFORMS}}}instance") if el.get("id") is not None}


def _baseline(built):
    """The declarations of a control holding plain text, which builds clean."""
    assert not isinstance(built, Exception), built
    assert built.errors == [], (
        f"HQ's suite test app, its first form's case actions off, does not build clean: {built.errors}"
    )
    return _declared(built)


def _refused_naming(outcome, name):
    from corehq.apps.app_manager.exceptions import XFormException

    assert isinstance(outcome, XFormException), outcome
    message = str(outcome)
    assert "missing some instance declarations" in message and name in message, message


def test_a_label_reads_as_an_instance_as_one_text_node_and_as_text_as_nova_writes_it(hq, core_runner):
    with hq_check(CONFIGURATION) as (state, record):
        baseline = _baseline(_built(state, record, _edited(_label_as_one_text_node("Plain"))))
        absent_joined = _built(state, record, _edited(_label_as_one_text_node(ABSENT)))
        casedb_joined = _built(state, record, _edited(_label_as_one_text_node(CASEDB)))
        absent_cut = _built(state, record, _edited(_label_as_nova_writes_it(ABSENT)))
        casedb_cut = _built(state, record, _edited(_label_as_nova_writes_it(CASEDB)))

    _refused_naming(absent_joined, "nova_absent")
    assert "casedb" not in baseline, baseline
    assert _declared(casedb_joined) == {**baseline, "casedb": "jr://instance/casedb"}
    for built in (absent_cut, casedb_cut):
        assert not isinstance(built, Exception), built
        assert built.errors == []
        assert _declared(built) == baseline


@pytest.mark.parametrize(
    "site", [_learn_description, _title_and_name], ids=["learn module description", "title and data name"]
)
def test_plain_text_in_a_forms_source_reads_as_an_instance_and_a_space_before_the_bracket_keeps_it_text(
    hq, core_runner, site
):
    with hq_check(CONFIGURATION) as (state, record):
        baseline = _baseline(_built(state, record, _edited(site("Plain"))))
        absent = _built(state, record, _edited(site(ABSENT)))
        fixture = _built(state, record, _edited(site(FIXTURE)))
        offered = _built(state, record, _edited(site(OFFERED)))

    _refused_naming(absent, "nova_absent")

    assert not isinstance(fixture, Exception), fixture
    assert "item-list:nova_absent" not in baseline, baseline
    assert _declared(fixture) == {**baseline, "item-list:nova_absent": "jr://fixture/item-list:nova_absent"}

    assert not isinstance(offered, Exception), offered
    assert offered.errors == []
    assert _declared(offered) == baseline
    tree = etree.fromstring(offered.files[BUILT_FORM])
    if site is _learn_description:
        (description,) = list(tree.iter(f"{{{CONNECT}}}description"))
        assert description.text == OFFERED
    else:
        assert next(tree.iter(f"{{{XHTML}}}title")).text == OFFERED
        assert _data_root(tree).get("name") == OFFERED
