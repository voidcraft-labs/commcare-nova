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
