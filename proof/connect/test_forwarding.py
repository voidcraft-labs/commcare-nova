"""HQ forwards a device's form to a served Connect end to end, with nothing called on HQ's behalf.

Contract (``proof.observe.connect``, ``proof.connect.hq.forwarding``): while a
state of a Connect app is served, a form posted to HQ's own receiver view as
a device posts it is taken by HQ's receiver whole, registered by HQ's own
signal as a repeat record of the project space's Connect repeater, fired by
HQ's own task, and posted by HQ's own HTTP client, with a token it asked
Connect for, to Connect's own server over a real connection; Connect, whose
opportunity was made from the build HQ's own archive view served it,
answers, and HQ keeps the answer on its repeat record.

The plausible failures: a payload built beside HQ's repeater; a forward
acknowledged without reaching Connect's receiver; an opportunity made from
an archive HQ did not serve; a run that reads what another run left in
Connect; a project space that forwards without Data Forwarding.
"""

import tempfile
from pathlib import Path

import pytest

from proof.connect.conftest import DELIVER
from proof.observe.record import Blobs


@pytest.fixture(scope="module")
def forwarded_delivery(hq, core_runner, connect_runtime, connect_documents):
    """One delivery of ``targeted-connect-deliver-rename`` made by Core on HQ's released build, posted twice as
    two runs of one served state, and once in a project space whose plan has no Data Forwarding."""
    from proof.checks import casedata
    from proof.connect import hq as connect_hq
    from proof.formplayer import hq as formplayer_hq
    from proof.hq import seams
    from proof.observe import connect
    from proof.observe.sessions import hq_restore, run_sessions
    from proof.rules.conftest import published

    document = connect_documents[DELIVER]
    blobs = Blobs()
    with published(document, core_runner) as app, tempfile.TemporaryDirectory() as scratch:
        database = casedata.case_database(document.document)
        _, restore = hq_restore(app.unit, database, app.export.create.lookups, "restore")
        with formplayer_hq.serve(app.unit, document, app.app_id) as served:
            archive = Path(scratch) / "release.ccz"
            archive.write_bytes(served.archive())
            trace = run_sessions(core_runner, "A", archive, restore).trace
            opportunity = connect.open_opportunity(served, runtime=connect_runtime)
            try:
                with connect.forwarded(served, opportunity, "A") as forwarder:
                    path = connect.release_post_path(served)
                    forwarder.devices(trace, path=path, reader="first")
                    forwarder.devices(trace, path=path, reader="again")
                    forwarder.devices(trace, path=path, reader="no-fix", fix=None)
                    kept = blobs.get_json(forwarder.take(blobs))
                    # The same state with Data Forwarding taken back off the project space's plan.
                    seams.ALSO_GRANTED.clear()
                    forwarder.devices(trace, path=path, reader="unprivileged")
                    unprivileged = forwarder.runs.pop("unprivileged", [])
                    assert connect_hq.forwards(app.unit) == []
                yield {
                    "served": served,
                    "path": path,
                    "opportunity": connect.opportunity_record(opportunity),
                    "kept": kept,
                    "unprivileged": unprivileged,
                }
            finally:
                opportunity.close()


def test_connect_makes_the_opportunity_from_the_build_hqs_own_view_serves(forwarded_delivery):
    """Connect asks HQ's archive view for the released build, and HQ's own view answers it: the opportunity holds
    the deliver unit and the task the document authors."""
    opportunity = forwarded_delivery["opportunity"]
    assert opportunity["asked"] and {asked["view"] for asked in opportunity["asked"]} == {"direct_ccz"}
    assert opportunity["asked"][0]["status"] == 200
    assert [unit["slug"] for unit in opportunity["catalog"]["deliverUnits"]] == ["home_visit"]
    assert [task["slug"] for task in opportunity["catalog"]["taskTypes"]] == ["follow_up"]


def test_a_devices_form_reaches_connect_through_hqs_own_receiver_and_repeater(forwarded_delivery):
    """The released build's profile sends a device to the receiver under the build's own id; HQ's receiver
    answers the device 201 and reads the app from the build, HQ's repeat record ends in success, and the payload
    that reached Connect's receiver names the app and the build and carries the Connect block and the device's
    fix; Connect answers 200 and holds the visit with that location."""
    served, kept = forwarded_delivery["served"], forwarded_delivery["kept"]
    assert forwarded_delivery["path"] == f"/a/{served.domain}/receiver/{served.build_id}/"
    (run,) = kept["runs"]["first"]
    assert [received["status"] for received in run["received"]] == [201]
    (forward,) = run["forwards"]
    assert forward["state"] == "Success", forward
    (post,) = run["posts"]
    assert (post["status"], post["raised"]) == (200, [])
    assert (post["payload"]["app_id"], post["payload"]["build_id"]) == ("@app", "@build")
    assert post["payload"]["metadata"]["location"] == "12.97160 77.59460 920.0 5.0"
    assert "home_visit" in post["payload"]["form"]
    (visit,) = run["state"]["visits"]
    assert (visit["deliverUnit"], visit["location"]) == ("home_visit", "12.97160 77.59460 920.0 5.0")


@pytest.mark.under_determinism
def test_each_run_meets_the_opportunity_as_it_stood(forwarded_delivery):
    """The second run posts the same form again and Connect holds exactly what it held after the first: one
    visit, not two, and no duplicate refused."""
    kept = forwarded_delivery["kept"]
    assert kept["runs"]["again"] == kept["runs"]["first"]


def test_a_form_without_a_fix_is_the_one_connect_flags(forwarded_delivery):
    """The control for the fix: the same form with no fix written reaches Connect with no location, and Connect,
    whose opportunity verifies GPS, flags the visit."""
    (run,) = forwarded_delivery["kept"]["runs"]["no-fix"]
    assert run["posts"][0]["payload"]["metadata"]["location"] is None
    (visit,) = run["state"]["visits"]
    assert visit["location"] is None and ["gps", "GPS data is missing"] in visit["flags"]


def test_a_project_space_without_data_forwarding_forwards_nothing(forwarded_delivery):
    """HQ registers a repeat record only where the project space can forward data: without the privilege HQ's
    receiver takes the form and nothing reaches Connect."""
    (run,) = forwarded_delivery["unprivileged"]
    assert [received["status"] for received in run["received"]] == [201]
    assert (run["forwards"], run["posts"], run["state"]["visits"]) == ([], [], [])
