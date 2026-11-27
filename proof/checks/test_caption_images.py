"""A saved picture may change name only at its own label and only on the side that delivered its bytes."""

import base64
import hashlib
import io
import json
import zipfile
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace

from proof.checks import caption_images, proof3, served
from proof.checks.corpus import Captured
from proof.matrix.media import png_of
from proof.observe.record import Blobs

OLD = "jr://file/commcare/old.png"
CONTENT = png_of("replacement")
DIGEST = hashlib.sha256(CONTENT).hexdigest()
ENTRY = f"commcare/{DIGEST}.png"
NEW = "jr://file/" + ENTRY
SCRIPT = [{"menu": 0}, {"menu": 0}]
SUITE = (
    '<suite><xform><resource><location authority="local">form.xml</location></resource></xform>'
    '<entry><form>urn:f</form><command id="m0-f0"/></entry></suite>'
)


def form_file(path):
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
    xmlns:jr="http://openrosa.org/javarosa"><h:head><model><instance><data xmlns="urn:f"><one/><two/></data></instance>
    <itext><translation lang="en"><text id="image"><value form="image">{path}</value></text></translation></itext>
    </model></h:head><h:body><input ref="/data/one"><label ref="jr:itext('image')"/></input>
    <input ref="/data/two"><label>Second</label></input></h:body></h:html>"""


def observations(path):
    # Both questions show the same image in the native records. Only the first question's label actually owns it.
    nodes = [
        {"type": "question", "binding": "/data/" + key, "caption": key, "caption_image": path} for key in ("one", "two")
    ]
    opened = {
        "title": "Visit",
        "selections": ["0", "0"],
        "tree": nodes,
        "instanceXml": {"output": '<data xmlns="urn:f"><one/><two/></data>'},
    }
    answered = {"answers": [{"ix": "0", "response": {"tree": nodes}}]}
    fp = {
        "locale": "en",
        "runs": [
            {
                "script": SCRIPT,
                "end": "submitted",
                "steps": [{"request": {"selections": ["0", "0"]}, "response": opened}, answered],
            }
        ],
    }
    url = "/hq/multimedia/file/CommCareImage/id/" + path.rsplit("/", 1)[-1]
    questions = [{"label": key, "media": [{"kind": "img", "src": url}]} for key in ("one", "two")]
    route = {"appId": "A" if path == OLD else "B", "selections": ["0", "0"]}
    screen = {"form": {"title": "Visit", "questions": questions}, "route": route}
    web = {"runs": [{"script": SCRIPT, "submit": "submitted", "screens": [screen, deepcopy(screen)]}]}
    return fp, web


def multiselect(pair, token, *, opens_immediately):
    """The walk sends the checked case, then follows the selection ID Formplayer returned for it."""
    trace, web = deepcopy(pair)
    run = trace["runs"][0]
    opened, answered = run["steps"]
    script = [{"menu": 0}, {"entity": "case-2"}]
    listed = {
        "type": "entities",
        "multiSelect": True,
        "entities": [{"id": "case-1"}, {"id": "case-2"}],
        "selections": ["0"],
    }
    selected = {"selections": ["0", "use_selected_values"], "selected_values": ["case-2"]}
    routes = ["0", "<selection 1>"]
    steps = [
        {"request": {"selections": []}, "response": {"type": "commands", "selections": []}},
        {"request": {"selections": ["0"]}, "response": listed},
    ]
    if opens_immediately:
        opened["request"] = selected
        opened["response"]["selections"] = ["0", token]
    else:
        steps.append({"request": selected, "response": {"type": "commands", "selections": ["0", token]}})
        script.append({"menu": 0})
        opened["request"]["selections"] = opened["response"]["selections"] = ["0", token, "0"]
        routes.append("0")
    run["steps"] = [*steps, opened, answered]
    run["script"] = web["runs"][0]["script"] = script
    for screen in web["runs"][0]["screens"]:
        screen["route"]["selections"] = list(routes)
    return trace, web


def test_two_reviewed_image_renames_stay_with_their_own_formplayer_binding():
    def xml(first, second):
        return (
            form_file(first)
            .replace("</translation>", f'<text id="other"><value form="image">{second}</value></text></translation>')
            .replace("<label>Second</label>", """<label ref="jr:itext('other')"/>""")
        )

    old, new = (
        (OLD, OLD.replace("old.png", "other.png")),
        (NEW, NEW.replace(DIGEST, hashlib.sha256(png_of("other")).hexdigest())),
    )
    source = {
        "langs": ["en"],
        "modules": [{"forms": [{"unique_id": "visit", "xmlns": "urn:f"}]}],
        "_attachments": {"visit.xml": xml(*old)},
    }

    def sites(swapped):
        traces = []
        for paths in (old, new):
            trace, _ = observations(paths[0])
            for node, uri in zip(
                trace["runs"][0]["steps"][0]["response"]["tree"], reversed(paths) if swapped else paths, strict=True
            ):
                node["caption_image"] = uri
            traces.append(trace)
        rows = served.formplayer_differences(*traces, check="proof3", document="example", artifact="formplayer@B")
        accepted = []
        for before, after in zip(old, new, strict=True):
            candidates = [d for d in rows if d.before == before and d.after == after]
            labels = caption_images.source_labels(source, before)
            side_sites = []
            for paths, uri, trace in zip((old, new), (before, after), traces, strict=True):
                installed = {"suite.xml": SUITE, "form.xml": xml(*paths)}
                ns, owners = caption_images.installed_labels(installed, {}, uri, labels)
                side_sites.append(caption_images.formplayer_label_sites(candidates, trace, ns, owners))
            left, right = side_sites
            accepted.extend(owner[-1] for key, owner in left.items() if right.get(key) == owner)
        return sorted(accepted)

    assert sites(False) == ["one", "one", "two", "two"]
    assert sites(True) == []

    # HQ keeps inactive source translations in the attachment and leaves them out of its built form.
    german = '<translation lang="de"><text id="image"><value form="image">other.png</value></text></translation>'
    source["_attachments"]["visit.xml"] = xml(*old).replace("</itext>", german + "</itext>")
    assert sites(False) == ["one", "one", "two", "two"]
    assert not caption_images.source_labels(source, "other.png")
    source["langs"].append("de")
    assert sites(False) == ["two", "two"]


def test_only_the_reviewed_label_and_bytes_delivered_by_each_reader_qualify(tmp_path):
    def app(path):
        return {
            "langs": ["en"],
            "modules": [{"forms": [{"unique_id": "visit", "xmlns": "urn:f"}]}],
            "_attachments": {"visit.xml": form_file(path)},
            "multimedia_map": {path: {"media_type": "CommCareImage", "multimedia_id": "id"}},
        }

    file = {"base64": base64.b64encode(CONTENT).decode(), "mimeType": "image/png"}
    capture = Captured(
        tmp_path / "posted",
        {},
        media=Captured(tmp_path / "bulk", {"contentType": "multipart/form-data; boundary=bulk"}),
    )
    def write_batch(batch, entry):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr(entry, CONTENT)
        batch.body_path.write_bytes(
            b'--bulk\r\nContent-Disposition: form-data; name="bulk_upload_file"; filename="images.zip"\r\n\r\n'
            + payload.getvalue()
            + b"\r\n--bulk--\r\n"
        )

    write_batch(capture.media, ENTRY)
    doc = SimpleNamespace(
        kind="corpus",
        hq_side={"republish": "brings-in", "mediaReplaced": {**file, "path": OLD}},
        document={"media": {"asset": {**file, "kind": "image", "extension": ".png"}}},
        exports={"min": SimpleNamespace(republish=capture)},
    )
    read = {
        "path": OLD,
        "mediaType": "CommCareImage",
        "multimediaId": "id",
        "status": 200,
        "sha256": DIGEST,
        "length": len(CONTENT),
    }
    saved = {"source": {"status": 200, "body": json.dumps(app(OLD))}, "media": [read]}
    upload = {"matched": [{"class": "CommCareImage", "path": NEW}]}
    blobs = Blobs()
    records = SimpleNamespace(
        blobs=blobs,
        configurations={"min": SimpleNamespace(a={"apiReads": {"saved": saved}}, b={"publish": {"media": upload}})},
    )
    a, b = observations(OLD), observations(NEW)

    def build(path, *, bundled=False):
        entry = path.removeprefix("jr://file/")
        locations = [{"authority": "local", "location": "./" + entry}]
        if not bundled:
            url = "https://www.commcarehq.org/hq/multimedia/file/CommCareImage/id/" + entry.rsplit("/", 1)[-1]
            locations.append({"authority": "remote", "location": url})
        xml = "".join(f'<location authority="{loc["authority"]}">{loc["location"]}</location>' for loc in locations)
        suite = f'<suite><media path="../../commcare"><resource id="image">{xml}</resource></media></suite>'
        files = {"suite.xml": SUITE, "form.xml": form_file(path), "media_suite.xml": suite}
        if bundled:
            files[entry] = CONTENT
        admission = {
            "admitted": True,
            "media": [{"location": "./" + entry, "id": "image", "bytesInArchive": bundled}],
            "resources": [
                {"id": "image", "installer": "MediaInstaller", "status": "Installed", "locations": locations}
            ],
        }
        return files, {"admission": admission}

    old_files, source_session = build(OLD)
    new_files, new_session = build(NEW)
    local, local_session = build(NEW, bundled=True)
    sessions = {"baseline": source_session, "b": new_session, "local": local_session}
    observed = SimpleNamespace(
        a=SimpleNamespace(build=SimpleNamespace(files=old_files), doc=app(OLD), app_id="A"),
        b=SimpleNamespace(doc=app(NEW), app_id="B"),
        b_aligned=SimpleNamespace(files=new_files),
    )

    def state(pair):
        fp, web = pair
        return {"formplayer": {"trace": blobs.put_json(fp)}, "webapps": blobs.put_json(web)}

    differing = {"A": [], "B": [], "local": []}

    def classified(published=None):
        browser = served.webapps_differences(
            a[1], b[1], traces=(a[0], b[0]), published=published, check="proof3", document="d", artifact="webapps@B"
        )
        if published is not None:
            # The comparator paired the desktop worker to ordinary B and retained its wrong URL.
            assert any(row.at == "/home/releaseListed" for row in browser)
            assert any(
                row.at == "/runs/0/screens/0/form/questions/0/media/0/src" and row.before.endswith("old.png")
                for row in browser
            )
        rows = list(browser)
        for target in ("B", "local.ccz"):
            rows += served.formplayer_differences(
                a[0], b[0], check="proof3", document="d", artifact=f"formplayer@{target}"
            )
        sites = {}
        baseline = {**state(a), "releaseDiffers": {"differing": differing["A"]}}
        states = {side: {**state(b), "releaseDiffers": {"differing": differing[side]}} for side in ("B", "local")}
        result = caption_images.saved_renames(
            doc, "min", records, observed, local, rows, baseline, states, sites, sessions=sessions
        )
        # Both the authored reading and the saved reading must tie each URI to its own label.
        authored = SimpleNamespace(
            exports=doc.exports,
            authored=SimpleNamespace(media_rows=lambda: [{"path": OLD, "kind": "image", "extension": "png"}]),
        )
        parts = records.configurations["min"]
        parts.a["apiReads"]["authored"] = saved
        parts.a["hooks"] = {"served": {"served": True, "A": baseline}}
        parts.b_aligned = {"served": states}
        captions = [row for row in rows if row.artifact.startswith("formplayer@")]
        authored_rows = proof3.verified_caption_renames(
            authored, "min", records, local, captions, observed=observed, sessions=sessions
        )
        if saved["source"]["body"] == json.dumps(app(OLD)):
            assert [row.at for row in authored_rows if row.path.endswith(":renamed-file")] == [
                row.at
                for row in result
                if row.artifact.startswith("formplayer@") and row.path.endswith(":renamed-file")
            ]
        assert all(owner == ("form", "0.0", "xform", "data", "one") for owner in sites.values())
        return [(d.artifact, d.at) for d in result if d.path.endswith(":renamed-file")]

    held = classified()
    assert sorted(held) == sorted(
        [
            (f"formplayer@{side}", f"/runs/0/steps/{i}/{field}/0/caption_image")
            for side in ("B", "local.ccz")
            for i, field in enumerate(("response/tree", "tree"))
        ]
        + [("webapps@B", f"/runs/0/screens/{s}/form/questions/0/media/0/src") for s in range(2)]
    )
    local_only = [key for key in held if key[0] == "formplayer@local.ccz"]
    other_batch = replace(capture.media, body_path=tmp_path / "other-bulk")
    captures = doc.exports["min"]
    captures.republish = replace(capture, media=None, batches=((other_batch, 2), (capture.media, 3)))
    write_batch(other_batch, "commcare/other.png")
    assert classified() == held
    write_batch(other_batch, ENTRY)
    assert classified() == local_only
    captures.republish = capture

    published_only = [key for key in held if key[0] != "formplayer@local.ccz"]
    native_only = [key for key in held if key[0] != "webapps@B"]
    # The same URI and upload report cannot qualify an unrelated or ambiguous installed resource.
    for files, expected in ((old_files, []), (new_files, local_only), (local, published_only)):
        suite = files["media_suite.xml"]
        for wrong in (
            suite.replace("../../commcare", "../../elsewhere"),
            suite.replace("</suite>", suite.removeprefix("<suite>")),
        ):
            files["media_suite.xml"] = wrong
            assert classified() == expected
        files["media_suite.xml"] = suite
    for side, expected in (("A", []), ("B", local_only), ("local", published_only)):
        differing[side] = ["media_suite.xml"]
        assert classified() == expected
        differing[side] = []
    # A changed host, id, or name is still visible even when the native URI and upload hash agree.
    target_xml = new_files["media_suite.xml"]
    for suspect in (target_xml.replace("commcarehq.org", "example.org"), target_xml.replace("/id/", "/other/")):
        new_files["media_suite.xml"] = suspect
        assert classified() == local_only
    new_files["media_suite.xml"] = target_xml
    dest = new_session["admission"]["resources"][0]
    dest["status"] = "Uninstalled"
    assert classified() == local_only
    dest["status"] = "Installed"
    local_session["admission"]["media"][0]["bytesInArchive"] = False
    assert classified() == published_only
    local_session["admission"]["media"][0]["bytesInArchive"] = True

    # Identical labels and valid image URLs can belong to a different app, navigation or viewport.
    for property_, wrong in (("appId", "other"), ("selections", ["1", "1"])):
        for pair in (a, b):
            for screen in pair[1]["runs"][0]["screens"]:
                screen["route"][property_] = wrong
        assert classified() == native_only
        for pair, app_id in ((a, "A"), (b, "B")):
            for screen in pair[1]["runs"][0]["screens"]:
                screen["route"][property_] = app_id if property_ == "appId" else ["0", "0"]
    b[1]["runs"][0]["viewport"] = "small"
    assert classified() == native_only
    del b[1]["runs"][0]["viewport"]
    opening = b[0]["runs"][0]["steps"][0]
    for trace in b:
        trace["runs"][0]["script"] = [{"language": "fra"}, *SCRIPT]
    opening["request"]["locale"] = "fra"
    assert classified() == []
    for trace in b:
        trace["runs"][0]["script"] = SCRIPT
    assert classified() == []  # The same scripted choices actually ran in a different locale.
    del opening["request"]["locale"]
    opening["request"]["selections"] = opening["response"]["selections"] = ["1", "0"]
    for screen in b[1]["runs"][0]["screens"]:
        screen["route"]["selections"] = ["1", "0"]
    assert classified() == []  # Each browser matches its own form, but the navigation differs across sides.
    for screen in b[1]["runs"][0]["screens"]:
        screen["route"]["selections"] = ["0", "0"]
    opening["request"]["selections"] = opening["response"]["selections"] = ["0", "0"]

    # Every fresh browser replay calls the first generated selection <selection 1>. Native tokens
    # can have different numbers on A and B, both when a selection opens a form and on a later menu.
    ordinary = a, b
    for opens_immediately in (True, False):
        a = multiselect(ordinary[0], "@generated:uuid:3", opens_immediately=opens_immediately)
        b = multiselect(ordinary[1], "@generated:uuid:19", opens_immediately=opens_immediately)
        positive = classified()
        assert len(positive) == len(held)
        browser_screen = b[1]["runs"][0]["screens"][0]
        browser_screen["route"]["selections"][1] = "<selection 2>"
        assert classified() == [key for key in positive if key[0] != "webapps@B"]
        browser_screen["route"]["selections"][1] = "<selection 1>"
        sent = b[0]["runs"][0]["steps"][2]["request"]
        sent["selected_values"] = ["case-1"]
        assert not classified()
        sent["selected_values"] = ["case-2"]
        b[0]["runs"][0]["steps"][1]["response"]["entities"].append({"id": "case-2"})
        assert not classified()
    # A UUID-shaped literal in a stored walk survived canonicalization because the app or restore supplied it.
    a = multiselect(ordinary[0], "2e0c3097-c5c3-4821-9639-8c71e1b3cd13", opens_immediately=True)
    b = multiselect(ordinary[1], "2e0c3097-c5c3-4821-9639-8c71e1b3cd13", opens_immediately=True)
    assert not classified()
    a, b = ordinary

    # Newly reachable worker runs use ordinary B for their left side. Its old URL can be spelled
    # exactly like A's expected rename; raw A's first run here is actually App Preview.
    ordinary_a, ordinary_b = a[1], b[1]
    sync = {"kind": "sync", "name": "Sync", "icon": None}
    first, second = (deepcopy(side) for side in (ordinary_a, ordinary_b))
    first.update(build={"workerApp": {"name": "Visit", "listed": False}}, home={"apps": [sync]})
    first["runs"][0]["viewport"] = "preview"
    second.update(
        build={"workerApp": {"name": "Visit", "listed": True}},
        home={"apps": [{"kind": "default", "name": "Visit", "icon": None}, sync]},
    )
    second["runs"] += [{**deepcopy(second["runs"][0]), "viewport": v} for v in ("small", "preview")]
    published = deepcopy(second)
    published["runs"][0]["screens"][0]["form"]["questions"][0]["media"][0]["src"] = first["runs"][0]["screens"][0][
        "form"
    ]["questions"][0]["media"][0]["src"]
    a = (a[0], first)
    b = (b[0], second)
    assert classified(published) == native_only
    a = (a[0], ordinary_a)
    b = (b[0], ordinary_b)

    local[ENTRY] = png_of("wrong")
    assert classified() == [key for key in held if key[0] != "formplayer@local.ccz"]
    local[ENTRY] = CONTENT
    observed.b.doc["multimedia_map"][NEW]["multimedia_id"] = "other"
    assert classified() == local_only
    observed.b.doc = app(NEW)
    b[1]["runs"][0]["screens"][0]["form"]["questions"][0]["media"][0]["src"] += "?other"
    assert classified() == [
        key for key in held if key != ("webapps@B", "/runs/0/screens/0/form/questions/0/media/0/src")
    ]
    upload["matched"].clear()
    assert classified() == [key for key in held if key[0] == "formplayer@local.ccz"]
    # Another form with identically named questions at this menu position cannot justify the move.
    other_form = app(OLD)
    other_form["modules"][0]["forms"][0]["xmlns"] = "urn:other"
    saved["source"]["body"] = json.dumps(other_form)
    assert not classified()
    saved["source"]["body"] = json.dumps(app(OLD))
    read["sha256"] = hashlib.sha256(png_of("old")).hexdigest()
    assert not classified()
