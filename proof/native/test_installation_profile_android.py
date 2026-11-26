"""A worker opens the selected archive downloaded from Nova on Android."""

import json

import pytest

from proof.android import observe
from proof.formplayer import hq as formplayer
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.observe.casedata import CaseDatabase, USER_ID, USERNAME
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")
FAMILIES = ("localization",)


def test_worker_opens_nova_downloaded_named_installation(native, lane_services):
    from corehq.apps.app_manager.models import Application

    directory = native.family("localization")
    source = json.loads((directory / "named-spanish.json").read_bytes())
    target = json.loads((directory / "installation-target.json").read_bytes())
    configuration = Configuration(domain=target["domain"], privileges={"CLOUDCARE", "BUILD_PROFILES"})
    with hq_check(configuration) as (state, _):
        # Seed the exact remote app the download names, with HQ's own model
        # importer and attachment store. Let Android send every request as written.
        attachments = source.pop("_attachments")
        app = Application.from_source(source, state.domain)
        app._id = target["appId"]
        with state.committing():
            app.save_attachments(attachments)
        app_id = app._id
        database = CaseDatabase(USER_ID, USERNAME, (), ())
        with formplayer.serve(state, None, app_id, database=database, label="local-named") as served:
            for label, languages, default, text in [
                ("named-spanish", ["es"], "es", "Nombre"),
                ("ordinary", ["en", "es"], "en", "Name"),
            ]:
                blobs = Blobs()
                record = observe.app(
                    served, blobs, label="local:" + label, archive=(directory / (label + ".ccz")).read_bytes(),
                    installation_languages=languages, commands=["m0-f0"],
                )
                answer = blobs.get_json(record["answer"])
                exchanges = blobs.get_json(record["hq"])
                assert exchanges and all(exchange["delivered"] is None for exchange in exchanges)
                assert answer["install"] == "Installed", answer["install"]
                assert answer["signIn"].startswith("Success("), (answer["signIn"], exchanges)
                walk = answer["walks"]["m0-f0"]
                (form,) = [step["form"] for step in walk["steps"] if step["screen"] == "FormEntryActivity" and "form" in step]
                assert form["language"] == default, form
                assert sorted(form["languages"]) == sorted(languages), form
                labels = [question["text"] for screen in form["screens"] for question in screen.get("questions", []) if "text" in question]
                assert text in labels, labels
