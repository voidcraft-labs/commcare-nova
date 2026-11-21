"""Native comparisons and source witnesses must belong to the same configuration and the same publish."""

import json
from types import SimpleNamespace

from proof.checks import changes, served_places
from proof.checks.differences import Difference
from proof.observe.record import Blobs


def _caption():
    return Difference(
        "proof3",
        "document",
        "formplayer@B",
        "/runs/*/steps/*/response/tree/*/caption",
        "/runs/0/steps/0/response/tree/0/caption",
        "changed",
        "",
        "Crop",
    )


def _response(namespace):
    xml = f'<data xmlns="{namespace}"><crop/></data>'
    return {"runs": [{"steps": [{"response": {"tree": [{"binding": "/data/crop"}], "instanceXml": {"output": xml}}}]}]}


def test_changed_sites_require_both_native_sides_and_the_suite_that_the_reader_installed():
    diff = _caption()
    suite = b'<suite><entry><form>one</form><command id="m0-f0"/></entry><entry><form>two</form><command id="m1-f0"/></entry></suite>'
    build = SimpleNamespace(files={"suite.xml": suite})
    observed = SimpleNamespace(a=SimpleNamespace(build=build), b_aligned=build)
    blobs = Blobs()
    a = {"formplayer": {"trace": blobs.put_json(_response("one"))}}
    b = {"formplayer": {"trace": blobs.put_json(_response("one"))}}
    parts = SimpleNamespace(a={"hooks": {"served": {"A": a}}}, b_aligned={"served": {"B": b}})
    records = SimpleNamespace(configurations={"minimum": parts}, blobs=blobs)

    def place():
        return served_places.sites(records, "minimum", [diff], observed, {}).served[diff.artifact, diff.at]

    assert place()[:2] == ("form", "0.0")
    b["formplayer"]["trace"] = blobs.put_json(_response("two"))
    assert place() is None
    b["formplayer"]["trace"] = a["formplayer"]["trace"]
    b["releaseDiffers"] = {"differing": ["suite.xml"]}
    assert place() is None
    del b["releaseDiffers"]
    del b["formplayer"]
    assert place() is None


def test_a_review_of_saved_hq_edits_uses_only_its_own_configurations_saved_source():
    doc = SimpleNamespace(kind="corpus", hq_authored=False, hq_side={"republish": "brings-in"})
    source = {"modules": [{"name": {"en": " Visits"}}], "translations": {}}
    answer = {"status": 200, "body": json.dumps(source)}
    parts = SimpleNamespace(a={"apiReads": {"published": {"source": answer}, "saved": {"source": answer}}})
    other = SimpleNamespace(a={"apiReads": {"published": {"source": answer}}})
    records = SimpleNamespace(configurations={"minimum": parts, "full": other})
    row = Difference(
        "proof3",
        "document",
        "formplayer@B",
        served_places.formplayer_menus.DISPLAY,
        "/runs/0/steps/0/response/commands/0/displayText",
        "changed",
        " Visits",
        "Visits",
    )
    sites = changes.Sites(served={(row.artifact, row.at): ("menu", "0", "name")})

    def path(configuration):
        return served_places.classify(doc, records, configuration, [row], sites)[0].path

    assert path("minimum") == f"{row.path}:trimmed"
    assert path("full") == row.path
    source["translations"] = {"en": {"modules.m0": " Visits"}}
    answer["body"] = json.dumps(source)
    assert path("minimum") == row.path


def test_native_date_padding_requires_the_reviewed_forms_typed_case_write_and_the_same_moment():
    from dataclasses import replace

    from proof.checks import android, served_datetimes

    original = "2026-01-15T10:30:00.123Z"
    stored = "2026-01-15T10:30:00.123000Z"
    xml = """<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
            xmlns:xsd="http://www.w3.org/2001/XMLSchema"><h:head><model>
            <instance><data xmlns="urn:visit"><seen/><nova_datetime_seen/></data></instance>
            <bind nodeset="/data/seen" type="xsd:dateTime"/>
            <bind nodeset="/data/nova_datetime_seen" type="xsd:string"
             calculate="if(/data/seen = '', '', format-date( coalesce( /data/seen, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))"/>
            </model></h:head><h:body/></h:html>"""
    field = {"question_path": "/data/nova_datetime_seen"}
    form = {"unique_id": "record", "actions": {"update_case": {"condition": {"type": "always"},
                                                              "update": {"seen_at": field}}}}
    app = {"modules": [{"case_type": "visit", "forms": [form]}], "_attachments": {"record.xml": xml}}
    case_types = {"visit": {"seen_at": "datetime", "other": "text"}}
    doc = SimpleNamespace(kind="corpus", hq_side=None, hq_authored=True, case_types=lambda: case_types)

    def device(value):
        case = {"id": "visit/1", "type": "visit", "name": "Home", "properties": {"seen_at": value, "other": "held"}}
        step = {"screen": "FormEntryActivity", "session": {"command": "m0-f0"}, "form": {"saved": {"cases": [case]}}}
        select = {"screen": "EntitySelectActivity", "session": {"command": "m0-f0", "datum": "case_id"},
                  "list": {"chose": "visit/1"}}
        return {"install": "Installed", "walks": {"one": {"steps": [select, step]}}}

    def android_classes(a, b):
        checked = android.app_differences(a, b, check="proof3", document="document", artifact="android@B")
        blobs = Blobs()
        parts = SimpleNamespace(a={"hooks": {"served": {"A": {"android": {"answer": blobs.put_json(a)}}}},
                                   "apiReads": {"authored": {"source": {"status": 200, "body": json.dumps(app)}}}},
                                b_aligned={"served": {"B": {"android": {"answer": blobs.put_json(b)}}}})
        records = SimpleNamespace(configurations={"minimum": parts}, blobs=blobs)
        places = served_places.sites(records, "minimum", checked, SimpleNamespace(a=None, b_aligned=None), {}, document=doc)
        return [(d.path, changes.locate(d, places) or None) for d in
                served_places.classify(doc, records, "minimum", checked, places)]

    a, b = device(original), device(stored)
    assert android_classes(a, b) == [(served_datetimes.CASES + ":stored-datetime", ("case", "visit", "seen_at"))]
    # Two forms can both write the same typed property on the same selected case. A switch of
    # form between builds must stay visible even when padding is the only change to the saved case.
    app["modules"][0]["forms"].append({**form, "unique_id": "other-form"})
    app["_attachments"]["other-form.xml"] = xml
    for step in b["walks"]["one"]["steps"]:
        step["session"]["command"] = "m0-f1"
    assert [(path, owner) for path, owner in android_classes(a, b)
            if path.startswith(served_datetimes.CASES)] == [(served_datetimes.CASES, None)]
    b = device(stored)
    # A change to any sibling, type, or instant must remain a whole-case difference.
    def case(answer):
        return answer["walks"]["one"]["steps"][1]["form"]["saved"]["cases"][0]

    case(b)["properties"]["other"] = "changed"
    assert android_classes(a, b) == [(served_datetimes.CASES, None)]
    b = device(stored)
    case(b)["type"] = "worker"
    assert android_classes(a, b) == [(served_datetimes.CASES, None)]
    for changed in ("2026-01-15T10:30:00.123001Z", "2026-01-15T10:31:00.123000Z", original):
        assert all(":stored-datetime" not in path for path, _ in android_classes(a, device(changed)))
    a, b = device(original), device(stored)
    for side in (a, b):
        side["walks"]["one"]["steps"][0]["list"]["chose"] = "another"
    assert android_classes(a, b) == [(served_datetimes.CASES, None)]
    a = device(original)
    app["_attachments"]["record.xml"] = xml.replace("xsd:dateTime", "xsd:string")
    assert android_classes(a, device(stored)) == [(served_datetimes.CASES, None)]
    app["_attachments"]["record.xml"] = xml

    source_answer = {"status": 200, "body": json.dumps(app)}
    records = SimpleNamespace(configurations={"minimum": SimpleNamespace(a={"apiReads": {"authored": {"source": source_answer}}})})
    path = served_datetimes.SUBMISSION + "case[*]/update[*]/*/text()"
    row = replace(_caption(), path=path, before=original, after=stored)
    def formplayer_class(slot, d=row):
        sites = changes.Sites(served={(d.artifact, d.at): ("form", "0.0", "xform", "data", "case", "update", slot)})
        return served_places.classify(doc, records, "minimum", [d], sites)[0].path

    assert formplayer_class("seen_at") == path + ":stored-datetime"
    assert formplayer_class("other") == path
    assert formplayer_class("seen_at", replace(row, after="2026-01-15T10:30:00.123001Z")) == path
    case_types["visit"]["seen_at"] = "text"
    assert formplayer_class("seen_at") == path
