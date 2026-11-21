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
                    {
                        "answers": [{"response": {"tree": tree}}],
                        "submissions": [{"instance": other}],
                    },
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


def test_subcase_name_follows_the_same_bound_question_on_each_installed_form():
    from proof.checks import changes, formplayer_case_names

    case_ns = "http://commcarehq.org/case/transaction/v2"
    file = "modules-0/forms-2.xml"
    ns = {"urn:form": "0.2"}
    owner = ("form", "0.2", "xform", "data", "first_member")
    at = "/runs/0/steps/0/submissions/0/instance/data/subcase_0[1]/case[1]/create[1]/case_name[1]/text()"
    shape = formplayer_case_names.SUBMISSION + "subcase_*[*]/" + formplayer_case_names.CREATE
    original, trimmed = "  proof  ", "proof"
    change = Difference("proof3", "sample", "formplayer@B", shape, at, "changed", original, trimmed)
    key = (change.artifact, at)
    case_path = "/data/subcase_0/case/create/case_name"

    def witness(
        *,
        before,
        field="first_member",
        bound_case=case_path,
        captured=original,
        duplicate="",
        differing=(),
    ):
        calculation = f"/data/{field}" if before else f"/data/nova_trimmed_{field}"
        form = rf'''<html><model xmlns="http://www.w3.org/2002/xforms">
          <instance><data xmlns="urn:form"/></instance>
          <bind nodeset="{bound_case}" calculate="{calculation}"/>
          <bind nodeset="/data/nova_trimmed_{field}"
                calculate="replace(/data/{field}, '^[\x00-\x20]+|[\x00-\x20]+$', '')"/>
        </model></html>'''
        name = original if before else trimmed
        xml = f'''<data xmlns="urn:form"><first_member>{captured}</first_member>{duplicate}
          <head_name>{original}</head_name>
          <nova_trimmed_{field}>{trimmed}</nova_trimmed_{field}>
          <subcase_0><case xmlns="{case_ns}"><create><case_name>{name}</case_name></create></case></subcase_0></data>'''
        trace = {"runs": [{"steps": [{"answers": [], "submissions": [{"instance": xml}]}]}]}
        return locations([change], trace, ns, files={file: form}, differing=differing, before=before)

    old, new = witness(before=True), witness(before=False)
    assert old == new == {key: owner}
    wrong_question = witness(before=False, field="head_name")
    assert changes.merged_sites(changes.Sites(served=old), changes.Sites(served=wrong_question)).served[key] is None
    assert witness(before=False, bound_case="/data/case/create/case_name") == {}
    assert witness(before=False, captured="another answer") == {}
    assert witness(before=False, duplicate="<first_member>another answer</first_member>") == {}
    assert witness(before=True, differing=[file]) == {}
