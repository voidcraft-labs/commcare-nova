"""An unavailable required source resource can explain only the installation that actually requested it."""

from dataclasses import replace

import pytest

from proof.checks import android
from proof.checks import missing_android_media as media
from proof.checks.differences import Difference
from proof.observe.record import Blobs

LOST = "commcare/image/removed.png"
KEPT = "commcare/image/kept.png"
URI = "jr://file/" + LOST
URL = "https://www.commcarehq.org/hq/multimedia/file/CommCareImage/old-id/removed.png"


def _files(missing):
    profile = b"<profile><suite><resource><location authority='local'>./media_suite.xml</location></resource></suite></profile>"
    paths = [KEPT, LOST] if missing else [KEPT]
    suite = (
        "<suite>"
        + "".join(
            f'<media><resource lazy="false"><location authority="local">./{path}</location>'
            f'<location authority="remote">{URL if path == LOST else URL.replace("removed", "kept")}</location>'
            "</resource></media>"
            for path in paths
        )
        + "</suite>"
    )
    return {
        "profile.ccpr": profile,
        "media_profile.ccpr": profile,
        "media_suite.xml": suite.encode(),
        KEPT: b"kept bytes",
    }


def _source():
    return {
        "multimedia_map": {URI: {"media_type": "CommCareImage", "multimedia_id": "old-id"}},
        "modules": [{"forms": [{"media_image": {"en": URI}}]}],
    }


def _read():
    return {"path": URI, "status": 404, "mediaType": "CommCareImage", "multimediaId": "old-id"}


@pytest.mark.parametrize(
    "wrong",
    [
        "",
        "id",
        "status",
        "non-icon",
        "lazy",
        "second missing",
        "different second local export",
        "sibling bytes",
        "still listed",
        "profile",
    ],
)
def test_exact_src_404_and_one_missing_eager_archive_entry_explain_only_that_one_picture(wrong):
    blobs = Blobs()
    source, read = _source(), _read()
    a, b, local = _files(True), _files(False), _files(False)
    if wrong == "id":
        read["multimediaId"] = "another-id"
    elif wrong == "status":
        read["status"] = 403
    elif wrong == "non-icon":
        source["modules"][0]["forms"][0]["media_image"]["en"] = "jr://file/other.png"
    elif wrong == "lazy":
        a["media_suite.xml"] = a["media_suite.xml"].replace(b'lazy="false"', b'lazy="true"')
    elif wrong == "second missing":
        del a[KEPT]
    elif wrong == "sibling bytes":
        local[KEPT] = b"other bytes"
    elif wrong == "still listed":
        b["media_suite.xml"] = a["media_suite.xml"]
    elif wrong == "profile":
        a["profile.ccpr"] = b"<profile/>"

    def stored(files):
        return {path: blobs.put(data) for path, data in files.items()}

    again = {**local, KEPT: b"different"} if wrong == "different second local export" else local
    assert media._cause(source, [read], stored(a), stored(b), stored(b), local, blobs, again=again) == (
        None if wrong else (URI, URL)
    )


def _request():
    return {"method": "GET", "url_name": "hqmedia_download", "url": URL, "status": 404, "raised": None}


@pytest.mark.parametrize("wrong", ["url", "view", "status", "extra", "unread"])
def test_the_installers_actual_request_must_have_received_exactly_the_relevant_hq_404(wrong):
    req = _request()
    assert media._failed([req], URL)
    if wrong == "extra":
        traffic = [req, req]
    else:
        change = {
            "url": {"url": URL.replace("old-id", "other")},
            "view": {"url_name": "other"},
            "status": {"status": 500},
            "unread": {"unread": True},
        }
        traffic = [{**req, **change[wrong]}]
    assert not media._failed(traffic, URL)


def _identity():
    first = {"uniqueid": "HQ", "version": "8"}
    second = {"uniqueid": "HQ", "version": "11"}
    local = {"uniqueid": "local", "version": "1"}
    return {
        "republish": {
            "update": {"install": media.MISSING, "archives": {"before": first, "after": second}},
            "installs": {
                "installs": [
                    {"install": media.MISSING, "installedApps": []},
                    {"install": "Installed", "installedApps": ["HQ"]},
                ]
            },
        },
        "local": {
            "update": {
                "install": "Installed",
                "staged": "UpToDate",
                "archives": {"before": local, "after": local.copy()},
            },
            "installs": {
                "installs": [
                    {"install": "Installed", "installedApps": ["local"]},
                    {"install": "DuplicateApp", "installedApps": ["local"]},
                ]
            },
        },
    }


@pytest.mark.parametrize(
    "wrong", ["", "second app", "version", "other update", "duplicate", "different local revision"]
)
def test_the_refusal_can_only_explain_the_later_install_of_the_same_application(wrong):
    devices = _identity()
    if wrong == "second app":
        devices["republish"]["update"]["archives"]["after"]["uniqueid"] = "different"
    elif wrong == "version":
        devices["republish"]["update"]["archives"]["after"]["version"] = "7"
    elif wrong == "other update":
        devices["republish"]["update"]["staged"] = "UpdateStaged"
    elif wrong == "duplicate":
        devices["local"]["installs"]["installs"][1]["installedApps"] = ["other"]
    elif wrong == "different local revision":
        devices["local"]["update"]["archives"]["after"]["version"] = "2"
    blobs = Blobs()
    native = {
        key: {
            kind: {"answer": blobs.put_json(value), "hq": blobs.put_json([_request()] if key == "republish" else [])}
            for kind, value in pair.items()
        }
        for key, pair in devices.items()
    }
    rows = [
        Difference("proof1", "document", android.LOCAL, path, at, "changed", a, b)
        for path, at, a, b in (
            ("/installs/*", "/installs/0", media.MISSING, "Installed"),
            ("/installs/*", "/installs/1", "Installed", "DuplicateApp"),
            ("/update", "/update", f"not installed: {media.MISSING}", "Installed"),
        )
    ]
    held = media._identity(rows, native, blobs, URL)
    assert held == (rows if not wrong else [rows[-1]] if wrong == "duplicate" else [])
    assert not media._identity([replace(d, after="wrong") for d in rows], native, blobs, URL)


def test_two_installed_builds_with_the_same_form_error_are_still_failed_walks():
    answer = {
        "install": "Installed",
        "areMMResourcesValidatedAfterInstall": True,
        "signIn": "Success(worker)",
        "walks": {
            "root": {"steps": [{"screen": "Home"}]},
            "form/visit": {
                "steps": [
                    {
                        "screen": "FormEntryActivity",
                        "form": {"loaded": False, "alert": {"title": "Error Occurred", "msg": "Wrong date"}},
                    }
                ]
            },
        },
    }
    found = android.recovered_walks("document", "android@B", answer)
    assert [(d.at, d.after) for d in found] == [
        ("/after-install/walks/form~1visit/steps/0", {"title": "Error Occurred", "msg": "Wrong date"})
    ]
    form = answer["walks"]["form/visit"]["steps"][0]["form"]
    form.update(loaded=True, ended="end", saved={"finishing": True, "resultCode": -1})
    del form["alert"]
    assert not android.recovered_walks("document", "android@B", answer)


def _records(b_drift=False, sibling_404=False, missing_walk=False):
    import json
    from types import SimpleNamespace

    blobs = Blobs()
    failed = {"install": media.MISSING}

    def complete_answer(value):
        return {
            "install": "Installed",
            "areMMResourcesValidatedAfterInstall": True,
            "signIn": "Success(worker)",
            "walks": {
                "root": {"steps": [{"screen": "Menu"}]},
                "form": {
                    "steps": [
                        {
                            "screen": "FormEntryActivity",
                            "session": {"command": "m0-f0"},
                            "form": {
                                "loaded": True,
                                "ended": "end",
                                "finishShown": True,
                                "formTitle": value,
                                "saved": {"finishing": True, "resultCode": -1},
                            },
                        }
                    ]
                },
            },
        }

    ordinary = complete_answer("Followup")
    if missing_walk:
        ordinary["walks"]["sibling"] = ordinary["walks"]["form"]
    hq, local = complete_answer("Wrong" if b_drift else "Followup"), complete_answer("Followup")

    def held(answer, traffic):
        return {"answer": blobs.put_json(answer), "hq": blobs.put_json(traffic)}

    old = held(failed, [_request()])
    tablet = held(failed, [{**_request(), "url": URL + "-unrelated"}]) if sibling_404 else old
    old_files, new_files = (
        {path: blobs.put(data) for path, data in _files(missing).items()} for missing in (True, False)
    )
    a = {
        "state": {"archive": {"entries": old_files}},
        "apiReads": {"authored": {"source": {"status": 200, "body": json.dumps(_source())}, "media": [_read()]}},
        "hooks": {"served": {"A": {"android": old, "androidTablet": tablet}}},
    }
    b = {
        "state": {"archive": {"entries": new_files}},
        "proof4": {"served": {"android": held(ordinary, []), "androidTablet": held(ordinary, [])}},
    }
    aligned = {
        "aligned": {"files": new_files},
        "served": {
            "B": {"android": held(hq, []), "androidTablet": held(hq, [])},
            "local": {
                "android": held(local, []),
                "androidDelivered": held(local, []),
                "androidDeliveredTablet": held(local, []),
            },
        },
    }
    parts = SimpleNamespace(a=a, b=b, b_aligned=aligned)
    doc = SimpleNamespace(hq_authored=True, hq_side=None, id="planted")

    def comparison(device):
        return android.configuration_behavior(
            doc.id, android.walks_record(parts, blobs, tablet=device == android.TABLET), device=device, menus={}
        )

    return (
        doc,
        SimpleNamespace(configurations={"minimum": parts}, blobs=blobs),
        comparison("android"),
        comparison(android.TABLET),
    )


@pytest.mark.parametrize(
    "drift,other_request,missing_walk",
    [(False, False, False), (True, False, False), (False, True, False), (False, False, True)],
)
def test_repaired_source_installs_keep_both_working_walks_and_their_independent_ordinary_b_control(
    drift, other_request, missing_walk
):
    doc, records, phone, tablet = _records(drift, other_request, missing_walk)
    rows, sites = media.classify(doc, records, "minimum", phone, _files(False), tablet_rows=tablet)
    owned = [d for d in rows if d.path == media.FAILED_REQUEST or d.path.endswith(media.SUFFIX)]
    assert len(owned) == 3
    assert all(sites.served[d.artifact, d.at] == ("app", "multimedia_map", URI) for d in owned)
    remainder = [d for d in rows if d not in owned]
    if drift:
        assert [(d.artifact, d.path, d.before, d.after) for d in remainder] == [
            ("android@local.ccz", "/after-install/walks/*/steps/*/form/formTitle", "Wrong", "Followup"),
            ("android@B", "/after-install/control/walks/*/steps/*/form/formTitle", "Followup", "Wrong"),
        ]
    elif other_request:
        assert {(d.artifact, d.path) for d in remainder} == {(d.artifact, d.path) for d in tablet}
    elif missing_walk:
        assert [(d.artifact, d.at, d.kind) for d in remainder] == [
            ("android@B", "/after-install/control/walks/sibling", "removed")
        ]
    else:
        assert not remainder


@pytest.mark.parametrize("control", ["absent", "two builds skip the form"])
def test_an_absent_control_or_a_form_skipped_on_both_delivered_builds_stays_reported(control):
    doc, records, phone, tablet = _records()
    parts = records.configurations["minimum"]
    if control == "absent":
        parts.b["proof4"]["served"] = {}
    else:
        for role, key in (
            ("B", "android"),
            ("B", "androidTablet"),
            ("local", "androidDelivered"),
            ("local", "androidDeliveredTablet"),
        ):
            held = parts.b_aligned["served"][role][key]
            value = records.blobs.get_json(held["answer"])
            value["walks"]["form"]["steps"] = [{"screen": "Menu"}]
            held["answer"] = records.blobs.put_json(value)
    rows, _ = media.classify(doc, records, "minimum", phone, _files(False), tablet_rows=tablet)
    diagnostics = [d for d in rows if d.path.startswith("/after-install/control")]
    assert len(diagnostics) == 1 and diagnostics[0].artifact == "android@B"
    if control == "absent":
        assert diagnostics[0].kind == "error" and diagnostics[0].after is None
    else:
        assert diagnostics[0].before == "FormEntryActivity" and diagnostics[0].after == "Menu"
