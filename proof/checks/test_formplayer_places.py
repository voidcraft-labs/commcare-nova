"""A native observation's place must be the form and binding the trace actually carries."""

from proof.checks.differences import Difference
from proof.checks.formplayer_places import locations


def test_each_side_places_the_questions_and_xml_nodes_it_actually_holds():
    other = '<data xmlns="urn:two"><name>First</name><name>Second</name></data>'
    tree = [{"children": [{"binding": "/data/name", "caption": "Name", "caption_image": "icon"}]}]
    trace = {
        "runs": [
            {
                "steps": [
                    {"response": {"instanceXml": {"output": other}, "tree": tree}},
                    {"answers": [{"response": {"tree": tree}}], "submissions": [{"instance": other}]},
                ]
            }
        ]
    }
    base = "/runs/0/steps"
    paths = [
        f"{base}/0/response/tree/0/children/0/caption_image",
        f"{base}/1/tree/0/children/0/caption",
        f"{base}/1/submissions/0/instance/data/name[2]/text()",
        f"{base}/0/response/instanceXml/output/data/name[3]/text()",
        f"{base}/1/tree/0/caption_image",  # the containing group has no binding
    ]
    rows = [Difference("proof3", "doc", "formplayer@B", path, path, "changed", "a", "b") for path in paths]
    places = locations(rows, trace, {"urn:two": "1.2", "urn:one": "0.0"})
    field = ("form", "1.2", "xform", "data", "name")
    assert places == {
        ("formplayer@B", paths[0]): field,
        ("formplayer@B", paths[1]): (*field, ":itext"),
        ("formplayer@B", paths[2]): field,
    }
    assert locations(rows, trace, {"urn:two": None}) == {}
    trace["runs"][0]["steps"][0]["request"] = {"locale": "fra"}
    assert locations(rows, trace, {"urn:two": "1.2"})["formplayer@B", paths[1]] == (
        *field,
        ":itext",
        "label",
        "fra",
        "default",
    )
