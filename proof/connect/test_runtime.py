"""The Connect runtime runs Connect at the pin, and each scenario alone.

Contract: the runtime's Connect is the commit ``proof/pins.json`` names, on a
virtualenv the image built from that same commit's lock; every scenario runs
in Connect's database as its migrations leave it and over an empty broker,
whatever an earlier scenario wrote; and a scenario Connect's driver cannot
run fails with the driver's own error, never with a partial result.

The plausible failures: a pin moved without the image's virtualenv (Connect
then runs on another commit's dependencies); a row or a queued task one
scenario leaves for the next, which would make an observation depend on the
order tests run in; and a driver error read as an empty outcome.
"""

import os
from pathlib import Path

import pytest

from proof.connect import checkout
from proof.connect.runtime import ConnectRuntimeFailed

HQ_URL = "https://www.commcarehq.org"


def _opportunity(domain):
    return {
        "do": "opportunity",
        "hqUrl": HQ_URL,
        "domain": domain,
        "learnApp": "learn-app",
        "deliverApp": "deliver-app",
        "commcareUsername": f"worker@{domain}.commcarehq.org",
    }


def _payload(domain):
    """A learn submission's payload in the shape HQ forwards (``test_receiver`` holds HQ's own), for an app the
    scenario's opportunity names."""
    meta = {
        "timeStart": "2026-01-15T10:30:00.000000Z",
        "timeEnd": "2026-01-15T10:31:00.000000Z",
        "app_build_version": None,
        "username": "worker",
        "location": None,
    }
    block = {
        "@xmlns": "http://commcareconnect.com/data/v1/learn",
        "@id": "lesson",
        "name": "Lesson",
        "description": "One lesson.",
        "time_estimate": "5",
    }
    return {
        "domain": domain,
        "id": "8f0f9c8e-2d0a-4a53-9d53-0a3f0f9c8e2d",
        "app_id": "learn-app",
        "build_id": None,
        "received_on": "2026-01-15T10:32:00.000000Z",
        "metadata": meta,
        "form": {"lesson": {"module": block}},
    }


def test_connect_runs_at_the_pin_on_the_images_environment_for_it(connect_runtime):
    pinned = checkout.pinned_commit()
    assert connect_runtime.checkout.commit == pinned
    built_for = Path(os.environ["PROOF_CONNECT_VENV"], "proof-connect-pin").read_text().strip()
    assert built_for == pinned, (
        f"The image's Connect virtualenv was built from the lock of {built_for}, and proof/pins.json names {pinned}."
        ' Rebuild the image for the pins (proof/README.md, "Changing a pin").'
    )


def test_each_scenario_starts_from_connects_migrated_database_and_an_empty_broker(connect_runtime):
    """A scenario that completes a module and queues nothing else is followed by one that sees none of it."""
    domain = "proof-runtime"
    first = connect_runtime.run(
        {"steps": [_opportunity(domain), {"do": "post", "name": "lesson", "payload": _payload(domain)}]}
    )
    assert (first[-1]["status"], first[-1]["raised"]) == (200, [])
    assert [done["module"] for done in first[-1]["state"]["completedModules"]] == ["lesson"]
    assert first[-1]["state"]["learnModules"] != []
    second = connect_runtime.run({"steps": [_opportunity(domain)]})
    state = second[-1]["state"]
    assert (state["learnModules"], state["completedModules"], state["queued"]) == ([], [], [])


def test_a_scenario_the_driver_cannot_run_fails_with_the_drivers_error(connect_runtime):
    """An unknown step fails the scenario by name; the scenario without it runs."""
    domain = "proof-runtime"
    with pytest.raises(ConnectRuntimeFailed, match="no step named 'polish'"):
        connect_runtime.run({"steps": [_opportunity(domain), {"do": "polish"}]})
    assert connect_runtime.run({"steps": [_opportunity(domain)]})[-1]["do"] == "opportunity"
