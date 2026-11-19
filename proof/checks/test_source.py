"""The stored-app comparison reads HQ's two source answers the way HQ makes them, with no HQ.

Contract (``proof.checks.source.compare_sources``): a source read mints every
form's ``unique_id`` again (``Application.export_json`` → ``scrub_source``),
so two reads of one app compare by the menu and form position each id and
each reference names; a form link moved to another form is a difference at
its ``form_id``; a kept setting that changed is reported at its own pointer,
for no entry to absorb; ``last_modified``, which every save sets, is no
difference; and a held media path's map item that names another file is one
difference at ``/multimedia_map/*/held``. A calculated column's expression
that differs is reported at its ``field``, and any other column's ``field``
at the column's ``held``, so no row naming a calculation's respelling holds a
change of the property a column shows. No spelling rule is applied: a
difference a registered ``app.json`` rule erases where builds are compared
is still reported. The plausible failures: two reads' re-minted ids reported
as a change on every base, a link that moved hidden by that same allowance,
a kept key absorbed, a column's property changed under a calculation's
pointer, and a stored difference a rule erased unseen.
"""

from __future__ import annotations

from proof.checks.source import compare_sources


def _app(first, second, *, link_to, show="no", last_modified="2026-01-01", multimedia="m1"):
    return {
        "langs": ["en"],
        "last_modified": last_modified,
        "profile": {"properties": {"cc-show-saved": show}},
        "multimedia_map": {"jr://file/commcare/image/a.png": {"multimedia_id": multimedia, "unique_id": "u1"}},
        "modules": [
            {
                "name": {"en": "Households"},
                "forms": [
                    {"unique_id": first, "form_links": [{"form_id": link_to, "xpath": ""}]},
                    {"unique_id": second, "form_links": []},
                ],
            }
        ],
        "_attachments": {f"{first}.xml": _xform(), f"{second}.xml": _xform(title="Second")},
    }


def _xform(*, title="Visit", calculate="/data/age * 2", label="Age", label_id="age-label"):
    """A form as HQ's form builder writes one: a question whose label is an itext text and a Hidden Value."""
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
 xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="http://commcarehq.org/xforms/vellum">
<h:head><h:title>{title}</h:title>
<model><instance><data xmlns="http://openrosa.org/formdesigner/f1" uiVersion="1" version="1"><age/><double/></data>
</instance>
<bind nodeset="/data/age" type="xsd:int"/>
<bind nodeset="/data/double" calculate="{calculate}"/>
<itext><translation lang="en" default=""><text id="{label_id}"><value>{label}</value></text></translation></itext>
</model></h:head>
<h:body><input ref="/data/age"><label ref="jr:itext('{label_id}')"/></input></h:body></h:html>"""


HELD = frozenset({"jr://file/commcare/image/a.png"})


def test_two_reads_of_one_app_with_re_minted_ids_are_no_difference():
    a = _app("aaa", "bbb", link_to="bbb")
    b = _app("ccc", "ddd", link_to="ddd", last_modified="2026-02-02")
    assert compare_sources("doc", a, b, HELD) == []


def test_a_form_link_moved_to_another_form_is_reported_at_its_form_id():
    a = _app("aaa", "bbb", link_to="bbb")
    b = _app("ccc", "ddd", link_to="ccc")
    found = compare_sources("doc", a, b, HELD)
    assert [(d.path, d.at, d.before, d.after) for d in found] == [
        ("/modules/*/forms/*/form_links/*/form_id", "/modules/0/forms/0/form_links/0/form_id", "form:0.1", "form:0.0")
    ]


def test_a_changed_kept_key_is_reported_at_its_own_pointer():
    found = compare_sources("doc", _app("a", "b", link_to="b"), _app("c", "d", link_to="d", show="yes"), HELD)
    assert [(d.path, d.kind) for d in found] == [("/profile/properties/cc-show-saved", "changed")]


def test_a_changed_form_source_is_a_difference_at_each_part_it_changed_under_the_node_it_is_about():
    a = _app("a", "b", link_to="b")
    b = _app("c", "d", link_to="d")
    b["_attachments"]["c.xml"] = _xform(calculate="/data/age*2", label="Age in years")
    found = compare_sources("doc", a, b, HELD)
    assert [(d.path, d.at, d.kind, d.before, d.after) for d in found] == [
        (
            "/_attachments/*/data/*/:itext/label/*/default",
            "/_attachments/form:0.0.xml/data/age/:itext/label/en/default",
            "changed",
            "Age",
            "Age in years",
        ),
        (
            "/_attachments/*/data/*/:bind/@calculate",
            "/_attachments/form:0.0.xml/data/double/:bind/@calculate",
            "changed",
            "/data/age * 2",
            "/data/age*2",
        ),
    ]


def test_a_text_kept_under_another_id_is_no_difference_and_a_form_only_one_side_holds_is_one():
    a = _app("a", "b", link_to="b")
    b = _app("c", "d", link_to="d")
    b["_attachments"]["c.xml"] = _xform(label_id="age_question-label")
    assert compare_sources("doc", a, b, HELD) == []
    b["_attachments"]["e.xml"] = _xform()
    found = compare_sources("doc", a, b, HELD)
    assert [(d.path, d.at, d.kind) for d in found] == [("/_attachments/*", "/_attachments/e.xml", "added")]


def test_a_form_source_that_does_not_parse_is_refused_at_its_attachment():
    a = _app("a", "b", link_to="b")
    b = _app("c", "d", link_to="d")
    b["_attachments"]["c.xml"] = "<h:html>"
    found = compare_sources("doc", a, b, HELD)
    assert [(d.path, d.at, d.kind) for d in found] == [
        ("/_attachments/*/:not-well-formed", "/_attachments/form:0.0.xml/:not-well-formed", "refused")
    ]


def test_a_held_media_path_naming_another_file_is_reported_apart():
    found = compare_sources("doc", _app("a", "b", link_to="b"), _app("c", "d", link_to="d", multimedia="m2"), HELD)
    assert [(d.path, d.at) for d in found] == [
        ("/multimedia_map/*/held", "/multimedia_map/jr:~1~1file~1commcare~1image~1a.png/held/multimedia_id")
    ]
    # The same path held by no document of the app is an ordinary map difference.
    unheld = compare_sources(
        "doc", _app("a", "b", link_to="b"), _app("c", "d", link_to="d", multimedia="m2"), frozenset()
    )
    assert [d.path for d in unheld] == ["/multimedia_map/*/multimedia_id"]


def test_a_held_path_whose_built_resource_version_moved_is_reported():
    suite = '<suite><media path="../../commcare/image"><resource id="media-u1-a.png" version="{}"/></media></suite>'
    a = _app("a", "b", link_to="b")
    found = compare_sources(
        "doc", a, _app("c", "d", link_to="d"), HELD, (suite.format(3).encode(), suite.format(4).encode())
    )
    assert [(d.path, d.before, d.after) for d in found] == [("/multimedia_map/*/held", "3", "4")]


def _listed(first, second, columns):
    app = _app(first, second, link_to=second)
    app["modules"][0]["case_details"] = {"short": {"columns": columns}, "long": {"columns": []}}
    return app


def test_a_calculated_column_respelled_is_at_its_field_and_a_property_column_changed_is_held():
    calculated = {"field": 'cond(a = 1, "x", "y")', "useXpathExpression": True}
    shown = {"field": "name", "useXpathExpression": False}
    a = _listed("a", "b", [calculated, shown, {"field": "visits", "useXpathExpression": False}])
    b = _listed(
        "c",
        "d",
        [
            {"field": "if(a = 1, 'x', 'y')", "useXpathExpression": True},
            {"field": "case_name", "useXpathExpression": False},
            # A column calculated on one side alone shows something else, whatever its text.
            {"field": "visits", "useXpathExpression": True},
        ],
    )
    found = compare_sources("doc", a, b, HELD)
    assert sorted((d.path, d.at) for d in found) == [
        ("/modules/*/case_details/short/columns/*/field", "/modules/0/case_details/short/columns/0/field"),
        ("/modules/*/case_details/short/columns/*/held", "/modules/0/case_details/short/columns/1/held/field"),
        (
            "/modules/*/case_details/short/columns/*/useXpathExpression",
            "/modules/0/case_details/short/columns/2/useXpathExpression",
        ),
    ]
    # A column one side holds alone is an ordinary list difference.
    longer = _listed("c", "d", [calculated, shown, {"field": "visits", "useXpathExpression": False}, shown])
    assert [(d.path, d.kind) for d in compare_sources("doc", a, longer, HELD)] == [
        ("/modules/*/case_details/short/columns/*", "added")
    ]


def test_the_stored_app_is_compared_as_stored_with_no_spelling_rule():
    from proof.rules import normalized

    def stored(operator):
        app = _app("a", "b", link_to="b")
        app["modules"][0]["forms"][0]["actions"] = {
            "close_case": {"condition": {"type": "never", "question": None, "answer": None, "operator": operator}}
        }
        return app

    page, nova = stored(None), stored("=")
    # The registered rule condition-operator-default reads the two as one where builds are compared.
    assert normalized("app.json", page) == normalized("app.json", nova)
    found = compare_sources("doc", page, nova, HELD)
    assert [(d.path, d.before, d.after) for d in found] == [
        ("/modules/*/forms/*/actions/close_case/condition/operator", None, "=")
    ]
