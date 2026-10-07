"""The rule ``connect-work-area-empty`` is sound: every reader of a deliver unit's empty ``work_area_id`` reads it
as it reads none.

Contract: the rule erases an empty ``work_area_id`` child of a Connect
deliver unit, which Vellum's save writes and Nova's form does not hold, in a
form's instance, in a submission and in what Formplayer hands of either. The
plausible failures: HQ's build, Core's run or HQ's case processing reading
the node; Formplayer answering the two forms differently; HQ's Connect
repeater dropping or changing a deliver unit for it; Connect's receiver
making other rows of the empty id than of none; and the rule erasing an id
that names a work area, which Connect reads.

A Connect deliver app's form is written both ways in forks of Nova's
publish. HQ builds the two alike but for the element, and Core's sessions
and HQ's case processing differ only in the submission's element, which the
rule erases. Each spelling is then served (``proof.formplayer.hq.serve``):
Formplayer's walks differ only in the element of the instance it hands back
and submits; and HQ's own receiver and Connect repeater forward each of
Core's and Formplayer's submissions to one opportunity in Connect
(``proof.observe.connect``), whose answers, tasks and rows are the same for
both, though the payload that reached it holds the empty id for one and no
id for the other. Where the element names a work area, Connect refuses the
delivery, and the rule leaves the element.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from lxml import etree

from proof.rules.conftest import (
    assert_spelled,
    build_differences,
    published,
    restore,
    rewritten,
    runs_alike,
    shown,
)
from proof.rules.connect_work_area_empty import CONNECT, RULE, normalize

DOCUMENT = "targeted-connect-deliver-rename"
FORM = "0.0"
DELIVER = f"{{{CONNECT}}}deliver"
WORK_AREA = f"{{{CONNECT}}}work_area_id"
# An id that names a work area, which the opportunity does not hold.
NAMED = "not-a-work-area"


def _with_work_area(value):
    """A form's root with a ``work_area_id`` holding ``value`` written into each deliver unit, as Vellum's save
    writes one."""

    def change(root):
        units = list(root.iter(DELIVER))
        assert units, "the form holds no Connect deliver unit"
        for unit in units:
            etree.SubElement(unit, WORK_AREA).text = value or None

    return change


def _named_only(path):
    return "work_area_id" in path


def test_hq_builds_and_core_runs_the_empty_work_area_id_as_none(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={FORM: rewritten()})
        vellum = app.spell(sources={FORM: rewritten(_with_work_area(""))})
        assert_spelled(nova, vellum, RULE, _named_only)
        built = shown(build_differences(nova.build, vellum.build))
        assert built and all(_named_only(path) for _, path, _ in built), built
        assert shown(build_differences(nova.build, vellum.build, rules=(RULE,))) == []
        _, _, raw = runs_alike(app, core_runner, nova.build, vellum.build)
        _, _, after = runs_alike(app, core_runner, nova.build, vellum.build, rules=(RULE,))

    assert raw, "the sessions submit no deliver unit, so the two spellings were never run apart"
    assert all(_named_only(path) and "/submission/" in path for _, path, _ in shown(raw)), shown(raw)
    assert after == [], shown(after)


@pytest.fixture(scope="module")
def received(rule_documents, hq, core_runner, lane_services):
    """Each spelling of the deliver form (no ``work_area_id``, an empty one, one that names a work area) served,
    walked by Formplayer, and its submissions (Formplayer's and Core's) forwarded by HQ to one opportunity in
    Connect: Formplayer's trace and what Connect made of the submissions, by spelling."""
    from proof.checks import casedata
    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer import observe as formplayer_observe
    from proof.observe import connect, services
    from proof.observe.record import Blobs
    from proof.observe.sessions import run_sessions

    document = rule_documents[DOCUMENT]
    spellings = {"none": None, "empty": _with_work_area(""), "named": _with_work_area(NAMED)}
    blobs, found = Blobs(), {}
    walk = sessions = opportunity = None
    with published(document, core_runner) as app, tempfile.TemporaryDirectory() as scratch:
        restored = restore(app, casedata.case_database(document.document))
        runner = services.formplayer()
        try:
            for name, change in spellings.items():
                with app.unit.fork():
                    app._write(sources={FORM: rewritten(change)})
                    with formplayer_hq.serve(app.unit, document, app.app_id, runner=runner, label=name) as served:
                        if opportunity is None:
                            opportunity = connect.open_opportunity(served)
                        archive = Path(scratch) / f"{name}.ccz"
                        archive.write_bytes(served.archive())
                        ran = run_sessions(core_runner, name, archive, restored, sessions).trace
                        sessions = sessions or [list(run["script"]) for run in ran["runs"]]
                        with connect.forwarded(served, opportunity, name) as forwarder:
                            with forwarder.reading("formplayer"):
                                _, trace = formplayer_observe.walked(served, runner, blobs, script=walk)
                            walk = walk or formplayer_observe.script_of(trace)
                            forwarder.walked(trace)
                            forwarder.devices(ran, path=connect.release_post_path(served))
                            found[name] = {"formplayer": trace, "connect": blobs.get_json(forwarder.take(blobs))}
        finally:
            if opportunity is not None:
                opportunity.close()
    return found


def _units(value, found):
    """Every deliver unit below a payload's value (an object of Connect's namespace that holds an entity)."""
    if isinstance(value, dict):
        if value.get("@xmlns") == CONNECT and "entity_id" in value:
            found.append(value)
        for item in value.values():
            _units(item, found)
    return found


def _deliver_units(record):
    """Each deliver unit of each payload that reached Connect, by reader."""
    return {
        reader: [unit for run in runs for post in run["posts"] for unit in _units(post["payload"].get("form"), [])]
        for reader, runs in record["runs"].items()
    }


def test_formplayer_hands_the_two_forms_alike_but_for_the_element(received):
    from proof.checks import served

    def compared(other, rules):
        return shown(
            served.formplayer_differences(
                received["none"]["formplayer"],
                received[other]["formplayer"],
                check="proof4",
                document="-",
                artifact="formplayer",
                rules=rules,
            )
        )

    raw = compared("empty", ())
    assert raw and all(_named_only(path) for _, path, _ in raw), raw
    assert compared("empty", (RULE,)) == []
    # An id that names a work area is another form to every reader, and the rule leaves it.
    assert compared("named", (RULE,)), "the rule erased a work area id that names a work area"


def test_hq_forwards_the_empty_id_and_connect_makes_the_same_rows_of_it_as_of_none(received):
    """The payload that reached Connect holds ``"work_area_id": ""`` for the empty spelling and no such key for
    Nova's, from Core's submission and from Formplayer's, and Connect answers, runs and holds the same."""
    from proof.checks import connect as judge

    none, empty = received["none"]["connect"], received["empty"]["connect"]
    assert sorted(none["runs"]) == sorted(empty["runs"]) == ["core", "formplayer"]
    for reader in ("core", "formplayer"):
        assert all("work_area_id" not in unit for unit in _deliver_units(none)[reader])
        assert [unit["work_area_id"] for unit in _deliver_units(empty)[reader]] == [""]
        assert [post["status"] for run in empty["runs"][reader] for post in run["posts"]] == [200]
        (visit,) = empty["runs"][reader][0]["state"]["visits"]
        assert visit["workArea"] is None
    assert judge.differences(none, empty, check="proof4", document="-", artifact="connect") == []


def test_connect_refuses_a_delivery_whose_work_area_id_names_a_work_area_it_does_not_hold(received):
    """The control: Connect reads a ``work_area_id`` that holds anything, so the two spellings are two forms to
    it and the rule must leave the element."""
    from proof.checks import connect as judge

    named = received["named"]["connect"]
    assert [unit["work_area_id"] for unit in _deliver_units(named)["core"]] == [NAMED]
    found = judge.differences(received["none"]["connect"], named, check="proof4", document="-", artifact="connect")
    assert {(d.path, d.before, d.after) for d in found} == {
        ("/runs/*/posts/*/answer", "200", "400: invalid-work-area-case-id-specified")
    }, found


def test_the_rule_leaves_an_id_that_holds_anything_and_a_work_area_update():
    form = etree.fromstring(
        f'<data xmlns="http://example.org/f"><visit><deliver xmlns="{CONNECT}" id="v"><name>V</name>'
        f'<work_area_id/></deliver></visit><other><deliver xmlns="{CONNECT}" id="w">'
        f"<work_area_id>{NAMED}</work_area_id></deliver></other><gone>"
        f'<work_area_update xmlns="{CONNECT}" id="u"><work_area_id/></work_area_update></gone></data>'
    )
    kept = normalize(form)
    assert [(element.getparent().get("id"), element.text) for element in kept.iter(WORK_AREA)] == [
        ("w", NAMED),
        ("u", None),
    ]
