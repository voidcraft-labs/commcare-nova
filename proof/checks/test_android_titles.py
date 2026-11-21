"""A native form title belongs to the XForm the session opened and to the record that form just saved."""

import json
from types import SimpleNamespace

import pytest

from proof.checks import android, android_titles, changes, served_places
from proof.observe.record import Blobs


def xform(namespace, title):
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
        <h:head><h:title>{title or ""}</h:title><model><instance><data xmlns="{namespace}"/></instance></model></h:head>
        <h:body/></h:html>"""


def source(old):
    forms = [{"unique_id": f"f{n}", "name": {"en": "Followup", "fr": "Suivi"}} for n in range(2)]
    return {
        "langs": ["en", "fr"],
        "modules": [{"forms": forms}],
        "_attachments": {f"f{n}.xml": xform(f"urn:form{n}", old) for n in range(2)},
    }


def files(title):
    resources = "".join(
        f'<xform><resource><location authority="local">./form-{n}.xml</location></resource></xform>' for n in range(2)
    )
    entries = "".join(f'<entry><form>urn:form{n}</form><command id="m0-f{n}"/></entry>' for n in range(2))
    return {
        "suite.xml": f"<suite>{resources}{entries}</suite>",
        **{f"form-{n}.xml": xform(f"urn:form{n}", title) for n in range(2)},
    }


def device(title):
    record = {
        "status": "unsent",
        android_titles.RECORD: "NAME" if title is None else title,
        "AndroidCommCarePlatform.getFormDefId": "held",
    }
    form = {
        android_titles.CONTROLLER: "null" if title is None else title,
        android_titles.DEFAULT: title,
        "FormEntryActivity.getHeaderString": "App > Visits",
        "title": "App > Visits",
        "loaded": True,
        "ended": "end",
        "finishShown": True,
        "saved": {"records": [record], "resultCode": -1, "finishing": True},
    }
    return {
        "install": "Installed",
        "walks": {
            "complete": {
                "steps": [
                    {"screen": "FormEntryActivity", "session": {"command": "m0-f0", "needed": None}, "form": form}
                ]
            }
        },
    }


def step(answer):
    return answer["walks"]["complete"]["steps"][0]


def judged(*, app, a, b, before, after, side="B", different=()):
    doc = SimpleNamespace(kind="corpus", hq_authored=True, hq_side=None)
    blobs = Blobs()
    authored = {"source": {"status": 200, "body": json.dumps(app)}}
    held = {"releaseDiffers": {"differing": list(different)}}
    if side == "B":
        held["android"] = {"answer": blobs.put_json(b)}
    else:
        held["androidDelivered"] = {"answer": blobs.put_json(b)}
    parts = SimpleNamespace(
        a={"apiReads": {"authored": authored}, "hooks": {"served": {"A": {"android": {"answer": blobs.put_json(a)}}}}},
        b_aligned={"served": {"B" if side == "B" else "local": held}},
    )
    records = SimpleNamespace(configurations={"minimum": parts}, blobs=blobs)
    observation = SimpleNamespace(
        a=SimpleNamespace(build=SimpleNamespace(files=before)), b_aligned=SimpleNamespace(files=after)
    )
    raw = android.app_differences(a, b, artifact=f"android@{side}", check="proof3", document="planted")
    places = served_places.sites(records, "minimum", raw, observation, after, document=doc)
    found = served_places.classify(doc, records, "minimum", raw, places)
    return {d.path.removeprefix(android_titles.FORM): changes.locate(d, places) for d in found}


@pytest.fixture
def original():
    return {
        "app": source(None),
        "a": device(None),
        "b": device("Followup"),
        "before": files(None),
        "after": files("Followup"),
    }


@pytest.mark.parametrize("side", ["B", "local.ccz"])
@pytest.mark.parametrize("old", [None, "Legacy\u00a0"])
def test_only_the_new_title_and_its_completed_save_name_belong_to_the_disclosed_form(old, side):
    b = device("Followup")
    # Reaching the form from a menu gives it a separate breadcrumb. A change there stays visible.
    step(b)["form"].update({"FormEntryActivity.getHeaderString": "Wrong menu", "title": "Wrong menu"})
    values = judged(app=source(old), a=device(old), b=b, before=files(old), after=files("Followup"), side=side)
    expected = {
        s + ":written-title": ("form", "0.0", "xform", "title")
        for s in (android_titles.CONTROLLER, android_titles.DEFAULT, android_titles.DISPLAY)
    }
    assert {s: place for s, place in values.items() if place} == expected
    assert {"FormEntryActivity.getHeaderString", "title"} <= values.keys()


@pytest.mark.parametrize(
    "change",
    [
        "other command",
        "source namespace",
        "before title",
        "after title",
        "different release",
        "swapped suite",
        "ambiguous resource",
        "duplicate command",
        "other language",
        "entry override",
    ],
)
def test_missing_or_wrong_attachment_resource_or_command_on_either_side_cannot_supply_a_title(original, change):
    if change == "other command":
        step(original["b"])["session"]["command"] = "m0-f1"  # same titles, different real form
    elif change == "source namespace":
        original["app"]["_attachments"]["f0.xml"] = xform("urn:form1", None)
    elif change == "before title":
        original["before"]["form-0.xml"] = xform("urn:form0", "Existing")
    elif change == "after title":
        original["after"]["form-0.xml"] = xform("urn:form0", "Other")
    elif change == "different release":
        original["different"] = ["form-0.xml"]
    elif change == "swapped suite":
        original["after"]["suite.xml"] = original["after"]["suite.xml"].replace("urn:form0", "urn:form1")
    elif change == "duplicate command":
        original["after"]["suite.xml"] = original["after"]["suite.xml"].replace(
            "</suite>", '<entry><command id="m0-f0"/></entry></suite>'
        )
    elif change == "ambiguous resource":
        original["after"]["form-1.xml"] = xform("urn:form0", "Followup")
    elif change == "entry override":
        original["app"]["translations"] = {"en": {"forms.m0f0": "Override"}}
    else:
        original["app"]["langs"] = ["fr", "en"]
    assert not any(":written-title" in path for path in judged(**original))


@pytest.mark.parametrize(
    "change", ["wrong display", "stale default", "another changed record", "interrupted", "absent form"]
)
def test_a_sibling_record_or_a_default_supplied_by_an_existing_save_cannot_borrow_the_title(original, change):
    f = step(original["a"])["form"]
    record = f["saved"]["records"][0]
    if change == "wrong display":
        record[android_titles.RECORD] = "Previous saved name"
    elif change == "stale default":
        f[android_titles.DEFAULT] = "Previously edited save"
        record[android_titles.RECORD] = "Previously edited save"
    elif change == "another changed record":
        f["saved"]["records"].append(dict(record))
    elif change == "interrupted":
        f["saved"]["resultCode"] = 0
    else:
        record["AndroidCommCarePlatform.getFormDefId"] = "none"
    paths = judged(**original)
    assert android_titles.DISPLAY in paths
    assert android_titles.DISPLAY + ":written-title" not in paths
    assert android_titles.CONTROLLER + ":written-title" in paths
    if change == "stale default":
        assert android_titles.DEFAULT in paths and android_titles.DEFAULT + ":written-title" not in paths


def test_controller_value_must_match_the_installed_title_even_if_its_default_and_record_agree(original):
    step(original["b"])["form"][android_titles.CONTROLLER] = "Wrong"
    assert not any(":written-title" in path for path in judged(**original))


@pytest.mark.parametrize(
    "title, expected",
    [
        ("", True),
        ("<h:title/><h:title>Ambiguous</h:title>", False),
        ("<h:title>Old<h:span>name</h:span></h:title>", False),
    ],
)
def test_a_missing_title_leaves_the_new_forms_title_null_but_ambiguous_titles_cannot_witness_it(
    original, title, expected
):
    app, before = original["app"], original["before"]
    for holder, key in ((app["_attachments"], "f0.xml"), (before, "form-0.xml")):
        holder[key] = holder[key].replace("<h:title></h:title>", title)
    # A second installed form with mixed title content still has its own identifiable namespace.
    before["form-1.xml"] = before["form-1.xml"].replace("<h:title></h:title>", "<h:title><h:span/></h:title>")
    witnessed = {p for p in judged(**original) if p.endswith(":written-title")}
    slots = {s + ":written-title" for s in (android_titles.CONTROLLER, android_titles.DEFAULT, android_titles.DISPLAY)}
    assert witnessed == (slots if expected else set())
