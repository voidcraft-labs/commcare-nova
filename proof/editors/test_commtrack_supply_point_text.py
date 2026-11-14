"""HQ's build adds no supply-point step to a form whose label or string says the session's supply point, before or
after a save in HQ's form builder, even with CommCare Supply on.

Contract: HQ's build gives a form's entry a ``supply_point_id`` datum, the
location the worker's user data names, with the two assertions that it is
there and names a case, where CommCare Supply is on and
``instance('commcaresession')/session/data/supply_point_id`` is a substring of
the stored ``form.source``
(``suite_xml/sections/entries.py::EntriesHelper.entry_for_module``;
``EntriesHelper.get_userdata_autoselect``). Nova writes a label's bracket after
``instance`` as a literal output (``lib/commcare/xform/builder.ts::literalLabelNodes``)
and splits a string literal there (``lib/commcare/xpath/wire/serialize.ts::literalPieces``),
so no stretch of the source holds the text, decoded or not, and Nova's publish
asks nothing about CommCare Supply for it
(``lib/commcare/planPrivileges.ts::commtrackReasons``).

``targeted-supply-point-text`` holds a survey form with the text in a label in
two languages and in a calculate's string literal. It is published as Nova's
publish leaves it, saved in HQ's form builder, and HQ builds it before and
after the save, each with CommCare Supply off and on: four builds, none of
which adds the step. Where each form's source holds the text, decoded and as
stored, is written as the run's evidence.

The control is the published source written by hand with each bracket output
joined back into its label's text, so the label holds the text as one node, as
a label written whole would. HQ builds it with CommCare Supply off and on, and
gives the step, the datum from the worker's supply point with its two
assertions, to every form whose source then holds the text, with CommCare
Supply on only. So the four builds' empty answers mean the step's trigger is
absent, not that HQ's build at the pin no longer has the step.

The plausible failures: a save that writes the bracket output back as text
(then the save would put the text in the source, and a project space with
CommCare Supply on would give the form a step Nova never asked about), a
calculate the save writes back as one string, a step HQ adds to Nova's own
bytes, and a pin move that drops or moves HQ's step, which the control shows.
"""

from __future__ import annotations

import dataclasses

from lxml import etree

from proof.editors import compare, vellum
from proof.editors.conftest import corpus_document, record_timing, write_evidence
from proof.hq import operations
from proof.hq.check import hq_check
from proof.observe import sensitivity as observe

DOCUMENT = "targeted-supply-point-text"
# HQ's substring test (``entries.py``: ``session_var('supply_point_id') in form.source``).
SUPPLY_POINT_TEXT = "instance('commcaresession')/session/data/supply_point_id"
# What ``get_userdata_autoselect('commtrack-supply-point', 'supply_point_id', AUTO_SELECT_LOCATION)`` writes:
# the datum's id, the user data key its function reads, and its two assertions' locale ids.
DATUM = "supply_point_id"
USER_DATA = "instance('commcaresession')/session/user/data/commtrack-supply-point"
ASSERTIONS = ("case_autoload.location.property_missing", "case_autoload.location.case_missing")
XFORMS = "http://www.w3.org/2002/xforms"


def _holds_text(source):
    """Where a form's source holds the text as a parsed XML reads it: ``(element tag, "text", "tail" or an
    attribute name)`` for each text node, tail and attribute value whose decoded value contains it."""
    root = etree.fromstring(source.encode("utf-8"))
    found = []
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        name = etree.QName(element).localname
        if SUPPLY_POINT_TEXT in (element.text or ""):
            found.append((name, "text"))
        if SUPPLY_POINT_TEXT in (element.tail or ""):
            found.append((name, "tail"))
        found.extend((name, attribute) for attribute, value in element.attrib.items() if SUPPLY_POINT_TEXT in value)
    return sorted(found)


def _joined(source):
    """The source with each literal bracket output Nova writes after ``instance`` joined back into the text around
    it, so a label that says the text holds it as one text node: the control's hand-written spelling."""
    root = etree.fromstring(source.encode("utf-8"))
    for output in list(root.iter(f"{{{XFORMS}}}output")):
        if output.get("value") != "'('":
            continue
        parent, previous = output.getparent(), output.getprevious()
        joined = "(" + (output.tail or "")
        if previous is None:
            parent.text = (parent.text or "") + joined
        else:
            previous.tail = (previous.tail or "") + joined
        parent.remove(output)
    return etree.tostring(root, encoding="unicode")


def _supply_point_step(built):
    """The supply-point datums and assertions of each entry of HQ's built suite, by the entry's command id."""
    suite = etree.fromstring(built.files["suite.xml"])
    found = {}
    for entry in suite.iter("entry"):
        command = entry.find("command")
        datums = [datum.get("function") for datum in entry.iter("datum") if datum.get("id") == DATUM]
        assertions = [
            text.get("id")
            for assertion in entry.iter("assert")
            for text in assertion.iter("locale")
            if text.get("id") in ASSERTIONS
        ]
        if datums or assertions:
            found[command.get("id") if command is not None else None] = {
                "datums": datums,
                "assertions": sorted(assertions),
            }
    return found


def _builds(state, record, app_id, configuration):
    """HQ's build of the app as HQ holds it, with CommCare Supply as the configuration has it (off) and turned on."""
    from proof.hq.boot import clear_caches

    (flip,) = observe.flip_plan(configuration, set(), {observe.COMMTRACK: 1})
    assert flip.configuration.commtrack and not configuration.commtrack
    found = {}
    clear_caches()
    found[False] = compare.build(state, app_id, record)
    with observe.flipped(flip, state):
        clear_caches()
        found[True] = compare.build(state, app_id, record)
    for commtrack, built in found.items():
        assert built.errors == [], (commtrack, built.errors)
    return {commtrack: _supply_point_step(built) for commtrack, built in found.items()}


def test_hqs_build_adds_no_supply_point_step_before_or_after_a_form_builder_save(hq, core_runner, editor_driver):
    from proof.observe import publish

    export = corpus_document(DOCUMENT).exports["minimum"]
    configuration = export.configuration.hq()
    # Nova's publish asks nothing about CommCare Supply for this document.
    assert not configuration.commtrack
    configuration = dataclasses.replace(configuration, privileges=configuration.privileges | {"CLOUDCARE"})
    with hq_check(configuration) as (state, record):
        app_id, refusal, _ = publish.create(state, export)
        assert refusal is None, refusal
        app = operations.held_app(state, app_id)
        forms = [form.unique_id for form in app.get_forms() if form.source]
        assert forms, f"{DOCUMENT} holds no form with a source."

        def held_by(held_app):
            return {
                form_id: {
                    "decoded": _holds_text(held_app.get_form(form_id).source),
                    "plain": SUPPLY_POINT_TEXT in held_app.get_form(form_id).source,
                }
                for form_id in forms
            }

        published = held_by(app)
        published_sources = {form_id: app.get_form(form_id).source for form_id in forms}
        before = _builds(state, record, app_id, configuration)
        for form_id in forms:
            run = vellum.open_and_save(editor_driver, state, app_id, form_id)
            record_timing("vellum_open", run.seconds["open"])
            record_timing("vellum_save", run.seconds["save"])
            assert run.loaded and run.saved and run.save_button == "saved", (run.load_error, run.save_refusal)
        saved = held_by(operations.held_app(state, app_id))
        after = _builds(state, record, app_id, configuration)

        control = operations.held_app(state, app_id)
        for form_id, source in published_sources.items():
            control.get_form(form_id).source = _joined(source)
        control.save()
        joined = [form_id for form_id in forms if SUPPLY_POINT_TEXT in _joined(published_sources[form_id])]
        assert joined, f"No form of {DOCUMENT} holds the text once its bracket outputs are joined."
        stepped = _builds(state, record, app_id, configuration)

    write_evidence(
        "commtrack-supply-point-text",
        {
            "held": {"published": published, "saved": saved},
            "builds": {"before": before, "after": after, "control": stepped},
        },
    )
    nowhere = {form_id: {"decoded": [], "plain": False} for form_id in forms}
    assert published == nowhere, published
    assert saved == nowhere, saved
    assert before == {False: {}, True: {}}, before
    assert after == {False: {}, True: {}}, after
    # The control: HQ's build at the pin gives the step where the source holds the text, with CommCare Supply on.
    assert stepped[False] == {}, stepped
    assert len(stepped[True]) == len(joined), stepped
    for step in stepped[True].values():
        assert len(step["datums"]) == 1 and USER_DATA in step["datums"][0], step
        assert step["assertions"] == sorted(ASSERTIONS), step
