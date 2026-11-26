"""A Vellum-authored work-area request and its photo from each real worker to Connect.

The receiving project space also keeps its own copy of the photo. Its Connect
forwarder sends the filename in the form, while a delivery that only associates
the visit with the area can be received without the attachment manifest.
"""

import hashlib
import json
from contextlib import contextmanager
from pathlib import Path

import pytest
from lxml import etree

from proof.android import observe as android
from proof.connect.conftest import BOTH, CONNECT_XMLNS, DELIVER
from proof.connect.test_receiver_transactions import AREA_ID, submitted_blocks
from proof.editors import vellum
from proof.editors.hq import HQAnswers
from proof.formplayer import hq as forms
from proof.observe import connect
from proof.observe.record import Blobs
from proof.rules.conftest import published
from proof.webapps import steps
from proof.webapps.session import Session

NAME = "area_request"
PHOTO = "entrance_picture"
MODULE = "safe_access"
DESTINATION = "REQUEST_FOR_INACCESSIBLE"
PROOF = Path(__file__).resolve().parents[1]
VALUES = {
    "work_area_id": f"'{AREA_ID}'",
    "status": f"'{DESTINATION}'",
    "reason": "'Entrance locked'",
    "additional_details": "'Return on Tuesday'",
    "photo_evidence": f"/data/{PHOTO}",
}
AREA_QUESTIONS = [
    {"type": "Image", "id": PHOTO, "label": "Entrance photo"},
    {"type": "ConnectWorkAreaUpdate", "id": NAME, "properties": VALUES},
    {
        "type": "ConnectLearnModule",
        "id": MODULE,
        "properties": {"name": "Entrance safety", "description": "Check the entrance", "time_estimate": "5"},
    },
]


@contextmanager
def saved_app(document, core_runner, editor_driver, out, *, update):
    """The project has Connect and Web Apps. HQ keeps the edit made in its own form designer."""
    with published(document, core_runner, "maximum") as app:
        app._write(doc=lambda data: {**data, "cloudcare_enabled": True})
        form = app._app().modules[0].forms[0]
        if update:
            edit = {"way": "add-questions", "questions": AREA_QUESTIONS}
        else:
            edit = {
                "way": "builder-model",
                "path": "/data/home_visit",
                "property": "work_area_id",
                "value": VALUES["work_area_id"],
            }
        run = vellum.open_and_save(editor_driver, HQAnswers(app.unit, app.unit), app.app_id, form.unique_id, edit=edit)
        assert run.saved and run.stored_source, (run.load_error, run.save_refusal, run.form_errors)
        stored = run.stored_source.encode()
        out.mkdir(exist_ok=True, parents=True)
        (out / "vellum-saved.xml").write_bytes(stored)
        source = etree.fromstring(stored)
        ns = {"x": "http://www.w3.org/2002/xforms", "c": CONNECT_XMLNS, "v": "http://commcarehq.org/xforms/vellum"}
        deliveries = source.xpath("//x:instance/*/*/c:deliver", namespaces=ns)
        assert [node.get("id") for node in deliveries] == ["home_visit"]
        if update:
            (area,) = source.xpath(
                "//x:instance/*/*[@v:role='ConnectWorkAreaUpdate']/c:work_area_update", namespaces=ns
            )
            assert area.get("id") == NAME
            assert [etree.QName(node).localname for node in area] == list(VALUES)
            assert {
                node.get("nodeset"): node.get("calculate")
                for node in source.xpath("//x:bind", namespaces=ns)
                if (node.get("nodeset") or "").startswith(f"/data/{NAME}/work_area_update/")
            } == {f"/data/{NAME}/work_area_update/{key}": expr for key, expr in VALUES.items()}
            order = source.xpath("//x:instance/*/*/c:*[@id]/@id", namespaces=ns)
            assert order == ["home_visit", NAME, MODULE], order
        else:
            assert not source.xpath("//c:work_area_update", namespaces=ns)
            assert source.xpath(
                "//x:bind[@nodeset='/data/home_visit/deliver/work_area_id']/@calculate", namespaces=ns
            ) == [VALUES["work_area_id"]]
        yield app


def test_the_designer_creates_a_work_area_request_beside_the_delivery(
    hq, core_runner, editor_driver, connect_documents, connect_out
):
    with saved_app(connect_documents[DELIVER], core_runner, editor_driver, connect_out / "areas/editor", update=True):
        pass


def enter_web(served, editor_driver, directory, *, update):
    """A worker opens the form in HQ's Web Apps client, chooses a photo in its widget and presses Submit."""
    from corehq import privileges

    from proof.hq.seams import also_granted
    from proof.webapps.observe import worker_home

    menu = served.doc["modules"][0]
    language = served.languages[0]
    # Home visit holds one text question before the image added by the designer. The delivery, area
    # request and learning activity have no widgets. Each answer below is checked against the label
    # and value the worker actually saw on the form.
    made = [
        steps.SCREEN,
        *steps.open_app(served.doc["name"]),
        *steps.choose(menu["name"][language]),
        *steps.choose(menu["forms"][0]["name"][language]),
        *steps.answer("0", "Household 8"),
    ]
    if update:
        content = (PROOF / "hq-apps/hq-media/media/6.png").read_bytes()
        made += steps.answer_media("1", "image", "web-entrance.png", content, "image/png")
    made += [steps.SCREEN, *steps.submit_and_land()]
    # This opportunity began with an Android app. Enabling its release for Web Apps is one
    # requirement; the signed-in worker also needs Web Apps on the project space's plan.
    session = Session(served, editor_driver)
    with also_granted(privileges.CLOUDCARE):
        run = session.run(made, name="area-visit")
    (directory / "web-apps.json").write_text(json.dumps(run.screens, indent=2) + "\n")
    assert not run.page_errors, run.page_errors
    home, screen = run.screens
    assert worker_home(session, run, home)
    answers = {q["label"]: q["answer"] for q in screen["form"]["questions"]}
    assert answers["Household"] == "Household 8", answers
    if update:
        assert answers["Entrance photo"] == "web-entrance.png", answers
        (upload,) = run.answered("answer_media")
        assert upload.status == 200 and upload.json()["status"] == "accepted", upload.response
    (submit,) = run.answered("submit-all")
    assert submit.status == 200 and submit.json()["status"] == "success", submit.response


def observe_worker(document, core_runner, editor_driver, runtime, directory, *, reader, update, runner=None):
    from corehq.apps.api.resources.v0_4 import XFormInstanceResource
    from corehq.apps.api.util import form_to_es_form
    from corehq.form_processor.models import XFormInstance

    with (
        saved_app(document, core_runner, editor_driver, directory, update=update) as app,
        forms.serve(app.unit, document, app.app_id, runner=runner, platforms=BOTH) as served,
    ):
        assert served.doc["cloudcare_enabled"] and served.reads(reader)
        archive = android.release_archive(served)
        (directory / "release.ccz").write_bytes(archive)
        opportunity = connect.open_opportunity(served, runtime=runtime)
        try:
            session = opportunity.session
            session.step("flags", gps=False, duplicate=False, location=0)
            session.step("assign_area", case=AREA_ID)
            before = session.step("collect", observeAreas=True)["state"]
            opportunity.ready = session.checkpoint()
            assert before["areas"] == [{"case": AREA_ID, "status": "NOT_VISITED", "assignedToWorker": True}]
            captures = []

            def observed(_reader, views, posts):
                (post,) = posts
                payload = post["payload"]
                stored = XFormInstance.objects.get_form(payload["id"], domain=served.domain)
                (sent,) = [
                    s
                    for s in views.submissions
                    if s.instance
                    and forms.DEVICE_REPORT not in s.instance
                    and etree.fromstring(s.instance)
                    .xpath("string(//*[local-name()='instanceID'])")
                    .removeprefix("uuid:")
                    == payload["id"].removeprefix("uuid:")
                ]
                (directory / "submitted.xml").write_bytes(sent.instance)
                (directory / "forwarded.json").write_text(json.dumps(payload, indent=2) + "\n")
                assert payload["app_id"] == served.app_id and payload["build_id"] == served.build_id
                assert payload["domain"] == served.domain and "attachments" not in payload
                if update:
                    (block,) = submitted_blocks(payload["form"], "work_area_update")
                    assert block["work_area_id"] == AREA_ID and block["status"] == DESTINATION
                    name = block["photo_evidence"]
                    assert etree.fromstring(sent.instance).xpath("//*[local-name()='photo_evidence']/text()") == [name]
                    assert etree.fromstring(sent.instance).xpath(f"//*[local-name()='{PHOTO}']/text()") == [name]
                    assert isinstance(name, str) and name and Path(name).name == name
                    ((file_name, content),) = sent.files
                    assert file_name == name and stored.get_attachment(name) == content
                    expected = PROOF / (
                        "core/captures/proof-image.jpg" if reader == "android" else "hq-apps/hq-media/media/6.png"
                    )
                    assert content == expected.read_bytes()
                    resource = XFormInstanceResource()
                    metadata = resource.dehydrate_attachments(
                        resource.build_bundle(obj=form_to_es_form(stored, include_attachments=True))
                    )
                    assert metadata[name]["length"] == len(content) and name in metadata[name]["url"]
                    assert metadata[name]["content_type"] == ("image/jpeg" if reader == "android" else "image/png")
                    (directory / ("photo.jpg" if reader == "android" else "photo.png")).write_bytes(content)
                    (directory / "hq-attachment.json").write_text(
                        json.dumps(
                            {"filename": name, "sha256": hashlib.sha256(content).hexdigest(), **metadata[name]},
                            indent=2,
                        )
                        + "\n"
                    )
                    assert post["status"] == 400 and name in str(post["body"]) and "not found" in str(post["body"])
                else:
                    (delivered,) = submitted_blocks(payload["form"], "deliver")
                    assert delivered["work_area_id"] == AREA_ID and post["status"] == 200, post
                captures.append(payload["id"])

            with connect.forwarded(served, opportunity, f"area-{reader}", observe_submission=observed) as forwarder:
                if reader == "android":
                    android.app(
                        served,
                        Blobs(),
                        label="area",
                        archive=archive,
                        fix=android.LANE_FIX,
                        commands=["m0-f0"],
                    )
                else:
                    with forwarder.reading("webapps"):
                        enter_web(served, editor_driver, directory, update=update)
                (run,) = forwarder.runs[reader]
                assert len(captures) == 1 and run["received"] == [{"status": 201}]
                (forward,) = run["forwards"]
                assert forward["form"] == captures[0]
                final = session.step("collect", observeAreas=True)["state"]
                (directory / "connect-receipt.json").write_text(
                    json.dumps({"before": before, "after": final, "forward": forward, "tasks": run["tasks"]}, indent=2)
                    + "\n"
                )
                if update:
                    (delivered,) = submitted_blocks(run["posts"][0]["payload"]["form"], "deliver")
                    (lesson,) = submitted_blocks(run["posts"][0]["payload"]["form"], "module")
                    assert delivered["@id"] == "home_visit" and lesson["@id"] == MODULE
                    assert final == before and run["tasks"] == []
                else:
                    (visit,) = final["visits"]
                    assert visit["deliverUnit"] == "home_visit" and visit["workArea"] == AREA_ID
                    assert [area["status"] for area in final["areas"]] == ["VISITED"] and not final["areaRequests"]
        finally:
            opportunity.close()


@pytest.mark.reader("android")
@pytest.mark.parametrize("update", [True, False], ids=["request", "association"])
def test_android_submits_the_vellum_area_form(
    hq, core_runner, editor_driver, connect_documents, connect_out, connect_runtime, update
):
    observe_worker(
        connect_documents[DELIVER],
        core_runner,
        editor_driver,
        connect_runtime,
        connect_out / "areas" / ("android-request" if update else "android-association"),
        reader="android",
        update=update,
    )


@pytest.mark.reader("webapps")
@pytest.mark.parametrize("update", [True, False], ids=["request", "association"])
def test_web_apps_submits_the_vellum_area_form(
    hq, core_runner, editor_driver, connect_documents, connect_out, connect_runtime, formplayer_runner, update
):
    observe_worker(
        connect_documents[DELIVER],
        core_runner,
        editor_driver,
        connect_runtime,
        connect_out / "areas" / ("web-request" if update else "web-association"),
        reader="webapps",
        update=update,
        runner=formplayer_runner,
    )
