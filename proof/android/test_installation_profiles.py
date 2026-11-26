"""A worker opens a named installation from the project's actual released build."""

import json

import pytest

from proof.android import observe
from proof.formplayer import hq as formplayer
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import nova_shaped_upload
from proof.hq.test_installation_profiles import bilingual_app, profile_payload
from proof.observe.casedata import CaseDatabase, USER_ID, USERNAME
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")


def test_worker_opens_named_installation_in_its_own_language(hq, lane_services):
    with hq_check(Configuration(privileges={"CLOUDCARE", "BUILD_PROFILES"})) as (state, _):
        source = bilingual_app()
        source["build_profiles"] = {"visits": profile_payload("Visites", ["fra"])}
        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "Team visits")])
        database = CaseDatabase(USER_ID, USERNAME, (), ())
        with formplayer.serve(state, None, app_id, database=database, label="named-installation") as served:
            blobs = Blobs()
            selected = observe.release_archive(served, profile_key="visits")
            record = observe.app(served, blobs, label="named-french", archive=selected,
                                 installation_languages=["fra"], commands=["m0-f0"])
            answer = blobs.get_json(record["answer"])
            assert answer["install"] == "Installed" and answer["signIn"].startswith("Success(")
            assert answer["walks"].get("m0-f0"), answer.get("walks")
            assert "Visite" in json.dumps(answer["walks"]["m0-f0"], ensure_ascii=False)
