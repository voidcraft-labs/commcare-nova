"""The value classes the manifest check reads of each use (``proof.checks.manifest_value_classes``).

Contract: where inventory entries split a surface key by value (one entry per
value class, plan decision 6), the check places each use of the key in the
class its value is in, read from where the use sits in the parsed export, by
the rule the entry's row states and the reader that row names (Core's parser,
Vellum's, HQ's build and search, Android's widgets). The plausible failures: a
reader that places every use outside its REFUSED class, so the check passes
what Nova's own reader refuses (the checker's doubt this exists for); one that
places every use inside it, so one export's real use is reported as refused;
one that reads a neighbouring object instead of the one the use sits in (a
form's other action, a detail's other column), so a use is refused for what
another holds; and a registry whose ids drift from the entries', so a reader
silently stops being consulted.

Every reader the registry holds has its shapes in ``SHAPES``, by its entry's
id, and the registry and the table must name the same ids: a refused shape
(the reader says True) and an accepted one beside it (False), each a use of a
key the entry names, found by the check's own extraction in an export as HQ,
Vellum and Nova write it, and each also standing as the check places it (the
refused one refused, or the source's in a local archive, resting on the entry;
the accepted one resting elsewhere). A class the export cannot settle has the
shape it leaves open (None) in place of a refused one, and a class that takes
every use of its keys has no accepted one, each named with why; a class the
check never consults its reader on (an entry naming a key its uses never have)
is named too (``UNCONSULTED``), so the gap stays visible until the inventory's
keys close it. The shapes that need what HQ's and Core's readers read (a parse,
the strings a search sends, a calculate's structure, what a media file is) are
read with the observation's own readings of the same artifacts, once. The tests
before the table pin finer points of single readers (the setvalues HQ's build
writes, a count read on the repeat and its group alike, a calculate's reads
from its own node, each side of a CSQL comparison).
"""

from __future__ import annotations

import json
import struct
import zlib
from copy import deepcopy
from dataclasses import dataclass, replace
from xml.sax.saxutils import escape, quoteattr

import pytest
from lxml import etree

from proof.checks import manifest_usage
from proof.checks import manifest_value_classes as classes
from proof.observe import manifest as observed_manifest


@pytest.fixture(scope="module")
def manifest():
    return manifest_usage.load_manifest()


def test_every_reader_reads_a_refused_entry_that_names_a_value_class(manifest):
    """The registry is keyed by the entries' ids: each id is a REFUSED inventory entry with a value class (an
    allowing class is the rest of its key's values, never read), so a renamed or removed entry fails here
    rather than leaving its reader unread."""
    entries = {entry.id: entry for held in manifest.entries.values() for entry in held}
    assert sorted(set(classes.VALUE_CLASSES) - set(entries)) == []
    assert [key for key in classes.VALUE_CLASSES if entries[key].value_class is None] == []
    assert [key for key in classes.VALUE_CLASSES if entries[key].disposition != "REFUSED"] == []
    # A REFUSED entry refused only because HQ's build refuses its state is the bar's, and needs no reader.
    assert [key for key in classes.VALUE_CLASSES if entries[key].refused_by_hq_build()] == []


FORM = """<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml"
 xmlns:jr="http://openrosa.org/javarosa" xmlns:xsd="http://www.w3.org/2001/XMLSchema"
 xmlns:vellum="http://commcarehq.org/xforms/vellum" xmlns:odkx="http://opendatakit.org/xforms"
 xmlns:x="http://example.org/elsewhere">
 <h:head><h:title>T</h:title><model>
  <instance><data xmlns="http://example.org/t" name="T">{data}</data></instance>
  <instance id="casedb" src="jr://instance/casedb"/>
  <instance id="commcaresession" src="jr://instance/session"/>
  {model}
 </model>{head}</h:head>
 <h:body>{body}</h:body></h:html>"""


def _form(data="", model="", body="", head=""):
    return FORM.format(data=data, model=model, body=body, head=head).encode()


def _protected_form(
    control="input", languages=("en", "es"), pieces=(1, 4), nested=False, collision=False, media=False, typed=True
):
    """Independent wire shapes for the classifier, read by the observation's real Core/HQ parsers.

    Noncontiguous ordinals, a blank localized piece, nested paths, every media mode and a case predicate
    distinguish this class from an observed fixture or a simple-path-only approximation. No Nova emitter
    or private consumer artifact supplies these bytes.
    """
    parent = "/data/items/item" if nested else "/data"
    source, carrier = f"{parent}/q", f"{parent}/nova_constraint_message_q{'_2' if collision else ''}"
    base = "items-q-constraintMsg" if nested else "q-constraintMsg"
    reference = (
        "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id and "
        "starts-with(name, /data/other)]/name"
    )
    terms = [f"json-property(jr:itext('{base};__nova_piece_{index}'), 'v')" for index in pieces]
    composition = f"if(count({reference}) > 1, '', concat({', '.join([*terms, reference])}))"
    if not pieces:
        composition = f"if(count({reference}) > 1, '', {reference})"
    if not typed:
        composition = terms[0] if len(terms) == 1 else f"concat({', '.join(terms)})"
    for language in reversed(languages[:-1]):
        composition = f"if(jr:itext('{base};__nova_locale') = '{language}', {composition}, '')"
    message = f"if(jr:itext('{base};__nova_mode') = 'media', jr:itext('{base}'), {composition})"
    translations = []
    for index, language in enumerate(languages):
        helpers = {
            "__nova_identity": base,
            "__nova_mode": "plain",
            "__nova_mode;markdown": "plain",
            "__nova_locale": language,
            "__nova_locale;markdown": language,
        }
        helpers.update({f"__nova_mode;{name}": "media" for name in ("image", "audio", "video", "video-inline")})
        for piece in pieces:
            literal = "" if index else "Literal ${not-an-expression} café"
            payload = json.dumps({"v": literal}, ensure_ascii=True).replace("$", "\\u0024")
            helpers[f"__nova_piece_{piece}"] = payload
            helpers[f"__nova_piece_{piece};markdown"] = payload
        values = "<value>Message</value><value form='markdown'>Message</value>"
        if media:
            values += "".join(
                f"<value form='{name}'>jr://file/{name}.bin</value>"
                for name in ("image", "audio", "video", "video-inline")
            )
        values += "".join(f"<value form={quoteattr(name)}>{escape(value)}</value>" for name, value in helpers.items())
        default = ' default=""' if index == 0 else ""
        translations.append(
            f"<translation lang={quoteattr(language)}{default}><text id={quoteattr(base)}>{values}</text></translation>"
        )
    data = f"<q/><{carrier.rsplit('/', 1)[-1]}/>"
    if nested:
        data = f'<items><item jr:template="">{data}</item></items>'
    model = (
        f"""<bind nodeset={quoteattr(source)} type="xsd:string" constraint=". != ''" """
        f"""jr:constraintMsg={quoteattr(message)}/>\n"""
        f"""      <bind nodeset={quoteattr(carrier)} type="xsd:string" relevant="false()" readonly="true()"/>\n"""
        f"""      <itext>{"".join(translations)}</itext>"""
    )
    extra = " mediatype='image/*'" if control == "upload" else ""
    choices = "<item><label>A</label><value>a</value></item>" if control in ("select", "select1") else ""
    body = f"<{control} ref={quoteattr(source)}{extra}><label>Q</label>{choices}</{control}>"
    label_ref = f'jr:itext("{base}")'
    body += f"<input ref={quoteattr(carrier)}><label ref={quoteattr(label_ref)}/></input>"
    if nested:
        body = f"<group><repeat nodeset='{parent}'>{body}</repeat></group>"
    return _form(data=data + "<other/>", model=model, body=body)


def _uses(xml, manifest, key, artifact="form:0.0", readings=None):
    found = manifest_usage.Uses()
    manifest_usage.xform_uses(xml, manifest, artifact, found)
    if readings is not None:
        manifest_usage.read_observed(found, manifest, readings)
    return [use for use in found.uses if use.key == key]


def _read(reader, uses, manifest):
    return {use.where: reader(use, manifest) for use in uses}


def _protected_cases():
    accepted_cases = {name: _protected_form(control=name) for name in sorted(classes.QUESTION_CONTROLS)}
    accepted_cases.update(
        {
            "one-locale": _protected_form(languages=("en",)),
            "no-literal-pieces": _protected_form(pieces=()),
            "literal-only": _protected_form(pieces=(2,), typed=False),
            "sparse-piece-ordinals": _protected_form(pieces=(0, 2, 8)),
            "nested-collision": _protected_form(nested=True, collision=True),
            "media-and-blank-localized-pieces": _protected_form(languages=("en", "fr", "es"), media=True),
        }
    )
    refused_cases = {}
    for name in (
        "custom-form",
        "unknown-helper",
        "unknown-mode-suffix",
        "unowned-group",
        "wrong-owner-label",
        "wrong-identity",
        "wrong-mode",
        "invalid-json",
        "missing-piece-markdown",
        "raw-message",
        "unowned-computed-message",
        "without-constraint",
        "calculated-carrier",
        "nonempty-carrier",
    ):
        root = etree.fromstring(_protected_form())
        model = root.find(f"{{{classes.XHTML}}}head/{{{classes.XFORMS}}}model")
        binds = model.findall(f"{{{classes.XFORMS}}}bind")
        text = model.find(f"{{{classes.XFORMS}}}itext/{{{classes.XFORMS}}}translation/{{{classes.XFORMS}}}text")
        values = {value.get("form"): value for value in text}
        if name in ("custom-form", "unknown-helper", "unknown-mode-suffix"):
            extra = deepcopy(values["__nova_mode"])
            extra.set(
                "form",
                {
                    "custom-form": "custom",
                    "unknown-helper": "__nova_unfamiliar",
                    "unknown-mode-suffix": "__nova_mode;tts",
                }[name],
            )
            text.append(extra)
        elif name == "unowned-group":
            other = deepcopy(text)
            other.set("id", "unowned")
            text.getparent().append(other)
        elif name == "wrong-owner-label":
            label = root.find(f"{{{classes.XHTML}}}body/{{{classes.XFORMS}}}input[2]/{{{classes.XFORMS}}}label")
            label.set("ref", "jr:itext('unowned')")
        elif name == "wrong-identity":
            values["__nova_identity"].text = "unowned"
        elif name == "wrong-mode":
            values["__nova_mode;image"].text = "plain"
        elif name == "invalid-json":
            values["__nova_piece_1"].text = '{"other": "text"}'
        elif name == "missing-piece-markdown":
            text.remove(values["__nova_piece_1;markdown"])
        elif name == "raw-message":
            binds[0].set(f"{{{classes.JAVAROSA}}}constraintMsg", "Literal raw warning")
        elif name == "unowned-computed-message":
            binds[0].set(f"{{{classes.JAVAROSA}}}constraintMsg", "concat('raw ', /data/other)")
        elif name == "without-constraint":
            del binds[0].attrib["constraint"]
        elif name == "calculated-carrier":
            binds[1].set("calculate", "'authored'")
        elif name == "nonempty-carrier":
            node = model.find(f"{{{classes.XFORMS}}}instance")[0][1]
            node.text = "authored"
        refused_cases[name] = etree.tostring(root)
    return accepted_cases, refused_cases


@pytest.fixture(scope="module")
def protected_cases(hq, core_runner):
    accepted_cases, refused_cases = _protected_cases()
    authored_readonly = etree.fromstring(accepted_cases["input"])
    bind = authored_readonly.find(f"{{{classes.XHTML}}}head/{{{classes.XFORMS}}}model/{{{classes.XFORMS}}}bind")
    bind.set("readonly", "true()")
    table = observed_manifest.readings(
        core_runner, forms=[*accepted_cases.values(), *refused_cases.values(), etree.tostring(authored_readonly)]
    )
    return accepted_cases, refused_cases, manifest_usage.Readings.of(table)


def _protected_uses(xml, manifest, readings):
    found = manifest_usage.Uses()
    manifest_usage.xform_uses(xml, manifest, "form:0.0", found)
    manifest_usage.read_observed(found, manifest, readings)
    return found


def test_protected_messages_use_their_owned_forms_and_the_recorded_expression_grammar(manifest, protected_cases):
    accepted_cases, _, readings = protected_cases
    for name, xml in accepted_cases.items():
        found = _protected_uses(xml, manifest, readings)
        assert not [use.key for use in found.uses if use.key.startswith("itext-form:*/")], name
        message = next(use for use in found.uses if use.key == "xform:model/bind@jr:constraintMsg")
        readonly = next(use for use in found.uses if use.key == "xform:model/bind@readonly")
        assert classes.literal_validation_message(message, manifest) is False, name
        assert classes.authored_readonly(readonly, manifest) is False, name
        assert manifest_usage.standing(manifest, message)[0] == manifest_usage.HELD, name
        assert manifest_usage.standing(manifest, readonly)[0] == manifest_usage.HELD, name
        grammar = {use.key for use in found.uses if use.where == message.where}
        assert {"jr-handler:jr:itext", "jr-fn:if"} <= grammar, name
        if name != "literal-only":
            assert {"jr-fn:count", "jr-fn:starts-with"} <= grammar, name
        assert any(key.startswith("xpath-expr:") for key in grammar), name
        if name != "literal-only":
            assert any(key.startswith("xpath-axis:") for key in grammar), name
        if name != "no-literal-pieces":
            assert "jr-fn:json-property" in grammar, name


def test_custom_forms_and_unowned_messages_keep_their_manifest_refusals(manifest, protected_cases):
    _, refused_cases, readings = protected_cases
    for name, xml in refused_cases.items():
        found = _protected_uses(xml, manifest, readings)
        unknown = [use for use in found.uses if use.key.startswith("itext-form:*/")]
        assert unknown, name
        assert all(manifest_usage.standing(manifest, use)[0] == manifest_usage.UNNAMED for use in unknown), name
        message = next(use for use in found.uses if use.key == "xform:model/bind@jr:constraintMsg")
        readonly = next(use for use in found.uses if use.key == "xform:model/bind@readonly")
        # Identical helper names on a different group must remain unknown even beside a valid graph.
        if name == "unowned-group":
            assert all(use.at.element.getparent().get("id") == "unowned" for use in unknown)
            assert classes.literal_validation_message(message, manifest) is False
            assert classes.authored_readonly(readonly, manifest) is False
        else:
            assert classes.literal_validation_message(message, manifest) is True, name
            assert classes.authored_readonly(readonly, manifest) is True, name
            assert "jr-fn:json-property" not in {use.key for use in found.uses}, name


def test_a_protected_carrier_does_not_classify_the_authored_questions_readonly(manifest, protected_cases):
    accepted_cases, _, readings = protected_cases
    root = etree.fromstring(accepted_cases["input"])
    bind = root.find(f"{{{classes.XHTML}}}head/{{{classes.XFORMS}}}model/{{{classes.XFORMS}}}bind")
    bind.set("readonly", "true()")
    found = _protected_uses(etree.tostring(root), manifest, readings)
    readonly = [use for use in found.uses if use.key == "xform:model/bind@readonly"]
    assert [classes.authored_readonly(use, manifest) for use in readonly] == [True, False]


def test_protected_ownership_requires_the_recorded_core_parse_and_hq_structure(manifest, protected_cases):
    accepted_cases, _, readings = protected_cases
    xml = accepted_cases["input"]
    source = _protected_uses(xml, manifest, readings)
    message = next(use for use in source.uses if use.key == "xform:model/bind@jr:constraintMsg")
    text = message.at.element.get(f"{{{classes.JAVAROSA}}}constraintMsg")
    for incomplete in (
        replace(readings, expressions={key: value for key, value in readings.expressions.items() if key != text}),
        replace(readings, trees={key: value for key, value in readings.trees.items() if key != text}),
    ):
        found = _protected_uses(xml, manifest, incomplete)
        assert any(use.key.startswith("itext-form:*/") for use in found.uses)
        message = next(use for use in found.uses if use.key == "xform:model/bind@jr:constraintMsg")
        assert classes.literal_validation_message(message, manifest) is not False
    found = manifest_usage.Uses()
    manifest_usage.xform_uses(xml, manifest, "form:0.0", found)
    readonly = next(use for use in found.uses if use.key == "xform:model/bind@readonly")
    assert classes.authored_readonly(readonly, manifest) is None


def test_a_refused_class_names_novas_scaffolding_apart_from_the_ids_a_person_authors(manifest):
    """Nova's scaffolding nodes and the ids a person authors are two defects' symptoms in one REFUSED class
    (13 and 15), so the check names a scaffolding node's part of the class by its name, its minted part ``*``,
    and an authored id's by the class alone. The plausible failure: one path for both, so a fix of either
    leaves the other's register entry holding it."""
    xml = _form(
        data="<__nova_operations><__nova_guard_1f2e_text><x/></__nova_guard_1f2e_text></__nova_operations><_notes/>",
        model='<bind nodeset="/data/__nova_operations/__nova_guard_1f2e_text" calculate="1"/>',
    )
    found = manifest_usage.Uses()
    manifest_usage.xform_uses(xml, manifest, "form:0.0", found)
    paths = {
        (use.where.rsplit("}", 1)[-1], path)
        for use in found.uses
        for difference in manifest_usage.unclassified("d", [use], manifest)
        for path in [difference.path]
        if "/refused/" in path
    }
    assert (
        "__nova_operations[1]",
        "/xform:model~1instance~1*~1*/refused/invalid-question-id/__nova_operations",
    ) in paths
    assert ("_notes[1]", "/xform:model~1instance~1*~1*/refused/invalid-question-id") in paths
    assert (
        "__nova_guard_1f2e_text[1]",
        "/xform:model~1instance~1~1*/refused/hidden-value-with-children/__nova_guard_*",
    ) in paths


def test_types_vellum_drops_or_rewrites_on_selects_secrets_and_savetocase_leaves(manifest):
    xml = _form(
        data="<choice/><word/><pin/><op><case xmlns='http://commcarehq.org/case/transaction/v2' case_id=''"
        " date_modified='' user_id=''><update><when/></update></case></op>".replace(
            "<op>", '<op vellum:role="SaveToCase">'
        ),
        model="""<bind nodeset="/data/choice" type="xsd:int"/><bind nodeset="/data/word" type="xsd:string"/>
          <bind nodeset="/data/pin" type="xsd:int"/>
          <bind nodeset="/data/op/case/update/when" type="xsd:dateTime" calculate="now()"/>
          <bind nodeset="/data/op/case/@date_modified" type="xsd:dateTime" calculate="now()"/>""",
        body="""<select1 ref="/data/choice"><item><value>a</value></item></select1>
          <select1 ref="/data/word"><item><value>a</value></item></select1><secret ref="/data/pin"/>""",
    )
    binds = {
        use.where.rsplit("/", 2)[-2]: use
        for use in _uses(xml, manifest, "jr-type:int")
        + _uses(xml, manifest, "jr-type:string")
        + _uses(xml, manifest, "jr-type:dateTime")
    }

    def verdicts(reader):
        return {where: reader(use, manifest) for where, use in sorted(binds.items())}

    assert verdicts(classes.non_choice_type_on_select) == {
        "bind[1]": True,  # xsd:int on a select1: Vellum drops it
        "bind[2]": False,  # a string on a select1 is Vellum's own
        "bind[3]": False,  # not a select
        "bind[4]": False,
        "bind[5]": False,
    }
    assert verdicts(classes.numeric_type_on_secret)["bind[3]"] is True
    assert verdicts(classes.numeric_type_on_secret)["bind[1]"] is False
    leaf = verdicts(classes.savetocase_leaf_type)
    # A type on an update leaf is dropped; the @date_modified Vellum types itself is no leaf.
    assert (leaf["bind[4]"], leaf["bind[5]"], leaf["bind[1]"]) == (True, False, False)


def test_an_inputs_type_and_appearance_as_vellum_reads_them(manifest):
    xml = _form(
        data="<a/><b/><c/><d/><e/><f/><g/>",
        model="""<bind nodeset="/data/a" type="xsd:decimal"/><bind nodeset="/data/b" type="xsd:Int"/>
          <bind nodeset="/data/c" type="int"/><bind nodeset="/data/d" type="xsd:long"/>
          <bind nodeset="/data/f" type="xsd:string"/>""",
        body="""<input ref="/data/a"/><input ref="/data/b"/><input ref="/data/c"/><input ref="/data/d"/>
          <input ref="/data/e" appearance="Numbers"/><input ref="/data/f" appearance="numeric"/>
          <input ref="/data/g" readonly="true()"/>""",
    )
    inputs = {use.where.rsplit("/", 1)[-1]: use for use in _uses(xml, manifest, "jr-control:input")}
    order = sorted(inputs)

    def verdicts(reader):
        return [reader(inputs[where], manifest) for where in order]

    # Vellum writes xsd:string for a type it does not know, and xsd:int for xsd:Int, which Core reads apart
    # (its type names are case-sensitive); "int" without its prefix is the same state as xsd:int.
    assert verdicts(classes.type_vellum_does_not_write) == [True, True, False, False, False, False, False]
    assert verdicts(classes.long_input) == [False, False, False, True, False, False, False]
    # Untyped with Numbers as the whole appearance; a typed one with numeric is Vellum's phone number.
    assert verdicts(
        classes.VALUE_CLASSES["questions/an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring"]
    ) == [
        False,
        False,
        False,
        False,
        True,
        False,
        False,
    ]
    assert verdicts(classes.readonly_input) == [False] * 6 + [True]


def test_setvalues_vellum_keeps_as_defaults_its_plugins_take_and_the_rest(manifest):
    xml = _form(
        data="""<top/><rows jr:template=""><cell/></rows>
          <iter vellum:role="Repeat" ids="" count="" current_index="">
           <item id="" index="" jr:template=""><v/></item></iter>
          <made vellum:role="SaveToCase"><case xmlns="http://commcarehq.org/case/transaction/v2" case_id=""
          date_modified="" user_id=""><create><case_name/></create></case></made><flag x=""/>""",
        model="""<setvalue event="xforms-ready" ref="/data/top" value="1"/>
          <setvalue event="xforms-ready" ref="/data/rows/cell" value="1"/>
          <setvalue event="jr-insert" ref="/data/rows/cell" value="1"/>
          <setvalue event="xforms-value-changed" ref="/data/top" value="2"/>
          <setvalue event="xforms-revalidate" ref="/data/top" value="now()"/>
          <setvalue event="xforms-ready" ref="/data/iter/@ids" value="join(' ', /data/top)"/>
          <setvalue event="xforms-ready" ref="/data/iter/@count" value="count-selected(/data/iter/@ids)"/>
          <setvalue event="jr-insert" ref="/data/iter/item/@index" value="int(/data/iter/@current_index)"/>
          <setvalue event="jr-insert" ref="/data/iter/item/@id" value="selected-at(/data/iter/@ids, ../@index)"/>
          <setvalue event="xforms-ready" ref="/data/made/case/@case_id" value="uuid()"/>
          <setvalue event="xforms-ready" ref="/data/flag/@x" value="1"/>
          <x:setvalue event="xforms-ready" ref="/data/top" value="3"/>""",
        body="""<input ref="/data/top"><setvalue event="xforms-value-changed" ref="/data/top" value="4"/></input>
          <group ref="/data/rows"><repeat nodeset="/data/rows"><input ref="/data/rows/cell"/></repeat></group>""",
    )
    uses = _uses(xml, manifest, "jr-action:setvalue")
    model = [use for use in uses if "/model[1]/" in use.where]
    nested = [use for use in uses if "/h:body[1]/" in use.where]
    # Core dispatches the foreign-namespace one by its local name too (the last of the model's).
    assert len(model) == 12 and len(nested) == 1
    assert [classes.foreign_namespace_model_child(use, manifest) for use in model] == [False] * 11 + [True]
    model = model[:11]

    def verdicts(reader, among):
        return [reader(use, manifest) for use in among]

    assert verdicts(classes.default_event_mismatching_placement, model) == [
        False,  # a default outside repeats at form load
        True,  # xforms-ready inside a repeat: a save rewrites it to jr-insert
        False,
        False,  # not a default's event
        False,
        False,  # a model iteration's
        False,
        False,
        False,
        False,  # a SaveToCase create's Case ID
        False,  # an attribute is no question
    ]
    assert verdicts(classes.form_level_setvalue, model) == [
        False,
        False,
        False,
        True,  # xforms-value-changed
        True,  # an authored xforms-revalidate
        False,
        False,
        False,
        False,
        False,
        True,  # a setvalue on a non-question ref no plugin takes
    ]
    assert verdicts(classes.form_level_setvalue, nested) == [False]
    assert verdicts(classes.action_nested_in_control, nested + model[:1]) == [True, False]


def test_hqs_build_output_is_in_no_source_class_of_a_setvalue(manifest):
    """HQ's meta block and case blocks are its build's (``XForm._add_meta_2``, ``_create_casexml``): a
    local archive carries them as HQ's build does, and they are no authored setvalue."""
    xml = _form(
        data="""<q/><case xmlns="http://commcarehq.org/case/transaction/v2" case_id="" date_modified=""
          user_id=""><create><case_name/></create></case><orx:meta xmlns:orx="http://openrosa.org/jr/xforms">
          <orx:timeEnd/><orx:drift/></orx:meta>""",
        model="""<setvalue ref="/data/case/@case_id" event="xforms-ready"
            value="instance('commcaresession')/session/data/case_id_new_patient_0"/>
          <setvalue ref="/data/meta/timeEnd" value="now()" event="xforms-revalidate"/>
          <setvalue ref="/data/meta/drift" value="now()" event="xforms-revalidate"/>""",
        body="""<input ref="/data/q"/>""",
    )
    uses = _uses(xml, manifest, "jr-action:setvalue")
    # The case block's and HQ's own timeEnd are the build's; a drift HQ never writes so is authored.
    assert [classes.form_level_setvalue(use, manifest) for use in uses] == [False, False, True]


def test_a_head_child_core_dispatches_other_than_hqs_own(manifest):
    xml = _form(
        data="<q/>",
        body="""<input ref="/data/q"/>""",
        head="""<odkx:intent id="q" class="org.example.CALLOUT"/><x:extra><x:input ref="/data/q"/></x:extra>
          <vellum:hashtags>{}</vellum:hashtags>""",
    )
    controls = {
        use.where: classes.head_child(use, manifest)
        for key in ("jr-control:model", "jr-control:title", "jr-control:intent", "jr-control:input")
        for use in _uses(xml, manifest, key)
    }
    assert controls == {
        "/h:html/h:head[1]/model[1]": False,
        "/h:html/h:head[1]/h:title[1]": False,
        "/h:html/h:head[1]/odkx:intent[1]": False,  # HQ's own callout tag, by its namespace
        "/h:html/h:head[1]/{http://example.org/elsewhere}extra[1]/{http://example.org/elsewhere}input[1]": True,
        "/h:html/h:body[1]/input[1]": False,
    }


def test_an_upload_mediatype_as_vellum_and_core_read_it(manifest):
    xml = _form(
        data="<a/><b/><c/><d/>",
        body="""<upload ref="/data/a" mediatype="image/*"/><upload ref="/data/b" mediatype="IMAGE/*"/>
          <upload ref="/data/c" mediatype="application/*,text/*"/><upload ref="/data/d"/>""",
    )
    uses = _uses(xml, manifest, "jr-control:upload")
    assert [classes.other_upload_mediatype(use, manifest) for use in uses] == [False, True, False, True]


COUNTED = _form(
    data="""<n/><d/><t/><size/><nova_count_a/><nova_count_b/><nova_count_c/><nova_count_e/><nova_count_k/>
      <a jr:template=""><x/></a><b jr:template=""><x/></b><c jr:template=""><x/></c><e jr:template=""><x/></e>
      <f jr:template=""><x/></f><g jr:template=""><x/></g><h jr:template=""><x/></h><k jr:template=""><x/></k>
      <iter vellum:role="Repeat" ids="" count="" current_index=""><item id="" index="" jr:template=""/></iter>""",
    model="""<bind nodeset="/data/n" type="xsd:int"/><bind nodeset="/data/d" type="xsd:double"/>
      <bind nodeset="/data/t" type="xsd:string"/><bind nodeset="/data/size" type="xsd:int"/>
      <bind nodeset="/data/nova_count_a" type="xsd:int" calculate="3"/>
      <bind nodeset="/data/nova_count_b" type="xsd:int" calculate="/data/size + 0.7"/>
      <bind nodeset="/data/nova_count_c" type="xsd:int" calculate="if(/data/t = 'pump', 2, 0)"/>
      <bind nodeset="/data/nova_count_k" type="xsd:int" calculate="if(/data/t = 'pump', 2, count(/data/a))"/>
      <bind nodeset="/data/nova_count_e" type="xsd:int" calculate="/data/size div 2"/>
      <bind nodeset="/data/iter/@count" calculate="count-selected(/data/iter/@ids)"/>""",
    body="""<input ref="/data/n"/><input ref="/data/d"/><input ref="/data/t"/><input ref="/data/size"/>
      <group><repeat nodeset="/data/a" jr:count="/data/nova_count_a"/></group>
      <group><repeat nodeset="/data/b" jr:count="/data/nova_count_b"/></group>
      <group><repeat nodeset="/data/c" jr:count="/data/nova_count_c"/></group>
      <group><repeat nodeset="/data/e" jr:count="/data/nova_count_e"/></group>
      <group><repeat nodeset="/data/f" jr:count="/data/d"/></group>
      <group><repeat nodeset="/data/g" jr:count="/data/t"/></group>
      <group><repeat nodeset="/data/h" jr:count="instance('casedb')/casedb/case[1]/n"/></group>
      <group ref="/data/iter"><repeat nodeset="/data/iter/item" jr:count="/data/iter/@count"/></group>
      <group><repeat nodeset="/data/k" jr:count="/data/nova_count_k"/></group>""",
)


def test_a_repeat_count_by_what_it_names(hq, manifest, core_runner):
    """Each count class read on the repeat and the group around it alike, over the readings the observation
    makes (Core's parse of the count; HQ's XPath grammar's structure of a hidden value's calculate, typed as
    Nova's types type it)."""
    readings = manifest_usage.Readings.of(observed_manifest.readings(core_runner, forms=[COUNTED]))
    repeats = _uses(COUNTED, manifest, "jr-control:repeat", readings=readings)
    groups = _uses(COUNTED, manifest, "jr-control:group", readings=readings)
    assert len(repeats) == len(groups) == 9

    def verdicts(reader):
        on_repeats = [reader(use, manifest) for use in repeats]
        assert on_repeats == [reader(use, manifest) for use in groups]
        return on_repeats

    # literal 3, size + 0.7, if(_, 2, 0), size div 2, decimal q, text q, other instance, model iteration, and a
    # call after a comma (if()'s third argument), which eulxml's lexer refuses and the observation's grammar reads
    assert verdicts(classes.count_from_non_integer_hidden_value) == [False, True, False, True] + [False] * 5
    assert verdicts(classes.count_from_decimal_question) == [False] * 4 + [True, False, False, False, False]
    assert verdicts(classes.count_from_other_question) == [False] * 4 + [False, True, False, False, False]
    assert verdicts(classes.count_outside_form_data) == [False] * 6 + [True, False, False]


RELATIVE_COUNTS = _form(
    data="""<iter vellum:role="Repeat" ids="" count="" current_index=""><item id="" index="" jr:template=""/></iter>
      <rows jr:template=""/><n/>""",
    model="""<bind nodeset="/data/iter/@count" calculate="count-selected(../@ids)"/>
      <bind nodeset="/data/n" type="xsd:int" calculate="count(current()/../rows)"/>""",
    body="""<group ref="/data/iter"><repeat nodeset="/data/iter/item" jr:count="/data/iter/@count"/></group>
      <group><repeat nodeset="/data/rows" jr:count="/data/n"/></group>""",
)


def test_a_count_read_through_a_calculate_from_its_own_node(hq, manifest, core_runner):
    """A calculate's relative path, and its path from ``current()``, are read from the calculate's own node: a model
    iteration's count reads its container's ids (``../@ids`` from ``@count``), not its rows, and a count reading
    ``current()/../rows`` from a hidden value beside the repeat reads the rows it creates."""
    readings = manifest_usage.Readings.of(observed_manifest.readings(core_runner, forms=[RELATIVE_COUNTS]))
    counts = _uses(RELATIVE_COUNTS, manifest, "xform:repeat@jr:count", readings=readings)
    assert [classes.count_reading_its_rows(use, manifest) for use in counts] == [False, True]


# The app JSON -------------------------------------------------------------------------


def _app(modules, **fields):
    return {"doc_type": "Application", "langs": ["en"], "modules": modules, **fields}


def _module(forms=(), **fields):
    return {
        "doc_type": "Module",
        "unique_id": fields.pop("unique_id", "m"),
        "case_type": "patient",
        "forms": list(forms),
        **fields,
    }


def _app_uses(app, manifest, key):
    found = manifest_usage.Uses()
    manifest_usage.app_json_uses(app, manifest, "app.json", found)
    return [use for use in found.uses if use.key == key]


def _form_json(requires="case", **actions):
    return {"doc_type": "Form", "unique_id": "f", "requires": requires, "actions": actions}


ALWAYS, NEVER = {"type": "always"}, {"type": "never"}


def test_a_forms_case_actions_by_the_action_a_use_sits_in(manifest):
    extension = {"case_type": "child", "condition": ALWAYS, "relationship": "extension"}
    survey_child = _form_json("none", subcases=[extension])
    lone_never = _form_json("case", update_case={"condition": NEVER}, close_case={"condition": NEVER})
    closing = _form_json("case", update_case={"condition": NEVER}, close_case={"condition": ALWAYS})
    conditional = _form_json(
        "none", open_case={"condition": {"type": "if", "question": "/data/q"}}, subcases=[extension]
    )
    app = _app([_module([survey_child, lone_never, closing, conditional])])
    actions = _app_uses(app, manifest, "schema:Form.actions")
    assert [classes.child_cases_without_open(use, manifest) for use in actions] == [True, False, False, False]
    assert [classes.extension(use, manifest) for use in actions] == [True, False, False, True]
    assert [classes.update_never_followup_alone(use, manifest) for use in actions] == [False, True, False, False]
    # A use in another action of the same form is in no class about this one: the open case's condition type
    # is not the child case's.
    types = [use for use in _app_uses(app, manifest, "schema:FormActionCondition.type") if "/forms/3/" in use.where]
    open_condition = next(use for use in types if "/open_case/" in use.where)
    child_condition = next(use for use in types if "/subcases/" in use.where)
    assert classes.extension(open_condition, manifest) is False
    assert classes.extension(child_condition, manifest) is True


def test_a_case_list_columns_value_by_the_column_a_use_sits_in(manifest):
    columns = [
        {"doc_type": "DetailColumn", "field": "dob", "format": "date", "date_format": "%Y-%m-%d %I"},
        {"doc_type": "DetailColumn", "field": "dob", "format": "date", "date_format": "%d/%m/%Y"},
        {"doc_type": "DetailColumn", "field": "seen", "format": "time-ago", "time_ago_interval": 7.0},
        {"doc_type": "DetailColumn", "field": "seen", "format": "time-ago", "time_ago_interval": 3.0},
        {"doc_type": "DetailColumn", "field": "kind", "format": "enum", "enum": [{"key": "a&b", "value": {}}]},
        {"doc_type": "DetailColumn", "field": "loc", "format": "geo-points"},
    ]
    module = _module(case_details={"short": {"columns": columns}, "long": {"columns": []}})
    formats = _app_uses(_app([module]), manifest, "schema:DetailColumn.format")
    assert [classes.date_with_another_pattern(use, manifest) for use in formats] == [True] + [False] * 5
    assert [classes.time_ago_with_another_interval(use, manifest) for use in formats] == [False] * 3 + [
        True,
        False,
        False,
    ]
    assert [classes.enum_xml_special_key(use, manifest) for use in formats] == [False] * 4 + [True, False]
    # geo-points needs an address column beside it in the detail.
    assert [classes.geo_without_dependency(use, manifest) for use in formats] == [False] * 5 + [True]


def test_an_apps_settings_by_their_values(manifest):
    app = _app(
        [_module()],
        build_spec={"doc_type": "BuildSpec", "version": "2.54.0"},
        langs=["en", "EN-us", "en"],
        profile={"custom_properties": {"cc-index-case-search-results": "yes", "cc-auto-purge": "yes"}},
    )
    [spec] = _app_uses(app, manifest, "schema:Application.build_spec")
    [langs] = _app_uses(app, manifest, "schema:Application.langs")
    [profile] = _app_uses(app, manifest, "schema:Application.profile")
    assert classes.below_floor(spec, manifest) is True
    assert classes.invalid_or_repeated_code(langs, manifest) is True
    assert classes.custom_property_other(profile, manifest) is True
    held = _app([_module()], build_spec={"doc_type": "BuildSpec", "version": "2.57.0"}, langs=["en", "pt-br"])
    assert classes.below_floor(_app_uses(held, manifest, "schema:Application.build_spec")[0], manifest) is False
    assert classes.invalid_or_repeated_code(_app_uses(held, manifest, "schema:Application.langs")[0], manifest) is False


def test_menus_by_where_they_sit(manifest):
    parent = _module(unique_id="p")
    child = _module(unique_id="c", root_module_id="p")
    stranger = _module(unique_id="s")
    grandchild = _module(unique_id="g", root_module_id="c")
    app = _app([parent, stranger, child, grandchild])
    roots = {use.where: use for use in _app_uses(app, manifest, "schema:Module.root_module_id")}
    assert classes.grandchild(roots["/modules/3/root_module_id"], manifest) is True
    assert classes.grandchild(roots["/modules/2/root_module_id"], manifest) is False
    [modules] = _app_uses(app, manifest, "schema:Application.modules")
    # c is separated from p by s; HQ's menu moves keep a parent's children right after it.
    assert classes.child_menu_separated_from_its_parent(modules, manifest) is True
    ordered = _app([parent, child, grandchild, stranger])
    [kept] = _app_uses(ordered, manifest, "schema:Application.modules")
    assert classes.child_menu_separated_from_its_parent(kept, manifest) is False


def test_search_settings_and_prompts(manifest):
    search = {
        "properties": [
            {"name": "indices.parent"},
            {"name": "dob", "appearance": "address", "validations": [{"test": "true()"}]},
        ],
        "default_properties": [{"property": "x_commcare_data_registry", "defaultValue": "'r'"}, {"property": "status"}],
        "search_button_label": {"en": "Search"},
    }
    app = _app([_module(search_config=search)], cloudcare_enabled=True)
    names = _app_uses(app, manifest, "schema:CaseSearchProperty.name")
    assert [classes.reserved_request_key(use, manifest) for use in names] == [True, False]
    appearance = _app_uses(app, manifest, "schema:CaseSearchProperty.appearance")
    assert [classes.address_with_required_or_validations(use, manifest) for use in appearance] == [True]
    [defaults] = _app_uses(app, manifest, "schema:CaseSearch.default_properties")
    assert classes.data_registry_key(defaults, manifest) is True
    assert classes.missing_default_value(defaults, manifest) is True
    [label] = _app_uses(app, manifest, "schema:CaseSearch.search_button_label")
    assert classes.other_search_button_label(label, manifest) is True
    # auto_launch false in an app that declares Web Apps (cloudcare_enabled) is the retiring legacy workflow.
    [auto] = _app_uses(
        _app([_module(search_config={**search, "auto_launch": True})], cloudcare_enabled=True),
        manifest,
        "schema:CaseSearch.auto_launch",
    ) or [None]
    assert auto is None or classes.list_first_with_web_apps(auto, manifest) is False
    [properties] = _app_uses(app, manifest, "schema:CaseSearch.properties")
    assert classes.list_first_with_web_apps(properties, manifest) is True


SEARCH_SUITE = b"""<suite version="1">
 <entry><form>http://example.org/f</form><command id="m0-f0"><text><locale id="f"/></text></command>
  <instance id="results" src="jr://instance/remote/results"/>
  <session><datum id="case_id" nodeset="x" value="y"/></session></entry>
 <entry><form>http://example.org/g</form><command id="m0-f1"><text><locale id="g"/></text></command>
  <instance id="results:inline" src="jr://instance/remote/results:inline"/>
  <session><query url="https://example.org/s" storage-instance="results:inline" template="case" default_search="false">
   <prompt key="indices.parent"><display><text><locale id="p"/></text></display></prompt></query></session></entry>
 <detail id="d"><title><text><locale id="t"/></text></title>
  <variables/><field><header><text><locale id="h"/></text></header>
  <template><text><xpath function="."/></text></template></field>
 </detail>
</suite>"""


def test_a_suites_search_instances_and_prompts(manifest):
    found = manifest_usage.Uses()
    manifest_usage.runtime_xml_uses(SEARCH_SUITE, "SuiteParser", manifest, "local.ccz/suite.xml", found)
    schemes = [use for use in found.uses if use.key == "instance-scheme:results"]
    reader = classes.non_inline_search_form("results")
    # The first entry reads results with no query in its session: the search's rewind drops it.
    assert [reader(use, manifest) for use in schemes] == [True, False]
    [prompt] = [use for use in found.uses if use.key == "parser:QueryPromptParser/prompt@key"]
    assert classes.reserved_request_key(prompt, manifest) is True


def test_csql_comparisons_by_what_stands_on_their_value_side(hq, manifest, core_runner):
    queries = {
        "time": "'dob > \"10:30\"'",
        "date": "'dob > \"2024-01-01\"'",
        "number": "'visits >= 3'",
        "blank_metadata": "'date_opened > \"\"'",
        "today_metadata": "'date_opened >= today()'",
        "runtime": "concat('visits > ', /data/n)",
    }
    suite = (
        b'<suite version="1"><remote-request><session><query url="u" storage-instance="results">'
        + b"".join(
            f'<data key="_xpath_query" ref="{text.replace(chr(34), "&quot;")}"/>'.encode() for text in queries.values()
        )
        + b"</query></session></remote-request></suite>"
    )
    readings = manifest_usage.Readings.of(observed_manifest.readings(core_runner, runtimes=[suite]))
    found = manifest_usage.Uses()
    manifest_usage.runtime_xml_uses(suite, "SuiteParser", manifest, "local.ccz/suite.xml", found)
    manifest_usage.read_observed(found, manifest, readings)

    def verdict(reader, key, index):
        [use] = [use for use in found.uses if use.key == key and f"/data[{index}]/" in use.where]
        return reader(use, manifest)

    assert verdict(classes.untyped_right_side, "csql-op:>", 1) is True  # a time of day is no date
    assert verdict(classes.untyped_right_side, "csql-op:>", 2) is False
    assert verdict(classes.untyped_right_side, "csql-op:>=", 3) is False
    assert verdict(classes.non_date_value, "csql-metadata:date_opened", 4) is True  # '' is no date
    assert verdict(classes.non_date_value, "csql-metadata:date_opened", 5) is False
    # A value only the run time knows, spliced in unquoted: whether a guard keeps it a number is not read.
    assert verdict(classes.untyped_right_side, "csql-op:>", 6) is None


# Every reader, by its class's shapes ----------------------------------------------------------------------------
#
# Each value class the check reads has a refused shape (its reader says True) and an accepted shape beside it (the
# reader says False), each a use of a key the class's entry names, in an export as HQ, Vellum and Nova write one,
# found by the check's own extraction. A class the export cannot settle has the shape it leaves open (None) in place
# of a refused one, and a class every use of whose keys it takes has no accepted shape; both are named below with
# why. The shapes that need what HQ's and Core's readers read (a parse, a CSQL string, a calculate's structure, a
# media file) are read with the observation's readings of the same artifacts.


@dataclass(frozen=True)
class Shape:
    """One use of a value class's key and the verdict its reader gives it: the export (``form``: XForm bytes,
    ``app``: an app JSON, ``suite``: suite bytes), the key, where the use sits (its ``where``, or the end of it),
    and whether it needs the observation's readings (``media``: what a local archive holds beside it). A shape whose
    key the class's entry does not name (``named``) is a use of the class the check never consults its reader on,
    a gap in the inventory's keys (``UNCONSULTED``)."""

    export: str
    source: object
    key: str
    where: str
    verdict: bool | None
    readings: bool = False
    media: tuple = ()
    named: bool = True  # whether the class's entry names the key (False: a use of the class the check never sees)


def refused(export, source, key, where, **kw):
    return Shape(export, source, key, where, True, **kw)


def accepted(export, source, key, where, **kw):
    return Shape(export, source, key, where, False, **kw)


def unsettled(export, source, key, where, **kw):
    return Shape(export, source, key, where, None, **kw)


ARTIFACTS = {"form": "form:0.0", "app": "app.json", "suite": "local.ccz/suite.xml"}
CASE_NS = "http://commcarehq.org/case/transaction/v2"
ODKX = "http://opendatakit.org/xforms"


def _with_forms(app, **sources):
    """An app JSON carrying each form's XForm source in ``_attachments``, by the form's unique_id."""
    return {**app, "_attachments": {f"{unique_id}.xml": xml.decode() for unique_id, xml in sources.items()}}


def _detail_module(columns=(), long_columns=(), doc_type="Module", short=None, long=None, **fields):
    """A module whose case list holds ``columns`` and whose case detail ``long_columns``, each detail with the
    settings ``short`` and ``long`` give it."""
    details = {
        "doc_type": "DetailPair",
        "short": {"columns": list(columns), **(short or {})},
        "long": {"columns": list(long_columns), **(long or {})},
    }
    return _module(doc_type=doc_type, case_details=details, **fields)


def _column(field="name", fmt="plain", **fields):
    return {"doc_type": "DetailColumn", "field": field, "format": fmt, "header": {"en": field}, **fields}


def _search_module(**config):
    return _module(search_config={"doc_type": "CaseSearch", **config})


def _prompt(name, **fields):
    return {"doc_type": "CaseSearchProperty", "name": name, **fields}


def _default(prop, value=None):
    entry = {"doc_type": "DefaultCaseSearchProperty", "property": prop}
    return entry if value is None else {**entry, "defaultValue": value}


def _update(path):
    return {"doc_type": "ConditionalCaseUpdate", "question_path": path}


IF = {"type": "if", "question": "/data/q", "answer": "yes", "operator": "="}


def _if(question, answer="yes"):
    return {**IF, "question": question, "answer": answer}


def _subcase(**fields):
    return {"doc_type": "OpenSubCaseAction", "case_type": "child", "condition": ALWAYS, **fields}


# A form holding an input (q), a single select (s), a label (t), an upload (u) and a repeat (rep, with its name).
QUESTIONS = _form(
    data='<q/><s/><t/><u/><rep jr:template=""><name/></rep>',
    body="""<input ref="/data/q"/><select1 ref="/data/s"><item><value>a</value></item></select1>
      <trigger ref="/data/t"/><upload ref="/data/u" mediatype="image/*"/>
      <group><repeat nodeset="/data/rep"><input ref="/data/rep/name"/></repeat></group>""",
)


def _question_app(form, **fields):
    """An app whose one module holds ``form`` (unique_id ``f``), its XForm being QUESTIONS."""
    return _with_forms(_app([_module([form])], **fields), f=QUESTIONS)


def _linked(link, target_requires="case", **target_module):
    """A form linking to the form of another module (``f2``), by ``link``."""
    source = {**_form_json("none"), "form_links": [link]}
    target = {**_form_json(target_requires), "unique_id": "f2"}
    return _app([_module([source]), _module([target], unique_id="m2", **target_module)])


# A menu's search: one prompt (``util.py::module_offers_search``).
SEARCHING = {"doc_type": "CaseSearch", "properties": [{"doc_type": "CaseSearchProperty", "name": "name"}]}


def _child_linked(*, source_parent):
    """A form linking to a child menu (``m2``, under a parent of case type ``patient``), from a top-level menu
    (``source_parent`` None) or from a child menu whose parent has case type ``source_parent``."""
    source = {**_form_json("none"), "form_links": [{"doc_type": "FormLink", "module_unique_id": "m2"}]}
    modules = [
        _module(unique_id="tp"),
        _module([{**_form_json("case"), "unique_id": "f2"}], unique_id="m2", root_module_id="tp"),
    ]
    if source_parent is None:
        return _app([_module([source]), *modules])
    parent = {**_module(unique_id="sp"), "case_type": source_parent}
    return _app([_module([source], root_module_id="sp"), parent, *modules])


def _media_app(path, media_type, **fields):
    return _app(
        [_module()],
        multimedia_map={f"jr://file/{path}": {"doc_type": "HQMediaMapItem", "media_type": media_type}},
        **fields,
    )


def _box(kind, body):
    return struct.pack(">I", 8 + len(body)) + kind + body


def _iso(brand, *tracks):
    """An ISO base media file: its ftyp brand and each track's handler and sample entry."""
    traks = b"".join(
        _box(
            b"trak",
            _box(
                b"mdia",
                _box(b"hdlr", b"\0" * 8 + handler + b"\0" * 12)
                + _box(b"minf", _box(b"stbl", _box(b"stsd", b"\0\0\0\0\0\0\0\1" + _box(codec, b"\0" * 16)))),
            ),
        )
        for handler, codec in tracks
    )
    return _box(b"ftyp", brand + b"\0\0\0\0" + brand) + _box(b"moov", traks)


def _wav(code, bits):
    fmt = struct.pack("<HHIIHH", code, 1, 8000, 8000 * bits // 8, bits // 8, bits)
    body = b"WAVE" + _box_le(b"fmt ", fmt) + _box_le(b"data", b"\0" * 16)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def _box_le(kind, body):
    return kind + struct.pack("<I", len(body)) + body


def _png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\0\0\0\0")) + chunk(b"IEND", b"")
    )


TIFF = b"II*\x00\x08\x00\x00\x00\x00\x00\x00\x00\x00\x00"
OGG_THEORA = b"OggS\x00\x02" + b"\0" * 22 + b"\x01\x2a\x80theora\x03\x02\x01" + b"\0" * 40
OGG_VORBIS = b"OggS\x00\x02" + b"\0" * 22 + b"\x01\x1e\x01vorbis" + b"\0" * 40


def _media_shapes(media_type, key, refused_file, accepted_file):
    """The refused and accepted shapes of a media class: a multimedia map item of ``media_type`` naming a file Nova's
    archive holds as ``refused_file`` and as ``accepted_file`` (each ``(name, bytes)``)."""
    shapes = []
    for make, (name, data) in ((refused, refused_file), (accepted, accepted_file)):
        path = f"commcare/{name}"
        shapes.append(
            make(
                "app",
                _media_app(path, media_type),
                key,
                f"/jr:~1~1file~1{path.replace('/', '~1')}/media_type",
                readings=True,
                media=((path, data),),
            )
        )
    return tuple(shapes)


def _questions():
    form = _form
    combobox = form(
        data="<a/><b/><c/>",
        body="""<select1 ref="/data/a" appearance="combobox2"><item><value>x</value></item></select1>
          <select1 ref="/data/b" appearance="combobox"><item><value>x</value></item></select1>
          <select1 ref="/data/c" appearance="compactcombobox"><item><value>x</value></item></select1>""",
    )
    setvalues = form(
        data='<top/><rows jr:template=""><cell/></rows>',
        model="""<setvalue event="xforms-ready" ref="/data/rows/cell" value="1"/>
          <setvalue event="xforms-ready" ref="/data/top" value="1"/>
          <setvalue event="xforms-value-changed" ref="/data/top" value="2"/>
          <x:setvalue event="xforms-ready" ref="/data/top" value="3"/>""",
        body="""<input ref="/data/top"><setvalue event="xforms-value-changed" ref="/data/top" value="4"/></input>
          <group><repeat nodeset="/data/rows"><input ref="/data/rows/cell"/></repeat></group>""",
    )
    case = f'<case xmlns="{CASE_NS}" case_id="" date_modified="" user_id="">'
    created = form(
        data=f'<made vellum:role="SaveToCase">{case}<create><case_name/></create></case></made>'
        f'<other vellum:role="SaveToCase">{case}<create><case_name/></create></case></other>',
        model="""<setvalue event="xforms-ready" ref="/data/made/case/@case_id" value="''"/>
          <setvalue event="xforms-ready" ref="/data/other/case/@case_id" value="uuid()"/>""",
    )
    leaves = form(
        data=f'<q/><op vellum:role="SaveToCase">{case}<update><when/></update></case></op>',
        model="""<bind nodeset="/data/q" type="xsd:dateTime"/>
          <bind nodeset="/data/op/case/update/when" type="xsd:dateTime" calculate="now()"/>""",
        body='<input ref="/data/q"/>',
    )
    pair = form(
        data="<a/><b/>",
        model='<bind nodeset="/data/a" type="xsd:int"/><bind nodeset="/data/b" type="xsd:int"/>',
        body="""<select1 ref="/data/a"><item><value>x</value></item></select1><input ref="/data/b"/>""",
    )
    secret = form(
        data="<a/><b/>",
        model='<bind nodeset="/data/a" type="xsd:int"/><bind nodeset="/data/b" type="xsd:int"/>',
        body='<secret ref="/data/a"/><input ref="/data/b"/>',
    )

    def inputs(first, second, control="input", appearances=("", "")):
        binds = "".join(
            f'<bind nodeset="/data/{name}" type="{kind}"/>' for name, kind in (("a", first), ("b", second)) if kind
        )
        body = "".join(
            f'<{control} ref="/data/{name}"' + (f' appearance="{appearance}"' if appearance else "") + "/>"
            for name, appearance in zip("ab", appearances, strict=True)
        )
        return form(data="<a/><b/>", model=binds, body=body)

    callouts = form(
        data="<p/><c/>",
        model='<bind nodeset="/data/p" type="intent"/><bind nodeset="/data/c" type="intent"/>',
        head=f"""<odkx:intent id="p" class="{classes.PRINT_ACTION}"/>
          <odkx:intent id="c" class="org.example.CALLOUT"/>""",
        body='<input ref="/data/p"/><input ref="/data/c"/>',
    )
    labels = form(
        data="<r/><t/>",
        body="""<input ref="/data/r" readonly="true()"><label>R</label></input>
          <trigger ref="/data/t"><label>T</label></trigger>""",
    )
    heads = form(data="<q/>", body='<input ref="/data/q"/>', head='<x:extra><x:input ref="/data/q"/></x:extra>')
    uploads = form(
        data="<a/><b/>", body='<upload ref="/data/a" mediatype="IMAGE/*"/><upload ref="/data/b" mediatype="image/*"/>'
    )
    setvalue = "jr-action:setvalue"
    group = "body[1]/group[{}]/repeat[1]"
    return {
        "questions/other-h-head-children-whose-local-name-or-a-descendant-s-core-or": (
            refused("form", heads, "jr-control:input", "{http://example.org/elsewhere}input[1]"),
            accepted("form", heads, "jr-control:input", "h:body[1]/input[1]"),
        ),
        "questions/type-on-a-savetocase-property-leaf-a-create-update-or-index": (
            refused("form", leaves, "jr-type:dateTime", "model[1]/bind[2]/@type"),
            accepted("form", leaves, "jr-type:dateTime", "model[1]/bind[1]/@type"),
        ),
        "questions/a-select-whose-bind-type-is-neither-a-choice-type-nor-a-string": (
            refused("form", pair, "jr-type:int", "model[1]/bind[1]/@type"),
            accepted("form", pair, "jr-type:int", "model[1]/bind[2]/@type"),
        ),
        "questions/secret-with-a-numeric-bind-type": (
            refused("form", secret, "jr-type:int", "model[1]/bind[1]/@type"),
            accepted("form", secret, "jr-type:int", "model[1]/bind[2]/@type"),
        ),
        "questions/input-whose-bind-type-vellum-does-not-write-xsd-decimal-xsd": (
            refused("form", inputs("xsd:decimal", "xsd:int"), "jr-control:input", "body[1]/input[1]"),
            accepted("form", inputs("xsd:decimal", "xsd:int"), "jr-control:input", "body[1]/input[2]"),
        ),
        "questions/an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring": (
            refused(
                "form",
                inputs("", "xsd:string", appearances=("Numbers", "numeric")),
                "jr-control:input",
                "body[1]/input[1]",
            ),
            accepted(
                "form",
                inputs("", "xsd:string", appearances=("Numbers", "numeric")),
                "jr-control:input",
                "body[1]/input[2]",
            ),
        ),
        "questions/a-secret-whose-bind-has-no-type-with-numeric-or-numbers-ignoring": (
            refused(
                "form",
                inputs("", "xsd:int", "secret", ("numeric", "numeric")),
                "jr-control:secret",
                "body[1]/secret[1]",
            ),
            accepted(
                "form",
                inputs("", "xsd:int", "secret", ("numeric", "numeric")),
                "jr-control:secret",
                "body[1]/secret[2]",
            ),
        ),
        "questions/long-xsd-long": (
            refused("form", inputs("xsd:long", "xsd:int"), "jr-control:input", "body[1]/input[1]"),
            accepted("form", inputs("xsd:long", "xsd:int"), "jr-control:input", "body[1]/input[2]"),
        ),
        "questions/print-callout-class-org-commcare-dalvik-action-print-extra-cc": (
            refused("form", callouts, "jr-control:input", "body[1]/input[1]"),
            accepted("form", callouts, "jr-control:input", "body[1]/input[2]"),
        ),
        "questions/input-readonly-true-control-attribute": (
            refused("form", labels, "jr-control:input", "body[1]/input[1]"),
            accepted("form", labels, "mug:Trigger", "/data/t", readings=True),
        ),
        "questions/upload-with-any-other-mediatype-or-none": (
            refused("form", uploads, "jr-control:upload", "body[1]/upload[1]"),
            accepted("form", uploads, "jr-control:upload", "body[1]/upload[2]"),
        ),
        "questions/a-default-value-s-setvalue-whose-event-does-not-match-where-the": (
            refused("form", setvalues, setvalue, "model[1]/setvalue[1]"),  # xforms-ready inside a repeat
            accepted("form", setvalues, setvalue, "model[1]/setvalue[2]"),
        ),
        "questions/setvalue-event-xforms-value-changed-authored-xforms-revalidate": (
            refused("form", setvalues, setvalue, "model[1]/setvalue[3]"),
            accepted("form", setvalues, setvalue, "model[1]/setvalue[2]"),  # a question's default value
        ),
        "questions/savetocase-create-at-the-form-root-whose-authored-case-id-xpath": (
            refused("form", created, setvalue, "model[1]/setvalue[1]", readings=True),
            accepted("form", created, setvalue, "model[1]/setvalue[2]", readings=True),
        ),
        "questions/actions-nested-inside-controls": (
            refused("form", setvalues, setvalue, "body[1]/input[1]/setvalue[1]"),
            accepted("form", setvalues, setvalue, "model[1]/setvalue[2]"),
        ),
        "questions/unknown-namespace-model-children-named-itext-instance-bind": (
            refused("form", setvalues, setvalue, "model[1]/{http://example.org/elsewhere}setvalue[1]"),
            accepted("form", setvalues, setvalue, "model[1]/setvalue[2]"),
        ),
        "questions/jr-count-naming-a-node-in-a-secondary-instance-or-no-node": (
            refused("form", COUNTED, "jr-control:repeat", group.format(7), readings=True),
            accepted("form", COUNTED, "jr-control:repeat", group.format(1), readings=True),
        ),
        "questions/jr-count-naming-a-decimal-question": (
            refused("form", COUNTED, "jr-control:repeat", group.format(5), readings=True),
            accepted("form", COUNTED, "jr-control:repeat", group.format(1), readings=True),
        ),
        "questions/jr-count-naming-any-other-question-kind-text-barcode-multi": (
            refused("form", COUNTED, "jr-control:repeat", group.format(6), readings=True),
            accepted("form", COUNTED, "jr-control:repeat", group.format(1), readings=True),
        ),
        "questions/jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer": (
            refused("form", COUNTED, "jr-control:repeat", group.format(2), readings=True),
            accepted("form", COUNTED, "jr-control:repeat", group.format(1), readings=True),
            accepted("form", COUNTED, "jr-control:repeat", group.format(9), readings=True),  # a call after a comma
        ),
        "questions/any-other-single-string-no-row-names-that-holds-a-value-android": (
            refused("form", combobox, "appearance:android/combobox", "select1[1]/@appearance"),
            accepted("form", combobox, "appearance:android/combobox", "select1[2]/@appearance"),
            accepted("form", combobox, "appearance:android/combobox", "select1[3]/@appearance"),  # a grid
        ),
    }


def _settings_and_forms():
    def app(**fields):
        return _app([_module()], **fields)

    def one_form(form, **module):
        return (
            _question_app(form, **module) if not module else _with_forms(_app([_module([form], **module)]), f=QUESTIONS)
        )

    actions = "/modules/0/forms/0/actions"
    subcases = f"{actions}/subcases"
    update = f"{actions}/update_case"
    multi = {"case_details": {"doc_type": "DetailPair", "short": {"multi_select": True}, "long": {}}}
    survey_child = _form_json("none", subcases=[_subcase(relationship="extension")])
    closing = _form_json("case", update_case={"condition": NEVER}, close_case={"condition": ALWAYS})
    lone_never = _form_json("case", update_case={"condition": NEVER}, close_case={"condition": NEVER})
    preloaded = _form(
        data="<q/><r/>",
        model='<setvalue event="xforms-ready" ref="/data/r" value="/data/q"/>',
        body='<input ref="/data/q"/><input ref="/data/r"/>',
    )
    unread = _form(
        data="<q/><r/>",
        model='<setvalue event="xforms-ready" ref="/data/r" value="today()"/>',
        body='<input ref="/data/q"/><input ref="/data/r"/>',
    )

    def preload_app(xml):
        form = _form_json("case", case_preload={"condition": ALWAYS, "preload": {"/data/q": "dob"}})
        return _with_forms(_app([_module([form])]), f=xml)

    def links(**link):
        return {"doc_type": "FormLink", "form_id": "f2", **link}

    case_id = "instance('commcaresession')/session/data/case_id"
    workflow = "/modules/0/forms/0/post_form_workflow"
    return {
        # Application and settings
        "application-and-settings/34p-hq-build-spec-below-nova-s-floor": (
            refused(
                "app",
                app(build_spec={"doc_type": "BuildSpec", "version": "2.54.0"}),
                "schema:Application.build_spec",
                "/build_spec",
            ),
            accepted(
                "app",
                app(build_spec={"doc_type": "BuildSpec", "version": "2.57.0"}),
                "schema:Application.build_spec",
                "/build_spec",
            ),
        ),
        "application-and-settings/50pp-hq-location-fixture-restore-only-hierarchical-fixture": (
            refused(
                "app",
                app(location_fixture_restore="only_hierarchical_fixture"),
                "schema:Application.location_fixture_restore",
                "/location_fixture_restore",
            ),
            accepted(
                "app",
                app(location_fixture_restore="both_fixtures"),
                "schema:Application.location_fixture_restore",
                "/location_fixture_restore",
            ),
        ),
        "application-and-settings/a-non-empty-langs-code-outside-that-grammar-or-repeated": (
            refused("app", app(langs=["en", "EN-us"]), "schema:Application.langs", "/langs"),
            refused("app", app(langs=["en", "fr", "en"]), "schema:Application.langs", "/langs"),
            accepted("app", app(langs=["en", "pt-br"]), "schema:Application.langs", "/langs"),
        ),
        "application-and-settings/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare": (
            refused(
                "app",
                app(logo_refs={"hq_logo_android_home": {"path": "jr://file/commcare/logo/abc.png"}}),
                "schema:Application.logo_refs",
                "/logo_refs",
            ),
            accepted(
                "app",
                app(
                    logo_refs={
                        "hq_logo_android_home": {"path": "jr://file/commcare/logo/data/hq_logo_android_home.png"}
                    }
                ),
                "schema:Application.logo_refs",
                "/logo_refs",
            ),
        ),
        "application-and-settings/profile-custom-properties-any-other-entry-incl-formplayer-keys": (
            refused(
                "app",
                app(profile={"custom_properties": {"cc-auto-purge": "yes"}}),
                "schema:Application.profile",
                "/profile",
            ),
            accepted(
                "app",
                app(profile={"custom_properties": {"cc-index-case-search-results": "yes"}}),
                "schema:Application.profile",
                "/profile",
            ),
        ),
        "application-and-settings/profile-features-sense-true-or-profile-properties-cc-entry-mode": (
            refused("app", app(profile={"features": {"sense": "true"}}), "schema:Application.profile", "/profile"),
            refused(
                "app",
                app(profile={"properties": {"cc-entry-mode": "cc-entry-review"}}),
                "schema:Application.profile",
                "/profile",
            ),
            accepted(
                "app", app(profile={"properties": {"cc-show-saved": "no"}}), "schema:Application.profile", "/profile"
            ),
        ),
        # Forms and case writes
        "forms-and-case-writes/form-requires-referral": (
            refused(
                "app", _app([_module([_form_json("referral")])]), "schema:Form.requires", "/modules/0/forms/0/requires"
            ),
            accepted(
                "app", _app([_module([_form_json("case")])]), "schema:Form.requires", "/modules/0/forms/0/requires"
            ),
        ),
        "forms-and-case-writes/form-requires-none-with-child-cases-but-no-open": (
            refused("app", _app([_module([survey_child, closing])]), "schema:Form.actions", actions),
            accepted(
                "app", _app([_module([survey_child, closing])]), "schema:Form.actions", "/modules/0/forms/1/actions"
            ),
        ),
        "forms-and-case-writes/subcases-condition-never": (
            refused(
                "app",
                _app([_module([_form_json(subcases=[_subcase(condition=NEVER)])])]),
                "schema:FormActions.subcases",
                subcases,
            ),
            accepted(
                "app", _app([_module([_form_json(subcases=[_subcase()])])]), "schema:FormActions.subcases", subcases
            ),
        ),
        "forms-and-case-writes/subcases-reference-id-any-other-value": (
            refused(
                "app",
                _app([_module([_form_json(subcases=[_subcase(reference_id="mother")])])]),
                "schema:FormActions.subcases",
                subcases,
            ),
            accepted(
                "app",
                _app([_module([_form_json(subcases=[_subcase(reference_id="")])])]),
                "schema:FormActions.subcases",
                subcases,
            ),
        ),
        "forms-and-case-writes/subcases-relationship-extension": (
            refused(
                "app",
                _app([_module([_form_json(subcases=[_subcase(relationship="extension")])])]),
                "schema:FormActions.subcases",
                subcases,
            ),
            accepted(
                "app",
                _app([_module([_form_json(subcases=[_subcase(relationship="child")])])]),
                "schema:FormActions.subcases",
                subcases,
            ),
        ),
        "forms-and-case-writes/subcases-repeat-context-other-than-the-name-question-s-innermost": (
            refused(
                "app",
                _question_app(_form_json(subcases=[_subcase(name_update=_update("/data/rep/name"))])),
                "schema:FormActions.subcases",
                subcases,
            ),
            accepted(
                "app",
                _question_app(
                    _form_json(subcases=[_subcase(name_update=_update("/data/rep/name"), repeat_context="/data/rep")])
                ),
                "schema:FormActions.subcases",
                subcases,
            ),
        ),
        "forms-and-case-writes/update-case-condition-never-on-a-follow-up-with-no-other-active": (
            refused("app", _app([_module([lone_never, closing])]), "schema:Form.actions", actions),
            accepted(
                "app", _app([_module([lone_never, closing])]), "schema:Form.actions", "/modules/0/forms/1/actions"
            ),
        ),
        "forms-and-case-writes/update-key-with-any-other-index-segment-or-user-where-the": (
            refused(
                "app",
                _app(
                    [
                        _module(
                            [
                                _form_json(
                                    update_case={"condition": ALWAYS, "update": {"mother/dob": _update("/data/q")}}
                                )
                            ]
                        )
                    ]
                ),
                "schema:FormActions.update_case",
                update,
            ),
            accepted(
                "app",
                _app(
                    [
                        _module(
                            [
                                _form_json(
                                    update_case={"condition": ALWAYS, "update": {"parent/dob": _update("/data/q")}}
                                )
                            ]
                        )
                    ]
                ),
                "schema:FormActions.update_case",
                update,
            ),
            unsettled(
                "app",
                _app(
                    [
                        _module(
                            [_form_json(update_case={"condition": ALWAYS, "update": {"user/dob": _update("/data/q")}})]
                        )
                    ]
                ),
                "schema:FormActions.update_case",
                update,
            ),
        ),
        "forms-and-case-writes/an-update-key-with-an-index-segment-on-a-form-that-opens-its": (
            refused(
                "app",
                _app(
                    [
                        _module(
                            [
                                _form_json(
                                    "none",
                                    open_case={"condition": ALWAYS},
                                    update_case={"condition": ALWAYS, "update": {"parent/dob": _update("/data/q")}},
                                )
                            ]
                        )
                    ]
                ),
                "schema:FormActions.update_case",
                update,
            ),
            accepted(
                "app",
                _app(
                    [
                        _module(
                            [
                                _form_json(
                                    update_case={"condition": ALWAYS, "update": {"parent/dob": _update("/data/q")}}
                                )
                            ]
                        )
                    ]
                ),
                "schema:FormActions.update_case",
                update,
            ),
        ),
        "forms-and-case-writes/any-other-usercase-preload": (
            refused(
                "app",
                _app([_module([_form_json(usercase_preload={"condition": ALWAYS, "preload": {"/data/q": "name"}})])]),
                "schema:FormActions.usercase_preload",
                f"{actions}/usercase_preload",
            ),
            accepted(
                "app",
                _app([_module([_form_json(usercase_preload={"condition": ALWAYS, "preload": {}})])]),
                "schema:FormActions.usercase_preload",
                f"{actions}/usercase_preload",
            ),
            unsettled(
                "app",
                _app(
                    [
                        _module(
                            [
                                _form_json(
                                    usercase_preload={"condition": ALWAYS, "preload": {"/data/q": "name"}},
                                    usercase_update={"condition": ALWAYS, "update": {"name": _update("/data/q")}},
                                )
                            ]
                        )
                    ]
                ),
                "schema:FormActions.usercase_preload",
                f"{actions}/usercase_preload",
            ),
        ),
        "forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-in-a-multi-select-module": (
            refused(
                "app",
                one_form(_form_json(case_preload={"condition": ALWAYS, "preload": {"/data/q": "dob"}}), **multi),
                "schema:FormActions.case_preload",
                f"{actions}/case_preload",
            ),
            accepted(
                "app",
                _question_app(_form_json(case_preload={"condition": ALWAYS, "preload": {"/data/q": "dob"}})),
                "schema:FormActions.case_preload",
                f"{actions}/case_preload",
            ),
        ),
        "forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held": (
            refused(
                "app",
                preload_app(preloaded),
                "schema:FormActions.case_preload",
                f"{actions}/case_preload",
                readings=True,
            ),
            accepted(
                "app", preload_app(unread), "schema:FormActions.case_preload", f"{actions}/case_preload", readings=True
            ),
        ),
        "forms-and-case-writes/case-references-data-save-differing-from-that-computation": (
            refused(
                "app",
                _question_app(
                    {
                        **_form_json(),
                        "case_references_data": {"load": {}, "save": {"/data/q": {"case_type": "patient"}}},
                    }
                ),
                "schema:Form.case_references_data",
                "/modules/0/forms/0/case_references_data",
            ),
            accepted(
                "app",
                _question_app({**_form_json(), "case_references_data": {"load": {"/data/q": ["dob"]}, "save": {}}}),
                "schema:Form.case_references_data",
                "/modules/0/forms/0/case_references_data",
            ),
        ),
        "forms-and-case-writes/a-basic-form-s-own-case-s-close-or-open-condition-on-another": (
            refused(
                "app",
                _question_app(_form_json("none", open_case={"condition": _if("/data/q")})),
                "schema:FormActions.open_case",
                f"{actions}/open_case",
            ),
            refused(
                "app",
                _question_app(_form_json("none", open_case={"condition": _if("/data/s", "'a'")})),
                "schema:FormActions.open_case",
                f"{actions}/open_case",
            ),
            accepted(
                "app",
                _question_app(_form_json("none", open_case={"condition": _if("/data/s")})),
                "schema:FormActions.open_case",
                f"{actions}/open_case",
            ),
            # Each action is read on its own condition: the open case's always beside a quoted close condition.
            accepted(
                "app",
                _question_app(
                    _form_json("none", open_case={"condition": ALWAYS}, close_case={"condition": _if("/data/s", "'a'")})
                ),
                "schema:FormActions.open_case",
                f"{actions}/open_case",
            ),
            refused(
                "app",
                _question_app(
                    _form_json("none", open_case={"condition": ALWAYS}, close_case={"condition": _if("/data/s", "'a'")})
                ),
                "schema:FormActions.close_case",
                f"{actions}/close_case",
            ),
        ),
        "forms-and-case-writes/a-subcase-or-advanced-action-condition-on-a-question-the-picker": (
            refused(
                "app",
                _question_app(_form_json(subcases=[_subcase(condition=_if("/data/q"))])),
                "schema:OpenSubCaseAction.condition",
                f"{subcases}/0/condition",
            ),
            accepted(
                "app",
                _question_app(_form_json(subcases=[_subcase(condition=_if("/data/s"))])),
                "schema:OpenSubCaseAction.condition",
                f"{subcases}/0/condition",
            ),
        ),
        "forms-and-case-writes/an-open-close-child-case-or-advanced-action-condition-with": (
            refused(
                "app",
                _question_app(_form_json("none", open_case={"condition": _if("/data/s", "it's")})),
                "schema:OpenCaseAction.condition",
                f"{actions}/open_case/condition",
            ),
            accepted(
                "app",
                _question_app(_form_json("none", open_case={"condition": _if("/data/s", "its")})),
                "schema:OpenCaseAction.condition",
                f"{actions}/open_case/condition",
            ),
            # A condition's own slot is read on that condition, not on the close condition beside it.
            accepted(
                "app",
                _question_app(
                    _form_json(
                        "none", open_case={"condition": ALWAYS}, close_case={"condition": _if("/data/s", "it's")}
                    )
                ),
                "schema:OpenCaseAction.condition",
                f"{actions}/open_case/condition",
            ),
        ),
        "forms-and-case-writes/a-case-write-name-or-preload-on-a-question-the-picker-does-not": (
            refused(
                "app",
                _question_app(_form_json(update_case={"condition": ALWAYS, "update": {"note": _update("/data/t")}})),
                "schema:ConditionalCaseUpdate.question_path",
                f"{update}/update/note/question_path",
            ),
            refused(
                "app",
                _question_app(
                    _form_json(update_case={"condition": ALWAYS, "update": {"name": _update("/data/rep/name")}})
                ),
                "schema:ConditionalCaseUpdate.question_path",
                f"{update}/update/name/question_path",
            ),
            accepted(
                "app",
                _question_app(_form_json(update_case={"condition": ALWAYS, "update": {"note": _update("/data/q")}})),
                "schema:ConditionalCaseUpdate.question_path",
                f"{update}/update/note/question_path",
            ),
        ),
        "forms-and-case-writes/update-from-an-upload-question-attachment-mode": (
            refused(
                "app",
                _question_app(_form_json(update_case={"condition": ALWAYS, "update": {"photo": _update("/data/u")}})),
                "schema:ConditionalCaseUpdate.question_path",
                f"{update}/update/photo/question_path",
            ),
            accepted(
                "app",
                _question_app(_form_json(update_case={"condition": ALWAYS, "update": {"photo": _update("/data/q")}})),
                "schema:ConditionalCaseUpdate.question_path",
                f"{update}/update/photo/question_path",
            ),
        ),
        "forms-and-case-writes/subcase-of-the-module-s-own-case-type-in-a-project-space-with": (
            unsettled(
                "app",
                _app([_module([_form_json(subcases=[_subcase(case_type="patient")])])]),
                "schema:OpenSubCaseAction.case_type",
                f"{subcases}/0/case_type",
            ),
            accepted(
                "app",
                _app([_module([_form_json(subcases=[_subcase(case_type="child")])])]),
                "schema:OpenSubCaseAction.case_type",
                f"{subcases}/0/case_type",
            ),
        ),
        "forms-and-case-writes/subcases-on-such-a-form-in-an-app-that-shares-cases-where-a": (
            refused(
                "app",
                _app([_module([_form_json(subcases=[_subcase()])], **multi)], case_sharing=True),
                "schema:FormActions.subcases",
                subcases,
            ),
            accepted(
                "app",
                _app(
                    [
                        _module(
                            [_form_json(subcases=[_subcase(case_properties={"owner_id": _update("/data/q")})])], **multi
                        )
                    ],
                    case_sharing=True,
                ),
                "schema:FormActions.subcases",
                subcases,
            ),
        ),
        "forms-and-case-writes/form-links-datums-that-leave-the-target-s-case-id-empty": (
            refused(
                "app",
                _linked(links(datums=[{"name": "case_id", "xpath": ""}])),
                "schema:Form.form_links",
                "/modules/0/forms/0/form_links",
            ),
            accepted(
                "app",
                _linked(links(datums=[{"name": "case_id", "xpath": case_id}])),
                "schema:Form.form_links",
                "/modules/0/forms/0/form_links",
            ),
            # A target menu that offers search selects its case under the same datum.
            refused(
                "app",
                _linked(links(datums=[{"name": "case_id", "xpath": ""}]), search_config=SEARCHING),
                "schema:Form.form_links",
                "/modules/0/forms/0/form_links",
            ),
            accepted(
                "app",
                _linked(links(datums=[{"name": "case_id", "xpath": case_id}]), search_config=SEARCHING),
                "schema:Form.form_links",
                "/modules/0/forms/0/form_links",
            ),
        ),
        "forms-and-case-writes/form-links-datums-with-other-names-or-on-a-module-target": (
            refused(
                "app",
                _linked(links(datums=[{"name": "other_id", "xpath": case_id}])),
                "schema:Form.form_links",
                "/modules/0/forms/0/form_links",
            ),
            accepted(
                "app",
                _linked(links(datums=[{"name": "case_id", "xpath": case_id}])),
                "schema:Form.form_links",
                "/modules/0/forms/0/form_links",
            ),
        ),
        "forms-and-case-writes/form-links-target-any-other-module": (
            refused(
                "app",
                _linked({"doc_type": "FormLink", "module_unique_id": "m2"}, put_in_root=True),
                "schema:FormLink.module_unique_id",
                "/form_links/0/module_unique_id",
            ),
            accepted(
                "app",
                _linked({"doc_type": "FormLink", "module_unique_id": "m2"}),
                "schema:FormLink.module_unique_id",
                "/form_links/0/module_unique_id",
            ),
            # A child menu: matched where the linking form's menu has a parent of the target's parent's case type.
            refused(
                "app",
                _child_linked(source_parent=None),
                "schema:FormLink.module_unique_id",
                "/form_links/0/module_unique_id",
            ),
            accepted(
                "app",
                _child_linked(source_parent="patient"),
                "schema:FormLink.module_unique_id",
                "/form_links/0/module_unique_id",
            ),
            refused(
                "app",
                _child_linked(source_parent="household"),
                "schema:FormLink.module_unique_id",
                "/form_links/0/module_unique_id",
            ),
        ),
        "forms-and-case-writes/any-other-post-form-workflow-outside-the-offered-set-previous": (
            refused(
                "app",
                _app([_module([{**_form_json(), "post_form_workflow": "previous_screen"}], **multi)]),
                "schema:Form.post_form_workflow",
                workflow,
            ),
            accepted(
                "app",
                _app([_module([{**_form_json(), "post_form_workflow": "module"}], **multi)]),
                "schema:Form.post_form_workflow",
                workflow,
            ),
        ),
        "forms-and-case-writes/post-form-workflow-fallback-module-parent-module-or-previous": (
            refused(
                "app",
                _app(
                    [
                        _module(
                            [
                                {
                                    **_form_json(),
                                    "post_form_workflow": "form",
                                    "post_form_workflow_fallback": "previous_screen",
                                    "form_links": [{"doc_type": "FormLink", "xpath": "true()", "form_id": "f"}],
                                }
                            ],
                            **multi,
                        )
                    ]
                ),
                "schema:Form.post_form_workflow_fallback",
                "/modules/0/forms/0/post_form_workflow_fallback",
            ),
            accepted(
                "app",
                _app(
                    [
                        _module(
                            [
                                {
                                    **_form_json(),
                                    "post_form_workflow": "form",
                                    "post_form_workflow_fallback": "module",
                                    "form_links": [{"doc_type": "FormLink", "xpath": "true()", "form_id": "f"}],
                                }
                            ]
                        )
                    ]
                ),
                "schema:Form.post_form_workflow_fallback",
                "/modules/0/forms/0/post_form_workflow_fallback",
            ),
        ),
        "forms-and-case-writes/session-endpoint-id-not-a-slug-fixed-point-or-duplicated": (
            refused(
                "app",
                _app([_module([{**_form_json(), "session_endpoint_id": "My Form"}])]),
                "schema:Form.session_endpoint_id",
                "/modules/0/forms/0/session_endpoint_id",
            ),
            refused(
                "app",
                _app([_module([{**_form_json(), "session_endpoint_id": "visit"}], session_endpoint_id="visit")]),
                "schema:Form.session_endpoint_id",
                "/modules/0/forms/0/session_endpoint_id",
            ),
            accepted(
                "app",
                _app([_module([{**_form_json(), "session_endpoint_id": "my-form"}])]),
                "schema:Form.session_endpoint_id",
                "/modules/0/forms/0/session_endpoint_id",
            ),
        ),
        "forms-and-case-writes/form-filter-using-fixture-value": (
            refused(
                "app",
                _app([_module([{**_form_json(), "form_filter": "$fixture_value = 1"}])]),
                "schema:Form.form_filter",
                "/modules/0/forms/0/form_filter",
            ),
            accepted(
                "app",
                _app([_module([{**_form_json(), "form_filter": "true()"}])]),
                "schema:Form.form_filter",
                "/modules/0/forms/0/form_filter",
            ),
        ),
    }


def _search_and_menus():
    config = "/modules/0/search_config"
    prompts = f"{config}/properties/0"
    short = "/modules/0/case_details/short"
    long_ = "/modules/0/case_details/long"
    tile = {"case_tile_template": "custom"}

    def search(*modules, **fields):
        return _app(list(modules), **fields)

    def details(*modules):
        return _app(list(modules))

    def columns_app(*columns, doc_type="Module", where="short", **fields):
        placed = {"columns": columns} if where == "short" else {"long_columns": columns}
        return details(_detail_module(**placed, doc_type=doc_type, **fields))

    def plain(**module):
        return _module(unique_id=module.pop("unique_id", "p"), **module)

    multi = {"short": {"multi_select": True}}
    return {
        # Case search
        "case-search/a-commcare-sort-x-commcare-custom-related-case-property-or-case": (
            refused(
                "app",
                search(_search_module(default_properties=[_default("commcare_sort", "concat('a', 'b')")])),
                "schema:CaseSearch.default_properties",
                f"{config}/default_properties",
                readings=True,
            ),
            accepted(
                "app",
                search(_search_module(default_properties=[_default("commcare_sort", "'name'")])),
                "schema:CaseSearch.default_properties",
                f"{config}/default_properties",
                readings=True,
            ),
        ),
        "case-search/an-x-commcare-custom-related-case-property-entry-together-with": (
            refused(
                "app",
                search(
                    _search_module(
                        custom_related_case_property="parent/x",
                        default_properties=[_default("x_commcare_custom_related_case_property", "'parent/x'")],
                    )
                ),
                "schema:CaseSearch.custom_related_case_property",
                f"{config}/custom_related_case_property",
            ),
            accepted(
                "app",
                search(_search_module(custom_related_case_property="parent/x")),
                "schema:CaseSearch.custom_related_case_property",
                f"{config}/custom_related_case_property",
            ),
        ),
        "case-search/default-properties-entry-keyed-x-commcare-data-registry": (
            refused(
                "app",
                search(_search_module(default_properties=[_default("x_commcare_data_registry", "'r'")])),
                "schema:DefaultCaseSearchProperty.property",
                f"{config}/default_properties/0/property",
            ),
            accepted(
                "app",
                search(_search_module(default_properties=[_default("status", "'open'")])),
                "schema:DefaultCaseSearchProperty.property",
                f"{config}/default_properties/0/property",
            ),
        ),
        "case-search/default-properties-entry-keyed-x-commcare-endpoint-id": (
            refused(
                "app",
                search(_search_module(default_properties=[_default("x_commcare_endpoint_id", "'e'")])),
                "schema:DefaultCaseSearchProperty.property",
                f"{config}/default_properties/0/property",
            ),
            accepted(
                "app",
                search(_search_module(default_properties=[_default("status", "'open'")])),
                "schema:DefaultCaseSearchProperty.property",
                f"{config}/default_properties/0/property",
            ),
        ),
        "case-search/default-properties-entry-with-no-defaultvalue-hq-stores-an-empty": (
            refused(
                "app",
                search(_search_module(default_properties=[_default("status")])),
                "schema:CaseSearch.default_properties",
                f"{config}/default_properties",
            ),
            accepted(
                "app",
                search(_search_module(default_properties=[_default("status", "'open'")])),
                "schema:CaseSearch.default_properties",
                f"{config}/default_properties",
            ),
        ),
        "case-search/that-entry-together-with-blacklisted-owner-ids-expression": (
            refused(
                "app",
                search(
                    _search_module(
                        blacklisted_owner_ids_expression="'a'",
                        default_properties=[_default("commcare_blacklisted_owner_ids", "'b'")],
                    )
                ),
                "schema:CaseSearch.blacklisted_owner_ids_expression",
                f"{config}/blacklisted_owner_ids_expression",
            ),
            accepted(
                "app",
                search(_search_module(blacklisted_owner_ids_expression="'a'")),
                "schema:CaseSearch.blacklisted_owner_ids_expression",
                f"{config}/blacklisted_owner_ids_expression",
            ),
        ),
        "case-search/a-default-filter-and-a-search-property-sharing-one-name": (
            refused(
                "app",
                search(_search_module(properties=[_prompt("dob")], default_properties=[_default("dob", "'x'")])),
                "schema:CaseSearchProperty.name",
                f"{prompts}/name",
            ),
            accepted(
                "app",
                search(_search_module(properties=[_prompt("dob")], default_properties=[_default("status", "'x'")])),
                "schema:CaseSearchProperty.name",
                f"{prompts}/name",
            ),
        ),
        "case-search/appearance-address-with-required-or-validations": (
            refused(
                "app",
                search(
                    _search_module(
                        properties=[
                            _prompt(
                                "dob", appearance="address", validations=[{"doc_type": "Assertion", "test": "true()"}]
                            )
                        ]
                    )
                ),
                "schema:CaseSearchProperty.appearance",
                f"{prompts}/appearance",
            ),
            accepted(
                "app",
                search(_search_module(properties=[_prompt("dob", appearance="address")])),
                "schema:CaseSearchProperty.appearance",
                f"{prompts}/appearance",
            ),
        ),
        "case-search/hidden-together-with-required-or-validations": (
            refused(
                "app",
                search(
                    _search_module(
                        properties=[_prompt("dob", hidden=True, required={"doc_type": "Assertion", "test": "true()"})]
                    )
                ),
                "schema:CaseSearchProperty.hidden",
                f"{prompts}/hidden",
            ),
            accepted(
                "app",
                search(_search_module(properties=[_prompt("dob", hidden=True)])),
                "schema:CaseSearchProperty.hidden",
                f"{prompts}/hidden",
            ),
        ),
        "case-search/validations-1": (
            refused(
                "app",
                search(
                    _search_module(
                        properties=[
                            _prompt(
                                "dob",
                                validations=[
                                    {"doc_type": "Assertion", "test": "true()"},
                                    {"doc_type": "Assertion", "test": "false()"},
                                ],
                            )
                        ]
                    )
                ),
                "schema:CaseSearchProperty.validations",
                f"{prompts}/validations",
            ),
            accepted(
                "app",
                search(
                    _search_module(
                        properties=[_prompt("dob", validations=[{"doc_type": "Assertion", "test": "true()"}])]
                    )
                ),
                "schema:CaseSearchProperty.validations",
                f"{prompts}/validations",
            ),
        ),
        "case-search/input-select1-select-commcare-reports-itemset-mobile-ucr": (
            refused(
                "app",
                search(
                    _search_module(
                        properties=[
                            _prompt(
                                "dob",
                                input_="select1",
                                itemset={"doc_type": "Itemset", "instance_id": "commcare-reports:r1"},
                            )
                        ]
                    )
                ),
                "schema:CaseSearchProperty.input_",
                f"{prompts}/input_",
            ),
            accepted(
                "app",
                search(
                    _search_module(
                        properties=[
                            _prompt(
                                "dob",
                                input_="select1",
                                itemset={"doc_type": "Itemset", "instance_id": "item-list:regions"},
                            )
                        ]
                    )
                ),
                "schema:CaseSearchProperty.input_",
                f"{prompts}/input_",
            ),
        ),
        "case-search/search-button-label-any-other-value": (
            refused(
                "app",
                search(_search_module(search_button_label={"en": "Search"})),
                "schema:CaseSearch.search_button_label",
                f"{config}/search_button_label",
            ),
        ),
        "case-search/workflow-legacy-classic-auto-launch-false-in-an-app-with": (
            refused(
                "app",
                search(_search_module(properties=[_prompt("dob")], default_search=True), cloudcare_enabled=True),
                "schema:CaseSearch.default_search",
                f"{config}/default_search",
            ),
            accepted(
                "app",
                search(_search_module(properties=[_prompt("dob")], auto_launch=True), cloudcare_enabled=True),
                "schema:CaseSearch.auto_launch",
                f"{config}/auto_launch",
            ),
            unsettled("suite", SEARCH_SUITE, "parser:SessionDatumParser/query@default_search", "/@default_search"),
        ),
        "case-search/a-prompt-that-reaches-hq-as-its-own-key-named-as-a-config-keys": (
            refused(
                "app",
                search(_search_module(properties=[_prompt("indices.parent")])),
                "schema:CaseSearchProperty.name",
                f"{prompts}/name",
            ),
            accepted(
                "app",
                search(_search_module(properties=[_prompt("dob")])),
                "schema:CaseSearchProperty.name",
                f"{prompts}/name",
            ),
            refused("suite", SEARCH_SUITE, "parser:QueryPromptParser/prompt@key", "prompt[1]/@key"),
        ),
        "case-search/property-names-operators-or-function-names-computed-at-runtime": (
            refused(
                "app",
                search(_search_module(default_properties=[_default("_xpath_query", "concat(/data/p, ' = 1')")])),
                "schema:DefaultCaseSearchProperty.defaultValue",
                f"{config}/default_properties/0/defaultValue",
                readings=True,
            ),
            accepted(
                "app",
                search(_search_module(default_properties=[_default("_xpath_query", "'dob = \"2020-01-01\"'")])),
                "schema:DefaultCaseSearchProperty.defaultValue",
                f"{config}/default_properties/0/defaultValue",
                readings=True,
            ),
        ),
        "case-search/p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of": (
            refused("suite", CSQL_SUITE, "csql-op:>", "/data[1]/@ref", readings=True),
            accepted("suite", CSQL_SUITE, "csql-op:>", "/data[2]/@ref", readings=True),
            unsettled("suite", CSQL_SUITE, "csql-op:>", "/data[6]/@ref", readings=True),
        ),
        "case-search/date-opened-closed-on-or-last-modified-compared-with-any": (
            refused("suite", CSQL_SUITE, "csql-metadata:date_opened", "/data[4]/@ref", readings=True),
            accepted("suite", CSQL_SUITE, "csql-metadata:date_opened", "/data[5]/@ref", readings=True),
        ),
        # Menus and case lists
        "menus-and-case-lists/menu-order-that-separates-a-child-from-its-parent": (
            refused(
                "app",
                _app([plain(), plain(unique_id="s"), plain(unique_id="c", root_module_id="p")]),
                "schema:Application.modules",
                "/modules",
            ),
            accepted(
                "app",
                _app([plain(), plain(unique_id="c", root_module_id="p"), plain(unique_id="s")]),
                "schema:Application.modules",
                "/modules",
            ),
        ),
        "menus-and-case-lists/module-unique-id-missing": (
            refused("app", _app([plain(unique_id="")]), "schema:Module.unique_id", "/modules/0/unique_id"),
            accepted("app", _app([plain(unique_id="m1")]), "schema:Module.unique_id", "/modules/0/unique_id"),
        ),
        "menus-and-case-lists/case-type-commcare-user-or-user-owner-mapping-case-on-a-basic": (
            refused("app", _app([plain(case_type="commcare-user")]), "schema:Module.case_type", "/modules/0/case_type"),
            accepted("app", _app([plain(case_type="patient")]), "schema:Module.case_type", "/modules/0/case_type"),
        ),
        "menus-and-case-lists/module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed": (
            refused(
                "app",
                _app([plain(session_endpoint_id="My Menu")]),
                "schema:Module.session_endpoint_id",
                "/modules/0/session_endpoint_id",
            ),
            accepted(
                "app",
                _app([plain(session_endpoint_id="my-menu")]),
                "schema:Module.session_endpoint_id",
                "/modules/0/session_endpoint_id",
            ),
        ),
        "menus-and-case-lists/two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form": (
            refused(
                "app",
                _app([plain(session_endpoint_id="visit"), plain(unique_id="q", session_endpoint_id="visit")]),
                "schema:Module.session_endpoint_id",
                "/modules/0/session_endpoint_id",
            ),
            accepted(
                "app",
                _app([plain(session_endpoint_id="visit"), plain(unique_id="q", session_endpoint_id="b")]),
                "schema:Module.session_endpoint_id",
                "/modules/0/session_endpoint_id",
            ),
            refused("suite", ENDPOINTS, "parser:EndpointParser/endpoint@id", "endpoint[1]/@id"),
            accepted("suite", ENDPOINTS, "parser:EndpointParser/endpoint@id", "endpoint[3]/@id"),
        ),
        "menus-and-case-lists/module-task-list-show-true": (
            refused(
                "app",
                _app([plain(task_list={"doc_type": "CaseList", "show": True})]),
                "schema:CaseList.show",
                "/modules/0/task_list/show",
            ),
            accepted(
                "app",
                _app([plain(case_list={"doc_type": "CaseList", "show": True})]),
                "schema:CaseList.show",
                "/modules/0/case_list/show",
            ),
        ),
        "menus-and-case-lists/shadowmodule-case-list-show-true": (
            refused(
                "app",
                _app([plain(doc_type="ShadowModule", case_list={"doc_type": "CaseList", "show": True})]),
                "schema:CaseList.show",
                "/modules/0/case_list/show",
            ),
            accepted(
                "app",
                _app([plain(case_list={"doc_type": "CaseList", "show": True})]),
                "schema:CaseList.show",
                "/modules/0/case_list/show",
            ),
        ),
        **{
            entry: (
                refused(
                    "app",
                    columns_app(_column(fmt=slug), _column()),
                    "schema:DetailColumn.format",
                    f"{short}/columns/0/format",
                ),
                accepted(
                    "app",
                    columns_app(_column(fmt=slug), _column()),
                    "schema:DetailColumn.format",
                    f"{short}/columns/1/format",
                ),
            )
            for entry, slug in (
                ("menus-and-case-lists/15-address-popup", "address-popup"),
                ("menus-and-case-lists/17-picture", "picture"),
                ("menus-and-case-lists/18-audio", "audio"),
                ("menus-and-case-lists/22-graph", "graph"),
                ("menus-and-case-lists/23-image-cc-case-image", "image"),
            )
        },
        "menus-and-case-lists/model-product": (
            refused(
                "app", columns_app(_column(model="product")), "schema:DetailColumn.model", f"{short}/columns/0/model"
            ),
            accepted(
                "app", columns_app(_column(model="case")), "schema:DetailColumn.model", f"{short}/columns/0/model"
            ),
        ),
        "menus-and-case-lists/16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case": (
            refused(
                "app",
                columns_app(_column(fmt="clickable-icon"), doc_type="AdvancedModule"),
                "format:clickable-icon",
                f"{short}/columns/0/format",
            ),
            accepted(
                "app", columns_app(_column(fmt="clickable-icon")), "format:clickable-icon", f"{short}/columns/0/format"
            ),
        ),
        "menus-and-case-lists/16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint": (
            refused(
                "app",
                columns_app(_column(fmt="clickable-icon"), where="long"),
                "format:clickable-icon",
                f"{long_}/columns/0/format",
            ),
            accepted(
                "app", columns_app(_column(fmt="clickable-icon")), "format:clickable-icon", f"{short}/columns/0/format"
            ),
        ),
        "menus-and-case-lists/21p-translatable-enum-key-outside-a-za-z0-9": (
            refused(
                "app",
                columns_app(_column(fmt="translatable-enum", enum=[{"key": "a b", "value": {}}])),
                "format:translatable-enum",
                f"{short}/columns/0/format",
            ),
            accepted(
                "app",
                columns_app(_column(fmt="translatable-enum", enum=[{"key": "a_b", "value": {}}])),
                "format:translatable-enum",
                f"{short}/columns/0/format",
            ),
        ),
        "menus-and-case-lists/translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-offers": (
            refused(
                "app",
                columns_app(
                    _column("parent/kind", "translatable-enum"),
                    search_config={"doc_type": "CaseSearch", "properties": [_prompt("dob")]},
                ),
                "format:translatable-enum",
                f"{short}/columns/0/format",
            ),
            accepted(
                "app",
                columns_app(
                    _column("kind", "translatable-enum"),
                    search_config={"doc_type": "CaseSearch", "properties": [_prompt("dob")]},
                ),
                "format:translatable-enum",
                f"{short}/columns/0/format",
            ),
        ),
        "menus-and-case-lists/5p-enum-key-containing": (
            refused(
                "app",
                columns_app(_column(fmt="enum", enum=[{"key": "a&b", "value": {}}])),
                "format:enum",
                f"{short}/columns/0/format",
            ),
            accepted(
                "app",
                columns_app(_column(fmt="enum", enum=[{"key": "ab", "value": {}}])),
                "format:enum",
                f"{short}/columns/0/format",
            ),
        ),
        "menus-and-case-lists/an-enum-enum-image-conditional-enum-or-translatable-enum-column": (
            refused(
                "app",
                columns_app(_column(fmt="enum", enum=[{"key": "a", "value": {}}, {"key": "a", "value": {}}])),
                "format:enum",
                f"{short}/columns/0/format",
            ),
            accepted(
                "app",
                columns_app(_column(fmt="enum", enum=[{"key": "a", "value": {}}, {"key": "b", "value": {}}])),
                "format:enum",
                f"{short}/columns/0/format",
            ),
        ),
        "menus-and-case-lists/2p-date-any-other-date-format": (
            refused(
                "app",
                columns_app(_column("dob", "date", date_format="%Y-%m-%d %I:%M")),
                "schema:DetailColumn.date_format",
                f"{short}/columns/0/date_format",
            ),
            accepted(
                "app",
                columns_app(_column("dob", "date", date_format="%d/%m/%Y")),
                "schema:DetailColumn.date_format",
                f"{short}/columns/0/date_format",
            ),
            # A pattern HQ's menu does not offer that Core formats, which HQ's Case List page keeps.
            accepted(
                "app",
                columns_app(_column("dob", "date", date_format="%Y-%m-%d")),
                "schema:DetailColumn.date_format",
                f"{short}/columns/0/date_format",
            ),
        ),
        "menus-and-case-lists/3p-time-ago-other-interval": (
            refused(
                "app",
                columns_app(_column("seen", "time-ago", time_ago_interval=3.0)),
                "schema:DetailColumn.time_ago_interval",
                f"{short}/columns/0/time_ago_interval",
            ),
            accepted(
                "app",
                columns_app(_column("seen", "time-ago", time_ago_interval=7.0)),
                "schema:DetailColumn.time_ago_interval",
                f"{short}/columns/0/time_ago_interval",
            ),
        ),
        "menus-and-case-lists/a-geo-column-without-the-column-it-depends-on": (
            refused("app", columns_app(_column("loc", "geo-points")), "format:geo-points", f"{short}/columns/0/format"),
            accepted(
                "app",
                columns_app(_column("loc", "geo-points"), _column("home", "address")),
                "format:geo-points",
                f"{short}/columns/0/format",
            ),
        ),
        "menus-and-case-lists/24p-filter-otherwise": (
            refused(
                "app", columns_app(_column("x", "filter"), _column()), "format:filter", f"{short}/columns/0/format"
            ),
            accepted(
                "app", columns_app(_column(), _column("x", "filter")), "format:filter", f"{short}/columns/1/format"
            ),
        ),
        "menus-and-case-lists/more-than-one-address-column-or-more-than-one-image-or-geo": (
            refused(
                "app",
                columns_app(_column("a", "image"), _column("b", "image")),
                "format:image",
                f"{short}/columns/0/format",
            ),
            accepted(
                "app",
                columns_app(_column("a", "image"), _column("b", "plain")),
                "format:image",
                f"{short}/columns/0/format",
            ),
        ),
        "menus-and-case-lists/more-than-one-image-or-geo-column-of-the-same-format-in-a-detail": (
            refused(
                "app",
                columns_app(_column("a", "image"), _column("b", "image"), doc_type="AdvancedModule"),
                "format:image",
                f"{short}/columns/0/format",
            ),
            accepted(
                "app",
                columns_app(_column("a", "image"), _column("b", "image")),
                "format:image",
                f"{short}/columns/0/format",
            ),
        ),
        "menus-and-case-lists/field-failing-details-utils-js-isvalidpropertyname-non": (
            refused("app", columns_app(_column("dob\n")), "schema:DetailColumn.field", f"{short}/columns/0/field"),
            refused("app", columns_app(_column("2dob")), "schema:DetailColumn.field", f"{short}/columns/0/field"),
            accepted(
                "app", columns_app(_column("parent/dob")), "schema:DetailColumn.field", f"{short}/columns/0/field"
            ),
        ),
        "menus-and-case-lists/property-x-or-prefix-x-with-a-prefix-hq-registers-no-generator": (
            refused(
                "app", columns_app(_column("property:dob")), "detail-field-type:property", f"{short}/columns/0/field"
            ),
            accepted("app", columns_app(_column("dob")), "detail-field-type:property", f"{short}/columns/0/field"),
        ),
        "menus-and-case-lists/custom-tile-column-with-grid-null-unplaced": (
            refused(
                "app",
                columns_app(_column(grid_x=1), short=tile),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/0/grid_x",
            ),
            accepted(
                "app",
                columns_app(_column(grid_x=1, grid_y=0), short=tile),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/0/grid_x",
            ),
            # Both coordinates null are HQ's defaults, no use of either: the tile's template holds the column.
            refused(
                "app",
                columns_app(_column(), short=tile),
                "schema:Detail.case_tile_template",
                f"{short}/case_tile_template",
            ),
            accepted(
                "app",
                columns_app(_column(grid_x=0, grid_y=0), short=tile),
                "schema:Detail.case_tile_template",
                f"{short}/case_tile_template",
            ),
        ),
        # A null font_size or horizontal_align is HQ's default, no use of the key: the tile's template is the use
        # the check reads the column's class on.
        "menus-and-case-lists/custom-tile-font-size-null": (
            refused(
                "app",
                columns_app(_column(font_size=None), short=tile),
                "schema:Detail.case_tile_template",
                f"{short}/case_tile_template",
            ),
            accepted(
                "app",
                columns_app(_column(font_size="small"), short=tile),
                "schema:Detail.case_tile_template",
                f"{short}/case_tile_template",
            ),
        ),
        "menus-and-case-lists/horizontal-align-null-on-a-placed-custom-tile-column": (
            refused(
                "app",
                columns_app(_column(grid_x=0, grid_y=0, horizontal_align=None), short=tile),
                "schema:Detail.case_tile_template",
                f"{short}/case_tile_template",
            ),
            accepted(
                "app",
                columns_app(_column(grid_x=0, grid_y=0, horizontal_align="left"), short=tile),
                "schema:Detail.case_tile_template",
                f"{short}/case_tile_template",
            ),
        ),
        "menus-and-case-lists/detail-case-tile-template-person-simple": (
            refused(
                "app",
                columns_app(short={"case_tile_template": "person_simple"}),
                "schema:Detail.case_tile_template",
                f"{short}/case_tile_template",
            ),
            accepted(
                "app",
                columns_app(long={"case_tile_template": "person_simple"}),
                "schema:Detail.case_tile_template",
                f"{long_}/case_tile_template",
            ),
        ),
        "menus-and-case-lists/long-detail-non-custom-tile": (
            refused(
                "app",
                columns_app(long={"case_tile_template": "person_simple"}),
                "schema:Detail.case_tile_template",
                f"{long_}/case_tile_template",
            ),
            accepted(
                "app",
                columns_app(long={"case_tile_template": "custom"}),
                "schema:Detail.case_tile_template",
                f"{long_}/case_tile_template",
            ),
        ),
        "menus-and-case-lists/field-and-a-differing-sort-calculation-on-any-other-column": (
            refused(
                "app",
                columns_app(
                    _column("dob"),
                    short={"sort_elements": [{"doc_type": "SortElement", "field": "dob", "sort_calculation": "x"}]},
                ),
                "schema:SortElement.sort_calculation",
                f"{short}/sort_elements/0/sort_calculation",
            ),
            accepted(
                "app",
                columns_app(
                    _column("dob", "date"),
                    short={"sort_elements": [{"doc_type": "SortElement", "field": "dob", "sort_calculation": "x"}]},
                ),
                "schema:SortElement.sort_calculation",
                f"{short}/sort_elements/0/sort_calculation",
            ),
            # A calculated column's sort field, which HQ attaches to the column at its index: its own expression
            # is the HELD class beside this one, and another expression is this one.
            accepted(
                "app",
                columns_app(
                    _column("x + 1", useXpathExpression=True),
                    short={
                        "sort_elements": [
                            {"doc_type": "SortElement", "field": "_cc_calculated_0", "sort_calculation": "x + 1"}
                        ]
                    },
                ),
                "schema:SortElement.sort_calculation",
                f"{short}/sort_elements/0/sort_calculation",
            ),
            refused(
                "app",
                columns_app(
                    _column("x + 1", useXpathExpression=True),
                    short={
                        "sort_elements": [
                            {"doc_type": "SortElement", "field": "_cc_calculated_0", "sort_calculation": "x + 2"}
                        ]
                    },
                ),
                "schema:SortElement.sort_calculation",
                f"{short}/sort_elements/0/sort_calculation",
            ),
        ),
        "menus-and-case-lists/short-columns-empty-on-a-module-another-module-s-active-parent": (
            refused(
                "app",
                details(
                    _detail_module(long_columns=[_column()], unique_id="a"),
                    _module(unique_id="b", parent_select={"active": True, "module_id": "a"}),
                ),
                "schema:Detail.columns",
                f"{long_}/columns",
            ),
            accepted(
                "app",
                details(
                    _detail_module([_column()], unique_id="a"),
                    _module(unique_id="b", parent_select={"active": True, "module_id": "a"}),
                ),
                "schema:Detail.columns",
                f"{short}/columns",
            ),
        ),
        "menus-and-case-lists/case-list-form-on-a-child-put-in-root-module-whose-parent-s-case": (
            refused(
                "app",
                _app(
                    [
                        plain(case_list_form={"form_id": "r"}),
                        plain(unique_id="c", root_module_id="p", put_in_root=True, case_list_form={"form_id": "r"}),
                    ]
                ),
                "schema:CaseListForm.form_id",
                "/modules/1/case_list_form/form_id",
            ),
            accepted(
                "app",
                _app(
                    [
                        plain(case_list_form={"form_id": "r"}),
                        plain(unique_id="c", root_module_id="p", put_in_root=True, case_list_form={"form_id": "s"}),
                    ]
                ),
                "schema:CaseListForm.form_id",
                "/modules/1/case_list_form/form_id",
            ),
        ),
        "menus-and-case-lists/case-list-form-on-a-module-whose-forms-do-not-all-require-a-case": (
            refused(
                "app",
                _app([plain(forms=[_form_json("none")], case_list_form={"form_id": "r"})]),
                "schema:CaseListForm.form_id",
                "/modules/0/case_list_form/form_id",
            ),
            accepted(
                "app",
                _app([plain(forms=[_form_json("case")], case_list_form={"form_id": "r"})]),
                "schema:CaseListForm.form_id",
                "/modules/0/case_list_form/form_id",
            ),
        ),
        "menus-and-case-lists/case-list-form-on-a-put-in-root-module-whose-case-list-is-a-tile": (
            refused(
                "app",
                columns_app(
                    put_in_root=True, case_list_form={"form_id": "r"}, short={"case_tile_template": "person_simple"}
                ),
                "schema:CaseListForm.form_id",
                "/modules/0/case_list_form/form_id",
            ),
            accepted(
                "app",
                columns_app(case_list_form={"form_id": "r"}, short={"case_tile_template": "person_simple"}),
                "schema:CaseListForm.form_id",
                "/modules/0/case_list_form/form_id",
            ),
        ),
        "menus-and-case-lists/any-module-under-a-training-menu": (
            refused(
                "app",
                _app([plain(is_training_module=True), plain(unique_id="c", root_module_id="p")]),
                "schema:Module.root_module_id",
                "/modules/1/root_module_id",
            ),
            accepted(
                "app",
                _app([plain(), plain(unique_id="c", root_module_id="p")]),
                "schema:Module.root_module_id",
                "/modules/1/root_module_id",
            ),
        ),
        "menus-and-case-lists/any-other-module-under-a-shadow-menu": (
            refused(
                "app",
                _app([plain(doc_type="ShadowModule"), plain(unique_id="c", root_module_id="p")]),
                "schema:Module.root_module_id",
                "/modules/1/root_module_id",
            ),
            accepted(
                "app",
                _app([plain(), plain(unique_id="c", root_module_id="p")]),
                "schema:Module.root_module_id",
                "/modules/1/root_module_id",
            ),
            unsettled(
                "app",
                _app(
                    [plain(doc_type="ShadowModule"), plain(doc_type="ShadowModule", unique_id="c", root_module_id="p")]
                ),
                "schema:ShadowModule.root_module_id",
                "/modules/1/root_module_id",
            ),
        ),
        "menus-and-case-lists/child-menu-deeper-than-one-tier-grandchild": (
            refused(
                "app",
                _app([plain(), plain(unique_id="c", root_module_id="p"), plain(unique_id="g", root_module_id="c")]),
                "schema:Module.root_module_id",
                "/modules/2/root_module_id",
            ),
            accepted(
                "app",
                _app([plain(), plain(unique_id="c", root_module_id="p"), plain(unique_id="g", root_module_id="c")]),
                "schema:Module.root_module_id",
                "/modules/1/root_module_id",
            ),
        ),
        "menus-and-case-lists/module-with-is-training-module-true-training-menu-root-training": (
            refused(
                "app",
                _app([plain(is_training_module=True)]),
                "schema:Module.is_training_module",
                "/modules/0/is_training_module",
            ),
            unsettled("suite", MENUS, "parser:MenuParser/menu@root", "menu[2]/@root"),
        ),
        "menus-and-case-lists/custom-assertions-module-non-empty": (
            refused(
                "app",
                _app([plain(custom_assertions=[{"doc_type": "CustomAssertion", "test": "true()"}])]),
                "schema:Module.custom_assertions",
                "/modules/0/custom_assertions",
            ),
            accepted(
                "app",
                _app(
                    [
                        plain(
                            forms=[
                                {
                                    **_form_json(),
                                    "custom_assertions": [{"doc_type": "CustomAssertion", "test": "true()"}],
                                }
                            ]
                        )
                    ]
                ),
                "schema:CustomAssertion.test",
                "/modules/0/forms/0/custom_assertions/0/test",
            ),
        ),
        "menus-and-case-lists/parent-select-module-id-naming-a-multi-select-module-or-an": (
            refused(
                "app",
                details(
                    _detail_module(unique_id="a", **multi),
                    _module(unique_id="b", parent_select={"active": True, "module_id": "a"}),
                ),
                "schema:ParentSelect.module_id",
                "/modules/1/parent_select/module_id",
            ),
            accepted(
                "app",
                details(
                    _detail_module(unique_id="a"),
                    _module(unique_id="b", parent_select={"active": True, "module_id": "a"}),
                ),
                "schema:ParentSelect.module_id",
                "/modules/1/parent_select/module_id",
            ),
        ),
        "menus-and-case-lists/parent-select-naming-a-survey-module-on-a-child-that-shows-its": (
            refused(
                "app",
                _app(
                    [
                        plain(unique_id="a", case_type=""),
                        plain(
                            unique_id="b",
                            case_list={"doc_type": "CaseList", "show": True},
                            parent_select={"active": True, "module_id": "a"},
                        ),
                    ]
                ),
                "schema:ParentSelect.module_id",
                "/modules/1/parent_select/module_id",
            ),
            accepted(
                "app",
                _app(
                    [
                        plain(unique_id="a"),
                        plain(
                            unique_id="b",
                            case_list={"doc_type": "CaseList", "show": True},
                            parent_select={"active": True, "module_id": "a"},
                        ),
                    ]
                ),
                "schema:ParentSelect.module_id",
                "/modules/1/parent_select/module_id",
            ),
        ),
        "menus-and-case-lists/detail-max-select-value-of-0-or-below-1-on-a-multi-select-basic": (
            refused(
                "app",
                columns_app(short={"multi_select": True, "max_select_value": 0}),
                "schema:Detail.max_select_value",
                f"{short}/max_select_value",
            ),
            accepted(
                "app",
                columns_app(short={"multi_select": True, "max_select_value": 5}),
                "schema:Detail.max_select_value",
                f"{short}/max_select_value",
            ),
            refused("suite", MENUS, "parser:SessionDatumParser/instance-datum@max-select-value", "/@max-select-value"),
        ),
        "menus-and-case-lists/detail-filter-failing-etree-xpath-dummy-filter": (
            refused(
                "app",
                columns_app(short={"filter": "1 +"}, doc_type="AdvancedModule"),
                "schema:Detail.filter",
                f"{short}/filter",
                readings=True,
            ),
            accepted(
                "app",
                columns_app(short={"filter": "dob > 1"}, doc_type="AdvancedModule"),
                "schema:Detail.filter",
                f"{short}/filter",
                readings=True,
            ),
        ),
        "menus-and-case-lists/type-index-cache-and-index-order-2": (
            refused(
                "app",
                columns_app(
                    _column("dob"),
                    short={"sort_elements": [{"doc_type": "SortElement", "field": "dob", "type": "index"}]},
                ),
                "schema:SortElement.type",
                f"{short}/sort_elements/0/type",
            ),
            accepted(
                "app",
                columns_app(
                    _column("dob"),
                    short={"sort_elements": [{"doc_type": "SortElement", "field": "dob", "type": "string"}]},
                ),
                "schema:SortElement.type",
                f"{short}/sort_elements/0/type",
            ),
        ),
        # Expressions and data
        "expressions-and-data/results-read-in-form-expressions-reached-through-a-search-that": (
            refused("suite", SEARCH_SUITE, "instance-scheme:results", "entry[1]/instance[1]/@id"),
            accepted("suite", SEARCH_SUITE, "instance-scheme:results", "entry[2]/instance[1]/@id"),
        ),
        "expressions-and-data/search-input-read-in-form-expressions-reached-through-a-search": (
            refused("suite", INPUTS_SUITE, "instance-scheme:search-input", "entry[1]/instance[1]/@id"),
            accepted("suite", INPUTS_SUITE, "instance-scheme:search-input", "entry[2]/instance[1]/@id"),
        ),
        "expressions-and-data/legacy-search-input-read-after-the-query-in-the-results-detail": (
            refused("suite", INPUTS_SUITE, "instance-scheme:search-input", "entry[3]/instance[1]/@id"),
            accepted("suite", INPUTS_SUITE, "instance-scheme:search-input", "remote-request[1]/instance[1]/@id"),
        ),
        "expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install": (
            unsettled(
                "app",
                _media_app("commcare/a.png", "CommCareImage", profile={"properties": {"cc-content-valid": "no"}}),
                "schema:Application.multimedia_map",
                "/multimedia_map",
            ),
            accepted(
                "app",
                _media_app("commcare/a.png", "CommCareImage"),
                "schema:Application.multimedia_map",
                "/multimedia_map",
            ),
        ),
        "expressions-and-data/image-tiff-heif": _media_shapes(
            "CommCareImage", "media-class:CommCareImage", ("a.tif", TIFF), ("b.png", _png())
        ),
        "expressions-and-data/audio-wav-that-is-not-8-or-16-bit-pcm": _media_shapes(
            "CommCareAudio", "media-class:CommCareAudio", ("c.wav", _wav(3, 32)), ("d.wav", _wav(1, 16))
        ),
        "expressions-and-data/audio-3gp": _media_shapes(
            "CommCareVideo",
            "media-class:CommCareVideo",
            ("e.3gp", _iso(b"3gp4", (b"soun", b"samr"))),
            ("f.3gp", _iso(b"3gp4", (b"vide", b"s263"), (b"soun", b"samr"))),
        ),
        "expressions-and-data/audio-m4a-with-another-brand-isom-mp41-mp42-dash": _media_shapes(
            "CommCareVideo",
            "media-class:CommCareVideo",
            ("g.m4a", _iso(b"isom", (b"soun", b"mp4a"))),
            ("h.m4a", _iso(b"M4A ", (b"soun", b"mp4a"))),
        ),
        "expressions-and-data/video-av1-mov-avi-ogg-theora-h-263-3gp": (
            *_media_shapes(
                "CommCareVideo",
                "media-class:CommCareVideo",
                ("i.mp4", _iso(b"isom", (b"vide", b"av01"))),
                ("j.mp4", _iso(b"isom", (b"vide", b"avc1"))),
            ),
            *_media_shapes("CommCareVideo", "media-class:CommCareVideo", ("k.ogv", OGG_THEORA), ("l.ogg", OGG_VORBIS)),
        ),
    }


# A suite's searches: comparisons whose value sides HQ's comparison reads (proof.observe.manifest.comparison_side).
CSQL_QUERIES = (
    "'dob > \"10:30\"'",  # a time of day is no date
    "'dob > \"2024-01-01\"'",
    "'visits >= 3'",
    "'date_opened > \"\"'",  # '' is no date
    "'date_opened >= today()'",
    "concat('visits > ', /data/n)",  # a value only the run time knows, spliced in unquoted
)
CSQL_SUITE = (
    b'<suite version="1"><remote-request><session><query url="u" storage-instance="results">'
    + b"".join(f'<data key="_xpath_query" ref="{text.replace(chr(34), "&quot;")}"/>'.encode() for text in CSQL_QUERIES)
    + b"</query></session></remote-request></suite>"
)
# Endpoints by id: two share one, the third has its own.
ENDPOINTS = b"""<suite version="1"><endpoint id="visit"><command value="'m0'"/></endpoint>
 <endpoint id="visit"><command value="'m1'"/></endpoint>
 <endpoint id="close"><command value="'m2'"/></endpoint></suite>"""
# Menus, one under another, and a multi-select datum whose limit is 0.
MENUS = b"""<suite version="1"><menu id="m0"><text><locale id="m0"/></text></menu>
 <menu id="m1" root="m0"><text><locale id="m1"/></text></menu>
 <entry><form>http://example.org/f</form><command id="m1-f0"><text><locale id="f"/></text></command>
  <instance id="casedb" src="jr://instance/casedb"/>
  <session><instance-datum id="selected_cases" nodeset="instance('casedb')/casedb/case" value="./@case_id"
   detail-select="m1_case_short" max-select-value="0"/></session></entry></suite>"""
# The search input instance an entry reads with no search in its session, one whose session searches, the legacy
# bare id in an entry, and the legacy bare id in a search's own request.
INPUTS_SUITE = b"""<suite version="1">
 <entry><form>http://example.org/f</form><command id="m0-f0"><text><locale id="f"/></text></command>
  <instance id="search-input:results" src="jr://instance/search-input/results"/>
  <session><datum id="case_id" nodeset="x" value="y"/></session></entry>
 <entry><form>http://example.org/g</form><command id="m0-f1"><text><locale id="g"/></text></command>
  <instance id="search-input:results" src="jr://instance/search-input/results"/>
  <session><query url="https://example.org/s" storage-instance="results" template="case" default_search="false">
   <prompt key="dob"><display><text><locale id="p"/></text></display></prompt></query></session></entry>
 <entry><form>http://example.org/h</form><command id="m0-f2"><text><locale id="h"/></text></command>
  <instance id="search-input" src="jr://instance/search-input"/>
  <session><datum id="case_id" nodeset="x" value="y"/></session></entry>
 <remote-request><post url="https://example.org/claim"/><command id="search_command.m0"><display><text>
  <locale id="s"/></text></display></command><instance id="search-input" src="jr://instance/search-input"/>
  <session><query url="https://example.org/s" storage-instance="results" template="case"/></session><stack/>
 </remote-request></suite>"""


# The attribute every model iteration's container and SaveToCase node carries (``modeliteration.js``,
# ``saveToCase.js``).
ROLE = "vellum-markup:model/instance//*@vellum:role"
# A suite expression reading a variable (a menu's display condition).
VARIABLES_SUITE = b"""<suite version="1"><menu id="m0" relevant="$v = 1"><text><locale id="m"/></text></menu></suite>"""


def _data_binds_and_itext():
    """The shapes of the classes read on a form's data nodes, binds, model iterations, itext and appearances, and of
    the keys a class does not declare."""
    form = _form
    data = "{http://example.org/t}"
    case = f'<case xmlns="{CASE_NS}" case_id="" date_modified="" user_id="">'
    node, root_child, role = "xform:model/instance//*", "xform:model/instance/*/*", ROLE
    nodes = form(
        data=f"""<_bad/><good/><twin/><twin/><rows jr:template=""/><rows/><holder><inner/></holder>
          <grp><inner2/></grp><filled>x</filled><empty/><meta/><metadata/>
          <hand>{case}<update/></case></hand><op vellum:role="SaveToCase">{case}<update/>
          <attachment><photo/></attachment></case></op><other><attachment/></other>""",
        body="""<group><repeat nodeset="/data/rows"/></group>
          <group ref="/data/grp"><input ref="/data/grp/inner2"/></group>""",
    )
    usercase = form(data="<commcare_usercase/><q/>", body='<input ref="/data/q"/>')
    usercase_update = {"condition": ALWAYS, "update": {"name": _update("/data/q")}}

    def usercase_app(**actions):
        return _with_forms(_app([_module([_form_json("none", **actions)])]), f=usercase)

    choices = form(
        data="<s/><m/>",
        body="""<select1 ref="/data/s"><item><value>a b</value></item><item><value>ok</value></item></select1>
          <select ref="/data/m"><item><value>x</value></item><item><value>x</value></item></select>""",
    )
    repeats = form(
        data='<r jr:template=""/><c jr:template=""/><fl><r2 jr:template=""/></fl><u jr:template=""/><n/>',
        model='<bind nodeset="/data/n" type="xsd:int"/>',
        body="""<group><repeat nodeset="/data/r" jr:noAddRemove="true()"/></group>
          <group><repeat nodeset="/data/c" jr:count="/data/n" jr:noAddRemove="true()"/></group>
          <group ref="/data/fl" appearance="Field-List"><group><repeat nodeset="/data/fl/r2"/></group></group>
          <group><repeat nodeset="/data/u"/></group>""",
    )
    counted = form(
        data='<rows jr:template=""><x/></rows><n/><other jr:template=""/><m/>',
        model="""<bind nodeset="/data/n" type="xsd:int" calculate="count(/data/rows) + 1"/>
          <bind nodeset="/data/m" type="xsd:int" calculate="2"/>""",
        body="""<group><repeat nodeset="/data/rows" jr:count="/data/n"/></group>
          <group><repeat nodeset="/data/other" jr:count="/data/m"/></group>""",
    )
    iteration = '{name} vellum:role="Repeat" ids="" count="" current_index=""><item id="" index="" jr:template=""/>'
    iterations = form(
        data=f"""<outer jr:template=""><{iteration.format(name="iter")}</iter></outer>
          <page><{iteration.format(name="late")}</late></page><{iteration.format(name="top")}</top><q/><show/>
          <shown><{iteration.format(name="early")}</early></shown><open/>
          <worked><{iteration.format(name="computed")}</computed></worked><sum/>""",
        model="""<bind nodeset="/data/page" relevant="/data/show = 'yes'"/>
          <bind nodeset="/data/shown" relevant="/data/open = 'yes'"/>
          <bind nodeset="/data/worked" relevant="/data/sum &gt; 1"/><bind nodeset="/data/sum" calculate="/data/q + 1"/>
          <setvalue event="xforms-ready" ref="/data/show" value="'no'"/>
          <setvalue event="xforms-ready" ref="/data/open" value="'yes'"/>
          <setvalue event="xforms-ready" ref="/data/page/late/@ids" value="join(' ', 'a b')"/>
          <setvalue event="xforms-ready" ref="/data/shown/early/@ids" value="join(' ', 'a b')"/>
          <setvalue event="xforms-ready" ref="/data/worked/computed/@ids" value="join(' ', 'a b')"/>
          <setvalue event="xforms-ready" ref="/data/top/@ids" value="join(' ', /data/q)"/>""",
        body="""<group><repeat nodeset="/data/outer"/></group><input ref="/data/q"/><input ref="/data/show"/>
          <input ref="/data/open"/>""",
    )
    binds = form(
        data=f"""<q/><shown/><hidden/><node attr=""/>
          <op vellum:role="SaveToCase">{case}<create><case_name/></create><update><v/></update></case></op>
          <upd vellum:role="SaveToCase">{case}<update><w/></update></case></upd>""",
        model="""<bind nodeset="/data/op" relevant="true()"/><bind nodeset="/data/q" relevant="true()"/>
          <bind nodeset="/data/op/case/update/v" constraint=". &gt; 0"/><bind nodeset="/data/q" constraint=". &gt; 0"/>
          <bind nodeset="/data/op/case/@case_id" calculate="uuid()"/>
          <bind nodeset="/data/upd/case/@case_id" calculate="/data/q"/>
          <bind nodeset="/data/shown" calculate="1"/><bind nodeset="/data/hidden" calculate="1"/>
          <bind nodeset="/data/node/@attr" calculate="1"/>""",
        body='<input ref="/data/q"/><input ref="/data/shown"/>',
    )
    users = form(
        data=f"""<u1 vellum:role="SaveToCase"
          vellum:case_type="commcare-user">{case}<create><case_name/></create></case>
          </u1><u2 vellum:role="SaveToCase" vellum:case_type="commcare-user">{case}<update><v/></update></case></u2>""",
    )
    defaults = form(
        data="<q/>",
        model="""<setvalue event="xforms-ready" ref="/data/q" value="1"/>
          <setvalue event="xforms-ready" ref="/data/q" value="2"/>""",
        body='<input ref="/data/q"/>',
    )
    versioned = form(data="<q/>").replace(b'name="T"', b'name="T" uiVersion="1"')
    itext = """<itext><translation lang="en" default="">
          <text id="a-msg"><value>Too small</value></text><text id="b-msg"><value>Too big</value></text>
          <text id="q-label"><value>Q</value></text><text id="extra"><value>E</value></text>
          <text id="Pragma-Form-Descriptor"><value>D</value></text></translation></itext>"""
    messages = form(
        data="<a/><b/><c/><q/><d/>",
        model=f"""<bind nodeset="/data/a" jr:constraintMsg="jr:itext('a-msg')"/>
          <bind nodeset="/data/b" constraint=". &gt; 1" jr:constraintMsg="jr:itext('b-msg')"/>
          <bind nodeset="/data/c" constraint=". &gt; 1" jr:constraintMsg="Too small"/>
          <bind nodeset="/data/q" calculate="concat(&quot;jr:itext('lit')&quot;, jr:itext('extra'))"/>
          <bind nodeset="/data/d" jr:constraintMsg="jr:itext('blank-msg')"/>{itext}""",
        body="""<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>""",
    ).replace(
        b'<text id="extra">',
        b'<text id="lit"><value>L</value></text><text id="blank-msg"><value/></text><text id="extra">',
    )
    case_path = "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/"
    required = form(
        data="<a/><b/><c/><d/><e/><f/>",
        model=f"""<bind nodeset="/data/a" required="/data/b = 'x'" vellum:requiredCondition="/data/c = 'y'"/>
          <bind nodeset="/data/b" required="/data/c = 'y'" vellum:requiredCondition="#form/c = 'y'"/>
          <bind nodeset="/data/c" required="/data/b='x'" vellum:requiredCondition="/data/b = 'x'"/>
          <bind nodeset="/data/d" required="{case_path}risk = 'high'" vellum:requiredCondition="#case/risk = 'high'"/>
          <bind nodeset="/data/e" required="/data/c = '/data/a'" vellum:requiredCondition="/data/c = '#form/a'"/>
          <bind nodeset="/data/f" required="/data/c = 'y'" vellum:requiredCondition="#form/nowhere = 'y'"/>""",
        head=f'<vellum:hashtagTransforms>{{"prefixes": {{"#case/": "{case_path}"}}}}</vellum:hashtagTransforms>',
    )
    itemsets = form(
        data="<s/><t/>",
        model='<instance id="items" src="jr://fixture/item-list:items"/>',
        body="""<select1 ref="/data/s"><itemset nodeset="instance('items')/items_list/items">
            <label ref="jr:itext(name)"/><value ref="id"/></itemset></select1>
          <select1 ref="/data/t"><itemset nodeset="instance('items')/items_list/items">
            <label ref="name"/><value ref="id"/></itemset></select1>""",
    )
    translations = form(
        data="<q/>",
        model="""<itext><translation lang="en" default="">
            <text id="t1"><value>A</value><value form="markdown">B</value></text>
            <text id="t2"><value>A</value><value form="markdown">A</value></text>
            <text id="t3"><value>Hello</value></text><text id="t4"><value/></text></translation>
          <translation lang="fr"><text id="t1"><value>A</value></text>
            <text id="t2"><value>A</value><value form="markdown">A</value></text>
            <text id="t3"><value/></text><text id="t4"><value/></text></translation>
          <translation lang="es"><text id="t4"><value>Hola</value></text></translation></itext>""",
    )
    # Vellum's default language is the app's first (fr here, though the form marks en), and it fills a blank value
    # from the default, else from any app language with content (t4: es).
    translated = _with_forms(_app([_module([_form_json("none")])], langs=["fr", "en", "es"]), f=translations)
    in_two_languages = _with_forms(_app([_module([_form_json("none")])], langs=["en", "fr"]), f=translations)
    appearances = form(
        data="<a/><b/><c/>",
        body="""<select1 ref="/data/a" appearance="minimal "><item><value>x</value></item></select1>
          <select1 ref="/data/b" appearance="minimal"><item><value>x</value></item></select1>
          <select1 ref="/data/c" appearance="minimal foo"><item><value>x</value></item></select1>""",
    )
    parents = form(
        data='<r jr:template=""/><other><q/></other><top/>',
        body="""<group><repeat nodeset="/data/r"><input ref="/data/other/q"/></repeat></group>
          <input ref="/data/top"/>""",
    )
    inline = form(data="<q/>", model='<instance id="inline"><root><row/></root></instance>')
    unnamed = form(data="<q/>", model="<instance><extra/></instance>")
    session = "instance('commcaresession')/session/data/supply_point_id"
    supply = form(data="<p/>", model=f'<bind nodeset="/data/p" calculate="{session}"/>')
    supply_second = form(
        data="<o/><p/>", model=f'<bind nodeset="/data/o" calculate="1"/><bind nodeset="/data/p" calculate="{session}"/>'
    )
    advanced = {
        **_form_json("none"),
        "doc_type": "AdvancedForm",
        "arbitrary_datums": [{"doc_type": "ArbitraryDatum", "datum_id": "supply_point_id", "datum_function": "x"}],
    }
    supplied = _with_forms(
        _app([_module([{**_form_json("none"), "unique_id": "basic"}, {**advanced, "unique_id": "advanced"}])]),
        basic=supply,
        advanced=supply_second,
    )
    variables = form(data="<v/>", model='<bind nodeset="/data/v" calculate="$x + 1"/>')
    functions = form(
        data="<h/><s/><t/><n/><m/>",
        model="""<instance id="items" src="jr://fixture/item-list:items"/>
          <bind nodeset="/data/h" calculate="here()"/>
          <bind nodeset="/data/n" calculate="jr:choice-name(/data/s, '/data/s')"/>
          <bind nodeset="/data/m" calculate="jr:choice-name(/data/t, '/data/t')"/>""",
        body="""<select1 ref="/data/s"><itemset nodeset="instance('items')/items_list/items">
            <label ref="name"/><value ref="id"/></itemset></select1>
          <select1 ref="/data/t"><item><value>a</value></item></select1>""",
    )
    here_suite = b"""<suite version="1"><detail id="d"><title><text><locale id="t"/></text></title><field><header><text>
      <locale id="h"/></text></header><template><text><xpath function="here()"/></text></template></field></detail>
      </suite>"""
    bound = form(
        data="<q/><g><r/></g><s/>",
        model="""<bind id="q" nodeset="/data/q"/><bind id="r" nodeset="/data/g/r"/>
          <bind id="other" nodeset="/data/s"/>""",
        body="""<input bind="q"/><group ref="/data/g"><input bind="r"/></group><input bind="other"/>""",
    )
    sources = form(
        data="<a/><b/>",
        model="""<instance id="odd" src="jr://elsewhere/odd"/><instance id="idle" src="jr://elsewhere/idle"/>
          <bind nodeset="/data/a" calculate="count(instance('odd')/root/row)"/>""",
    )
    images = form(
        data="<q/><s/>",
        model="""<itext><translation lang="en" default="">
            <text id="q-label"><value>Q</value><value form="big-image">jr://file/q.png</value></text>
            <text id="c-label"><value>C</value><value form="big-image">jr://file/c.png</value></text>
          </translation></itext>""",
        body="""<input ref="/data/q"><label ref="jr:itext('q-label')"/></input>
          <select1 ref="/data/s"><item><label ref="jr:itext('c-label')"/><value>c</value></item></select1>""",
    )
    steps = form(
        data="<a/><b/><c/>",
        model="""<bind nodeset="/data/a" calculate="/data/a/../b"/><bind nodeset="/data/c" calculate="../b"/>""",
    )
    times = form(
        data="<t/><n/><p/>",
        model=f"""<bind nodeset="/data/t" type="xsd:time" constraint=". &gt; '08:00'"/>
          <bind nodeset="/data/n" type="xsd:int" constraint=". &gt; 0 and count(/data/t) &lt;= 1"/>
          <bind nodeset="/data/p" calculate="if({case_path}age &gt; 1, 1, 0)"/>""",
        body='<input ref="/data/t"/><input ref="/data/n"/>',
    )
    detail_keys = _app([_detail_module([_column(foo=1, calc_xpath=".")], short={"foo": 1, "custom_variables": None})])
    form_keys = _app([_module([{**_form_json("none"), "bar": 1, "no_vellum": False}])])
    short = "/modules/0/case_details/short"
    return {
        "questions/question-id-failing-the-grammar-or-meta-in-any-case": (
            refused("form", nodes, root_child, f"{data}_bad[1]"),
            refused("form", nodes, root_child, f"{data}meta[1]"),
            accepted("form", nodes, root_child, f"{data}good[1]"),
        ),
        "questions/two-sibling-data-nodes-with-one-name": (
            refused("form", nodes, root_child, f"{data}twin[2]"),
            accepted("form", nodes, root_child, f"{data}rows[2]"),  # a repeat's rows share their path
        ),
        "questions/hidden-value-with-children": (
            refused("form", nodes, root_child, f"{data}holder[1]"),
            accepted("form", nodes, root_child, f"{data}grp[1]"),  # a group's node
        ),
        "questions/default-data-value-datavalue-instance-text": (
            refused("form", nodes, root_child, f"{data}filled[1]"),
            accepted("form", nodes, root_child, f"{data}empty[1]"),
        ),
        "questions/hand-written-case-block-without-vellum-role-incl-a-root-data": (
            refused("form", nodes, node, f"{data}hand[1]/{{{CASE_NS}}}case[1]"),
            accepted("form", nodes, node, f"{data}op[1]/{{{CASE_NS}}}case[1]"),
        ),
        "questions/attachment-inside-a-savetocase-block": (
            refused("form", nodes, node, f"{{{CASE_NS}}}case[1]/{{{CASE_NS}}}attachment[1]"),
            accepted("form", nodes, node, f"{data}other[1]/{data}attachment[1]"),
        ),
        "questions/authored-data-meta-block": (
            refused("form", nodes, root_child, f"{data}meta[1]"),
            accepted("form", nodes, root_child, f"{data}metadata[1]"),
        ),
        "questions/a-root-question-commcare-usercase-in-a-form-with-usercase": (
            refused("app", usercase_app(usercase_update=usercase_update), root_child, f"{data}commcare_usercase[1]"),
            accepted("app", usercase_app(), root_child, f"{data}commcare_usercase[1]"),
            unsettled("form", usercase, root_child, f"{data}commcare_usercase[1]"),  # no form object says it
        ),
        "questions/choice-value-with-whitespace-empty-or-duplicated": (
            refused("form", choices, "xform:select1/item/value", "select1[1]/item[1]/value[1]"),
            accepted("form", choices, "xform:select1/item/value", "select1[1]/item[2]/value[1]"),
            refused("form", choices, "xform:select/item/value", "select[1]/item[2]/value[1]"),
        ),
        "questions/jr-noaddremove-without-jr-count": (
            refused("form", repeats, "xform:repeat@jr:noAddRemove", "group[1]/repeat[1]/@jr:noAddRemove"),
            accepted("form", repeats, "xform:repeat@jr:noAddRemove", "group[2]/repeat[1]/@jr:noAddRemove"),
        ),
        "questions/user-controlled-repeat-inside-a-question-list-a-group-whose": (
            refused("form", repeats, "xform:repeat", "body[1]/group[3]/group[1]/repeat[1]"),
            accepted("form", repeats, "xform:repeat", "body[1]/group[4]/repeat[1]"),
        ),
        "questions/a-count-that-depends-on-the-rows-it-creates-through-calculations": (
            refused("form", counted, "xform:repeat@jr:count", "group[1]/repeat[1]/@jr:count", readings=True),
            accepted("form", counted, "xform:repeat@jr:count", "group[2]/repeat[1]/@jr:count", readings=True),
        ),
        "questions/model-iteration-repeat-nested-in-another-repeat-of-any-kind": (
            refused("form", iterations, role, f"{data}outer[1]/{data}iter[1]/@vellum:role"),
            accepted("form", iterations, role, f"{data}top[1]/@vellum:role"),
        ),
        "questions/model-iteration-repeat-under-an-ancestor-that-core-s-load-can": (
            # page's condition runs when /data/show is set to 'no' before late's query, and an answer can show it
            refused("form", iterations, role, f"{data}page[1]/{data}late[1]/@vellum:role", readings=True),
            accepted("form", iterations, role, f"{data}top[1]/@vellum:role", readings=True),
            accepted("form", iterations, role, f"{data}shown[1]/{data}early[1]/@vellum:role", readings=True),
            unsettled("form", iterations, role, f"{data}worked[1]/{data}computed[1]/@vellum:role", readings=True),
        ),
        "questions/model-iteration-repeat-whose-query-reads-a-form-answer-that-is": (
            refused("form", iterations, role, f"{data}top[1]/@vellum:role", readings=True),  # /data/q, entered later
            accepted("form", iterations, role, f"{data}page[1]/{data}late[1]/@vellum:role", readings=True),
        ),
        "questions/relevance-bound-on-the-savetocase-node-itself": (
            refused("form", binds, "xform:model/bind@relevant", "bind[1]/@relevant"),
            accepted("form", binds, "xform:model/bind@relevant", "bind[2]/@relevant"),
        ),
        "questions/constraint-on-savetocase-case-leaves": (
            refused("form", binds, "xform:model/bind@constraint", "bind[3]/@constraint"),
            accepted("form", binds, "xform:model/bind@constraint", "bind[4]/@constraint"),
        ),
        "questions/create-case-id-live-calculate-outside-a-repeat": (
            refused("form", binds, "xform:model/bind@calculate", "bind[5]/@calculate"),
            accepted("form", binds, "xform:model/bind@calculate", "bind[6]/@calculate"),  # an update's case id
        ),
        "questions/bind-calculate-on-a-visible-question": (
            refused("form", binds, "xform:model/bind@calculate", "bind[7]/@calculate"),
            accepted("form", binds, "xform:model/bind@calculate", "bind[8]/@calculate"),
        ),
        "questions/bind-on-an-attribute-path-not-owned-by-a-plugin-savetocase-model": (
            refused("form", binds, "xform:model/bind@nodeset", "bind[9]/@nodeset"),
            accepted("form", binds, "xform:model/bind@nodeset", "bind[5]/@nodeset"),  # SaveToCase's own
        ),
        "questions/savetocase-create-close-or-link-of-commcare-user-or-type-user": (
            refused(
                "form", users, "vellum-markup:model/instance//*@vellum:case_type", f"{data}u1[1]/@vellum:case_type"
            ),
            accepted(
                "form", users, "vellum-markup:model/instance//*@vellum:case_type", f"{data}u2[1]/@vellum:case_type"
            ),
        ),
        "questions/a-second-default-setvalue-on-one-question": (
            refused("form", defaults, "xform:setvalue", "model[1]/setvalue[2]"),
            accepted("form", defaults, "xform:setvalue", "model[1]/setvalue[1]"),
        ),
        "questions/data-root-uiversion-other-than-1-or-absent": (
            refused("form", nodes, "xform:model/instance/*", f"instance[1]/{data}data[1]"),
            accepted("form", versioned, "xform:model/instance/*", f"instance[1]/{data}data[1]"),
        ),
        "questions/requiredcondition-differing-from-a-present-non-false-required": tuple(
            make(
                "form",
                required,
                "vellum-markup:bind@vellum:requiredCondition",
                f"bind[{n}]/@vellum:requiredCondition",
                readings=True,
            )
            for make, n in (
                (refused, 1),
                (accepted, 2),  # #form/c is /data/c
                (accepted, 3),  # the same condition, spelled with other white space
                (accepted, 4),  # #case/risk through the form's hashtag transform
                (refused, 5),  # a string holding a hashtag's text is no hashtag
                (unsettled, 6),  # a hashtag Vellum places nowhere
            )
        ),
        "questions/validation-message-without-a-validation-condition": (
            refused("form", messages, "xform:model/bind@jr:constraintMsg", "bind[1]/@jr:constraintMsg", readings=True),
            accepted("form", messages, "xform:model/bind@jr:constraintMsg", "bind[2]/@jr:constraintMsg", readings=True),
            unsettled(
                "form", messages, "xform:model/bind@jr:constraintMsg", "bind[5]/@jr:constraintMsg", readings=True
            ),
        ),
        "questions/literal-jr-constraintmsg-text-no-itext": (
            refused("form", messages, "xform:model/bind@jr:constraintMsg", "bind[3]/@jr:constraintMsg", readings=True),
            accepted("form", messages, "xform:model/bind@jr:constraintMsg", "bind[2]/@jr:constraintMsg", readings=True),
            accepted(
                "form",
                _protected_form(),
                "xform:model/bind@jr:constraintMsg",
                "bind[1]/@jr:constraintMsg",
                readings=True,
            ),
        ),
        "questions/bind-readonly": (
            refused(
                "form",
                _form(data="<q/>", model='<bind nodeset="/data/q" readonly="true()"/>', body='<input ref="/data/q"/>'),
                "xform:model/bind@readonly",
                "bind[1]/@readonly",
            ),
            accepted("form", _protected_form(), "xform:model/bind@readonly", "bind[2]/@readonly", readings=True),
        ),
        "questions/itemset-label-jr-itext-field": (
            refused(
                "form",
                itemsets,
                "xform:select1/itemset/label@ref",
                "select1[1]/itemset[1]/label[1]/@ref",
                readings=True,
            ),
            accepted(
                "form",
                itemsets,
                "xform:select1/itemset/label@ref",
                "select1[2]/itemset[1]/label[1]/@ref",
                readings=True,
            ),
        ),
        "questions/markdown-form-differing-from-the-default-text": (
            refused("form", translations, "itext-form:core/markdown", "translation[1]/text[1]/value[2]/@form"),
            accepted("form", translations, "itext-form:core/markdown", "translation[1]/text[2]/value[2]/@form"),
        ),
        "questions/a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk": (
            refused("form", translations, "itext-form:core/markdown", "translation[1]/text[1]/value[2]/@form"),
            accepted("form", translations, "itext-form:core/markdown", "translation[1]/text[2]/value[2]/@form"),
        ),
        "questions/an-explicitly-blank-value-in-a-non-default-language-where-the": (
            refused(
                "app", in_two_languages, "xform:model/itext/translation/text/value", "translation[2]/text[3]/value[1]"
            ),
            accepted(
                "app", in_two_languages, "xform:model/itext/translation/text/value", "translation[2]/text[1]/value[1]"
            ),
            # fr is the app's default: its blank t3 is no other language's; en's blank t4 takes es's text
            accepted("app", translated, "xform:model/itext/translation/text/value", "translation[2]/text[3]/value[1]"),
            refused("app", translated, "xform:model/itext/translation/text/value", "translation[1]/text[4]/value[1]"),
            unsettled(
                "form", translations, "xform:model/itext/translation/text/value", "translation[2]/text[3]/value[1]"
            ),
        ),
        "questions/itext-entry-referenced-only-from-jr-itext-in-an-expression": (
            refused("form", messages, "xform:model/itext/translation/text@id", "text[6]/@id", readings=True),  # extra
            accepted("form", messages, "xform:model/itext/translation/text@id", "text[3]/@id", readings=True),
            # lit: only a string's text names it
            accepted("form", messages, "xform:model/itext/translation/text@id", "text[4]/@id", readings=True),
        ),
        "questions/itext-pragma-entries-pragma-form-descriptor-pragma-skip-full": (
            refused("form", messages, "xform:model/itext/translation/text@id", "text[7]/@id", readings=True),
            accepted("form", messages, "xform:model/itext/translation/text@id", "text[3]/@id", readings=True),
        ),
        "questions/an-appearance-holding-such-whitespace-that-some-runtime-reads": (
            refused("form", appearances, "xform:select1@appearance", "select1[1]/@appearance"),
            accepted("form", appearances, "xform:select1@appearance", "select1[2]/@appearance"),
        ),
        "questions/any-other-multi-token-string-holding-a-token-no-runtime-reads-on": (
            refused("form", appearances, "xform:select1@appearance", "select1[3]/@appearance"),
            accepted("form", appearances, "xform:select1@appearance", "select1[2]/@appearance"),
        ),
        "questions/any-other-bind-id-named-by-a-control-s-bind": (
            refused("form", bound, "xform:input@bind", "body[1]/input[2]/@bind"),
            refused("form", bound, "xform:model/bind@id", "bind[3]/@id"),
            accepted("form", bound, "xform:input@bind", "body[1]/input[1]/@bind"),  # the path from the root
            accepted("form", bound, "xform:input@bind", "group[1]/input[1]/@bind"),  # the path from its group
        ),
        "questions/label-big-image": (
            refused("form", images, "itext-form:android/big-image", "text[1]/value[2]/@form", readings=True),
            accepted("form", images, "itext-form:android/big-image", "text[2]/value[2]/@form", readings=True),
        ),
        "questions/choice-big-image": (
            refused("form", images, "itext-form:android/big-image", "text[2]/value[2]/@form", readings=True),
            accepted("form", images, "itext-form:android/big-image", "text[1]/value[2]/@form", readings=True),
        ),
        "expressions-and-data/here-in-a-form": (
            refused("form", functions, "jr-handler:here", "bind[1]/@calculate", readings=True),
            accepted("suite", here_suite, "jr-handler:here", "xpath[1]/@function", readings=True),
        ),
        "expressions-and-data/jr-choice-name-on-a-lookup-itemset-select": (
            refused("form", functions, "jr-handler:jr:choice-name", "bind[2]/@calculate", readings=True),
            accepted("form", functions, "jr-handler:jr:choice-name", "bind[3]/@calculate", readings=True),
        ),
        "expressions-and-data/declared-and-referenced-instance-with-an-unrecognized-src": (
            refused("form", sources, "instance-source:(none)", "instance[4]/@src", readings=True),
            accepted("form", sources, "instance-source:(none)", "instance[5]/@src", readings=True),
        ),
        "expressions-and-data/after-a-named-step-data-a-b": (
            refused("form", steps, "xpath-token:DBL_DOT", "bind[1]/@calculate", readings=True),
            accepted("form", steps, "xpath-token:DBL_DOT", "bind[2]/@calculate", readings=True),
        ),
        "expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string": (
            refused("form", times, "xpath-expr:XPathCmpExpr", "bind[1]/@constraint", readings=True),
            accepted("form", times, "xpath-expr:XPathCmpExpr", "bind[2]/@constraint", readings=True),
            unsettled("form", times, "xpath-expr:XPathCmpExpr", "bind[3]/@calculate", readings=True),  # a case's
        ),
        "questions/data-parent-crossing-a-repeat": (
            refused("form", parents, "xform:input@ref", "repeat[1]/input[1]/@ref"),
            accepted("form", parents, "xform:input@ref", "body[1]/input[1]/@ref"),
        ),
        "expressions-and-data/inline-instance-content-inside-instance-no-src": (
            refused("form", inline, "xform:model/instance@id", "instance[4]/@id"),
            accepted("form", inline, "xform:model/instance@id", "instance[2]/@id"),
        ),
        "expressions-and-data/more-than-one-instance-without-an-id": (
            refused("form", unnamed, "xform:model/instance", "model[1]/instance[1]"),
            accepted("form", inline, "xform:model/instance", "model[1]/instance[1]"),
        ),
        "expressions-and-data/session-data-supply-point-id-anywhere-except-in-an-advanced-form": (
            refused("app", supplied, "session-path:session/data/*", "bind[1]/@calculate", readings=True),
            accepted("app", supplied, "session-path:session/data/*", "bind[2]/@calculate", readings=True),
        ),
        "expressions-and-data/var-in-a-form-expression": (
            refused("form", variables, "xpath-token:VAR", "bind[1]/@calculate", readings=True),
            accepted("suite", VARIABLES_SUITE, "xpath-token:VAR", "menu[1]/@relevant", readings=True),
        ),
        "menus-and-case-lists/any-other-undeclared-key": (
            refused("app", detail_keys, "schema:Detail.<undeclared>", f"{short}/foo"),
            accepted("app", detail_keys, "schema:Detail.<undeclared>", f"{short}/custom_variables"),
            refused("app", detail_keys, "schema:DetailColumn.<undeclared>", f"{short}/columns/0/foo"),
            accepted("app", detail_keys, "schema:DetailColumn.<undeclared>", f"{short}/columns/0/calc_xpath"),
        ),
        "forms-and-case-writes/any-other-undeclared-key": (
            refused("app", form_keys, "schema:Form.<undeclared>", "/modules/0/forms/0/bar"),
            accepted("app", form_keys, "schema:Form.<undeclared>", "/modules/0/forms/0/no_vellum"),
        ),
    }


SHAPES = {**_questions(), **_settings_and_forms(), **_search_and_menus(), **_data_binds_and_itext()}

# Classes whose refused shape no export holds, by why: the export leaves the class open (None) where it would be in it.
UNSETTLED = {
    "forms-and-case-writes/subcase-of-the-module-s-own-case-type-in-a-project-space-with": (
        "DONT_INDEX_SAME_CASETYPE is the project space's, which no export carries"
    ),
    "expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install": (
        "whether a reference has its file is the media's, which the app JSON does not carry"
    ),
}
# Classes that take every use of their keys, by why: they have no accepted shape.
EVERY_USE_TAKEN = {
    "case-search/search-button-label-any-other-value": (
        "every value but HQ's default is in the class, and HQ's default is no use"
    ),
    "menus-and-case-lists/module-with-is-training-module-true-training-menu-root-training": (
        "is_training_module is a use only where it is true, which is the class; a suite's menu root it does not read"
    ),
}
# Classes whose uses the check never consults their reader on, by why (each a gap the inventory's keys close).
UNCONSULTED = {}


def test_every_reader_has_a_refused_shape_and_an_accepted_one_beside_it():
    """Every reader the registry holds has its shapes here, and every set of shapes a reader: one the reader places in
    its class and one beside it that it places outside (or, where the export cannot settle the class, one it leaves
    open), so a reader that places every use outside its class, or every use inside it, fails."""
    assert sorted(set(classes.VALUE_CLASSES) ^ set(SHAPES)) == []
    unconsulted = {entry_id for entry_id, shapes in SHAPES.items() if not all(shape.named for shape in shapes)}
    assert unconsulted == set(UNCONSULTED)
    for entry_id, shapes in SHAPES.items():
        needed = {None if entry_id in UNSETTLED else True} | (set() if entry_id in EVERY_USE_TAKEN else {False})
        assert needed <= {shape.verdict for shape in shapes}, f"{entry_id} has no {needed} shape"


def _shape_uses(shape, manifest, readings=None):
    found = manifest_usage.Uses()
    artifact = ARTIFACTS[shape.export]
    if shape.export == "form":
        manifest_usage.xform_uses(shape.source, manifest, artifact, found)
    elif shape.export == "app":
        manifest_usage.app_json_uses(shape.source, manifest, artifact, found)
    else:
        manifest_usage.runtime_xml_uses(shape.source, "SuiteParser", manifest, artifact, found)
    if readings is not None:
        manifest_usage.read_observed(found, manifest, readings)
    return found


def _holds_its_shapes(entry_id, manifest, readings=None):
    entry = next(entry for held in manifest.entries.values() for entry in held if entry.id == entry_id)
    for shape in SHAPES[entry_id]:
        found = _shape_uses(shape, manifest, readings if shape.readings else None)
        uses = [use for use in found.uses if use.key == shape.key and use.where.endswith(shape.where)]
        assert len(uses) == 1, f"{entry_id}: {shape.key} at {shape.where} is {len(uses)} uses, not one"
        (use,) = uses
        named = entry in manifest.entries.get(shape.key, ())
        # A key the entry should name and does not is a gap listed in UNCONSULTED; one it names now moves its shape.
        assert named is shape.named, f"{entry_id} {'does not name' if shape.named else 'now names'} {shape.key}"
        verdict = classes.VALUE_CLASSES[entry_id](use, manifest)
        assert verdict is shape.verdict, f"{entry_id} reads {shape.key} at {shape.where} as {verdict}"
        if not named:
            continue
        # The check consults the reader for that use: the use stands in the class where the reader takes it.
        kind, held = manifest_usage.standing(manifest, use)
        if shape.verdict:
            refuses = not manifest_usage.is_build(use.artifact) or entry.judges_builds()
            assert kind == (manifest_usage.REFUSED if refuses else manifest_usage.SOURCE) and entry in held
        elif shape.verdict is False:
            assert entry not in held


@pytest.mark.parametrize(
    "entry_id", sorted(entry for entry, shapes in SHAPES.items() if not any(shape.readings for shape in shapes))
)
def test_a_reader_places_each_shape_of_its_class(entry_id, manifest):
    _holds_its_shapes(entry_id, manifest)


@pytest.fixture(scope="module")
def observed(hq, core_runner):
    """The observation's readings of every shape that needs them, read once."""
    forms, runtimes, apps, media = [], [], [], {}
    for shapes in SHAPES.values():
        for shape in shapes:
            if not shape.readings:
                continue
            if shape.export == "form":
                forms.append(shape.source)
            elif shape.export == "suite":
                runtimes.append(shape.source)
            else:
                apps.append(shape.source)
                forms += observed_manifest.app_forms(shape.source)
            media.update(shape.media)
    table = observed_manifest.readings(core_runner, forms=forms, runtimes=runtimes, apps=apps, media=media)
    return manifest_usage.Readings.of(table)


@pytest.mark.parametrize(
    "entry_id", sorted(entry for entry, shapes in SHAPES.items() if any(shape.readings for shape in shapes))
)
def test_a_reader_places_each_shape_read_with_the_observations_readings(entry_id, manifest, observed):
    _holds_its_shapes(entry_id, manifest, observed)


# REFUSED classes the inventory keys whose reader the registry does not hold, each a gap: every use of their keys
# is undecided (``manifest_usage.standing``), which no register entry may hold (``proof.checks.registers``), so an
# export that uses one of their keys cannot pass the lane, and the allowing classes beside them hold nothing. They
# were keyed before their readers were written, and no export of the corpus run uses their keys; a reader added
# moves its class out of this list.
KNOWN_GAPS = frozenset(
    {
        "application-and-settings/2-properties-lazy-load-video-files-true",
        "application-and-settings/41p-hq-use-custom-suite-true",
        "application-and-settings/44p-hq-translation-strategy-select-known",
        "application-and-settings/48p-hq-target-commcare-flavor-commcare-commcare-lts",
        "application-and-settings/49p-hq-mobile-ucr-restore-version-1-0-1-5",
        "application-and-settings/non-empty-custom-assertions-app",
        "application-and-settings/profile-properties-or-features-dependencies-value-outside-its",
        "case-search/instance-name-containing-casedb-ledgerdb-fixture-or-session",
        "case-search/receiver-expression-on-a-prompt-whose-editor-appearance-is",
        "expressions-and-data/commtrack-locations-hierarchical",
        "expressions-and-data/commtrack-products-commtrack-programs",
        "expressions-and-data/reports-commcare-reports-commcare-reports-commcare-reports",
        "expressions-and-data/tag-containing-casedb-or-ledgerdb",
        "expressions-and-data/tag-or-field-name-core-s-xpath-lexer-does-not-read-as-a-name-any",
        "forms-and-case-writes/a-load-or-open-action-s-case-tag-containing-which-the-advanced",
        "forms-and-case-writes/a-parent-load-tag-not-repeated-in-extra-actions-where-the-parent",
        "forms-and-case-writes/advancedform-schedule-with-enabled-true-visits-transition",
        "forms-and-case-writes/advancedopencaseaction-case-indices-naming-its-own-or-a-later",
        "forms-and-case-writes/advancedopencaseaction-case-properties-key-with-parent-p",
        "forms-and-case-writes/advancedopencaseaction-repeat-context-other-than-the-name",
        "forms-and-case-writes/an-advanced-open-action-indexed-to-an-open-action-that-has-a-neither",
        "forms-and-case-writes/an-advanced-open-action-s-index-to-a-load-whose-datum-hq-renames",
        "forms-and-case-writes/an-auto-select-load-with-a-blank-mode-or-a-blank-case-type",
        "forms-and-case-writes/auto-select-mode-case-naming-itself-a-later-load-or-an-open",
        "forms-and-case-writes/case-tag-blank-on-a-non-auto-select-action",
        "forms-and-case-writes/case-tag-of-a-non-auto-select-action-failing-actions-js",
        "forms-and-case-writes/caseindex-relationship-question-inside-a-repeat",
        "forms-and-case-writes/caseindex-relationship-question-on-an-index-to-a-load-that",
        "forms-and-case-writes/caseindex-relationship-question-relationship-question-the-index-naming-an",
        "forms-and-case-writes/custom-assertions-form-non-empty",
        "forms-and-case-writes/extra-actions-load-update-cases-show-product-stock-true-or-a-non",
        "forms-and-case-writes/is-release-notes-form-true-with-or-without-enable-release-notes",
        "forms-and-case-writes/loadupdateaction-case-index-on-an-auto-selected-load-or-on-the",
        "forms-and-case-writes/loadupdateaction-case-index-tag-naming-a-load-other-than-the-one",
        "forms-and-case-writes/loadupdateaction-preload-or-case-properties-property-with-on-a",
        "forms-and-case-writes/shadow-parent-form-id-naming-a-basic-form-or-another-shadowform",
        "forms-and-case-writes/show-count-true",
        "forms-and-case-writes/show-product-stock-true-or-a-non-empty-product-program",
        "forms-and-case-writes/two-or-more-open-actions-whose-repeat-context-is-one-repeat",
        "forms-and-case-writes/unknown-form-doc-type",
        "menus-and-case-lists/a-shadow-menu-s-own-or-mirror-form-endpoint-id-with-surrounding",
        "menus-and-case-lists/advancedmodule-has-schedule-true-or-schedule-phases-non-empty",
        "menus-and-case-lists/advancedmodule-product-details-differing-from-the-default",
        "menus-and-case-lists/attachment-name-with-any-other-format",
        "menus-and-case-lists/auto-select-case-true-on-a-basic-module-an-advanced-form-s-load",
        "menus-and-case-lists/callout-with-no-extras-or-no-responses",
        "menus-and-case-lists/columns-above-the-first-tab-when-tabs-exist",
        "menus-and-case-lists/detail-auto-select-true-on-a-single-select-basic-list",
        "menus-and-case-lists/detail-custom-variables-dict-non-empty",
        "menus-and-case-lists/detail-custom-xml-non-empty",
        "menus-and-case-lists/detail-instance-name-any-other-stored-value",
        "menus-and-case-lists/fixture-select-active-true",
        "menus-and-case-lists/indicator-any-other-set-name",
        "menus-and-case-lists/indicator-call-center-name",
        "menus-and-case-lists/lookup-on-the-long-detail-tabbed-or-not",
        "menus-and-case-lists/module-lazy-load-case-list-fields-true",
        "menus-and-case-lists/parent-select-relationship-null-other",
        "menus-and-case-lists/put-in-root-session-endpoint-id-or-inline-search-or-an-end-of",
        "menus-and-case-lists/report-context-tile-true",
        "menus-and-case-lists/shadowmodule-version-1-or-key-absent-model-default-1",
        "questions/a-case-variant-of-numeric-short-or-ethiopian-as-the-whole",
        "questions/a-choice-bind-type-contradicting-the-control-listitem-select1-on",
        "questions/a-connect-learn-module-or-task-id-longer-than-50-characters-or",
        "questions/a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does",
        "questions/a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-starts",
        "questions/authored-orx-pollsensor",
        "questions/bare-repeat-with-no-group-wrapper",
        "questions/intent-id-naming-an-odkx-intent-that-no-callout-question-writes",
        "questions/intent-id-on-any-input-naming-no-odkx-intent-in-the-form",
        "questions/jr-imagedimensionscaledmax-that-is-not-an-integer-or-is-greater",
        "questions/send-submission",
        "questions/several-connect-assessment-blocks-in-one-form-or-one-inside-a",
        "questions/unknown-body-control-vellum-readonly-e-g-range",
    }
)


def test_every_keyed_refused_class_has_a_reader_or_is_a_known_gap(manifest):
    """A REFUSED entry that names keys and a value class needs a reader of that class, or every use of its keys is
    undecided: each such entry (but one refused only because HQ's build refuses its state, which is the bar's) has a
    reader in the registry or is a known gap, and a known gap that has a reader, or names no key, leaves the list."""
    entries = {entry.id: entry for held in manifest.entries.values() for entry in held}
    unread = {
        entry_id
        for entry_id, entry in entries.items()
        if entry.disposition == "REFUSED"
        and entry.value_class is not None
        and not entry.refused_by_hq_build()
        and entry_id not in classes.VALUE_CLASSES
    }
    assert sorted(unread - KNOWN_GAPS) == []
    assert sorted(KNOWN_GAPS - unread) == []


def test_the_undeclared_keys_the_catch_alls_leave_are_the_ones_the_rows_name(manifest):
    """The REFUSED catch-alls for keys a class does not declare refuse every name but the ones the inventory's other
    rows name for that class (``ROW_UNDECLARED_KEYS``): for each class a catch-all names, the map holds exactly the
    names the items of the allowing entries naming ``schema:<Class>.<undeclared>`` spell (each backticked, a
    ``<Class>.`` before it aside), so a row added or renamed fails here rather than its key staying refused."""
    import json
    import re

    catch_alls = {
        entry_id for entry_id, reader in classes.VALUE_CLASSES.items() if reader is classes.undeclared_key_no_row_names
    }
    named, held = {}, {}
    for path in sorted((manifest_usage.SURFACE_DIR / "entries").glob("*.json")):
        if path.name == "gates.json":
            continue
        for entry in json.loads(path.read_text(encoding="utf-8")):
            for key in entry.get("surfaceKeys") or ():
                if not (key.startswith("schema:") and key.endswith(classes.UNDECLARED)):
                    continue
                cls = key[len("schema:") : -len(classes.UNDECLARED)]
                if entry["id"] in catch_alls:
                    named.setdefault(cls, set())
                elif entry["disposition"] != "REFUSED":
                    spelled = {name.split(".")[-1] for name in re.findall(r"`([^`]+)`", entry["item"])}
                    held.setdefault(cls, set()).update(spelled)
    assert set(classes.ROW_UNDECLARED_KEYS) == set(named)
    assert {cls: set(names) for cls, names in classes.ROW_UNDECLARED_KEYS.items()} == {
        cls: held.get(cls, set()) for cls in named
    }


def test_the_observation_reads_a_call_after_a_comma_and_vellums_hashtags(hq):
    """The observation reads an expression's structure with eulxml's grammar and XPath's own rule for a name after a
    comma, which eulxml's lexer leaves out (it refuses ``if(c, concat(a, b), '')``, which Core reads), so a text
    eulxml reads is read alike and one it refuses only there is read; a required condition is read with Vellum's
    hashtag production, as js-xpath allows it (an operand, with no step or predicate after it), and a plain
    expression never with it."""
    from eulxml.xpath import parse

    text = "if(/data/c, concat(/data/a, 'b'), '')"
    with pytest.raises(RuntimeError):
        parse(text)
    parse("thisisdumb")  # eulxml's parser after an error
    tree = observed_manifest.expression_tree(text)
    assert tree[:2] == ["call", "if"] and tree[2][1][:2] == ["call", "concat"]
    for read in ("/data/a/../b", "count(instance('x')/a[@b = 1]) > 0", "a div b * -c", "x and not(y or z)"):
        assert observed_manifest.expression_tree(read) == observed_manifest._tree(parse(read))
    assert observed_manifest.hashtag_tree("#form/a = 'x'") == ["binary", "=", ["hashtag", "#form/a"], ["text", "x"]]
    assert observed_manifest.hashtag_tree("count(#case/p) > 0")[2][2] == [["hashtag", "#case/p"]]
    assert observed_manifest.hashtag_tree("#form/a[1]") is None
    assert observed_manifest.hashtag_tree("#form/a/@b") is None
    assert observed_manifest.expression_tree("#form/a = 'x'") is None
