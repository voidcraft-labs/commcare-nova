"""HQ forwards a device's form to a served Connect end to end, with nothing called on HQ's behalf.

Contract (``proof.observe.connect``, ``proof.connect.hq.forwarding``): while a
state of a Connect app is served, the form a device's walk saves, sent by
CommCare Android's own send to HQ's own receiver view with the location the
form's own sensor poll wrote from the device's GPS, is taken by HQ's receiver
whole, registered by HQ's own
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

import pytest

from proof.connect.conftest import DELIVER, WRITTEN
from proof.observe.record import Blobs


@pytest.fixture(scope="module")
def forwarded_delivery(hq, core_runner, connect_runtime, connect_documents, lane_services):
    """``targeted-connect-deliver-rename``'s released build on a device (``proof.android.observe``), whose walks
    send each form they save to HQ's own receiver: twice, as two devices of one served state; once on a device
    whose GPS finds no fix; and once in a project space whose plan has no Data Forwarding."""
    from proof.android import observe as android
    from proof.connect import hq as connect_hq
    from proof.formplayer import hq as formplayer_hq
    from proof.hq import seams
    from proof.observe import connect
    from proof.rules.conftest import published

    document = connect_documents[DELIVER]
    blobs = Blobs()
    with published(document, core_runner) as app:
        with formplayer_hq.serve(app.unit, document, app.app_id) as served:
            archive = android.release_archive(served)
            opportunity = connect.open_opportunity(served, runtime=connect_runtime)
            try:
                with connect.forwarded(served, opportunity, "A") as forwarder:
                    kept = {}
                    for name, fix in (("first", android.LANE_FIX), ("again", android.LANE_FIX), ("no-fix", None)):
                        found = android.app(served, blobs, label=name, archive=archive, fix=fix)
                        kept[name] = {
                            "device": blobs.get_json(found["answer"]),
                            "connect": blobs.get_json(forwarder.take(blobs)),
                        }
                    # The same state with Data Forwarding taken back off the project space's plan.
                    seams.ALSO_GRANTED.clear()
                    android.app(served, blobs, label="unprivileged", archive=archive)
                    unprivileged = forwarder.runs.pop("android", [])
                    assert connect_hq.forwards(app.unit) == []
                yield {
                    "served": served,
                    "opportunity": connect.opportunity_record(opportunity),
                    "kept": kept,
                    "unprivileged": unprivileged,
                }
            finally:
                opportunity.close()


def _delivery(kept):
    """The one run of a device's walks that reached HQ's receiver."""
    (run,) = kept["connect"]["runs"]["android"]
    return run


def test_connect_makes_the_opportunity_from_the_build_hqs_own_view_serves(forwarded_delivery):
    """Connect asks HQ's archive view for the released build, and HQ's own view answers it: the opportunity holds
    the deliver unit and the task the document authors."""
    opportunity = forwarded_delivery["opportunity"]
    assert opportunity["asked"] and {asked["view"] for asked in opportunity["asked"]} == {"direct_ccz"}
    assert opportunity["asked"][0]["status"] == 200
    assert [unit["slug"] for unit in opportunity["catalog"]["deliverUnits"]] == ["home_visit"]
    assert [task["slug"] for task in opportunity["catalog"]["taskTypes"]] == ["follow_up"]


def test_a_devices_form_reaches_connect_through_hqs_own_receiver_and_repeater(forwarded_delivery):
    """The device sends the form its walk saved where the released build's profile sends it, the receiver under
    the build's own id; HQ's receiver answers the device 201 and reads the app from the build, HQ's repeat record
    ends in success, and the payload that reached Connect's receiver names the app and the build and carries the
    Connect block and the fix the device's GPS gave the form's sensor poll; Connect answers 200 and holds the
    visit with that location."""
    run = _delivery(forwarded_delivery["kept"]["first"])
    # The device's own send (its log report beside it is no form, and HQ forwards it nowhere).
    assert [received["status"] for received in run["received"]] == [201]
    (forward,) = run["forwards"]
    assert forward["state"] == "Success", forward
    (post,) = run["posts"]
    assert (post["status"], post["raised"]) == (200, [])
    assert (post["payload"]["app_id"], post["payload"]["build_id"]) == ("@app", "@build")
    assert post["payload"]["metadata"]["location"] == WRITTEN
    assert "home_visit" in post["payload"]["form"]
    (visit,) = run["state"]["visits"]
    assert (visit["deliverUnit"], visit["location"]) == ("home_visit", WRITTEN)


@pytest.mark.under_determinism
def test_each_run_meets_the_opportunity_as_it_stood(forwarded_delivery):
    """The second device sends the same form again and Connect holds exactly what it held after the first: one
    visit, not two, and no duplicate refused."""
    kept = forwarded_delivery["kept"]
    assert kept["again"]["connect"] == kept["first"]["connect"]


def test_a_form_without_a_fix_is_the_one_connect_flags(forwarded_delivery):
    """The control for the fix: on a device whose GPS finds no fix, the same form reaches Connect with no
    location, and Connect, whose opportunity verifies GPS, flags the visit."""
    run = _delivery(forwarded_delivery["kept"]["no-fix"])
    assert run["posts"][0]["payload"]["metadata"]["location"] is None
    (visit,) = run["state"]["visits"]
    assert visit["location"] is None and ["gps", "GPS data is missing"] in visit["flags"]


def test_a_project_space_without_data_forwarding_forwards_nothing(forwarded_delivery):
    """HQ registers a repeat record only where the project space can forward data: without the privilege HQ's
    receiver takes the form and nothing reaches Connect."""
    (run,) = forwarded_delivery["unprivileged"]
    assert [received["status"] for received in run["received"]] == [201]
    assert (run["forwards"], run["posts"], run["state"]["visits"]) == ([], [], [])
