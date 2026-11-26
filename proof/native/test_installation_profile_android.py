"""A worker opens the selected archive downloaded from Nova on Android."""

import json

import pytest

from proof.android import observe
from proof.formplayer import hq as formplayer
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import nova_shaped_upload
from proof.observe.casedata import CaseDatabase, USER_ID, USERNAME
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")
FAMILIES = ("localization",)


def test_worker_opens_nova_downloaded_named_installation(native, lane_services):
    directory = native.family("localization")
    source = json.loads((directory / "named-spanish.json").read_bytes())
    with hq_check(Configuration(privileges={"CLOUDCARE", "BUILD_PROFILES"})) as (state, _):
        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "Outreach")])
        database = CaseDatabase(USER_ID, USERNAME, (), ())
        with formplayer.serve(state, None, app_id, database=database, label="local-named") as served:
            for label, languages, default, text in [
                ("named-spanish", ["es"], "es", "Nombre"),
                ("ordinary", ["en", "es"], "en", "Name"),
            ]:
                blobs = Blobs()
                record = observe.app(
                    served, blobs, label="local:" + label, archive=(directory / (label + ".ccz")).read_bytes(),
                    delivered=True, installation_languages=languages, commands=["m0-f0"],
                )
                answer = blobs.get_json(record["answer"])
                assert answer["install"] == "Installed", answer["install"]
                assert answer["signIn"].startswith("Success("), answer["signIn"]
                walk = answer["walks"]["m0-f0"]
                (form,) = [step["form"] for step in walk["steps"] if step["screen"] == "FormEntryActivity" and "form" in step]
                assert form["language"] == default, form
                assert sorted(form["languages"]) == sorted(languages), form
                labels = [question["text"] for screen in form["screens"] for question in screen.get("questions", []) if "text" in question]
                assert text in labels, labels
