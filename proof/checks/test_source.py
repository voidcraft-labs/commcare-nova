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

A form's source is compared as its readers read it: no whitespace that only
stands between elements or that Core drops inside a text, attributes in name
order, the form builder's copy inside a text (an output's ``vellum:value``) a
part of its own, an order holding only what both forms hold, a translation in
a language the app does not hold one part, an itemset by its attributes and
references, and the form builder's escaped copies of an attribute as one class
however often it saved the form; and a language's strings only one app holds
are compared key by key. The plausible failures: a re-indented instance or a
dropped trailing space reported as a change, a label held by the class of a
shadow beside it, a question added reported again as its form's whole order,
a language no reader reads held by a row that also holds a listed language's
text, and a structural path that names how often a form was saved.
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
    b["_attachments"]["c.xml"] = _xform(calculate="/data/age * 3", label="Age in years")
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
            "/data/age * 3",
        ),
    ]
    # The same expression written another way is reported under the slot's respelling, apart from a change.
    b["_attachments"]["c.xml"] = _xform(calculate="(/data/age)*2.")
    assert [(d.path, d.at) for d in compare_sources("doc", a, b, HELD)] == [
        (
            "/_attachments/*/data/*/:bind/@calculate/:respelled",
            "/_attachments/form:0.0.xml/data/double/:bind/@calculate/:respelled",
        )
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


VELLUM = "http://commcarehq.org/xforms/vellum"


def _form(model="", body="", head="", itext=""):
    """A form with one question ``q`` and whatever ``model``, ``body``, ``head`` and ``itext`` add."""
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
 xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="{VELLUM}">
<h:head><h:title>F</h:title>{head}
<model><instance><data xmlns="http://openrosa.org/formdesigner/f1"><q/><r/></data></instance>{model}
<itext><translation lang="en" default="">{itext}</translation></itext>
</model></h:head>
<h:body>{body}</h:body></h:html>"""


def _parts(a, b, languages=None):
    from proof.checks import xform_parts

    return [(kind, path, at) for kind, at, path, _, _ in xform_parts.compare(a, b, languages)]


def test_whitespace_between_elements_and_attribute_order_are_no_difference_and_a_text_s_change_is():
    spaced = _form(model='\n\t<instance id="casedb" src="jr://instance/casedb" />\n\t')
    tight = _form(model='<instance src="jr://instance/casedb" id="casedb"/>')
    assert _parts(spaced, tight) == []
    # Core drops a run of a text that Java's trim leaves empty, and keeps any other.
    label = '<text id="q-label"><value>Hello <output value="/data/r"/>{}</value></text>'
    body = '<input ref="/data/q"><label ref="jr:itext(\'q-label\')"/></input>'
    trailing = _form(body=body, itext=label.format("\n\t"))
    bare = _form(body=body, itext=label.format(""))
    assert _parts(trailing, bare) == []
    worded = _form(body=body, itext=label.format("!"))
    assert _parts(bare, worded) == [("changed", "/data/*/:itext/label/*/default", "/data/q/:itext/label/en/default")]


def test_only_the_exact_singleton_session_count_guard_is_respelled_on_first_publish():
    path = "instance('commcaresession')/session/data/fingerprintquery"

    def form(condition, read, src="jr://instance/session"):
        return _form(model=(
            f'<instance id="commcaresession" src="{src}"/>'
            f'<bind nodeset="/data/q" calculate="if(count({path}) {condition}, number({read}), &apos;&apos;)"/>'
        ))

    before = form("= 1", path)
    after = form("= 1", f"{path}[1]")
    bind = "/data/*/:bind/@calculate"
    at = "/data/q/:bind/@calculate"
    assert _parts(before, after) == [("changed", bind + "/:respelled", at + "/:respelled")]
    assert _parts(form("= 2", path), form("= 2", f"{path}[1]")) == [("changed", bind, at)]
    assert _parts(before, form("= 1", f"{path}[2]")) == [("changed", bind, at)]
    other = "jr://fixture/item-list:counts"
    assert _parts(form("= 1", path, other), form("= 1", f"{path}[1]", other)) == [("changed", bind, at)]


def test_an_output_s_form_builder_copy_is_a_part_of_its_own_beside_the_text():
    body = '<input ref="/data/q"><label ref="jr:itext(\'q-label\')"/></input>'
    shadowed = _form(
        body=body, itext='<text id="q-label"><value>See <output value="/data/r" vellum:value="#form/r"/></value></text>'
    )
    plain = _form(body=body, itext='<text id="q-label"><value>See <output value="/data/r"/></value></text>')
    assert _parts(shadowed, plain) == [
        (
            "removed",
            "/data/*/:itext/label/*/default/output/*/@vellum:value",
            "/data/q/:itext/label/en/default/output/1/@vellum:value",
        )
    ]


def test_an_order_moves_only_where_what_both_forms_hold_moved():
    q, r = '<input ref="/data/q"/>', '<input ref="/data/r"/>'
    assert ("changed", "/:body/order()", "/:body/order()") not in _parts(_form(body=q), _form(body=q + r))
    assert ("added", "/data/*/:control", "/data/r/:control") in _parts(_form(body=q), _form(body=q + r))
    assert _parts(_form(body=q + r), _form(body=r + q)) == [("changed", "/:body/order()", "/:body/order()")]


def test_a_translation_in_a_language_the_app_does_not_hold_is_one_part():
    body = '<input ref="/data/q"><label ref="jr:itext(\'q-label\')"/></input>'
    text = '<text id="q-label"><value>Q</value></text>'
    other = '</translation><translation lang="hin">' + text
    both = _form(body=body, itext=text + other)
    one = _form(body=body, itext=text)
    assert _parts(both, one, ["en"]) == [("removed", "/:unlisted-translation/*", "/:unlisted-translation/hin")]
    # A language the app holds keeps its texts at what reads them.
    assert _parts(both, one, ["en", "hin"]) == [
        ("removed", "/data/*/:itext/label/*/default", "/data/q/:itext/label/hin/default")
    ]


def test_an_itemset_is_compared_by_its_attributes_and_references():
    itemset = '<select1 ref="/data/q"><itemset nodeset="{}"><label ref="{}"/><value ref="id"/></itemset></select1>'
    declared = '<instance id="{}" src="jr://fixture/item-list:t"/>'
    a = _form(model=declared.format("item-list:t"), body=itemset.format("instance('item-list:t')/t_list/t", "name"))
    b = _form(model=declared.format("t"), body=itemset.format("instance('t')/t_list/t", "title"))
    # The rows read under the id each form declares for one source are one expression; the label is another.
    assert _parts(a, b) == [
        ("removed", "/:instance/*", "/:instance/item-list:t"),
        ("added", "/:instance/*", "/:instance/t"),
        (
            "changed",
            "/data/*/:control/itemset/@nodeset/:respelled",
            "/data/q/:control/itemset/@nodeset/:respelled",
        ),
        ("changed", "/data/*/:control/itemset/label/@ref", "/data/q/:control/itemset/label/@ref"),
    ]
    other = _form(model=declared.format("t"), body=itemset.format("instance('t')/t_list/t[x = 1]", "name"))
    assert ("changed", "/data/*/:control/itemset/@nodeset", "/data/q/:control/itemset/@nodeset") in _parts(a, other)
    # A row's label read written another way is the same read: a respelling, as a nodeset's is.
    quoted = _form(model=declared.format("t"), body=itemset.format("instance('t')/t_list/t", 'name[@lang=&quot;en&quot;][1]'))
    spaced = _form(model=declared.format("t"), body=itemset.format("instance('t')/t_list/t", "name[@lang = 'en'][1]"))
    assert _parts(quoted, spaced) == [
        ("changed", "/data/*/:control/itemset/label/@ref/:respelled", "/data/q/:control/itemset/label/@ref/:respelled"),
    ]


def test_the_form_builder_s_escaped_copies_are_one_class_however_often_it_saved():
    saved = _form(model='<bind nodeset="/data/q" vellum:vellum__required="a" vellum:vellum__vellum__required="b"/>')
    assert sorted(_parts(saved, _form())) == [
        ("removed", "/data/*/:bind/@vellum:vellum__*", "/data/q/:bind/@vellum:vellum__required"),
        ("removed", "/data/*/:bind/@vellum:vellum__*", "/data/q/:bind/@vellum:vellum__vellum__required"),
    ]


def test_a_language_s_strings_only_one_app_holds_are_compared_key_by_key():
    a = _app("a", "b", link_to="b")
    b = _app("c", "d", link_to="d")
    a["translations"] = {"en": {"forms.m0f0": "Visit", "modules.m0": "Homes"}}
    b["translations"] = {}
    found = compare_sources("doc", a, b, HELD)
    assert [(d.path, d.at, d.kind) for d in found] == [
        ("/translations/*/forms.m0f0", "/translations/en/forms.m0f0", "removed"),
        ("/translations/*/modules.m0", "/translations/en/modules.m0", "removed"),
    ]


def test_a_string_type_added_where_every_reader_reads_the_node_as_text_is_apart_from_any_other_type_change():
    # Contract: only `xsd:string` added to a select's or an unasked node's bind is the implied string; the plausible
    # failure is a date read as text, or a type dropped, held as a re-spelling on every base made in HQ.
    select = '<select1 ref="/data/q"><item><label>A</label><value>a</value></item></select1>'
    typed = '<bind nodeset="/data/q" type="{}"/><bind nodeset="/data/r" type="{}"/>'
    untyped = '<bind nodeset="/data/q"/><bind nodeset="/data/r"/>'
    implied = "/data/*/:bind/@type/:implied-string"
    a = _form(model=untyped, body=select)
    b = _form(model=typed.format("xsd:string", "xsd:string"), body=select)
    assert _parts(a, b) == [
        ("added", implied, "/data/q/:bind/@type/:implied-string"),
        ("added", implied, "/data/r/:bind/@type/:implied-string"),
    ]
    # Another type added, a type dropped or changed, and a string added to an input stay at `@type`.
    dated = _form(model=typed.format("xsd:date", "xsd:int"), body=select)
    assert _parts(a, dated) == [
        ("added", "/data/*/:bind/@type", "/data/q/:bind/@type"),
        ("added", "/data/*/:bind/@type", "/data/r/:bind/@type"),
    ]
    assert ("removed", "/data/*/:bind/@type", "/data/q/:bind/@type") in _parts(b, a)
    assert ("changed", "/data/*/:bind/@type", "/data/q/:bind/@type") in _parts(dated, b)
    # A node only the after form holds is a change of its own, bind and all.
    added = _form(model='<bind nodeset="/data/s" type="xsd:string"/>').replace("<r/>", "<r/><s/>")
    assert ("added", "/data/*/:bind/@type", "/data/s/:bind/@type") in _parts(_form(), added)
    text = '<input ref="/data/q"/>'
    assert ("added", "/data/*/:bind/@type", "/data/q/:bind/@type") in _parts(
        _form(model=untyped, body=text), _form(model=typed.format("xsd:string", "xsd:string"), body=text)
    )


def test_a_row_filter_reading_current_is_no_respelling_of_one_reading_every_entry():
    # Contract: inside a row predicate, `/data/visits/case_ref` (every entry's answer) and `current()/../case_ref`
    # (this entry's) are two expressions, so the slot stays at `@calculate`, where row-predicate-current's place
    # stands; the plausible failure is that change held by the change that stands everywhere.
    calculate = "instance('casedb')/casedb/case[@case_id = {}]/case_name"
    form = (
        '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><h:title>F'
        "</h:title><model><instance><data><visits><case_ref/><total/></visits></data></instance>"
        '<instance id="casedb" src="jr://instance/casedb"/>'
        '<bind nodeset="/data/visits/total" calculate="{}"/></model></h:head><h:body/></h:html>'
    )
    a = form.format(calculate.format("/data/visits/case_ref"))
    b = form.format(calculate.format("current()/../case_ref"))
    assert _parts(a, b) == [("changed", "/data/*/:bind/@calculate", "/data/visits/total/:bind/@calculate")]


def test_only_a_single_declared_fixture_ordinal_is_its_explicit_position_spelling():
    itemset = '<select1 ref="/data/q"><itemset nodeset="{}"><label ref="name"/><value ref="id"/></itemset></select1>'

    def form(expression, source="jr://fixture/item-list:villages", *, control=None):
        return _form(
            model=f'<instance id="rows" src="{source}"/>',
            body=(control or itemset).format(expression),
        )

    path = "instance('rows')/villages_list/villages"
    before = form(path + "[2]")
    after = form(path + "[position() = 2]")
    at = "/data/q/:control/itemset/@nodeset"
    pattern = "/data/*/:control/itemset/@nodeset"
    assert _parts(before, after) == [("changed", pattern + "/:respelled", at + "/:respelled")]

    fractional = form(path + "[2.5]")
    assert _parts(fractional, after) == [("changed", pattern + "/:respelled", at + "/:respelled")]
    assert _parts(fractional, form(path + "[position() = 2.5]")) == [("changed", pattern, at)]
    for expression in ("[0]", "[2.0]", "[0.5]", "[(2)]", "[(2.5)]", "[-2]", "[2147483648]", "[last() - 1]", "[name != ''][2]"):
        assert _parts(form(path + expression), after) == [("changed", pattern, at)]
    assert _parts(before, form(path + "[position() = 1]")) == [("changed", pattern, at)]
    assert _parts(before, form(path + "[position() = 2][name != '']")) == [("changed", pattern, at)]
    cases = "jr://instance/casedb"
    assert _parts(form(path + "[2]", cases), form(path + "[position() = 2]", cases)) == [("changed", pattern, at)]
    value = itemset.replace('nodeset="{}"', f'nodeset="{path}"').replace('ref="id"', 'ref="{}"')
    assert _parts(
        form(path + "[2]", control=value), form(path + "[position() = 2]", control=value),
    ) == [("changed", "/data/*/:control/itemset/value/@ref", "/data/q/:control/itemset/value/@ref")]
