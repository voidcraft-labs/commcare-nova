"""HQ's build adds the supply-point step to a form once HQ's form builder has saved the text, and only with CommCare
Supply on.

Contract: Nova's publish asks the person to confirm the project space has
CommCare Supply off (``commtrack-off``) for an app whose form source holds
``instance('commcaresession')/session/data/supply_point_id``, read decoded
(``lib/commcare/xform/supplyPointText.ts``). HQ's build gives such a form's
entry a ``supply_point_id`` datum, the location the worker's user data names,
with the two assertions that it is there and names a case
(``suite_xml/sections/entries.py::EntriesHelper.entry_for_module``, where
``app.commtrack_enabled`` and ``session_var('supply_point_id')`` is a substring
of the stored ``form.source``; ``EntriesHelper.get_userdata_autoselect``). Nova
writes every ``'`` as ``&apos;``, so its own bytes never meet HQ's substring
test; a save in HQ's form builder writes the form again, after which they can.

``targeted-supply-point-text`` holds a survey form with the text in a label in
two languages and in a calculate's string literal. It is published as Nova's
publish leaves it, saved in HQ's form builder, and HQ builds it before and
after the save, each with CommCare Supply off and on: four builds. The datum
and its assertions appear in the build after the save with CommCare Supply on,
and in no other. Which of the label's text and the calculate's attribute hold
the text after the save is written as the run's evidence: it decides the
predicate's reach.

The plausible failures: a save that leaves the text as Nova escaped it (then
nothing a person does in HQ turns the step on, and Nova asks about nothing a
person meets), a step HQ adds with CommCare Supply off (then confirming the
setting off would not keep it away), and a step HQ adds to Nova's own bytes
before any save.
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


def _holds_text(source):
    """Where a form's source holds the text as a parsed XML reads it: ``(element tag, "text" or an attribute
    name)`` for each text node and attribute value whose decoded value contains it."""
    root = etree.fromstring(source.encode("utf-8"))
    found = []
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        name = etree.QName(element).localname
        if SUPPLY_POINT_TEXT in (element.text or ""):
            found.append((name, "text"))
        found.extend((name, attribute) for attribute, value in element.attrib.items() if SUPPLY_POINT_TEXT in value)
    return sorted(found)


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


def test_hqs_build_adds_the_supply_point_step_after_a_form_builder_save_with_commcare_supply_on(
    hq, core_runner, editor_driver
):
    from proof.observe import publish

    export = corpus_document(DOCUMENT).exports["minimum"]
    configuration = export.configuration.hq()
    # Nova's publish asks this document's project space to have CommCare Supply off.
    assert not configuration.commtrack
    configuration = dataclasses.replace(configuration, privileges=configuration.privileges | {"CLOUDCARE"})
    with hq_check(configuration) as (state, record):
        app_id, refusal, _ = publish.create(state, export)
        assert refusal is None, refusal
        app = operations.held_app(state, app_id)
        forms = [form.unique_id for form in app.get_forms() if form.source and _holds_text(form.source)]
        assert forms, f"{DOCUMENT} holds no form whose source holds {SUPPLY_POINT_TEXT}."
        # Nova's bytes hold the text escaped, so HQ's substring test does not meet it.
        assert not any(SUPPLY_POINT_TEXT in app.get_form(form_id).source for form_id in forms)
        before = _builds(state, record, app_id, configuration)
        runs = {}
        for form_id in forms:
            run = vellum.open_and_save(editor_driver, state, app_id, form_id)
            record_timing("vellum_open", run.seconds["open"])
            record_timing("vellum_save", run.seconds["save"])
            assert run.loaded and run.saved and run.save_button == "saved", (run.load_error, run.save_refusal)
            runs[form_id] = run
        saved = operations.held_app(state, app_id)
        held = {
            form_id: {
                "decoded": _holds_text(saved.get_form(form_id).source),
                "plain": SUPPLY_POINT_TEXT in saved.get_form(form_id).source,
            }
            for form_id in forms
        }
        after = _builds(state, record, app_id, configuration)

    write_evidence(
        "commtrack-supply-point-text",
        {"held": held, "builds": {"before": before, "after": after}},
    )
    assert before == {False: {}, True: {}}, before
    assert after[False] == {}, after
    assert all(each["plain"] for each in held.values()), held
    stepped = after[True]
    assert len(stepped) == len(forms), stepped
    for step in stepped.values():
        assert len(step["datums"]) == 1 and USER_DATA in step["datums"][0], step
        assert step["assertions"] == sorted(ASSERTIONS), step
