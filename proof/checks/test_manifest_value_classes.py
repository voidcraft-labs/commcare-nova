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
silently stops being consulted. A HELD-NEW class beside an allowing class of
its key has a reader too, where its class is one value's grammar or bound:
the failures there are a reader that holds a value Nova does not hold yet,
so the check passes what Nova's reader would not bring in, and one that
reads more than the use's own value, so parity cannot hold it to the reader.

Every reader the registry holds has its shapes in ``SHAPES``, by its entry's
id, and the registry and the table must name the same ids: a refused shape
(the reader says True) and an accepted one beside it (False), each a use of a
key the entry names, found by the check's own extraction in an export as HQ,
Vellum and Nova write it, and each also standing as the check places it (the
refused one refused, or the source's in a local archive, or held-new for a
HELD-NEW class, resting on the entry; the accepted one resting elsewhere). A class the export cannot settle has the
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
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

import pytest
from lxml import etree

from proof.checks import manifest_usage
from proof.checks import manifest_value_classes as classes
from proof.checks.corpus import Configuration
from proof.observe import manifest as observed_manifest


@pytest.fixture(scope="module")
def manifest():
    return manifest_usage.load_manifest()


def test_every_reader_reads_a_refused_or_held_new_entry_that_names_a_value_class(manifest):
    """The registry is keyed by the entries' ids: each id is a REFUSED or HELD-NEW inventory entry with a value
    class (an allowing class is the rest of its key's values, never read), so a renamed or removed entry fails here
    rather than leaving its reader unread, and a reader of an allowing entry is refused."""
    entries = {entry.id: entry for held in manifest.entries.values() for entry in held}
    assert sorted(set(classes.VALUE_CLASSES) - set(entries)) == []
    assert [key for key in classes.VALUE_CLASSES if entries[key].value_class is None] == []
    assert [key for key in classes.VALUE_CLASSES if entries[key].disposition not in ("REFUSED", "HELD-NEW")] == []
    # A REFUSED entry refused only because HQ's build refuses its state is the bar's, and needs no reader.
    assert [key for key in classes.VALUE_CLASSES if entries[key].refused_by_hq_build()] == []


SOURCE_FAMILIES_FILE = Path(__file__).parent / "fixtures" / "source-families.json"
SOURCE_FAMILIES = json.loads(SOURCE_FAMILIES_FILE.read_text(encoding="utf-8"))["families"]
ALLOWING = ("HELD", "TARGET-OWNED", "INERT")


def _held_new_readers(manifest):
    """Each HELD-NEW entry the registry holds a reader of, by its id, with the keys that name it."""
    named = {}
    for key, held in manifest.entries.items():
        for entry in held:
            if entry.disposition == "HELD-NEW" and entry.id in classes.VALUE_CLASSES:
                named.setdefault(entry, []).append(key)
    return named


def test_a_held_new_reader_reads_a_class_beside_an_allowing_class_of_a_key_an_app_source_holds(manifest):
    """Contract: a HELD-NEW class gets a reader only where the check would otherwise hold its uses: it shares a key
    with an allowing entry (HELD, TARGET-OWNED or INERT), and one of its keys is of a family the extraction reads
    from an app's source (``fixtures/source-families.json``), where its reader can read the value. The plausible
    failures: a reader of a class whose every key only HELD-NEW entries name, which ``standing`` already holds
    held-new, so the reader decides nothing; and one whose keys are read only in Nova's own builds or lookup
    data, which no app's source carries."""
    readers = _held_new_readers(manifest)
    assert readers, "the registry holds no HELD-NEW reader"
    for entry, keys in sorted(readers.items()):
        beside = {other.disposition for key in keys for other in manifest.entries[key] if other != entry}
        assert beside & set(ALLOWING), f"{entry.id} shares no key with an allowing entry"
        families = {key.split(":", 1)[0] for key in keys}
        assert families & set(SOURCE_FAMILIES), f"{entry.id} names no key of a family an app's source holds"


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
    control="input",
    languages=("en", "es"),
    pieces=(1, 4),
    nested=False,
    collision=False,
    media=False,
    typed=True,
    media_modes=True,
    markdown_copy=True,
):
    """Independent wire shapes for the classifier, read by the observation's real Core/HQ parsers.

    Noncontiguous ordinals, a blank localized piece, nested paths, every media mode and a case predicate
    distinguish this class from an observed fixture or a simple-path-only approximation. ``media_modes``
    writes the four ``__nova_mode;<medium>`` forms a retained control keeps; without them the message is the
    one Nova writes since defect 16. ``markdown_copy`` writes the message's own ``markdown`` value a retained
    control keeps; without it the message is the one Nova writes now, which writes no formatted copy of a
    validation message. No Nova emitter or private consumer artifact supplies these bytes.
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
        if media_modes:
            helpers.update({f"__nova_mode;{name}": "media" for name in ("image", "audio", "video", "video-inline")})
        for piece in pieces:
            literal = "" if index else "Literal ${not-an-expression} café"
            payload = json.dumps({"v": literal}, ensure_ascii=True).replace("$", "\\u0024")
            helpers[f"__nova_piece_{piece}"] = payload
            helpers[f"__nova_piece_{piece};markdown"] = payload
        values = "<value>Message</value>"
        if markdown_copy:
            values += "<value form='markdown'>Message</value>"
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
    binding = "nodeset" if control == "repeat" else "ref"
    body = f"<{control} {binding}={quoteattr(source)}{extra}><label>Q</label>{choices}</{control}>"
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
            "without-media-modes": _protected_form(media_modes=False),
            "without-markdown-copy": _protected_form(media_modes=False, markdown_copy=False),
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
        "some-media-modes",
        "media-modes-in-one-translation",
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
        elif name == "some-media-modes":
            text.remove(values["__nova_mode;video-inline"])
        elif name == "media-modes-in-one-translation":
            for medium in ("image", "audio", "video", "video-inline"):
                text.remove(values[f"__nova_mode;{medium}"])
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


# Each name the allocator gives a generated node (``lib/commcare/xform/generatedNodes.ts``) and the part of a
# REFUSED class it is: a fixed name kept, a minted name its family with the minted part ``*``, and a count node or
# a validation message carrier none, as an authored id's, though a family's prefix starts it.
GENERATED_PARTS = {
    "nova_operations": "nova_operations",
    "nova_subcases": "nova_subcases",
    "nova_selected_cases": "nova_selected_cases",
    "nova_update_selected_cases": "nova_update_selected_cases",
    "nova_close_selected_cases": "nova_close_selected_cases",
    "nova_close": "nova_close",
    "nova_url_photo": "nova_url_*",
    "nova_datetime_when": "nova_datetime_*",
    "nova_constraint_q_0": "nova_constraint_*",
    "nova_trimmed_name": "nova_trimmed_*",
    "nova_keyed_create_visit": "nova_keyed_*",
    "nova_guard_create_visit_text": "nova_guard_*",
    "nova_condition_update_selected_cases": "nova_condition_*",
    "nova_subcase_0": "nova_subcase_*",
    "nova_constraint_message_x_0": None,
    "nova_count_nova_keyed_create_visit": None,
}


@pytest.mark.parametrize(("name", "part"), GENERATED_PARTS.items())
def test_a_refused_class_names_each_generated_node_by_its_family(manifest, name, part):
    """A form whose generated node Vellum would keep as a Hidden Value with children names the class's part by the
    node's fixed name or family, as a comparison writes the node, so one REFUSED class over a guard and a
    condition group is two parts. The plausible failures: a family read as a fixed name (every guard its own
    part), or a constraint count of a field whose id starts ``message_``, or a keyed create's count node, read as
    the family its prefix names, which moves the path defect 30's entries hold."""
    xml = _form(data=f"<{name}><x/></{name}>", model=f'<bind nodeset="/data/{name}/x" calculate="1"/>')
    found = manifest_usage.Uses()
    manifest_usage.xform_uses(xml, manifest, "form:0.0", found)
    paths = {
        difference.path
        for use in found.uses
        if use.where.rsplit("}", 1)[-1] == f"{name}[1]"
        for difference in manifest_usage.unclassified("d", [use], manifest)
        if "/refused/hidden-value-with-children" in difference.path
    }
    suffix = "" if part is None else f"/{part}"
    assert paths == {f"/xform:model~1instance~1*~1*/refused/hidden-value-with-children{suffix}"}


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


def test_a_setvalue_core_reads_otherwise_than_nova_writes_is_form_level_and_no_default(manifest):
    """Core reads a setvalue's ``bind`` before its ``ref``, a relative ``ref`` from ``/``, an attribute of the name
    in any namespace (the form builder's ``vellum:`` shadows stripped before a device reads the form), and the
    element's text where there is no ``value`` (``XFormParser.parseSetValueAction``), while the form builder reads
    the plain ``ref`` alone. Nova's reader holds a setvalue's target only where the two agree, in the spelling Nova
    writes (``xform/model.ts::heldSetvalueRef``), and refuses every other model setvalue under the form-level
    setvalue's entry, so the classes read it so too: form-level, and no question's default, first or second. The
    plausible failure is the form builder's reading, which takes the first five as defaults of ``top``."""
    xml = _form(
        data="<top/><other/>",
        model="""<bind nodeset="/data/other" id="other_bind"/>
          <setvalue event="xforms-ready" ref="/data/top" bind="other_bind" value="1"/>
          <setvalue event="xforms-ready" ref="data/top" value="1"/>
          <setvalue event="xforms-ready" x:ref="/data/other" ref="/data/top" value="1"/>
          <setvalue event="xforms-ready" ref="/data/top">1</setvalue>
          <setvalue x:event="xforms-revalidate" event="xforms-ready" ref="/data/top" value="1"/>
          <setvalue event="xforms-ready" vellum:ref="#form/top" ref="/data/top" value="1"/>
          <setvalue event="xforms-ready" ref="/data/top" value="2"/>""",
        body="""<input ref="/data/top"/><input ref="/data/other"/>""",
    )
    uses = [use for use in _uses(xml, manifest, "jr-action:setvalue") if "/model[1]/" in use.where]
    assert len(uses) == 7
    assert [classes.form_level_setvalue(use, manifest) for use in uses] == [True] * 5 + [False, False]
    assert [classes.default_event_mismatching_placement(use, manifest) for use in uses] == [False] * 7
    # The sixth is the first default of ``top`` Core and the form builder agree on, so the seventh is its second.
    assert [classes.second_default(use, manifest) for use in uses] == [False] * 6 + [True]


def test_a_body_element_binds_to_its_node_as_core_binds_it(manifest):
    """Core binds a control by its ``bind`` wherever it holds one, a repeat by its ``nodeset`` and any other control
    by its ``ref`` (``XFormParser.parseControl``, ``parseGroup``); a group holding only ``nodeset`` binds none of its
    own. The plausible failure is the form builder's order (``ref``, else ``nodeset``, else ``bind``), which binds
    the first input to ``a`` and the group to ``g``."""
    xml = _form(
        data="<a/><b/><g><c/></g><r><d/></r>",
        model="""<bind nodeset="/data/a"/><bind nodeset="/data/b" id="b_bind"/><bind ref="/data/c" id="c_bind"/>""",
        body="""<input ref="/data/a" bind="b_bind"/><group nodeset="/data/g"><input ref="/data/g/c"/></group>
          <repeat nodeset="/data/r"><input ref="/data/r/d"/></repeat><repeat ref="/data/r"/>
          <input nodeset="/data/a"/><input bind="c_bind"/>""",
    )
    form = classes.Form(etree.fromstring(xml), "form:0.0")
    body = form.root.find("{http://www.w3.org/1999/xhtml}body")
    controls = [element for element in body if isinstance(element.tag, str)]
    assert [form.control_path(control) for control in controls] == [
        "/data/b",  # its bind, before its ref
        None,  # a group holding only nodeset
        "/data/r",  # a repeat's nodeset
        None,  # a repeat holding only ref
        None,  # a question holding only nodeset
        None,  # a bind holding only ref has no path
    ]
    assert [classes._local(control) for control in form.question_controls("/data/b")] == ["input"]
    assert form.question_controls("/data/a") == []
    assert form.question_controls("/data/g") == []


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
            # A date range over an address appearance is no address field: HQ's build writes the ``input_`` over
            # the appearance's ``input="address"``, and its Case List page shows the date range.
            {
                "name": "seen",
                "appearance": "address",
                "input_": "daterange",
                "validations": [{"test": "true()"}, {"test": "false()"}],
            },
        ],
        "default_properties": [{"property": "x_commcare_data_registry", "defaultValue": "'r'"}, {"property": "status"}],
        "search_button_label": {"en": "Search"},
    }
    app = _app([_module(search_config=search)], cloudcare_enabled=True)
    names = _app_uses(app, manifest, "schema:CaseSearchProperty.name")
    assert [classes.reserved_request_key(use, manifest) for use in names] == [True, False, False]
    appearance = _app_uses(app, manifest, "schema:CaseSearchProperty.appearance")
    assert [classes.address_with_required_or_validations(use, manifest) for use in appearance] == [True, False]
    validations = _app_uses(app, manifest, "schema:CaseSearchProperty.validations")
    assert [classes.later_validations(use, manifest) for use in validations] == [False, True]
    [defaults] = _app_uses(app, manifest, "schema:CaseSearch.default_properties")
    assert classes.data_registry_key(defaults, manifest) is True
    # A filter with no value is its own use, at the filter; the list that holds it is no use of that class.
    assert classes.missing_default_value(defaults, manifest) is False
    [unvalued] = _app_uses(app, manifest, "schema:DefaultCaseSearchProperty")
    assert unvalued.where == "/modules/0/search_config/default_properties/1"
    assert classes.missing_default_value(unvalued, manifest) is True
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


# A search's prompts with an input type no runtime names (``slider``) and one Core names (``date``).
INPUT_SUITE = b"""<suite version="1">
 <entry><form>http://example.org/g</form><command id="m0-f0"><text><locale id="g"/></text></command>
  <instance id="results:inline" src="jr://instance/remote/results:inline"/>
  <session><query url="https://example.org/s" storage-instance="results:inline" template="case" default_search="false">
   <prompt key="dob" input="slider"><display><text><locale id="p"/></text></display></prompt>
   <prompt key="seen" input="date" exclude="true()"><display><text><locale id="q"/></text></display></prompt>
  </query></session></entry>
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


# A registration form HQ's Register action opens after an empty inline search, its menu held off the menu: the action
# sits on the list a searching entry shows, by a ``<datum>`` where the list selects one case and by an
# ``<instance-datum>`` where it selects several (``suite_xml/xml_models.py::InstanceDatum``).
REGISTER_AFTER_SEARCH_SUITE = """<suite version="1">
  <detail id="m0_case_short"><title><text><locale id="t"/></text></title>
    <field><header><text><locale id="h"/></text></header><template><text><xpath function="."/></text></template></field>
    <action relevant="count(instance('results:inline')/results/case) = 0">
      <display><text><locale id="r"/></text></display>
      <stack><push><command value="'m1-f0'"/><datum id="case_id_new_patient_0" value="uuid()"/></push></stack>
    </action></detail>
  <entry><form>http://example.org/f</form><command id="m0-f0"><text><locale id="c"/></text></command>
    <instance id="results:inline" src="jr://instance/remote/results:inline"/>
    <session>{query}
      <{datum} id="{datum_id}" nodeset="instance('results:inline')/results/case" value="./@case_id"
        detail-select="m0_case_short"/></session></entry>
  <entry><form>http://example.org/r</form><command id="m1-f0"><text><locale id="c"/></text></command>
    <session><datum id="case_id_new_patient_0" function="uuid()"/></session></entry>
  <menu id="m0"><text><locale id="m"/></text><command id="m0-f0"/></menu>
  <menu id="m1" relevant="false()"><text><locale id="m"/></text><command id="m1-f0"/></menu>
</suite>"""
INLINE_QUERY = (
    '<query url="https://example.org/s" storage-instance="results:inline" template="case" default_search="false">'
    '<data key="case_type" ref="\'patient\'"/></query>'
)


@pytest.mark.parametrize("datum,datum_id", [("datum", "case_id"), ("instance-datum", "selected_cases")])
def test_a_form_the_register_action_opens_is_reached_through_the_searching_entry_s_frame(datum, datum_id):
    """Contract: the form a list's Register action pushes is reached on the frame of the entry that shows the list,
    whether that entry's list selects one case or several. The plausible failure: a several-case list's
    ``<instance-datum>`` read as showing no list, so the form reads as reached with no query and its read of the
    Search answer is refused (``no-matches-multiple-home``)."""

    def register_entry(query):
        root = etree.fromstring(
            REGISTER_AFTER_SEARCH_SUITE.format(query=query, datum=datum, datum_id=datum_id).encode()
        )
        [entry] = [entry for entry in root if entry.tag == "entry" and entry.find("command").get("id") == "m1-f0"]
        return entry

    assert classes._reached_without_a_query(register_entry(INLINE_QUERY)) is False
    assert classes._reached_without_a_query(register_entry("")) is True


def test_csql_comparisons_by_what_stands_on_their_value_side(hq, manifest, core_runner):
    queries = {
        "time": "'dob > \"10:30\"'",
        "date": "'dob > \"2024-01-01\"'",
        "number": "'visits >= 3'",
        "blank_metadata": "'date_opened > \"\"'",
        "today_metadata": "'date_opened >= today()'",
        "runtime": "concat('visits > ', /data/n)",
        # The device's today(), quoted: only the run time knows it, but Core always writes it as a date.
        "today": "concat('due <= \"', today(), '\"')",
        # A related case's property: eulxml builds the path with "/", which is no CSQL operator.
        "ancestor": 'concat("parent/@case_id = \'", /data/p, "\'")',
        # A unit only the run time knows names no unit of its own.
        "unit": "concat('within-distance(gps, ', \"'0 0'\", ', 200, \"', /data/u, '\")')",
    }
    suite = (
        b'<suite version="1"><remote-request><session><query url="u" storage-instance="results">'
        + b"".join(
            f'<data key="_xpath_query" ref="{text.replace(chr(34), "&quot;").replace("<", "&lt;")}"/>'.encode()
            for text in queries.values()
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
    assert verdict(classes.untyped_right_side, "csql-op:<=", 7) is False

    def keys(index):
        return {use.key for use in found.uses if f"/data[{index}]/" in use.where and use.key.startswith("csql-")}

    assert {"csql-op:=", "csql-metadata:@case_id"} <= keys(8)
    assert not {key for key in keys(8) if key.startswith("csql-op:") and key != "csql-op:="}
    assert "csql-fn:within-distance" in keys(9)
    assert not {key for key in keys(9) if key.startswith("csql-unit:")}


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
    case_types: dict | None = None  # declared types, supplied beside the recorded export as a retained control's are
    # The configurations an app JSON was sent under (``App.configurations``), which a flag's class reads.
    configurations: tuple | None = None
    # How many uses of the key sit there: one, but where the expression reads the key more than once (a guard and
    # the read it guards), each read is a use and each takes the verdict.
    uses: int = 1


def refused(export, source, key, where, **kw):
    return Shape(export, source, key, where, True, **kw)


def accepted(export, source, key, where, **kw):
    return Shape(export, source, key, where, False, **kw)


def unsettled(export, source, key, where, **kw):
    return Shape(export, source, key, where, None, **kw)


ARTIFACTS = {"form": "form:0.0", "app": "app.json", "suite": "local.ccz/suite.xml"}
# An itext value's own ``form`` attribute, a use beside each ``itext-form`` use at the same place, which takes the
# class of the form it names: a markdown class by the markdown rule, a big image by the text its reference names.
VALUE_FORM = "xform:model/itext/translation/text/value@form"
# Two project spaces an app JSON is sent to: one with DONT_INDEX_SAME_CASETYPE on, and one with no flag.
PLAIN = Configuration(
    name="minimum",
    flags=(),
    named_privileges=(),
    commcare_version="2.57.0",
    commtrack=False,
    sync_cases_on_form_entry=False,
    case_search_enabled=False,
)
SAME_TYPE_UNINDEXED = replace(PLAIN, name="DONT_INDEX_SAME_CASETYPE", flags=("DONT_INDEX_SAME_CASETYPE",))
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


# A form whose one SaveToCase block creates a patient named by the answer and writes its risk, and the map Vellum
# computes from it (logic.js::LogicManager.caseReferences, saveToCase.js::getCaseSaveData), doc_type and all.
SAVE_TO_CASE_FORM = _form(
    data=f"""<q/><save vellum:role="SaveToCase" vellum:case_type="patient"><case xmlns="{CASE_NS}" case_id=""
     date_modified="" user_id=""><create><case_type/><case_name/></create><update><risk/></update></case></save>""",
    model="""<bind nodeset="/data/save/case/create/case_type" calculate="'patient'"/>
     <bind nodeset="/data/save/case/create/case_name" calculate="/data/q"/>
     <bind nodeset="/data/save/case/update/risk" calculate="/data/q"/>""",
    body='<input ref="/data/q"><label>Q</label></input>',
)
SAVED = {
    "/data/save": {
        "doc_type": "CaseSaveReference",
        "case_type": "patient",
        "properties": ["risk", "case_type", "case_name"],
        "create": True,
        "close": False,
    }
}


ORX = "http://openrosa.org/jr/xforms"


def _pollsensor_form(ref=None):
    """A form holding a GPS question and the ``pollsensor`` HQ's build writes: the bare one (``_add_pollsensor``'s
    ``elif``), or, with ``ref``, the one capturing the location into the meta block (``auto_gps_capture``)."""
    attributes = 'event="xforms-ready"' + (f' ref="{ref}"' if ref else "")
    return _form(
        data="<place/>",
        model=f'<bind nodeset="/data/place" type="geopoint"/><orx:pollsensor xmlns:orx="{ORX}" {attributes}/>',
        body='<input ref="/data/place"><label>P</label></input>',
    )


def _question_app(form, **fields):
    """An app whose one module holds ``form`` (unique_id ``f``), its XForm being QUESTIONS."""
    return _with_forms(_app([_module([form])], **fields), f=QUESTIONS)


def _usercase_form(preload):
    """A follow-up whose active ``usercase_update`` writes the worker's ``visits`` and whose ``usercase_preload``
    loads ``preload`` (``{path: property}``)."""
    return _form_json(
        usercase_preload={"condition": ALWAYS, "preload": preload},
        usercase_update={"condition": ALWAYS, "update": {"visits": _update("/data/q")}},
    )


def _linked(link, target_requires="case", **target_module):
    """A form linking to the form of another module (``f2``), by ``link``."""
    source = {**_form_json("none"), "form_links": [link]}
    target = {**_form_json(target_requires), "unique_id": "f2"}
    return _app([_module([source]), _module([target], unique_id="m2", **target_module)])


def _root_linked(link, *, root_case_type, target_case_type="visit"):
    """A form linking to the case form (``f2``) of a child menu (``m2``, of ``target_case_type``) whose root's
    first form requires a case of ``root_case_type``."""
    source = {**_form_json("none"), "form_links": [link]}
    root = {**_module([{**_form_json("case"), "unique_id": "f3"}], unique_id="tp"), "case_type": root_case_type}
    target = _module([{**_form_json("case"), "unique_id": "f2"}], unique_id="m2", root_module_id="tp")
    return _app([_module([source]), root, {**target, "case_type": target_case_type}])


# A menu that selects its case's parent first, in the linking form's menu (``m``, of case type ``patient``).
PARENT_SELECT = {"parent_select": {"active": True, "relationship": "parent", "module_id": "m"}, "case_type": "visit"}


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


def _labelled_media_app(medium, path, mapped, **fields):
    """An app whose one form's question carries ``path`` as its label's ``medium``, with that path's
    ``multimedia_map`` entry where ``mapped``, beside an entry for another file, so the map is used either way."""
    form = _form(
        data="<q/>",
        model=(
            '<itext><translation lang="en" default=""><text id="q-label"><value>Q</value>'
            f'<value form="{medium}">jr://file/{path}</value></text></translation></itext>'
            '<bind nodeset="/data/q" type="xsd:string"/>'
        ),
        body='<input ref="/data/q"><label ref="jr:itext(\'q-label\')"/></input>',
    )
    entries = {"jr://file/commcare/other.png": {"doc_type": "HQMediaMapItem", "media_type": "CommCareImage"}}
    if mapped:
        entries[f"jr://file/{path}"] = {
            "doc_type": "HQMediaMapItem",
            "media_type": "CommCareAudio" if medium == "audio" else "CommCareImage",
        }
    return _with_forms(_app([_module([_form_json("none")])], multimedia_map=entries, **fields), f=form)


def _image_column_app(mapped, **fields):
    """An app whose case list maps a status to the picture ``commcare/s.png`` in an image column, with that
    path's ``multimedia_map`` entry where ``mapped``, beside an entry for another file."""
    column = {
        "doc_type": "DetailColumn",
        "field": "status",
        "format": "enum-image",
        "enum": [{"key": "selected(., 'active')", "value": {"en": "jr://file/commcare/s.png"}}],
    }
    entries = {"jr://file/commcare/other.png": {"doc_type": "HQMediaMapItem", "media_type": "CommCareImage"}}
    if mapped:
        entries["jr://file/commcare/s.png"] = {"doc_type": "HQMediaMapItem", "media_type": "CommCareImage"}
    return _app([_detail_module([column])], multimedia_map=entries, **fields)


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


def test_a_media_class_in_the_app_hq_made_is_read_from_the_file_hq_holds_at_its_path(manifest):
    """Contract: a multimedia map item of the app HQ made (``app_json_uses(..., authored=True)``) names the file HQ
    holds at the item's path, so its class is read from what the observation made of that file
    (``Readings.authored_media``, by the path the map gives it); an app Nova sends names the file of Nova's local
    archive at the reference's path (``Readings.media``). The plausible failures: a class left undecided at an
    item of HQ's app whose file Nova's archive does not hold under that path (a file Nova keeps elsewhere, or one
    no reference reads), one read from Nova's file where HQ holds another under the same path, and an item of HQ's
    app whose path HQ holds no file at (a starter app's stale item) left undecided where no format class can take
    it."""
    path = "commcare/b31d.png"
    readings = manifest_usage.Readings(
        questions={},
        expressions={},
        strings={},
        csql={},
        trees={},
        conditions={},
        media={path: {"mime": "image/png"}},
        authored_media={f"jr://file/{path}": {"mime": "image/svg+xml"}, "jr://file/unread.png": {"mime": "image/png"}},
    )
    app = _app(
        [_module()],
        multimedia_map={
            f"jr://file/{path}": {"doc_type": "HQMediaMapItem", "media_type": "CommCareImage"},
            "jr://file/unread.png": {"doc_type": "HQMediaMapItem", "media_type": "CommCareImage"},
            "jr://file/gone.png": {"doc_type": "HQMediaMapItem", "media_type": "CommCareImage"},
        },
    )

    def verdicts(authored):
        found = manifest_usage.Uses()
        manifest_usage.app_json_uses(app, manifest, "app.json", found, authored=authored)
        manifest_usage.read_observed(found, manifest, readings)
        uses = [use for use in found.uses if use.key == "media-class:CommCareImage"]
        return {use.where.split("/")[2]: classes.svg_image(use, manifest) for use in uses}

    # HQ holds no file at gone.png (its media view answers 404), so no format class takes the item.
    assert verdicts(True) == {
        "jr:~1~1file~1commcare~1b31d.png": True,
        "jr:~1~1file~1unread.png": False,
        "jr:~1~1file~1gone.png": False,
    }
    assert verdicts(False) == {
        "jr:~1~1file~1commcare~1b31d.png": False,
        "jr:~1~1file~1unread.png": None,
        "jr:~1~1file~1gone.png": None,
    }


def _png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\0\0\0\0")) + chunk(b"IEND", b"")
    )


TIFF = b"II*\x00\x08\x00\x00\x00\x00\x00\x00\x00\x00\x00"
SVG = b'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n'
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
        "questions/authored-orx-pollsensor": (
            refused("form", _pollsensor_form(), "jr-action:pollsensor", "pollsensor[1]"),
            refused("form", _pollsensor_form(), "jr-extension:PollSensorExtensionParser", "pollsensor[1]"),
        ),
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
            accepted("form", labels, "mug:Trigger", "data[1]/{http://example.org/t}t[1]", readings=True),
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

    def named(names, langs=("en",)):
        """An app whose one form is named ``names``, its languages ``langs`` (the first the default)."""
        return _app([_module([{**_form_json("none"), "name": names}])], langs=list(langs))

    def advanced_named(names):
        app = _advanced_app()
        app["modules"][0]["forms"][0]["name"] = names
        return app

    form_name = "/modules/0/forms/0/name"

    def links(**link):
        return {"doc_type": "FormLink", "form_id": "f2", **link}

    case_id = "instance('commcaresession')/session/data/case_id"
    workflow = "/modules/0/forms/0/post_form_workflow"
    translations = "schema:Application.translations"
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
        "application-and-settings/translations-key-that-is-no-locale-record-under-its-own-name": (
            refused("app", app(translations={"en": {" home.start": "Begin"}}), translations, "/translations"),
            refused(
                "app", app(translations={"en": {"home.sync\nmodules.m0": "Rounds"}}), translations, "/translations"
            ),
            refused("app", app(translations={"en": {"tourn#e": "Tour"}}), translations, "/translations"),
            refused("app", app(translations={"en": {"x=y": "Begin"}}), translations, "/translations"),
            accepted("app", app(translations={"en": {"home.start": "Begin"}}), translations, "/translations"),
            # A language the app does not hold is read by nothing.
            accepted("app", app(translations={"fra": {" home.start": "Commencer"}}), translations, "/translations"),
            # The rest after a carriage return defines a string: the carriage-return entry refuses the key first.
            accepted("app", app(translations={"en": {"x=y": "Begin\rhome.start=Go"}}), translations, "/translations"),
        ),
        "application-and-settings/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare": (
            refused(
                "app",
                app(logo_refs={"hq_logo_android_home": {"path": "jr://file/commcare/logo/abc.png"}}),
                "schema:Application.logo_refs",
                "/logo_refs",
            ),
            refused(
                "app",
                app(
                    logo_refs={
                        "hq_logo_android_home": {"path": "jr://file/commcare/logo/data/hq_logo_android_home.png"}
                    }
                ),
                "schema:Application.logo_refs",
                "/logo_refs",
            ),
            accepted(
                "app",
                app(
                    logo_refs={
                        "hq_logo_android_home": {
                            "path": "jr://file/commcare/logo/data/hq_logo_android_home.png",
                            "m_id": "6c4f0e1b2d3a",
                        }
                    }
                ),
                "schema:Application.logo_refs",
                "/logo_refs",
            ),
        ),
        "application-and-settings/repeated-android-app-dependency": (
            refused("app", app(profile={"features": {"dependencies": ["org.rdtoolkit", "org.rdtoolkit"]}}),
                    "setting:features.dependencies", "/profile/features/dependencies"),
            accepted("app", app(profile={"features": {"dependencies": ["org.rdtoolkit", "com.simprints.id"]}}),
                     "setting:features.dependencies", "/profile/features/dependencies"),
        ),
        "application-and-settings/profile-properties-or-features-dependencies-value-outside-its": (
            refused(
                "app",
                app(profile={"properties": {"cc-autoup-freq": "freq-hourly"}}),
                "setting:properties.cc-autoup-freq",
                "/profile/properties/cc-autoup-freq",
            ),
            accepted(
                "app",
                app(profile={"properties": {"cc-autoup-freq": "freq-never"}}),
                "setting:properties.cc-autoup-freq",
                "/profile/properties/cc-autoup-freq",
            ),
            # The number HQ's own save stores for the GPS accuracy is the row before's, not one outside the choices.
            accepted(
                "app",
                app(profile={"properties": {"cc-gps-auto-capture-accuracy": 10}}),
                "setting:properties.cc-gps-auto-capture-accuracy",
                "/profile/properties/cc-gps-auto-capture-accuracy",
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
        "forms-and-case-writes/form-name-read-as-an-instance": (
            refused("app", named({"en": "instance('abc') practice"}), "schema:Form.name", form_name),
            refused(
                "app",
                named({"fr": 'instance( "item-list:v" )', "en": "Visit"}, ("fr", "en")),
                "schema:Form.name",
                form_name,
            ),
            refused("app", advanced_named({"en": "instance('casedb')"}), "schema:AdvancedForm.name", form_name),
            # The spelling Nova offers: a space before the bracket, which HQ's pattern does not read.
            accepted("app", named({"en": "instance ('abc') practice"}), "schema:Form.name", form_name),
            # A name in another language reaches only the app's strings.
            accepted(
                "app", named({"en": "Visit", "fr": "instance('abc')"}, ("en", "fr")), "schema:Form.name", form_name
            ),
            accepted("app", advanced_named({"en": "Visit"}), "schema:AdvancedForm.name", form_name),
            # No default-language name: what the source's title holds is not in the app JSON.
            unsettled("app", named({"fr": "instance('abc')"}, ("en", "fr")), "schema:Form.name", form_name),
        ),
        "forms-and-case-writes/form-type-other-than-the-form-s-own-kind": (
            refused(
                "app",
                _app([_module([{**_form_json(), "form_type": "advanced_form"}])]),
                "schema:Form.form_type",
                "/modules/0/forms/0/form_type",
            ),
        ),
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
            # Under the condition never, HQ's build writes no key of the map, the inert class beside it.
            accepted(
                "app",
                _app(
                    [_module([_form_json(update_case={"condition": NEVER, "update": {"mother/dob": _update("/q")}})])]
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
            # Beside an update that writes, a load into a question outside any repeat is the row above's, and one
            # into a repeat's question, or of a property a worker-record read cannot spell, is this class.
            accepted(
                "app",
                _question_app(_usercase_form({"/data/q": "name", "s": "district"})),
                "schema:FormActions.usercase_preload",
                f"{actions}/usercase_preload",
            ),
            refused(
                "app",
                _question_app(_usercase_form({"/data/q": "name", "/data/rep/name": "district"})),
                "schema:FormActions.usercase_preload",
                f"{actions}/usercase_preload",
            ),
            refused(
                "app",
                _question_app(_usercase_form({"/data/q": "parent/district"})),
                "schema:FormActions.usercase_preload",
                f"{actions}/usercase_preload",
            ),
            # Without the form's source the export does not say which questions the paths name.
            unsettled(
                "app",
                _app([_module([_usercase_form({"/data/q": "name"})])]),
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
            # A form holding a SaveToCase block: the map Vellum computes from it, and the same map without the
            # case name the block's create binds.
            accepted(
                "app",
                _with_forms(
                    _app([_module([{**_form_json(), "case_references_data": {"load": {}, "save": SAVED}}])]),
                    f=SAVE_TO_CASE_FORM,
                ),
                "schema:Form.case_references_data",
                "/modules/0/forms/0/case_references_data",
            ),
            refused(
                "app",
                _with_forms(
                    _app(
                        [
                            _module(
                                [
                                    {
                                        **_form_json(),
                                        "case_references_data": {
                                            "load": {},
                                            "save": {
                                                "/data/save": {
                                                    **SAVED["/data/save"],
                                                    "properties": ["risk", "case_type"],
                                                }
                                            },
                                        },
                                    }
                                ]
                            )
                        ]
                    ),
                    f=SAVE_TO_CASE_FORM,
                ),
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
            # A condition's own slot is read on that condition, not on the close condition beside it.
            accepted(
                "app",
                _question_app(
                    _form_json(subcases=[_subcase(condition=_if("/data/s"), close_condition=_if("/data/q"))])
                ),
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
            # A basic preload on a label is in the class; one into a repeat question is the inert class beside it.
            refused(
                "app",
                _question_app(_form_json(case_preload={"doc_type": "PreloadAction", "preload": {"/data/t": "note"}})),
                "schema:PreloadAction.preload",
                "/modules/0/forms/0/actions/case_preload/preload",
            ),
            accepted(
                "app",
                _question_app(
                    _form_json(case_preload={"doc_type": "PreloadAction", "preload": {"/data/rep/name": "note"}})
                ),
                "schema:PreloadAction.preload",
                "/modules/0/forms/0/actions/case_preload/preload",
            ),
            # An advanced load takes no repeat question; an open action none outside its own repeat.
            refused(
                "app",
                _advanced_app([_load("load_patient_0", case_properties={"note": _update("/data/rep/name")})]),
                "schema:ConditionalCaseUpdate.question_path",
                "/modules/0/forms/0/actions/load_update_cases/0/case_properties/note/question_path",
            ),
            refused(
                "app",
                _advanced_app(
                    opens=[
                        _open(
                            "open_visit_0",
                            name_update=_update("/data/q"),
                            case_properties={"note": _update("/data/rep/name")},
                        )
                    ]
                ),
                "schema:ConditionalCaseUpdate.question_path",
                "/modules/0/forms/0/actions/open_cases/0/case_properties/note/question_path",
            ),
            # The advanced pickers offer labels, and an open action in a repeat that repeat's questions.
            accepted(
                "app",
                _advanced_app([_load("load_patient_0", case_properties={"note": _update("/data/t")})]),
                "schema:ConditionalCaseUpdate.question_path",
                "/modules/0/forms/0/actions/load_update_cases/0/case_properties/note/question_path",
            ),
            accepted(
                "app",
                _advanced_app(
                    opens=[
                        _open(
                            "open_visit_0",
                            repeat_context="/data/rep",
                            name_update=_update("/data/rep/name"),
                            case_properties={"note": _update("/data/q")},
                        )
                    ]
                ),
                "schema:ConditionalCaseUpdate.question_path",
                "/modules/0/forms/0/actions/open_cases/0/name_update/question_path",
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
            refused(
                "app",
                _app([_module([_form_json(subcases=[_subcase(case_type="patient")])])]),
                "schema:OpenSubCaseAction.case_type",
                f"{subcases}/0/case_type",
                configurations=(SAME_TYPE_UNINDEXED, PLAIN),
            ),
            accepted(
                "app",
                _app([_module([_form_json(subcases=[_subcase(case_type="patient")])])]),
                "schema:OpenSubCaseAction.case_type",
                f"{subcases}/0/case_type",
                configurations=(PLAIN,),
            ),
            accepted(
                "app",
                _app([_module([_form_json(subcases=[_subcase(case_type="child")])])]),
                "schema:OpenSubCaseAction.case_type",
                f"{subcases}/0/case_type",
                configurations=(SAME_TYPE_UNINDEXED,),
            ),
            unsettled(
                "app",
                _app([_module([_form_json(subcases=[_subcase(case_type="patient")])])]),
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
            # A target menu that selects the parent first needs that selection too (``parent_id``).
            refused(
                "app",
                _linked(links(datums=[{"name": "case_id", "xpath": case_id}]), **PARENT_SELECT),
                "schema:Form.form_links",
                "/modules/0/forms/0/form_links",
            ),
            accepted(
                "app",
                _linked(
                    links(datums=[{"name": "parent_id", "xpath": case_id}, {"name": "case_id", "xpath": case_id}]),
                    **PARENT_SELECT,
                ),
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
            accepted(
                "app",
                _linked(
                    links(datums=[{"name": "parent_id", "xpath": case_id}, {"name": "case_id", "xpath": case_id}]),
                    **PARENT_SELECT,
                ),
                "schema:Form.form_links",
                "/modules/0/forms/0/form_links",
            ),
            # A child menu's case datum whose id its root's first form holds is renamed for its case type, and
            # takes the root's id back only where both select one case type (``add_parent_datums``).
            refused(
                "app",
                _root_linked(links(datums=[{"name": "case_id", "xpath": case_id}]), root_case_type="patient"),
                "schema:Form.form_links",
                "/modules/0/forms/0/form_links",
            ),
            accepted(
                "app",
                _root_linked(links(datums=[{"name": "case_id_visit", "xpath": case_id}]), root_case_type="patient"),
                "schema:Form.form_links",
                "/modules/0/forms/0/form_links",
            ),
            accepted(
                "app",
                _root_linked(links(datums=[{"name": "case_id", "xpath": case_id}]), root_case_type="visit"),
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


def _load(tag, **fields):
    return {"doc_type": "LoadUpdateAction", "case_type": "patient", "case_tag": tag, **fields}


def _open(tag, **fields):
    return {"doc_type": "AdvancedOpenCaseAction", "case_type": "visit", "case_tag": tag, **fields}


def _index(tag, **fields):
    return {"doc_type": "CaseIndex", "tag": tag, **fields}


def _advanced_app(loads=(), opens=(), modules_before=(), **module):
    """An app whose advanced menu (after ``modules_before``) holds one advanced form (unique_id ``f``) with these
    loads and open actions, its XForm being QUESTIONS (a repeat ``/data/rep`` holding ``name``)."""
    form = {
        "doc_type": "AdvancedForm",
        "unique_id": "f",
        "actions": {"doc_type": "AdvancedFormActions", "load_update_cases": list(loads), "open_cases": list(opens)},
    }
    advanced = {"doc_type": "AdvancedModule", "unique_id": "m", "case_type": "patient", "forms": [form], **module}
    return _with_forms(_app([*modules_before, advanced]), f=QUESTIONS)


def _scheduled_app(schedule):
    """An app whose advanced menu's one form (``_advanced_app``) holds this visit schedule."""
    app = _advanced_app()
    app["modules"][0]["forms"][0]["schedule"] = schedule
    return app


def _shadow_app(source_loads, extra_loads):
    """An app whose advanced menu holds the advanced form ``f`` with these loads and the mirror form ``s`` of it whose
    ``extra_actions`` hold ``extra_loads``."""
    app = _advanced_app(source_loads)
    shadow = {
        "doc_type": "ShadowForm",
        "unique_id": "s",
        "shadow_parent_form_id": "f",
        "extra_actions": {"doc_type": "AdvancedFormActions", "load_update_cases": list(extra_loads), "open_cases": []},
    }
    app["modules"][0]["forms"].append(shadow)
    return app


def _advanced_actions():
    """The classes of an advanced form's loads and open actions, each read in the action a use sits in."""
    loads = "/modules/0/forms/0/actions/load_update_cases"
    opens = "/modules/0/forms/0/actions/open_cases"
    load_tag, open_tag = "schema:LoadUpdateAction.case_tag", "schema:AdvancedOpenCaseAction.case_tag"
    household = _load("load_household_0", case_type="household")
    linked = _load("load_patient_1", case_index=_index("load_household_0"))
    worker = _load("usercase", auto_select={"doc_type": "AutoSelectCase", "mode": "usercase", "value_key": ""})
    in_repeat = {"repeat_context": "/data/rep", "name_update": _update("/data/rep/name")}
    to_household = {"case_indices": [_index("load_household_0")]}
    # A child menu under a basic case-selecting root of the same type: HQ gives its load the root's ``case_id``.
    root = _module([_form_json("case")], unique_id="r")
    child_menu = {"root_module_id": "r"}
    renamed_index = "/modules/1/forms/0/actions/open_cases/0/case_indices/0/tag"
    question = {"relationship": "question", "relationship_question": "/data/q"}
    by_case = {"doc_type": "AutoSelectCase", "mode": "case", "value_key": "parent"}
    extra = "/modules/0/forms/1/extra_actions/load_update_cases"
    return {
        "forms-and-case-writes/an-auto-select-load-with-a-blank-mode-or-a-blank-case-type": (
            refused(
                "app",
                _advanced_app([{**worker, "case_type": ""}]),
                "schema:LoadUpdateAction.case_type",
                f"{loads}/0/case_type",
            ),
            refused(
                "app",
                _advanced_app([{**worker, "auto_select": {**worker["auto_select"], "mode": ""}}]),
                "schema:AutoSelectCase.mode",
                f"{loads}/0/auto_select/mode",
            ),
            accepted("app", _advanced_app([worker]), "schema:AutoSelectCase.mode", f"{loads}/0/auto_select/mode"),
            # A load that does not select its case itself takes its case type from its list.
            accepted(
                "app",
                _advanced_app([_load("load_patient_0", case_type="")]),
                "schema:LoadUpdateAction.case_type",
                f"{loads}/0/case_type",
            ),
        ),
        "forms-and-case-writes/auto-select-mode-case-naming-itself-a-later-load-or-an-open": (
            refused(
                "app",
                _advanced_app(
                    [household, _load("load_patient_1", auto_select={**by_case, "value_source": "load_patient_1"})]
                ),
                "schema:AutoSelectCase.value_source",
                f"{loads}/1/auto_select/value_source",
            ),
            accepted(
                "app",
                _advanced_app(
                    [household, _load("load_patient_1", auto_select={**by_case, "value_source": "load_household_0"})]
                ),
                "schema:AutoSelectCase.value_source",
                f"{loads}/1/auto_select/value_source",
            ),
            accepted("app", _advanced_app([worker]), "schema:AutoSelectCase.mode", f"{loads}/0/auto_select/mode"),
        ),
        "forms-and-case-writes/show-product-stock-true-or-a-non-empty-product-program": (
            refused(
                "app",
                _advanced_app([_load("load_patient_0", show_product_stock=True)]),
                "schema:LoadUpdateAction.show_product_stock",
                f"{loads}/0/show_product_stock",
            ),
            refused(
                "app",
                _advanced_app([_load("load_patient_0", product_program="p")]),
                "schema:LoadUpdateAction.product_program",
                f"{loads}/0/product_program",
            ),
            # The advanced editor's new load: ``show_product_stock`` false and a blank ``product_program``.
            accepted(
                "app",
                _advanced_app([_load("load_patient_0", product_program="", show_product_stock=False)]),
                "schema:LoadUpdateAction.product_program",
                f"{loads}/0/product_program",
            ),
        ),
        "forms-and-case-writes/advancedform-schedule-with-enabled-true-visits-transition": (
            refused(
                "app",
                _scheduled_app({"doc_type": "FormSchedule", "enabled": True}),
                "schema:AdvancedForm.schedule",
                "/modules/0/forms/0/schedule",
            ),
            # The schedule HQ writes on every new advanced form (``AdvancedModule.new_form``): off.
            accepted(
                "app",
                _scheduled_app({"doc_type": "FormSchedule", "enabled": False}),
                "schema:AdvancedForm.schedule",
                "/modules/0/forms/0/schedule",
            ),
            accepted(
                "app",
                _scheduled_app({"doc_type": "FormSchedule", "enabled": False}),
                "schema:FormSchedule.enabled",
                "/modules/0/forms/0/schedule/enabled",
            ),
        ),
        "forms-and-case-writes/extra-actions-load-update-cases-show-product-stock-true-or-a-non": (
            refused(
                "app",
                _shadow_app([_load("load_patient_0")], [_load("load_patient_0", show_product_stock=True)]),
                "schema:LoadUpdateAction.show_product_stock",
                f"{extra}/0/show_product_stock",
            ),
            accepted(
                "app",
                _shadow_app([_load("load_patient_0")], [_load("load_patient_0")]),
                "schema:AdvancedFormActions.load_update_cases",
                extra,
            ),
            # A load of an advanced form's own is ``commtrack-on``'s.
            accepted(
                "app",
                _advanced_app([_load("load_patient_0", show_product_stock=True)]),
                "schema:LoadUpdateAction.show_product_stock",
                f"{loads}/0/show_product_stock",
            ),
        ),
        "forms-and-case-writes/a-parent-load-tag-not-repeated-in-extra-actions-where-the-parent": (
            refused(
                "app",
                _shadow_app(
                    [_load("load_patient_0", case_properties={"note": _update("/data/q")})], [_load("load_other_0")]
                ),
                "schema:AdvancedFormActions.load_update_cases",
                extra,
            ),
            # A source load the source XForm neither reads nor writes through may be left out.
            accepted(
                "app",
                _shadow_app([_load("load_patient_0")], [_load("load_other_0")]),
                "schema:AdvancedFormActions.load_update_cases",
                extra,
            ),
            accepted(
                "app",
                _shadow_app(
                    [_load("load_patient_0", case_properties={"note": _update("/data/q")})], [_load("load_patient_0")]
                ),
                "schema:AdvancedFormActions.load_update_cases",
                extra,
            ),
            accepted("app", _advanced_app([household]), "schema:AdvancedFormActions.load_update_cases", loads),
        ),
        "forms-and-case-writes/a-load-or-open-action-s-case-tag-containing-which-the-advanced": (
            refused("app", _advanced_app([_load("load/patient")]), load_tag, f"{loads}/0/case_tag"),
            refused("app", _advanced_app(opens=[_open("open/visit")]), open_tag, f"{opens}/0/case_tag"),
            accepted("app", _advanced_app([_load("load_patient_0")]), load_tag, f"{loads}/0/case_tag"),
        ),
        "forms-and-case-writes/case-tag-blank-on-a-non-auto-select-action": (
            refused("app", _advanced_app([_load("")]), load_tag, f"{loads}/0/case_tag"),
            refused("app", _advanced_app(opens=[_open("")]), open_tag, f"{opens}/0/case_tag"),
            # The editor checks no tag of a load that selects its case itself.
            accepted("app", _advanced_app([{**worker, "case_tag": ""}]), load_tag, f"{loads}/0/case_tag"),
            accepted("app", _advanced_app([_load("load_patient_0")]), load_tag, f"{loads}/0/case_tag"),
        ),
        "forms-and-case-writes/case-tag-of-a-non-auto-select-action-failing-actions-js": (
            refused("app", _advanced_app([_load("0patient")]), load_tag, f"{loads}/0/case_tag"),
            # JavaScript's ``$`` matches no trailing newline, so the editor refuses this tag.
            refused("app", _advanced_app([_load("patient\n")]), load_tag, f"{loads}/0/case_tag"),
            # One tag on a load and an open action: the open action's is the second the page counts.
            refused("app", _advanced_app([household], [_open("load_household_0")]), open_tag, f"{opens}/0/case_tag"),
            accepted("app", _advanced_app([{**worker, "case_tag": "0user"}]), load_tag, f"{loads}/0/case_tag"),
            accepted("app", _advanced_app([household], [_open("open_visit_0")]), open_tag, f"{opens}/0/case_tag"),
        ),
        "forms-and-case-writes/loadupdateaction-preload-or-case-properties-property-with-on-a": (
            refused(
                "app",
                _advanced_app([household, {**linked, "case_properties": {"parent/name": _update("/data/q")}}]),
                "schema:LoadUpdateAction.case_properties",
                f"{loads}/1/case_properties",
            ),
            refused(
                "app",
                _advanced_app([household, {**linked, "preload": {"/data/q": "parent/name"}}]),
                "schema:LoadUpdateAction.preload",
                f"{loads}/1/preload",
            ),
            # The same parent write on a load with no index is a write HQ's builder resolves.
            accepted(
                "app",
                _advanced_app(
                    [household, _load("load_patient_1", case_properties={"parent/name": _update("/data/q")})]
                ),
                "schema:LoadUpdateAction.case_properties",
                f"{loads}/1/case_properties",
            ),
        ),
        "forms-and-case-writes/loadupdateaction-case-index-on-an-auto-selected-load-or-on-the": (
            refused(
                "app",
                _advanced_app([{**linked, "case_index": _index("open_visit_0")}], [_open("open_visit_0")]),
                "schema:LoadUpdateAction.case_index",
                f"{loads}/0/case_index",
            ),
            refused(
                "app",
                _advanced_app([household, {**worker, "case_index": _index("load_household_0")}]),
                "schema:LoadUpdateAction.case_index",
                f"{loads}/1/case_index",
            ),
            accepted(
                "app", _advanced_app([household, linked]), "schema:LoadUpdateAction.case_index", f"{loads}/1/case_index"
            ),
        ),
        "forms-and-case-writes/loadupdateaction-case-index-tag-naming-a-load-other-than-the-one": (
            refused(
                "app",
                _advanced_app([household, _load("load_patient_1"), {**linked, "case_tag": "load_patient_2"}]),
                "schema:CaseIndex.tag",
                f"{loads}/2/case_index/tag",
            ),
            accepted("app", _advanced_app([household, linked]), "schema:CaseIndex.tag", f"{loads}/1/case_index/tag"),
            # A tag naming no action is HQ's build's refusal (``missing parent tag``), another entry's.
            accepted(
                "app",
                _advanced_app([household, {**linked, "case_index": _index("load_nothing_9")}]),
                "schema:CaseIndex.tag",
                f"{loads}/1/case_index/tag",
            ),
        ),
        "forms-and-case-writes/advancedopencaseaction-case-properties-key-with-parent-p": (
            refused(
                "app",
                _advanced_app(opens=[_open("open_visit_0", case_properties={"parent/name": _update("/data/q")})]),
                "schema:AdvancedOpenCaseAction.case_properties",
                f"{opens}/0/case_properties",
            ),
            accepted(
                "app",
                _advanced_app(opens=[_open("open_visit_0", case_properties={"name": _update("/data/q")})]),
                "schema:AdvancedOpenCaseAction.case_properties",
                f"{opens}/0/case_properties",
            ),
        ),
        "forms-and-case-writes/two-or-more-open-actions-whose-repeat-context-is-one-repeat": (
            refused(
                "app",
                _advanced_app([household], [_open("open_visit_0", **in_repeat), _open("open_visit_1", **in_repeat)]),
                "schema:AdvancedOpenCaseAction.repeat_context",
                f"{opens}/1/repeat_context",
            ),
            # Two indexed open actions in the repeat: HQ nests each block under its own ``case_<tag>``.
            accepted(
                "app",
                _advanced_app(
                    [household],
                    [
                        _open("open_visit_0", **in_repeat, **to_household),
                        _open("open_visit_1", **in_repeat, **to_household),
                    ],
                ),
                "schema:AdvancedOpenCaseAction.repeat_context",
                f"{opens}/1/repeat_context",
            ),
        ),
        "forms-and-case-writes/advancedopencaseaction-repeat-context-other-than-the-name": (
            refused(
                "app",
                _advanced_app(
                    opens=[_open("open_visit_0", name_update=_update("/data/q"), repeat_context="/data/rep")]
                ),
                "schema:AdvancedOpenCaseAction.repeat_context",
                f"{opens}/0/repeat_context",
            ),
            accepted(
                "app",
                _advanced_app(opens=[_open("open_visit_0", **in_repeat)]),
                "schema:AdvancedOpenCaseAction.repeat_context",
                f"{opens}/0/repeat_context",
            ),
        ),
        "forms-and-case-writes/advancedopencaseaction-case-indices-naming-its-own-or-a-later": (
            refused(
                "app",
                _advanced_app(
                    opens=[_open("open_visit_0", case_indices=[_index("open_visit_1")]), _open("open_visit_1")]
                ),
                "schema:CaseIndex.tag",
                f"{opens}/0/case_indices/0/tag",
            ),
            accepted(
                "app",
                _advanced_app(
                    opens=[_open("open_visit_0"), _open("open_visit_1", case_indices=[_index("open_visit_0")])]
                ),
                "schema:CaseIndex.tag",
                f"{opens}/1/case_indices/0/tag",
            ),
        ),
        "forms-and-case-writes/an-advanced-open-action-s-index-to-a-load-whose-datum-hq-renames": (
            refused(
                "app",
                _advanced_app(
                    [_load("load_patient_0")],
                    [_open("open_visit_0", case_indices=[_index("load_patient_0")])],
                    modules_before=[root],
                    **child_menu,
                ),
                "schema:CaseIndex.tag",
                renamed_index,
            ),
            # Under a root of another case type HQ keeps the load's own datum id.
            accepted(
                "app",
                _advanced_app(
                    [_load("load_patient_0")],
                    [_open("open_visit_0", case_indices=[_index("load_patient_0")])],
                    modules_before=[{**root, "case_type": "household"}],
                    **child_menu,
                ),
                "schema:CaseIndex.tag",
                renamed_index,
            ),
        ),
        "forms-and-case-writes/caseindex-relationship-question-inside-a-repeat": (
            refused(
                "app",
                _advanced_app(
                    [household],
                    [
                        _open(
                            "open_visit_0",
                            case_indices=[
                                _index("load_household_0", **{**question, "relationship_question": "/data/rep/name"})
                            ],
                        )
                    ],
                ),
                "schema:CaseIndex.relationship_question",
                f"{opens}/0/case_indices/0/relationship_question",
            ),
            accepted(
                "app",
                _advanced_app(
                    [household], [_open("open_visit_0", case_indices=[_index("load_household_0", **question)])]
                ),
                "schema:CaseIndex.relationship_question",
                f"{opens}/0/case_indices/0/relationship_question",
            ),
        ),
        "forms-and-case-writes/caseindex-relationship-question-relationship-question-the-index-naming-an": (
            refused(
                "app",
                _advanced_app(
                    opens=[
                        _open("open_visit_0"),
                        _open("open_visit_1", case_indices=[_index("open_visit_0", **question)]),
                    ]
                ),
                "schema:CaseIndex.relationship",
                f"{opens}/1/case_indices/0/relationship",
            ),
            accepted(
                "app",
                _advanced_app(
                    [household], [_open("open_visit_0", case_indices=[_index("load_household_0", **question)])]
                ),
                "schema:CaseIndex.relationship",
                f"{opens}/0/case_indices/0/relationship",
            ),
        ),
        "forms-and-case-writes/caseindex-relationship-question-on-an-index-to-a-load-that": (
            refused(
                "app",
                _advanced_app(
                    [household],
                    [
                        _open("open_visit_0"),
                        _open(
                            "open_visit_1",
                            case_indices=[_index("open_visit_0"), _index("load_household_0", **question)],
                        ),
                    ],
                ),
                "schema:CaseIndex.relationship",
                f"{opens}/1/case_indices/1/relationship",
            ),
            # The index to the load first: HQ writes its binds on the child's own block.
            accepted(
                "app",
                _advanced_app(
                    [household],
                    [
                        _open("open_visit_0"),
                        _open(
                            "open_visit_1",
                            case_indices=[_index("load_household_0", **question), _index("open_visit_0")],
                        ),
                    ],
                ),
                "schema:CaseIndex.relationship",
                f"{opens}/1/case_indices/0/relationship",
            ),
        ),
        "forms-and-case-writes/an-advanced-open-action-indexed-to-an-open-action-that-has-a-neither": (
            refused(
                "app",
                _advanced_app(
                    opens=[
                        _open("open_visit_0", **in_repeat),
                        _open("open_visit_1", repeat_context="/data/rep2", case_indices=[_index("open_visit_0")]),
                    ]
                ),
                "schema:CaseIndex.tag",
                f"{opens}/1/case_indices/0/tag",
            ),
            accepted(
                "app",
                _advanced_app(
                    opens=[
                        _open("open_visit_0", **in_repeat),
                        _open("open_visit_1", **in_repeat, case_indices=[_index("open_visit_0")]),
                    ]
                ),
                "schema:CaseIndex.tag",
                f"{opens}/1/case_indices/0/tag",
            ),
        ),
    }


def _search_and_menus():
    config = "/modules/0/search_config"
    prompts = f"{config}/properties/0"
    short = "/modules/0/case_details/short"
    long_ = "/modules/0/case_details/long"
    tile = {"case_tile_template": "custom"}

    def cell(x, y, width, height=1):
        return {"grid_x": x, "grid_y": y, "width": width, "height": height}

    village = {"patient": {"village": "text", "visits": "int"}, "visit": {"outcome": "single_select"}}

    def tab(start, **fields):
        return {"doc_type": "DetailTab", "header": {"en": "Tab"}, "starting_index": start, **fields}

    def tabbed(*tabs):
        """A menu whose case detail's three fields stand under ``tabs``."""
        return details(
            _detail_module(long_columns=[_column(), _column("village"), _column("visits")], long={"tabs": list(tabs)})
        )

    def lined(text):
        return {"persist_case_context": True, "persistent_case_context_xml": text}

    def search(*modules, **fields):
        return _app(list(modules), **fields)

    def auto_selecting(module):
        """``module`` whose case list chooses its case by itself, as HQ reads it (its short detail's ``auto_select``,
        multi-select or not)."""
        return {
            **module,
            "case_details": {"doc_type": "DetailPair", "short": {"doc_type": "Detail", "auto_select": True}},
        }

    def details(*modules):
        return _app(list(modules))

    def columns_app(*columns, doc_type="Module", where="short", **fields):
        placed = {"columns": columns} if where == "short" else {"long_columns": columns}
        return details(_detail_module(**placed, doc_type=doc_type, **fields))

    def order_shape(verdict, key, *columns, readings=False, case_types=None, **sort):
        wire = {"doc_type": "SortElement", "field": "", "sort_calculation": "notes", "type": "plain", **sort}
        wire = {name: value for name, value in wire.items() if value is not None}
        return verdict(
            "app", columns_app(*columns, case_type="patient", short={"sort_elements": [wire]}),
            f"schema:SortElement.{key}", f"{short}/sort_elements/0/{key}", readings=readings, case_types=case_types,
        )

    def plain(**module):
        return _module(unique_id=module.pop("unique_id", "p"), **module)

    # A form that returns to its own menu after it is sent.
    returns_to_its_menu = {**_form_json(), "post_form_workflow": "module"}
    # A form whose one after-submit link opens the menu ``p``.
    linked_to_p = {
        **_form_json(),
        "post_form_workflow": "form",
        "form_links": [{"doc_type": "FormLink", "xpath": "", "module_unique_id": "p", "datums": []}],
    }

    def product_app(short=None, long_columns=(), header=None, **column):
        """An advanced menu whose product details are the ones ``AdvancedModule.new_module`` writes, but for
        ``short``'s detail settings, the long detail's columns and the product column's ``header`` and fields."""
        product = {
            **_column(model="product"),
            "header": header or {"en": "Product"},
            "useXpathExpression": False,
            **column,
        }
        pair = {
            "doc_type": "DetailPair",
            "short": {"doc_type": "Detail", "display": "short", "columns": [product], **(short or {})},
            "long": {"doc_type": "Detail", "display": "long", "columns": list(long_columns)},
        }
        return details(_module(doc_type="AdvancedModule", product_details=pair))

    multi = {"short": {"multi_select": True}}
    icons = [{"doc_type": "MappingItem", "key": "yes", "value": {"en": "jr://file/commcare/image/yes.png"}}]

    # An instance a form declares and a calculate of it reads; the read's place, at the calculate.
    def read_in_form(instance_id, src):
        return _form(
            data="<q/>",
            model=(
                f'<instance id="{instance_id}" src="{src}"/>'
                f'<bind nodeset="/data/q" calculate="count(instance(\'{instance_id}\')/*)"/>'
            ),
        )

    # A menu whose display condition reads an instance.
    def read_in_slot(condition):
        return _app([_module(module_filter=condition)])

    read_at = ("instance-scheme:results", "model[1]/bind[1]/@calculate")
    input_at = ("instance-scheme:search-input", "model[1]/bind[1]/@calculate")
    places_at = ("instance-scheme:locations", "model[1]/bind[1]/@calculate")
    module_read = ("instance-scheme:results", "/modules/0/module_filter")
    module_input = ("instance-scheme:search-input", "/modules/0/module_filter")
    search_input = "instance('search-input:results')/input/field"
    legacy_input = "instance('search-input')/input/field"
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
            # Another default filter beside the one keyed so is in no such class.
            accepted(
                "app",
                search(
                    _search_module(
                        custom_related_case_property="parent/x",
                        default_properties=[
                            _default("status", "'open'"),
                            _default("x_commcare_custom_related_case_property", "'parent/x'"),
                        ],
                    )
                ),
                "schema:DefaultCaseSearchProperty.property",
                f"{config}/default_properties/0/property",
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
        "case-search/data-registry-data-registry-workflow-additional-registry-cases": (
            refused(
                "app",
                search(_search_module(data_registry="r", data_registry_workflow="load_case")),
                "schema:CaseSearch.data_registry_workflow",
                f"{config}/data_registry_workflow",
            ),
            refused(
                "app",
                search(_search_module(data_registry="r")),
                "schema:CaseSearch.data_registry",
                f"{config}/data_registry",
            ),
            accepted(
                "app",
                search(_search_module(data_registry="", data_registry_workflow="load_case")),
                "schema:CaseSearch.data_registry_workflow",
                f"{config}/data_registry_workflow",
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
            # The class stands at the filter, which Nova's reader refuses whole, never at the list that holds it.
            refused(
                "app",
                search(_search_module(default_properties=[_default("status")])),
                "schema:DefaultCaseSearchProperty",
                f"{config}/default_properties/0",
            ),
            accepted(
                "app",
                search(_search_module(default_properties=[_default("status")])),
                "schema:CaseSearch.default_properties",
                f"{config}/default_properties",
            ),
            # a value of white space alone is none, as JavaScript's trim reads it
            refused(
                "app",
                search(_search_module(default_properties=[_default("status", " \u3000")])),
                "schema:DefaultCaseSearchProperty",
                f"{config}/default_properties/0",
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
            # Another default filter beside the one keyed so is in no such class.
            accepted(
                "app",
                search(
                    _search_module(
                        blacklisted_owner_ids_expression="'a'",
                        default_properties=[
                            _default("status", "'open'"),
                            _default("commcare_blacklisted_owner_ids", "'b'"),
                        ],
                    )
                ),
                "schema:DefaultCaseSearchProperty.property",
                f"{config}/default_properties/0/property",
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
            # A prompt beside the one that shares a name is in no such class.
            accepted(
                "app",
                search(
                    _search_module(
                        properties=[_prompt("village"), _prompt("dob")], default_properties=[_default("dob", "'x'")]
                    )
                ),
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
        "case-search/input-no-runtime-names": (
            refused(
                "app",
                search(_search_module(properties=[_prompt("dob", input_="slider")])),
                "schema:CaseSearchProperty.input_",
                f"{prompts}/input_",
            ),
            accepted(
                "app",
                search(_search_module(properties=[_prompt("dob", input_="daterange")])),
                "schema:CaseSearchProperty.input_",
                f"{prompts}/input_",
            ),
            refused("suite", INPUT_SUITE, "parser:QueryPromptParser/prompt@input", "prompt[1]/@input"),
            accepted("suite", INPUT_SUITE, "parser:QueryPromptParser/prompt@input", "prompt[2]/@input"),
        ),
        "case-search/receiver-expression-on-a-prompt-whose-editor-appearance-is": tuple(
            make(
                "app",
                search(_search_module(properties=[_prompt("dob", receiver_expression="'x'", **fields)])),
                "schema:CaseSearchProperty.receiver_expression",
                f"{prompts}/receiver_expression",
            )
            for make, fields in (
                (refused, {"appearance": "barcode_scan"}),
                (refused, {"input_": "daterange"}),
                # the date input HQ's page shows over a stored address appearance
                (refused, {"appearance": "address", "input_": "date"}),
                (accepted, {}),  # a plain text field
                # a selection's lookup choice shows over a stored barcode appearance
                (
                    accepted,
                    {
                        "appearance": "barcode_scan",
                        "input_": "select1",
                        "itemset": {"doc_type": "Itemset", "instance_id": "item-list:regions"},
                    },
                ),
            )
        ),
        # HQ's build reads these three only on a search the menu offers; on one it does not, each is part of the
        # search configuration HQ stores and builds nothing of.
        "case-search/case-search-endpoint-id": (
            refused(
                "app",
                search(_search_module(properties=[_prompt("dob")], case_search_endpoint_id="visits")),
                "schema:CaseSearch.case_search_endpoint_id",
                f"{config}/case_search_endpoint_id",
            ),
            accepted(
                "app",
                search(_search_module(case_search_endpoint_id="visits")),
                "schema:CaseSearch.case_search_endpoint_id",
                f"{config}/case_search_endpoint_id",
            ),
            # a default filter is the endpoint's parameter beside an id, and its own key's with none
            refused(
                "app",
                search(_search_module(default_properties=[_default("dob", "'x'")], case_search_endpoint_id="visits")),
                "schema:DefaultCaseSearchProperty.property",
                f"{config}/default_properties/0/property",
            ),
            accepted(
                "app",
                search(_search_module(default_properties=[_default("dob", "'x'")])),
                "schema:DefaultCaseSearchProperty.property",
                f"{config}/default_properties/0/property",
            ),
        ),
        "case-search/custom-sort-properties-property-name-sort-type-exact-date": tuple(
            make(
                "app",
                search(
                    _search_module(
                        **fields,
                        custom_sort_properties=[
                            {"doc_type": "CaseSearchCustomSortProperty", "property_name": "dob", "sort_type": "date"}
                        ],
                    )
                ),
                key,
                f"{config}/{where}",
            )
            for make, fields in ((refused, {"default_properties": [_default("status", "'open'")]}), (accepted, {}))
            for key, where in (
                ("schema:CaseSearch.custom_sort_properties", "custom_sort_properties"),
                ("schema:CaseSearchCustomSortProperty.property_name", "custom_sort_properties/0/property_name"),
            )
        ),
        "case-search/search-on-clear": (
            refused(
                "app",
                search(_search_module(properties=[_prompt("dob")], search_on_clear=True)),
                "schema:CaseSearch.search_on_clear",
                f"{config}/search_on_clear",
            ),
            # HQ reads a list's auto select from its short detail, never from ``auto_select_case``
            refused(
                "app",
                search({**_search_module(properties=[_prompt("dob")], search_on_clear=True), "auto_select_case": True}),
                "schema:CaseSearch.search_on_clear",
                f"{config}/search_on_clear",
            ),
            # beside the case list's auto select, multi-select or not, the bar's refusal
            accepted(
                "app",
                search(auto_selecting(_search_module(properties=[_prompt("dob")], search_on_clear=True))),
                "schema:CaseSearch.search_on_clear",
                f"{config}/search_on_clear",
            ),
            accepted(
                "app",
                search(_search_module(search_on_clear=True)),
                "schema:CaseSearch.search_on_clear",
                f"{config}/search_on_clear",
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
            # a system date compared with text is the date-time metadata class, never a property's range
            accepted("suite", CSQL_SUITE, "csql-op:>", "/data[4]/@ref", readings=True),
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
        "menus-and-case-lists/case-type-outside-the-menu-page-s-grammar": (
            refused("app", _app([plain(case_type="visit.note")]), "schema:Module.case_type", "/modules/0/case_type"),
            refused("app", _app([plain(case_type="visité")]), "schema:Module.case_type", "/modules/0/case_type"),
            accepted("app", _app([plain(case_type="1st-visit")]), "schema:Module.case_type", "/modules/0/case_type"),
            accepted("app", _app([plain(case_type="case")]), "schema:Module.case_type", "/modules/0/case_type"),
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
        "menus-and-case-lists/auto-select-case-true-on-a-basic-module-an-advanced-form-s-load": (
            # A household menu's chosen load of a patient lists from the first patient menu, the basic menu before
            # it; a load that selects its case itself, or one of the advanced menu's own case type, lists from none
            # of it.
            refused(
                "app",
                _advanced_app(
                    [_load("load_patient_0")],
                    modules_before=[_module(auto_select_case=True, unique_id="b")],
                    case_type="household",
                ),
                "schema:Module.auto_select_case",
                "/modules/0/auto_select_case",
            ),
            accepted(
                "app",
                _advanced_app(
                    [_load("usercase", auto_select={"doc_type": "AutoSelectCase", "mode": "usercase"})],
                    modules_before=[_module(auto_select_case=True, unique_id="b", case_type="visit")],
                ),
                "schema:Module.auto_select_case",
                "/modules/0/auto_select_case",
            ),
            accepted(
                "app",
                _advanced_app(
                    [_load("load_patient_0")],
                    modules_before=[_module(auto_select_case=True, unique_id="b")],
                    case_type="patient",
                ),
                "schema:Module.auto_select_case",
                "/modules/0/auto_select_case",
            ),
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
        "menus-and-case-lists/module-filter-false-on-a-menu-something-opens": (
            # Its own entry point opens a menu off the menu.
            refused(
                "app",
                _app([plain(module_filter="false()", session_endpoint_id="hidden")]),
                "schema:Module.module_filter",
                "/modules/0/module_filter",
            ),
            # A form of it returns to it.
            refused(
                "app",
                _app([plain(module_filter="false() and true()", forms=[returns_to_its_menu])]),
                "schema:Module.module_filter",
                "/modules/0/module_filter",
            ),
            # Another menu's form links to it.
            refused(
                "app",
                _app([plain(module_filter="false()"), plain(unique_id="o", forms=[linked_to_p])]),
                "schema:Module.module_filter",
                "/modules/0/module_filter",
            ),
            # Nothing opens it: its forms open from links and entry points of their own.
            accepted(
                "app",
                _app([plain(module_filter="false()", forms=[_form_json()])]),
                "schema:Module.module_filter",
                "/modules/0/module_filter",
            ),
            # An or outside every bracket makes the condition one that can show the menu.
            accepted(
                "app",
                _app([plain(module_filter="false() and true() or true()", session_endpoint_id="shown")]),
                "schema:Module.module_filter",
                "/modules/0/module_filter",
            ),
            refused("suite", HIDDEN_MENUS, "parser:MenuParser/menu@relevant", "menu[1]/@relevant"),
            accepted("suite", HIDDEN_MENUS, "parser:MenuParser/menu@relevant", "menu[2]/@relevant"),
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
            # The product column HQ's new advanced menu writes is its product details', judged whole there.
            accepted(
                "app",
                product_app(),
                "schema:DetailColumn.model",
                "/modules/0/product_details/short/columns/0/model",
            ),
        ),
        "menus-and-case-lists/advancedmodule-product-details-differing-from-the-default": (
            refused(
                "app", product_app(field="code"), "schema:AdvancedModule.product_details", "/modules/0/product_details"
            ),
            refused(
                "app",
                product_app(header={"en": "Item"}),
                "schema:AdvancedModule.product_details",
                "/modules/0/product_details",
            ),
            refused(
                "app",
                product_app(short={"sort_elements": [{"doc_type": "SortElement", "field": "name"}]}),
                "schema:AdvancedModule.product_details",
                "/modules/0/product_details",
            ),
            refused(
                "app",
                product_app(long_columns=[_column(model="product")]),
                "schema:AdvancedModule.product_details",
                "/modules/0/product_details",
            ),
            # ``AdvancedModule.new_module``'s, as Nova writes it: a column graph HQ reads only of a graph column.
            accepted(
                "app",
                product_app(graph_configuration=None),
                "schema:AdvancedModule.product_details",
                "/modules/0/product_details",
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
            # its icon mapping is the column's, never the column editor's extras on another format
            refused(
                "app",
                columns_app(_column(fmt="clickable-icon", enum=icons), doc_type="AdvancedModule"),
                "schema:DetailColumn.enum",
                f"{short}/columns/0/enum",
            ),
            accepted(
                "app",
                columns_app(
                    _column(fmt="clickable-icon", enum=icons, endpoint_action_id="visit"), doc_type="AdvancedModule"
                ),
                "schema:DetailColumn.enum",
                f"{short}/columns/0/enum",
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
            refused(
                "app",
                columns_app(_column(fmt="clickable-icon", enum=icons), where="long"),
                "schema:DetailColumn.enum",
                f"{long_}/columns/0/enum",
            ),
            accepted(
                "app",
                columns_app(_column(fmt="clickable-icon", enum=icons, endpoint_action_id="visit")),
                "schema:DetailColumn.enum",
                f"{short}/columns/0/enum",
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
            # The class is a fact about the repeated columns, never a neighbour of another format.
            accepted(
                "app",
                columns_app(_column("n", "plain"), _column("a", "image"), _column("b", "image")),
                "schema:DetailColumn.format",
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
            accepted(
                "app",
                columns_app(
                    _column("n", "plain"), _column("a", "image"), _column("b", "image"), doc_type="AdvancedModule"
                ),
                "schema:DetailColumn.format",
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
        "menus-and-case-lists/case-id-as-a-property-column-s-field": (
            refused("app", columns_app(_column("case_id")), "detail-field-type:property", f"{short}/columns/0/field"),
            refused("app", columns_app(_column("site-link/case_id")), "detail-field-type:property", f"{short}/columns/0/field"),
            accepted("app", columns_app(_column("site-link/status")), "detail-field-type:property", f"{short}/columns/0/field"),
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
            # A custom tile on the case detail is a class of its own, which takes its cells with it.
            accepted(
                "app",
                columns_app(_column(), where="long", long=tile),
                "schema:Detail.case_tile_template",
                f"{long_}/case_tile_template",
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
        "menus-and-case-lists/columns-above-the-first-tab-when-tabs-exist": (
            refused("app", tabbed(tab(1)), "schema:Detail.tabs", f"{long_}/tabs"),
            # Each tab's start is a use of the detail's tabs as a whole.
            refused("app", tabbed(tab(1), tab(2)), "schema:DetailTab.starting_index", f"{long_}/tabs/1/starting_index"),
            accepted("app", tabbed(tab(0), tab(1)), "schema:Detail.tabs", f"{long_}/tabs"),
            accepted("app", tabbed(tab(0), tab(1)), "schema:DetailTab.starting_index", f"{long_}/tabs/1/starting_index"),
        ),
        "menus-and-case-lists/tab-display-condition-outside-its-case-scope": (
            refused(
                "app", tabbed(tab(0, relevant="village = (")), "schema:DetailTab.relevant", f"{long_}/tabs/0/relevant",
                readings=True, case_types=village,
            ),
            accepted(
                "app", tabbed(tab(0, relevant="village = 'West'")), "schema:DetailTab.relevant",
                f"{long_}/tabs/0/relevant", readings=True, case_types=village,
            ),
            accepted(
                "app", tabbed(tab(0, relevant="not(village = 'West') or visits > 2")), "schema:DetailTab.relevant",
                f"{long_}/tabs/0/relevant", readings=True, case_types=village,
            ),
            # A text with both quote characters is spelled as a concatenation of literals.
            accepted(
                "app", tabbed(tab(0, relevant="selected(village, concat('a', \"'\", '\"b'))")),
                "schema:DetailTab.relevant", f"{long_}/tabs/0/relevant", readings=True, case_types=village,
            ),
            # A property the case type does not declare, or a comparison of a text with a number, is no type the
            # class reads: Nova's reader decides it.
            unsettled(
                "app", tabbed(tab(0, relevant="region = 'West'")), "schema:DetailTab.relevant",
                f"{long_}/tabs/0/relevant", readings=True, case_types=village,
            ),
            unsettled(
                "app", tabbed(tab(0, relevant="village = 2")), "schema:DetailTab.relevant",
                f"{long_}/tabs/0/relevant", readings=True, case_types=village,
            ),
            # Without the observation's parse the class is not settled.
            unsettled("app", tabbed(tab(0, relevant="village = 'West'")), "schema:DetailTab.relevant", f"{long_}/tabs/0/relevant"),
        ),
        "menus-and-case-lists/detail-tab-without-a-resolvable-row-source": (
            refused("app", tabbed(tab(0), tab(1, has_nodeset=True)), "schema:DetailTab.has_nodeset", f"{long_}/tabs/1/has_nodeset"),
            accepted(
                "app", tabbed(tab(0), tab(1, has_nodeset=True, nodeset_case_type="visit")),
                "schema:DetailTab.has_nodeset", f"{long_}/tabs/1/has_nodeset",
            ),
            refused(
                "app", tabbed(tab(0), tab(1, has_nodeset=True, nodeset_case_type="a visit")),
                "schema:DetailTab.nodeset_case_type", f"{long_}/tabs/1/nodeset_case_type",
            ),
            # With its rows off a tab's settings are read by nothing.
            accepted(
                "app", tabbed(tab(0), tab(1, nodeset_case_type="a visit")),
                "schema:DetailTab.nodeset_case_type", f"{long_}/tabs/1/nodeset_case_type",
            ),
            refused(
                "app", tabbed(tab(0), tab(1, has_nodeset=True, nodeset="instance('casedb')/casedb/case[")),
                "schema:DetailTab.nodeset", f"{long_}/tabs/1/nodeset", readings=True, case_types=village,
            ),
            accepted(
                "app",
                tabbed(tab(0), tab(1, has_nodeset=True, nodeset="instance('casedb')/casedb/case[@case_type = 'visit']")),
                "schema:DetailTab.nodeset", f"{long_}/tabs/1/nodeset", readings=True, case_types=village,
            ),
            accepted(
                "app",
                tabbed(
                    tab(0),
                    tab(
                        1, has_nodeset=True,
                        nodeset="instance('casedb')/casedb/case[@case_type = 'visit'][outcome = 'seen']",
                    ),
                ),
                "schema:DetailTab.nodeset", f"{long_}/tabs/1/nodeset", readings=True, case_types=village,
            ),
            refused(
                "app", tabbed(tab(0), tab(1, has_nodeset=True, nodeset="'a scalar'")),
                "schema:DetailTab.nodeset", f"{long_}/tabs/1/nodeset", readings=True, case_types=village,
            ),
            # Rows of a type the catalog does not declare are Nova's reader's to decide.
            unsettled(
                "app",
                tabbed(tab(0), tab(1, has_nodeset=True, nodeset="instance('casedb')/casedb/case[@case_type = 'other']")),
                "schema:DetailTab.nodeset", f"{long_}/tabs/1/nodeset", readings=True, case_types=village,
            ),
            refused(
                "app",
                tabbed(tab(0), tab(1, has_nodeset=True, nodeset_case_type="visit", nodeset_filter="outcome = (")),
                "schema:DetailTab.nodeset_filter", f"{long_}/tabs/1/nodeset_filter", readings=True, case_types=village,
            ),
            accepted(
                "app",
                tabbed(tab(0), tab(1, has_nodeset=True, nodeset_case_type="visit", nodeset_filter="outcome = 'seen'")),
                "schema:DetailTab.nodeset_filter", f"{long_}/tabs/1/nodeset_filter", readings=True, case_types=village,
            ),
        ),
        "menus-and-case-lists/form-context-expression-outside-its-case-scope": (
            refused(
                "app", details(_detail_module(short=lined("concat("))), "schema:Detail.persistent_case_context_xml",
                f"{short}/persistent_case_context_xml", readings=True, case_types=village,
            ),
            accepted(
                "app", details(_detail_module(short=lined("village"))), "schema:Detail.persistent_case_context_xml",
                f"{short}/persistent_case_context_xml", readings=True, case_types=village,
            ),
            # Beside a tile that persists, the line is read by nothing.
            accepted(
                "app",
                details(_detail_module(short={**lined("concat("), **tile, "persist_tile_on_forms": True})),
                "schema:Detail.persistent_case_context_xml", f"{short}/persistent_case_context_xml",
                readings=True, case_types=village,
            ),
            unsettled(
                "app", details(_detail_module(short=lined("region"))), "schema:Detail.persistent_case_context_xml",
                f"{short}/persistent_case_context_xml", readings=True, case_types=village,
            ),
        ),
        "menus-and-case-lists/form-context-without-a-compatible-case-tile": (
            refused(
                "app", details(_detail_module(short={"persistent_case_tile_from_module": "src"})),
                "schema:Detail.persistent_case_tile_from_module", f"{short}/persistent_case_tile_from_module",
            ),
            accepted(
                "app",
                details(
                    _detail_module(short={"persistent_case_tile_from_module": "src"}),
                    _detail_module(unique_id="src", short=tile),
                ),
                "schema:Detail.persistent_case_tile_from_module", f"{short}/persistent_case_tile_from_module",
            ),
            # Another case type's tile is no context for this list's case.
            refused(
                "app",
                details(
                    _detail_module(short={"persistent_case_tile_from_module": "src"}),
                    _detail_module(unique_id="src", case_type="household", short=tile),
                ),
                "schema:Detail.persistent_case_tile_from_module", f"{short}/persistent_case_tile_from_module",
            ),
            refused("app", details(_detail_module(short={"pull_down_tile": True})), "schema:Detail.pull_down_tile", f"{short}/pull_down_tile"),
            accepted(
                "app", details(_detail_module(short={**tile, "persist_tile_on_forms": True, "pull_down_tile": True})),
                "schema:Detail.pull_down_tile", f"{short}/pull_down_tile",
            ),
        ),
        "menus-and-case-lists/two-different-values-for-the-same-form-context": (
            refused(
                "app", details(_detail_module(short=lined("village"), long=lined("visits"))),
                "schema:Detail.persistent_case_context_xml", f"{long_}/persistent_case_context_xml",
            ),
            refused(
                "app", details(_detail_module(short=lined("village"), long=lined("visits"))),
                "schema:Detail.persist_case_context", f"{long_}/persist_case_context",
            ),
            # The case list's own line is the one Nova reads.
            accepted(
                "app", details(_detail_module(short=lined("village"), long=lined("visits"))),
                "schema:Detail.persistent_case_context_xml", f"{short}/persistent_case_context_xml",
            ),
            accepted(
                "app", details(_detail_module(short=lined("village"), long=lined("village"))),
                "schema:Detail.persistent_case_context_xml", f"{long_}/persistent_case_context_xml",
            ),
        ),
        "menus-and-case-lists/custom-tile-cells-covering-the-same-square": (
            refused(
                "app",
                columns_app(_column(**cell(0, 0, 12)), _column("notes", **cell(3, 0, 6)), short=tile),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/1/grid_x",
            ),
            # Each of the two cells is in the class, and so is the tile itself.
            refused(
                "app",
                columns_app(_column(**cell(0, 0, 12)), _column("notes", **cell(3, 0, 6)), short=tile),
                "schema:DetailColumn.width",
                f"{short}/columns/0/width",
            ),
            accepted(
                "app",
                columns_app(_column(**cell(0, 0, 6)), _column("notes", **cell(6, 0, 6)), short=tile),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/1/grid_x",
            ),
            # A third cell clear of the two is not in it.
            accepted(
                "app",
                columns_app(
                    _column(**cell(0, 0, 12)), _column("notes", **cell(3, 0, 6)), _column("dob", **cell(0, 1, 6)),
                    short=tile,
                ),
                "schema:DetailColumn.grid_y",
                f"{short}/columns/2/grid_y",
            ),
            # A list that is no custom tile lays nothing out, and a filter column writes no field.
            accepted(
                "app",
                columns_app(_column(**cell(0, 0, 12)), _column("notes", **cell(3, 0, 6))),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/1/grid_x",
            ),
            accepted(
                "app",
                columns_app(_column(**cell(0, 0, 12)), _column("notes", "filter", **cell(3, 0, 6)), short=tile),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/0/grid_x",
            ),
            # On the case detail two tabs lay their cells out apart; one tab's two cells on one square overlap.
            accepted(
                "app",
                columns_app(
                    _column(**cell(0, 0, 12)), _column("notes", **cell(0, 0, 12)),
                    where="long",
                    long={**tile, "tabs": [{"doc_type": "DetailTab", "starting_index": 0}, {"doc_type": "DetailTab", "starting_index": 1}]},
                ),
                "schema:DetailColumn.grid_x",
                f"{long_}/columns/1/grid_x",
            ),
            refused(
                "app",
                columns_app(
                    _column(**cell(0, 0, 12)), _column("notes", **cell(0, 0, 12)),
                    where="long",
                    long={**tile, "tabs": [{"doc_type": "DetailTab", "starting_index": 0}]},
                ),
                "schema:DetailColumn.grid_x",
                f"{long_}/columns/1/grid_x",
            ),
        ),
        "menus-and-case-lists/custom-tile-cell-outside-the-grid": (
            refused(
                "app",
                columns_app(_column(**cell(0, 0, 6)), _column("notes", **cell(8, 0, 6)), short=tile),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/1/grid_x",
            ),
            refused(
                "app",
                columns_app(_column(**cell(0, 0, 6)), _column("notes", **cell(-1, 0, 6)), short=tile),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/1/grid_x",
            ),
            refused(
                "app",
                columns_app(_column(**cell(0, 0, 6)), _column("notes", **cell(6, 0, 0)), short=tile),
                "schema:DetailColumn.width",
                f"{short}/columns/1/width",
            ),
            refused(
                "app",
                columns_app(_column(**cell(0, -1, 6)), _column("notes", **cell(6, 0, 6)), where="long", long=tile),
                "schema:DetailColumn.grid_y",
                f"{long_}/columns/0/grid_y",
            ),
            # A cell that ends on the twelfth column is inside; one past the twelfth row is the other class.
            accepted(
                "app",
                columns_app(_column(**cell(0, 0, 6)), _column("notes", **cell(6, 0, 6)), short=tile),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/1/grid_x",
            ),
            accepted(
                "app",
                columns_app(_column(**cell(0, 0, 6)), _column("notes", **cell(6, 12, 6)), short=tile),
                "schema:DetailColumn.grid_y",
                f"{short}/columns/1/grid_y",
            ),
            # A list that is no custom tile lays nothing out, and a filter column writes no field.
            accepted(
                "app",
                columns_app(_column(**cell(0, 0, 6)), _column("notes", **cell(8, 0, 6))),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/1/grid_x",
            ),
            accepted(
                "app",
                columns_app(_column(**cell(0, 0, 6)), _column("notes", "filter", **cell(8, 0, 6)), short=tile),
                "schema:DetailColumn.grid_x",
                f"{short}/columns/1/grid_x",
            ),
        ),
        "menus-and-case-lists/custom-tile-cell-below-the-twelfth-row": (
            refused(
                "app",
                columns_app(_column(**cell(0, 0, 12)), _column("notes", **cell(0, 12, 12)), short=tile),
                "schema:DetailColumn.grid_y",
                f"{short}/columns/1/grid_y",
            ),
            refused(
                "app",
                columns_app(
                    _column(**cell(0, 0, 12)), _column("notes", **cell(0, 11, 12, 2)), where="long", long=tile,
                ),
                "schema:DetailColumn.height",
                f"{long_}/columns/1/height",
            ),
            # The twelfth row is inside, and a cell past the twelfth column is the other class.
            accepted(
                "app",
                columns_app(_column(**cell(0, 0, 12)), _column("notes", **cell(0, 11, 12)), short=tile),
                "schema:DetailColumn.grid_y",
                f"{short}/columns/1/grid_y",
            ),
            accepted(
                "app",
                columns_app(_column(**cell(0, 0, 12)), _column("notes", **cell(8, 12, 6)), short=tile),
                "schema:DetailColumn.grid_y",
                f"{short}/columns/1/grid_y",
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
        "menus-and-case-lists/sort-calculation-without-a-typed-value": (
            order_shape(refused, "sort_calculation", sort_calculation="*", readings=True),
            order_shape(accepted, "sort_calculation", readings=True),
            order_shape(accepted, "sort_calculation", sort_calculation="'north'", readings=True),
            order_shape(accepted, "sort_calculation", sort_calculation="visits * 2", readings=True,
                        case_types={"patient": {"visits": "int"}}),
            # Nova's publish writes a sort element with no ``doc_type``; the observation reads its calculation all
            # the same.
            order_shape(accepted, "sort_calculation", sort_calculation="village", doc_type=None, readings=True),
        ),
        "menus-and-case-lists/distance-sort-without-a-location-field": (
            order_shape(refused, "type", type="distance"),
            order_shape(accepted, "type", field="gps", type="distance"),
            order_shape(accepted, "type", type="int"),
        ),
        "menus-and-case-lists/distance-on-a-translated-calculated-field": (
            order_shape(refused, "type", _column("gps", "translatable-enum", useXpathExpression=True),
                        field="_cc_calculated_0", type="distance"),
            order_shape(accepted, "type", _column("gps", "translatable-enum"),
                        field="gps", type="distance"),
            order_shape(accepted, "type", _column("gps"), _column("gps", "translatable-enum", useXpathExpression=True),
                        field="_cc_calculated_1", type="distance"),
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
        "menus-and-case-lists/case-list-form-post-form-workflow-default-on-a-multi-select-host": (
            refused(
                "app",
                columns_app(case_list_form={"form_id": "r", "post_form_workflow": "default"}, short=multi["short"]),
                "schema:CaseListForm.form_id",
                "/modules/0/case_list_form/form_id",
            ),
            accepted(
                "app",
                columns_app(case_list_form={"form_id": "r", "post_form_workflow": "case_list"}, short=multi["short"]),
                "schema:CaseListForm.form_id",
                "/modules/0/case_list_form/form_id",
            ),
            accepted(
                "app",
                columns_app(case_list_form={"form_id": "r", "post_form_workflow": "default"}),
                "schema:CaseListForm.form_id",
                "/modules/0/case_list_form/form_id",
            ),
        ),
        "menus-and-case-lists/put-in-root-session-endpoint-id-or-inline-search-or-an-end-of": (
            # Each of the three things HQ's build refuses beside put_in_root; then an end-of-form return to it, which
            # is the form's own class (forms-and-case-writes/post-form-workflow-hq-s-build-refuses-module-in-a-put-
            # in-root, the bar's), and the starter shape.
            refused(
                "app",
                _app([plain(put_in_root=True, session_endpoint_id="visit")]),
                "schema:Module.put_in_root",
                "/modules/0/put_in_root",
            ),
            refused(
                "app",
                _app(
                    [
                        plain(
                            put_in_root=True,
                            search_config={
                                "properties": [{"name": "name"}],
                                "inline_search": True,
                                "auto_launch": True,
                            },
                        )
                    ]
                ),
                "schema:Module.put_in_root",
                "/modules/0/put_in_root",
            ),
            refused(
                "app",
                _app(
                    [
                        plain(put_in_root=True),
                        plain(
                            unique_id="o",
                            forms=[
                                {
                                    **_form_json("case"),
                                    "post_form_workflow": "form",
                                    "form_links": [{"xpath": "", "module_unique_id": "p"}],
                                }
                            ],
                        ),
                    ]
                ),
                "schema:Module.put_in_root",
                "/modules/0/put_in_root",
            ),
            accepted(
                "app",
                _app([plain(put_in_root=True, forms=[{**_form_json("case"), "post_form_workflow": "module"}])]),
                "schema:Module.put_in_root",
                "/modules/0/put_in_root",
            ),
            accepted(
                "app",
                _app(
                    [
                        plain(put_in_root=True),
                        plain(
                            unique_id="c",
                            root_module_id="p",
                            forms=[{**_form_json("case"), "post_form_workflow": "parent_module"}],
                        ),
                    ]
                ),
                "schema:Module.put_in_root",
                "/modules/0/put_in_root",
            ),
            accepted(
                "app",
                _app(
                    [
                        plain(
                            put_in_root=True,
                            forms=[_form_json("none"), {**_form_json("case"), "post_form_workflow": "default"}],
                        ),
                        plain(
                            unique_id="o",
                            forms=[
                                {
                                    **_form_json("case"),
                                    "post_form_workflow": "form",
                                    "form_links": [
                                        {"xpath": "", "form_id": "f", "form_module_id": "p", "module_unique_id": "p"}
                                    ],
                                }
                            ],
                        ),
                    ]
                ),
                "schema:Module.put_in_root",
                "/modules/0/put_in_root",
            ),
        ),
        "menus-and-case-lists/case-list-session-endpoint-id-on-a-put-in-root-module": (
            refused(
                "app",
                _app([plain(put_in_root=True, case_list_session_endpoint_id="clients")]),
                "schema:Module.case_list_session_endpoint_id",
                "/modules/0/case_list_session_endpoint_id",
            ),
            accepted(
                "app",
                _app([plain(put_in_root=False, case_list_session_endpoint_id="clients")]),
                "schema:Module.case_list_session_endpoint_id",
                "/modules/0/case_list_session_endpoint_id",
            ),
            # The endpoint HQ builds through the first menu, one through its own menu, a form's, and one through a
            # menu id a put_in_root module shares with its parent.
            refused("suite", CASE_LIST_ENDPOINTS, "parser:EndpointParser/endpoint@id", "endpoint[1]/@id"),
            accepted("suite", CASE_LIST_ENDPOINTS, "parser:EndpointParser/endpoint@id", "endpoint[2]/@id"),
            accepted("suite", CASE_LIST_ENDPOINTS, "parser:EndpointParser/endpoint@id", "endpoint[3]/@id"),
            unsettled("suite", CASE_LIST_ENDPOINTS, "parser:EndpointParser/endpoint@id", "endpoint[4]/@id"),
            accepted("suite", CASE_LIST_ENDPOINTS, "parser:EntryParser/command@id", "entry[1]/command[1]/@id"),
        ),
        "menus-and-case-lists/form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first": (
            # A put_in_root module's follow-up form lists on its parent's screen, beside a registration form there.
            refused(
                "app",
                _app(
                    [
                        plain(forms=[_form_json("none")]),
                        plain(
                            unique_id="c",
                            root_module_id="p",
                            put_in_root=True,
                            forms=[{**_form_json("case"), "form_filter": "#case/status = 'open'"}],
                        ),
                    ]
                ),
                "schema:Form.form_filter",
                "/modules/1/forms/0/form_filter",
            ),
            accepted(
                "app",
                _app(
                    [
                        plain(forms=[_form_json("case")]),
                        plain(
                            unique_id="c",
                            root_module_id="p",
                            put_in_root=True,
                            forms=[{**_form_json("case"), "form_filter": "#case/status = 'open'"}],
                        ),
                    ]
                ),
                "schema:Form.form_filter",
                "/modules/1/forms/0/form_filter",
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
            # Null is HQ's model's None, which Core reads as 100; no number is a value HQ's model refuses as it wraps
            # the app, which Nova's reader leaves unclaimed.
            accepted(
                "app",
                columns_app(short={"multi_select": True, "max_select_value": None}),
                "schema:Detail.max_select_value",
                f"{short}/max_select_value",
            ),
            unsettled(
                "app",
                columns_app(short={"multi_select": True, "max_select_value": True}),
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
            # A form's read, with no suite beside it that says how an entry opens the form; a menu's display
            # condition is evaluated outside a form.
            unsettled("form", read_in_form("results", "jr://instance/remote/results"), *read_at, readings=True),
            accepted("app", read_in_slot("count(instance('results')/results/case) > 0"), *module_read, readings=True),
        ),
        "expressions-and-data/search-input-read-in-form-expressions-reached-through-a-search": (
            refused("suite", INPUTS_SUITE, "instance-scheme:search-input", "entry[1]/instance[1]/@id"),
            accepted("suite", INPUTS_SUITE, "instance-scheme:search-input", "entry[2]/instance[1]/@id"),
            unsettled(
                "form",
                read_in_form("search-input:results", "jr://instance/search-input/results"),
                *input_at,
                readings=True,
            ),
            accepted("app", read_in_slot(f"count({search_input}) > 0"), *module_input, readings=True),
        ),
        "expressions-and-data/commtrack-locations-hierarchical": (
            refused("suite", LOCATIONS_SUITE, "instance-scheme:commtrack", "entry[1]/instance[1]/@id"),
            accepted("suite", LOCATIONS_SUITE, "instance-scheme:locations", "entry[2]/instance[1]/@id"),
            unsettled("suite", LOCATIONS_SUITE, "instance-scheme:locations", "entry[3]/instance[1]/@id"),
            # A form's read of the instance it declares, by the declaration's source.
            refused("form", read_in_form("locations", "jr://fixture/commtrack:locations"), *places_at, readings=True),
            accepted("form", read_in_form("locations", "jr://fixture/locations"), *places_at, readings=True),
            # A slot's read, whose source HQ's build chooses by the project space's flag.
            accepted(
                "app",
                read_in_slot("count(instance('locations')/locations/location) > 0"),
                "instance-scheme:locations",
                "/modules/0/module_filter",
                readings=True,
                configurations=(PLAIN,),
            ),
        ),
        "expressions-and-data/legacy-search-input-read-after-the-query-in-the-results-detail": (
            refused("suite", INPUTS_SUITE, "instance-scheme:search-input", "entry[3]/instance[1]/@id"),
            accepted("suite", INPUTS_SUITE, "instance-scheme:search-input", "remote-request[1]/instance[1]/@id"),
            # A case list column's read of the legacy instance, after the query; a display condition's is a menu's.
            refused(
                "app",
                _app([_detail_module(columns=[_column(f"count({legacy_input})", useXpathExpression=True)])]),
                "instance-scheme:search-input",
                "/modules/0/case_details/short/columns/0/field",
                readings=True,
            ),
            accepted("app", read_in_slot(f"count({legacy_input}) > 0"), *module_input, readings=True),
        ),
        "expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install": (
            # With the verification on: a reference whose file the local archive lacks, and one it holds.
            refused(
                "app",
                _media_app(
                    "commcare/not-in-the-archive.png",
                    "CommCareImage",
                    profile={"properties": {"cc-content-valid": "no"}},
                ),
                "schema:Application.multimedia_map",
                "/multimedia_map",
                readings=True,
            ),
            accepted(
                "app",
                _media_app("commcare/held.png", "CommCareImage", profile={"properties": {"cc-content-valid": "no"}}),
                "schema:Application.multimedia_map",
                "/multimedia_map",
                readings=True,
                media=(("commcare/held.png", _png()),),
            ),
            # Without the observation's readings the export does not say; with the verification off nothing is.
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
        "expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws": (
            # In an app with Web Apps: a label's audio with no entry, and the same audio with its entry.
            refused(
                "app",
                _labelled_media_app("audio", "commcare/q.mp3", mapped=False, cloudcare_enabled=True),
                "schema:Application.multimedia_map",
                "/multimedia_map",
                readings=True,
            ),
            accepted(
                "app",
                _labelled_media_app("audio", "commcare/q.mp3", mapped=True, cloudcare_enabled=True),
                "schema:Application.multimedia_map",
                "/multimedia_map",
                readings=True,
            ),
            # A label's picture with no entry is drawn on Android alone, which no export declares.
            unsettled(
                "app",
                _labelled_media_app("image", "commcare/q.png", mapped=False, cloudcare_enabled=True),
                "schema:Application.multimedia_map",
                "/multimedia_map",
                readings=True,
            ),
            # In an app with Web Apps at a version whose build writes an image column's alternative text: the
            # column's picture with no entry, a broken picture in each cell, and the same picture with its entry.
            refused(
                "app",
                _image_column_app(False, cloudcare_enabled=True, build_spec={"version": "2.57.0"}),
                "schema:Application.multimedia_map",
                "/multimedia_map",
            ),
            accepted(
                "app",
                _image_column_app(True, cloudcare_enabled=True, build_spec={"version": "2.57.0"}),
                "schema:Application.multimedia_map",
                "/multimedia_map",
            ),
            # Below 2.54 the build writes no alternative text, and the cell draws nothing in Web Apps; Android
            # still draws its archive icon, which no export declares.
            unsettled(
                "app",
                _image_column_app(False, cloudcare_enabled=True, build_spec={"version": "2.53.0"}),
                "schema:Application.multimedia_map",
                "/multimedia_map",
            ),
        ),
        "expressions-and-data/image-tiff-heif": _media_shapes(
            "CommCareImage", "media-class:CommCareImage", ("a.tif", TIFF), ("b.png", _png())
        ),
        "expressions-and-data/image-svg": _media_shapes(
            "CommCareImage", "media-class:CommCareImage", ("m.svg", SVG), ("n.png", _png())
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
# Case list endpoints as HQ builds them (``EndpointsHelper._make_session_endpoint``): one through the first menu, the
# frame of a put_in_root module's case list; one through its own menu; a form's; and one through a menu id a
# put_in_root module shares with its parent, which the suite alone does not tell from the parent's own.
CASE_LIST_ENDPOINTS = b"""<suite version="1">
 <menu id="m0"><text><locale id="m0"/></text></menu>
 <menu id="m1"><text><locale id="m1"/></text></menu>
 <menu id="m1"><text><locale id="m2"/></text></menu>
 <entry><form>http://example.org/f</form><command id="m0-f0"><text><locale id="f"/></text></command></entry>
 <endpoint id="first"><argument id="case_id"/>
  <stack><push><datum id="case_id" value="$case_id"/></push></stack></endpoint>
 <endpoint id="own"><stack><push><command value="'m0'"/></push></stack></endpoint>
 <endpoint id="form"><stack><push><command value="'m0'"/><command value="'m0-f0'"/></push></stack></endpoint>
 <endpoint id="shared"><stack><push><command value="'m1'"/></push></stack></endpoint>
</suite>"""
# Two menus off the menu: an endpoint opens the first, and the second is passed through to its form.
HIDDEN_MENUS = b"""<suite version="1"><menu id="m0" relevant="false()"><text><locale id="m0"/></text></menu>
 <menu id="m1" relevant="false() and true()"><text><locale id="m1"/></text><command id="m1-f0"/></menu>
 <entry><form>http://example.org/f</form><command id="m1-f0"><text><locale id="f"/></text></command></entry>
 <endpoint id="own"><stack><push><command value="'m0'"/></push></stack></endpoint>
 <endpoint id="form"><stack><push><command value="'m1'"/><command value="'m1-f0'"/></push></stack></endpoint>
</suite>"""
# Menus, one under another, and a multi-select datum whose limit is 0.
MENUS = b"""<suite version="1"><menu id="m0"><text><locale id="m0"/></text></menu>
 <menu id="m1" root="m0"><text><locale id="m1"/></text></menu>
 <entry><form>http://example.org/f</form><command id="m1-f0"><text><locale id="f"/></text></command>
  <instance id="casedb" src="jr://instance/casedb"/>
  <session><instance-datum id="selected_cases" nodeset="instance('casedb')/casedb/case" value="./@case_id"
   detail-select="m1_case_short" max-select-value="0"/></session></entry></suite>"""
# The search input instance an entry reads with no search in its session, one whose session searches, the legacy
# bare id in an entry, and the legacy bare id in a search's own request.
# A form link reading places puts the instance on the form's entry, where HQ chooses its source: the
# hierarchical fixture, the flat one, and a source neither names.
LOCATIONS_SUITE = b"""<suite version="1">
 <entry><form>http://example.org/f</form><command id="m0-f0"><text><locale id="f"/></text></command>
  <instance id="commtrack:locations" src="jr://fixture/commtrack:locations"/></entry>
 <entry><form>http://example.org/g</form><command id="m0-f1"><text><locale id="g"/></text></command>
  <instance id="locations" src="jr://fixture/locations"/></entry>
 <entry><form>http://example.org/h</form><command id="m0-f2"><text><locale id="h"/></text></command>
  <instance id="locations" src="jr://fixture/other:locations"/></entry>
</suite>"""


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
# An entry whose first datum's filter reads the session's case_id, which only the datum after it writes, and whose
# second datum's filter reads parent_id, which the first wrote; the detail the second datum shows its list with reads
# parent_id, written before the list shows, and case_id, which the choice made on that list writes.
SESSION_DATUMS_SUITE = b"""<suite version="1">
  <detail id="d"><title><text><locale id="t"/></text></title>
    <field><header><text><locale id="h"/></text></header><template><text>
      <xpath function="instance('commcaresession')/session/data/parent_id"/></text></template></field>
    <field><header><text><locale id="h"/></text></header><template><text>
      <xpath function="instance('commcaresession')/session/data/case_id"/></text></template></field></detail>
  <entry><form>http://example.org/f</form><command id="m0-f0"><text><locale id="c"/></text></command>
    <instance id="casedb" src="jr://instance/casedb"/>
    <instance id="commcaresession" src="jr://instance/session"/>
    <session>
      <datum id="parent_id" value="./@case_id"
        nodeset="instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]"/>
      <datum id="case_id" value="./@case_id" detail-select="d"
        nodeset="instance('casedb')/casedb/case[index/parent = instance('commcaresession')/session/data/parent_id]"/>
    </session></entry></suite>"""
# Session data a suite reads where its frame holds it: a search launched from a case list's action reads the
# case the menu chose before the list (its query's ``data[2]``) and one nothing writes (``data[3]``); a claim an
# endpoint launches reads the case the endpoint's push writes; a registration form the list's Register action opens
# with ``return_to = 'm1'`` reads ``return_to`` under HQ's count guard (``create[1]``) and without one
# (``create[2]``), and the chosen case where its operation's condition names the action's frame (``create[1]``'s
# datum) and where no launch sets the value its condition names (``create[3]``'s).
SESSION_LAUNCH_SUITE = b"""<suite version="1">
  <detail id="d"><title><text><locale id="t"/></text></title>
    <field><header><text><locale id="h"/></text></header><template><text>
      <xpath function="./@case_id"/></text></template></field>
    <action><display><text><locale id="a"/></text></display>
      <stack><push><mark/><command value="'search_command.m0'"/></push></stack></action>
    <action><display><text><locale id="r"/></text></display>
      <stack><push><command value="'m1-f0'"/><datum id="case_id_new_visit_0" value="uuid()"/>
        <datum id="return_to" value="'m1'"/></push></stack></action></detail>
  <entry><form>http://example.org/f</form><command id="m0-f0"><text><locale id="c"/></text></command>
    <instance id="casedb" src="jr://instance/casedb"/>
    <instance id="commcaresession" src="jr://instance/session"/>
    <session>
      <datum id="parent_id" value="./@case_id" nodeset="instance('casedb')/casedb/case[@case_type = 'household']"/>
      <datum id="case_id" value="./@case_id" detail-select="d"
        nodeset="instance('casedb')/casedb/case[index/parent = instance('commcaresession')/session/data/parent_id]"/>
    </session></entry>
  <entry><form>http://example.org/r</form><command id="m1-f0"><text><locale id="c"/></text></command>
    <instance id="commcaresession" src="jr://instance/session"/>
    <session><datum id="case_id_new_visit_0" function="uuid()"/></session>
    <stack>
      <create if="count(instance('commcaresession')/session/data/return_to) = 1 and instance('commcaresession')/session/data/return_to = 'm1'"><command value="'m1'"/>
        <datum id="parent_id" value="instance('commcaresession')/session/data/parent_id"/></create>
      <create if="instance('commcaresession')/session/data/return_to = 'm2'"><command value="'m2'"/></create>
      <create if="count(instance('commcaresession')/session/data/return_to) = 1 and instance('commcaresession')/session/data/return_to = 'm9'"><command value="'m9'"/>
        <datum id="parent_id" value="instance('commcaresession')/session/data/parent_id"/></create>
    </stack></entry>
  <remote-request>
    <post url="https://example.org/claim/" relevant="true()">
      <data key="case_id" ref="instance('commcaresession')/session/data/search_case_id"/></post>
    <command id="search_command.m0"><display><text><locale id="s"/></text></display></command>
    <instance id="commcaresession" src="jr://instance/session"/>
    <instance id="results" src="jr://instance/remote/results"/>
    <session>
      <query url="https://example.org/search/" storage-instance="results" template="case" default_search="false">
        <data key="case_type" ref="'visit'"/>
        <data key="parent" ref="instance('commcaresession')/session/data/parent_id"/>
        <data key="other" ref="instance('commcaresession')/session/data/other_id"/></query>
      <datum id="search_case_id" nodeset="instance('results')/results/case" value="./@case_id"/>
    </session><stack/></remote-request>
  <remote-request>
    <post url="https://example.org/claim/" relevant="true()">
      <data key="case_id" ref="instance('commcaresession')/session/data/case_id"/></post>
    <command id="claim_command.visit.case_id"><display><text/></display></command>
    <instance id="commcaresession" src="jr://instance/session"/>
    <session><datum id="case_id" function="instance('commcaresession')/session/data/case_id"/></session>
    <stack/></remote-request>
  <endpoint id="visit"><argument id="case_id"/>
    <stack><push><datum id="case_id" value="$case_id"/><command value="'claim_command.visit.case_id'"/></push></stack>
  </endpoint></suite>"""
# A suite expression reading a variable (a menu's display condition).
VARIABLES_SUITE = b"""<suite version="1"><menu id="m0" relevant="$v = 1"><text><locale id="m"/></text></menu></suite>"""
# A case's system date read by name, ordered against a date, which is never a time of day; and another property
# read by name, whose value the suite does not say.
SYSTEM_DATES_SUITE = b"""<suite version="1">
  <menu id="m0" relevant="date_opened &gt;= date('2026-01-01')"><text><locale id="m"/></text></menu>
  <menu id="m1" relevant="visit_time &gt;= date('2026-01-01')"><text><locale id="m"/></text></menu>
</suite>"""
# A runtime case property's type is known only inside the case step whose sibling predicate names that type.
# The observation's tree keeps instance()'s argument and every step's predicates in one list; the steps' counts
# distinguish a comparison on the case from one on a child, and a nested path starts a fresh context.
CASE_PROPERTY_TYPES = {
    "visit": {
        "seen": "datetime",
        "due": "datetime",
        "clock": "time",
        "day": "date",
        "count": "int",
        "price": "decimal",
        "untyped": None,
    },
    "other": {"seen": "date", "due": "date"},
}
CASE_PROPERTY_PATHS = (
    "instance('casedb')/casedb/case[@case_type = 'visit'][seen < due]",
    "instance('casedb')/casedb/case[@case_type = 'visit'][clock < 12]",
    "instance('casedb')/casedb/case[@case_type = 'visit'][day < date('2026-01-01')]",
    "instance('casedb')/casedb/case[@case_type = 'visit'][count < 2 and price < 1.5]",
    "instance('casedb')/casedb/case[@case_type = 'visit'][untyped < 1]",
    "instance('casedb')/casedb/case[seen < due]",
    "instance('casedb')/casedb/case[@case_type = 'unknown'][seen < due]",
    "instance('casedb')/casedb/case[@case_type = 'other'][seen < due]",
    "instance('casedb')/casedb/case[@case_type = 'visit'][count(child[seen < due]) > 0]",
    "instance('casedb')/casedb/case[@case_type = 'visit']/child[seen < due]",
    "instance('casedb')/casedb[@case_type = 'visit']/case[seen < due]",
    "instance('elsewhere')/casedb/case[@case_type = 'visit'][seen < due]",
    "instance('casedb')/casedb/case[@case_type = 'visit'][coalesce(seen, due) < now()]",
)
CASE_PROPERTY_SUITE = (
    '<suite version="1"><entry><instance id="casedb" src="jr://instance/casedb"/><session>'
    + "".join(
        f'<datum id="case_{index}" nodeset={quoteattr(path)} value="@case_id"/>'
        for index, path in enumerate(CASE_PROPERTY_PATHS)
    )
    + "</session></entry></suite>"
).encode()
# The same queries inside form logic must use their case row's declared types, rather than treating every
# external read as unknown. Keep the case-property matrix identical across form and suite expressions.
CASE_PROPERTY_FORM = _form(
    data="".join(f"<query_{index}/>" for index in range(1, len(CASE_PROPERTY_PATHS) + 1)),
    model="".join(
        f'<bind nodeset="/data/query_{index}" calculate={quoteattr(f"count({path}) > 0")}/>'
        for index, path in enumerate(CASE_PROPERTY_PATHS, start=1)
    ),
)
CASE_QUERY_COUNT_FORM = _form(
    data="<query/>",
    model="""<bind nodeset="/data/query"
      relevant="count(instance('casedb')/casedb/case[@case_type = 'visit'][count &lt; 2]) &gt; 0"/>""",
)
# A predicate's relative children belong to its own row, even when the outer bind's group contains children
# with identical names and known numeric types. Unknown, nested and foreign rows must not borrow those types.
CASE_PROPERTY_COLLISION_PATHS = (
    "instance('casedb')/casedb/case[seen < due]",
    "instance('casedb')/casedb/case[@case_type = 'unknown'][seen < due]",
    "instance('casedb')/casedb/case[@case_type = 'visit'][count(child[seen < due]) > 0]",
    "instance('casedb')/casedb/case[@case_type = 'visit']/child[seen < due]",
    "instance('elsewhere')/casedb/case[@case_type = 'visit'][seen < due]",
)
CASE_PROPERTY_COLLISION_FORM = _form(
    data="".join(
        f"<query_{index}><seen/><due/></query_{index}>" for index in range(1, len(CASE_PROPERTY_COLLISION_PATHS) + 1)
    ),
    model="".join(
        f'<bind nodeset="/data/query_{index}" relevant={quoteattr(f"count({path}) > 0")}/>'
        for index, path in enumerate(CASE_PROPERTY_COLLISION_PATHS, start=1)
    )
    + "".join(
        f'<bind nodeset="/data/query_{index}/{name}" type="xsd:int"/>'
        for index in range(1, len(CASE_PROPERTY_COLLISION_PATHS) + 1)
        for name in ("seen", "due")
    ),
    body="".join(
        f'<group ref="/data/query_{index}"><input ref="/data/query_{index}/seen"/>'
        f'<input ref="/data/query_{index}/due"/></group>'
        for index in range(1, len(CASE_PROPERTY_COLLISION_PATHS) + 1)
    ),
)


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
    # Names HQ's form builder cannot open a form holding, names it only warns about, and a plain one.
    ids = form(data="<bind/><parsererror/><Registration/><SCRIPT/><plain/><g><script/></g>")
    usercase_update = {"condition": ALWAYS, "update": {"name": _update("/data/q")}}
    # A SaveToCase block's own update rows (`status`, `size`), a hand-written case block's and a question's.
    reserved = form(
        data=f"""<op vellum:role="SaveToCase">{case}<update><status/><size/></update></case></op>
          <hand>{case}<update><status/></update></case></hand><plain><status/></plain>"""
    )
    update_row = f"{data}op[1]/{{{CASE_NS}}}case[1]/{{{CASE_NS}}}update[1]/{{{CASE_NS}}}"
    hand_row = f"{data}hand[1]/{{{CASE_NS}}}case[1]/{{{CASE_NS}}}update[1]/{{{CASE_NS}}}status[1]"

    def usercase_app(**actions):
        return _with_forms(_app([_module([_form_json("none", **actions)])]), f=usercase)

    # A SaveToCase block of the worker's record, with rows no worker property takes (`external_id`, `case_type`)
    # and one it takes (`team`), and another case's block writing `external_id`.
    worker_block = form(
        data=f"""<w vellum:role="SaveToCase" vellum:case_type="commcare-user">{case}<update><external_id/>
          <case_type/><status/><team/></update></case></w>
          <p vellum:role="SaveToCase" vellum:case_type="patient">{case}<update><external_id/></update></case></p>"""
    )
    worker_row = f"{data}w[1]/{{{CASE_NS}}}case[1]/{{{CASE_NS}}}update[1]/{{{CASE_NS}}}"
    patient_row = f"{data}p[1]/{{{CASE_NS}}}case[1]/{{{CASE_NS}}}update[1]/{{{CASE_NS}}}external_id[1]"

    def worker_update(key):
        return usercase_app(usercase_update={"condition": ALWAYS, "update": {key: _update("/data/q")}})

    def worker_load(key):
        auto = {"doc_type": "AutoSelectCase", "mode": "usercase", "value_key": ""}
        return _advanced_app([_load("usercase", auto_select=auto, case_properties={key: _update("/data/q")})])

    usercase_map = "/modules/0/forms/0/actions/usercase_update/update"
    load_map = "/modules/0/forms/0/actions/load_update_cases/0/case_properties"

    choices = form(
        data="<s/><m/>",
        body="""<select1 ref="/data/s"><item><value>a b</value></item><item><value>ok</value></item></select1>
          <select ref="/data/m"><item><value>x</value></item><item><value>x</value></item></select>""",
    )
    instance_choices = form(
        data="<s/><m/>",
        body="""<select1 ref="/data/s"><item><value>instance('abc')</value></item>
          <item><value>instance_abc</value></item></select1>
          <select ref="/data/m"><item><value>instance( "item-list:v")</value></item>
          <item><value>instance</value></item></select>""",
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
    # A copy en (the default) holds and fr lacks: t1's fr text is en's copy, so fr shows one text; t2's copy is fr's
    # alone, which the default lacks; t3's fr text is a blank the form builder fills from en's. A copy fr holds beside
    # no text of its own, where fr shows en's text: t4's is en's text, one text; t5's is another, two.
    copied = form(
        data="<q/>",
        model="""<itext><translation lang="en" default="">
            <text id="t1"><value>A</value><value form="markdown">A</value></text>
            <text id="t2"><value>A</value></text>
            <text id="t3"><value>A</value><value form="markdown">A</value></text>
            <text id="t4"><value>A</value><value form="markdown">A</value></text>
            <text id="t5"><value>A</value><value form="markdown">A</value></text></translation>
          <translation lang="fr"><text id="t1"><value>A</value></text>
            <text id="t2"><value>A</value><value form="markdown">A</value></text>
            <text id="t3"><value/></text>
            <text id="t4"><value form="markdown">A</value></text>
            <text id="t5"><value form="markdown">B</value></text></translation></itext>""",
    )
    # The translations the reader reads: es is no app language (HQ removed it, and its build drops the translation),
    # so its stale t1 lacking the copy is not read; the app's first language, fr, is the default though the source
    # marks en, so t2's copy only fr holds, beside en's text equal to it, shows one text, and t3's copy, which en holds
    # and the default fr lacks, breaks en.
    relanguaged = _with_forms(
        _app([_module([_form_json("none")])], langs=["fr", "en"]),
        f=form(
            data="<q/>",
            model="""<itext><translation lang="en" default="">
                <text id="t1"><value>A</value><value form="markdown">A</value></text>
                <text id="t2"><value>A</value></text>
                <text id="t3"><value>A</value><value form="markdown">A</value></text></translation>
              <translation lang="fr"><text id="t1"><value>A</value><value form="markdown">A</value></text>
                <text id="t2"><value>A</value><value form="markdown">A</value></text>
                <text id="t3"><value>B</value></text></translation>
              <translation lang="es"><text id="t1"><value>Hola</value></text></translation></itext>""",
        ),
    )
    # A hint's and a label's copy that differs from its text: the hint's is no runtime's to read.
    hinted = form(
        data="<q/>",
        model="""<itext><translation lang="en" default="">
            <text id="q-hint"><value>A</value><value form="markdown">B</value></text>
            <text id="q-label"><value>A</value><value form="markdown">B</value></text></translation></itext>""",
        body="""<input ref="/data/q"><label ref="jr:itext('q-label')"/><hint ref="jr:itext('q-hint')"/></input>""",
    )
    # A form whose text formatting is off: the label's copy is dropped by the next save, the hint's is no runtime's.
    formatting_off = form(
        data="<q/>",
        model="""<itext><translation lang="en" default="">
            <text id="q-label"><value>A</value><value form="markdown">A</value></text>
            <text id="q-hint"><value>A</value><value form="markdown">A</value></text></translation></itext>""",
        body="""<input ref="/data/q"><label ref="jr:itext('q-label')"/><hint ref="jr:itext('q-hint')"/></input>""",
    ).replace(b"<h:html ", b'<h:html vellum:ignore="markdown" ', 1)
    # b's default reads a, whose default stands after it, though a stands before b in the data tree; c's reads nothing.
    reordered = form(
        data="<a/><b/><c/>",
        model="""<setvalue event="xforms-ready" ref="/data/b" value="/data/a"/>
          <setvalue event="xforms-ready" ref="/data/a" value="'x'"/>
          <setvalue event="xforms-ready" ref="/data/c" value="'y'"/>""",
    )
    # Vellum's default language is the app's first (fr here, though the form marks en), and it fills a blank value
    # from the default, else from any app language with content (t4: es).
    translated = _with_forms(_app([_module([_form_json("none")])], langs=["fr", "en", "es"]), f=translations)
    in_two_languages = _with_forms(_app([_module([_form_json("none")])], langs=["en", "fr"]), f=translations)
    # d's unread word may be dropped with every runtime's reading kept, the HELD-NEW class beside the refused one.
    appearances = form(
        data="<a/><b/><c/><d/>",
        body="""<select1 ref="/data/a" appearance="minimal "><item><value>x</value></item></select1>
          <select1 ref="/data/b" appearance="minimal"><item><value>x</value></item></select1>
          <select1 ref="/data/c" appearance="minimal foo"><item><value>x</value></item></select1>
          <select1 ref="/data/d" appearance="minimal hint-as-placeholder foo">
            <item><value>x</value></item>
          </select1>""",
    )
    # Each whole appearance Android reads ignoring case, as Nova writes it (a, c, e) and as a case variant (b, d, f).
    keypads = form(
        data="<a/><b/><c/><d/><e/><f/>",
        model="""<bind nodeset="/data/a" type="xsd:string"/><bind nodeset="/data/b" type="xsd:string"/>
          <bind nodeset="/data/c" type="xsd:string"/><bind nodeset="/data/d" type="xsd:string"/>
          <bind nodeset="/data/e" type="xsd:date"/><bind nodeset="/data/f" type="xsd:date"/>""",
        body="""<input ref="/data/a" appearance="numeric"/><input ref="/data/b" appearance="Numeric"/>
          <input ref="/data/c" appearance="short"/><input ref="/data/d" appearance="SHORT"/>
          <input ref="/data/e" appearance="ethiopian"/><input ref="/data/f" appearance="Ethiopian"/>""",
    )
    parents = form(
        data='<r jr:template=""/><other><q/></other><top/>',
        body="""<group><repeat nodeset="/data/r"><input ref="/data/other/q"/></repeat></group>
          <input ref="/data/top"/>""",
    )
    inline = form(data="<q/>", model='<instance id="inline"><root><row/></root></instance>')
    unnamed = form(data="<q/>", model="<instance><extra/></instance>")
    # A data node named instance: Vellum's second unnamed instance, an element of the main instance's content.
    instance_question = form(data="<q/><instance/>")
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
    # A menu's display condition is no form's, so it reads the supply point outside an advanced form's datum; a form
    # link is its form's, the advanced one holding the datum.
    supplied_slots = _app(
        [
            _module(
                [
                    {
                        **advanced,
                        "unique_id": "linking",
                        "form_links": [{"doc_type": "FormLink", "xpath": f"{session} = ''", "form_id": "linking"}],
                    }
                ],
                module_filter=f"{session} = ''",
            ),
            _module(module_filter="instance('commcaresession')/session/data/case_id = ''", unique_id="other"),
        ]
    )
    variables = form(data="<v/>", model='<bind nodeset="/data/v" calculate="$x + 1"/>')
    # HQ's build writes a menu's display condition into the suite, outside every form.
    slot_variables = _app([_module(module_filter="$x = 1")])
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
    # A form's display condition reading the case of another menu by its slug, and the shorthand for its own case.
    slug_cases = _app(
        [
            _module(
                [
                    {**_form_json(), "unique_id": "a", "form_filter": "#case:clinic/name = 'x'"},
                    {**_form_json(), "unique_id": "b", "form_filter": "#case/name = 'x'"},
                ]
            )
        ]
    )
    here_suite = b"""<suite version="1"><detail id="d"><title><text><locale id="t"/></text></title><field><header><text>
      <locale id="h"/></text></header><template><text><xpath function="here()"/></text></template></field></detail>
      </suite>"""
    window_width = form(
        data="<w/>",
        model="""<bind nodeset="/data/w" calculate="instance('commcaresession')/session/context/window_width"/>""",
    )
    window_width_suite = b"""<suite version="1"><detail id="d"><title><text><locale id="t"/></text></title><field>
      <header><text><locale id="h"/></text></header><template><text>
      <xpath function="instance('commcaresession')/session/context/window_width"/></text></template></field></detail>
      <entry><form>http://example.org/f</form><command id="m0-f0"><text><locale id="c"/></text></command>
      <instance id="commcaresession" src="jr://instance/session"/></entry></suite>"""
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
    ledger_sources = form(
        data="<v/>",
        model="""<instance id="stock" src="jr://fixture/item-list:stock_ledgerdb_codes"/>
          <instance id="unused" src="jr://instance/ledgerdb"/>
          <bind nodeset="/data/v" calculate="count(instance('stock')/rows/row)"/>""",
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
    # A case list's calculated column reads each row, a case of the menu's type; a menu's display condition reads
    # no case, so its bare name is not placed.
    time_columns = _app(
        [
            _detail_module(
                [
                    _column("if(seen < now(), 'past', 'due')", useXpathExpression=True),
                    _column("if(count < 3, 'few', 'many')", useXpathExpression=True),
                    _column("if(clock < 12, 'morning', 'later')", useXpathExpression=True),
                    # A literal spelled as a date and time is a moment, as Nova's reader types it; one spelled as a
                    # time of day is a time.
                    _column("if(seen < '2026-01-01T10:00:00Z', 'past', 'due')", useXpathExpression=True),
                    _column("if(count < '10:30', 'early', 'late')", useXpathExpression=True),
                ],
                case_type="visit",
                module_filter="count < 3",
            )
        ]
    )
    times = form(
        data="<t/><n/><p/>",
        model=f"""<bind nodeset="/data/t" type="xsd:time" constraint=". &gt; '08:00'"/>
          <bind nodeset="/data/n" type="xsd:int" constraint=". &gt; 0 and count(/data/t) &lt;= 1"/>
          <bind nodeset="/data/p" calculate="if({case_path}age &gt; 1, 1, 0)"/>""",
        body='<input ref="/data/t"/><input ref="/data/n"/>',
    )
    detail_keys = _app(
        [
            _detail_module(
                [_column(foo=1, calc_xpath=".")],
                short={"foo": 1, "custom_variables": None},
                long={"tabs": [{"doc_type": "DetailTab", "starting_index": 0, "isTab": True, "foo": 1}]},
            )
        ]
    )
    # HQ's build never writes a menu's ref_details, whose row holds the whole value.
    reference_keys = _app([_module(ref_details={"doc_type": "DetailPair", "short": {"foo": 1}, "long": {}})])
    form_keys = _app([_module([{**_form_json("none"), "bar": 1, "no_vellum": False}])])
    short = "/modules/0/case_details/short"
    nested = form(
        data="<asked><part/></asked><grp><inner/></grp><plain/>",
        body="""<input ref="/data/asked"/><group ref="/data/grp"><input ref="/data/grp/inner"/></group>
          <input ref="/data/plain"/>""",
    )
    rooted = form(
        data="<q/>",
        model="""<bind nodeset="/data" relevant="/data/q = 'yes'"/><bind nodeset="/data/q" relevant="true()"/>
          <bind nodeset="/data/." relevant="true()"/>""",
        body='<input ref="/data/q"/>',
    )
    return {
        "questions/question-id-failing-the-grammar-or-meta-in-any-case": (
            refused("form", nodes, root_child, f"{data}_bad[1]"),
            refused("form", nodes, root_child, f"{data}meta[1]"),
            refused("form", ids, root_child, f"{data}bind[1]"),
            refused("form", ids, root_child, f"{data}parsererror[1]"),
            accepted("form", nodes, root_child, f"{data}good[1]"),
            accepted("form", ids, root_child, f"{data}Registration[1]"),
        ),
        "questions/question-id-case-registration-script": (
            refused("form", ids, root_child, f"{data}Registration[1]"),
            refused("form", ids, root_child, f"{data}SCRIPT[1]"),
            refused("form", ids, node, f"{data}g[1]/{data}script[1]"),
            accepted("form", ids, root_child, f"{data}plain[1]"),
            accepted("form", ids, root_child, f"{data}bind[1]"),
        ),
        "questions/two-sibling-data-nodes-with-one-name": (
            refused("form", nodes, root_child, f"{data}twin[2]"),
            accepted("form", nodes, root_child, f"{data}rows[2]"),  # a repeat's rows share their path
        ),
        "questions/hidden-value-with-children": (
            refused("form", nodes, root_child, f"{data}holder[1]"),
            accepted("form", nodes, root_child, f"{data}grp[1]"),  # a group's node
        ),
        "questions/a-question-other-than-a-group-or-repeat-whose-data-node-has": (
            refused("form", nested, root_child, f"{data}asked[1]"),
            accepted("form", nested, root_child, f"{data}grp[1]"),  # a group's node
            accepted("form", nested, root_child, f"{data}plain[1]"),  # a question with no child
            accepted("form", nodes, root_child, f"{data}holder[1]"),  # no control: the Hidden Value's class
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
        "forms-and-case-writes/a-write-of-the-worker-s-record-to-a-key-no-worker-property-takes": (
            refused("form", worker_block, node, f"{worker_row}external_id[1]"),
            refused("form", worker_block, node, f"{worker_row}case_type[1]"),  # the sync writes the case's type
            refused("form", worker_block, node, f"{worker_row}status[1]"),
            accepted("form", worker_block, node, f"{worker_row}team[1]"),  # a worker property's name
            accepted("form", worker_block, node, patient_row),  # another case's block
            refused("app", worker_update("first_name"), "schema:UpdateCaseAction.update", usercase_map),
            refused("app", worker_update("Status"), "schema:UpdateCaseAction.update", usercase_map),
            accepted("app", worker_update("team"), "schema:UpdateCaseAction.update", usercase_map),
            accepted("app", worker_update("status"), "schema:UpdateCaseAction.update", usercase_map),  # the bar's
            refused("app", worker_load("user_type"), "schema:LoadUpdateAction.case_properties", load_map),
            accepted("app", worker_load("team"), "schema:LoadUpdateAction.case_properties", load_map),
        ),
        "questions/savetocase-update-key-nova-reserves-for-a-case-s-own-facts": (
            refused("form", reserved, node, f"{update_row}status[1]"),
            accepted("form", reserved, node, f"{update_row}size[1]"),  # a name Nova holds
            accepted("form", reserved, node, hand_row),  # a hand-written case block's
            accepted("form", worker_block, node, f"{worker_row}status[1]"),  # the worker's record's class
            accepted("form", reserved, node, f"{data}plain[1]/{data}status[1]"),  # a question's node
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
        "questions/choice-value-read-as-an-instance": (
            refused("form", instance_choices, "xform:select1/item/value", "select1[1]/item[1]/value[1]"),
            accepted("form", instance_choices, "xform:select1/item/value", "select1[1]/item[2]/value[1]"),
            refused("form", instance_choices, "xform:select/item/value", "select[1]/item[1]/value[1]"),
            accepted("form", instance_choices, "xform:select/item/value", "select[1]/item[2]/value[1]"),
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
        "questions/bind-whose-path-names-the-data-root-itself-data-data-or-a": (
            refused("form", rooted, "xform:model/bind@nodeset", "bind[1]/@nodeset"),
            refused("form", rooted, "xform:model/bind@nodeset", "bind[3]/@nodeset"),
            accepted("form", rooted, "xform:model/bind@nodeset", "bind[2]/@nodeset"),
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
        "questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes": (
            refused("form", reordered, "xform:setvalue", "model[1]/setvalue[1]", readings=True),
            refused("form", reordered, "xform:setvalue", "model[1]/setvalue[2]", readings=True),
            accepted("form", reordered, "xform:setvalue", "model[1]/setvalue[3]", readings=True),
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
            # the value's own form attribute takes the class of the form it names
            refused("form", translations, VALUE_FORM, "translation[1]/text[1]/value[2]/@form"),
            accepted("form", translations, VALUE_FORM, "translation[1]/text[2]/value[2]/@form"),
            # a hint's differing copy is questions/hint-markdown-form's; the label's beside it stays refused
            accepted(
                "form", hinted, "itext-form:core/markdown", "translation[1]/text[1]/value[2]/@form", readings=True
            ),
            refused("form", hinted, "itext-form:core/markdown", "translation[1]/text[2]/value[2]/@form", readings=True),
        ),
        "questions/a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk": (
            # fr's text beside no copy is A, en's copy B: fr's hierarchy and its question show two texts
            refused("form", translations, "itext-form:core/markdown", "translation[1]/text[1]/value[2]/@form"),
            accepted("form", translations, "itext-form:core/markdown", "translation[1]/text[2]/value[2]/@form"),
            # fr's text is en's copy, or a blank filled from en's text: one text in every language
            accepted("form", copied, "itext-form:core/markdown", "translation[1]/text[1]/value[2]/@form"),
            accepted("form", copied, "itext-form:core/markdown", "translation[1]/text[3]/value[2]/@form"),
            # a copy the default lacks
            refused("form", copied, "itext-form:core/markdown", "translation[2]/text[2]/value[2]/@form"),
            # a copy beside no text of its own: en's text, one text; another, two
            accepted("form", copied, "itext-form:core/markdown", "translation[1]/text[4]/value[2]/@form"),
            refused("form", copied, "itext-form:core/markdown", "translation[1]/text[5]/value[2]/@form"),
            # a removed language's stale text is no language's; the app's first language is the default
            accepted("app", relanguaged, "itext-form:core/markdown", "translation[1]/text[1]/value[2]/@form"),
            accepted("app", relanguaged, "itext-form:core/markdown", "translation[2]/text[2]/value[2]/@form"),
            refused("app", relanguaged, "itext-form:core/markdown", "translation[1]/text[3]/value[2]/@form"),
            refused("form", translations, VALUE_FORM, "translation[1]/text[1]/value[2]/@form"),
            accepted("form", copied, VALUE_FORM, "translation[1]/text[1]/value[2]/@form"),
        ),
        "questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text": (
            # fr is the app's first language: its blank t3 beside en's text is refused; en's blank t4 is no first's
            refused("app", translated, "xform:model/itext/translation/text/value", "translation[2]/text[3]/value[1]"),
            accepted("app", translated, "xform:model/itext/translation/text/value", "translation[1]/text[4]/value[1]"),
            # en is first: its blank t4 has no other app language's text (es is no app language here)
            accepted(
                "app", in_two_languages, "xform:model/itext/translation/text/value", "translation[1]/text[4]/value[1]"
            ),
            accepted(
                "app", in_two_languages, "xform:model/itext/translation/text/value", "translation[2]/text[3]/value[1]"
            ),
            unsettled(
                "form", translations, "xform:model/itext/translation/text/value", "translation[2]/text[3]/value[1]"
            ),
        ),
        "questions/a-markdown-form-in-a-form-whose-text-formatting-is-off": (
            refused(
                "form",
                formatting_off,
                "itext-form:core/markdown",
                "translation[1]/text[1]/value[2]/@form",
                readings=True,
            ),
            accepted(
                "form",
                formatting_off,
                "itext-form:core/markdown",
                "translation[1]/text[2]/value[2]/@form",
                readings=True,
            ),
            accepted("form", hinted, "itext-form:core/markdown", "translation[1]/text[2]/value[2]/@form"),
            refused("form", formatting_off, VALUE_FORM, "translation[1]/text[1]/value[2]/@form", readings=True),
            accepted("form", formatting_off, VALUE_FORM, "translation[1]/text[2]/value[2]/@form", readings=True),
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
            unsettled("form", appearances, "xform:select1@appearance", "select1[4]/@appearance"),
        ),
        "questions/a-case-variant-of-numeric-short-or-ethiopian-as-the-whole": (
            refused("form", keypads, "appearance:android/numeric", "input[2]/@appearance"),
            accepted("form", keypads, "appearance:android/numeric", "input[1]/@appearance"),  # Nova's Phone Number
            refused("form", keypads, "appearance:android/short", "input[4]/@appearance"),
            accepted("form", keypads, "appearance:android/short", "input[3]/@appearance"),
            refused("form", keypads, "appearance:android/ethiopian", "input[6]/@appearance"),
            accepted("form", keypads, "appearance:android/ethiopian", "input[5]/@appearance"),
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
            refused("form", images, VALUE_FORM, "text[1]/value[2]/@form", readings=True),
            accepted("form", images, VALUE_FORM, "text[2]/value[2]/@form", readings=True),
        ),
        "questions/choice-big-image": (
            refused("form", images, "itext-form:android/big-image", "text[2]/value[2]/@form", readings=True),
            accepted("form", images, "itext-form:android/big-image", "text[1]/value[2]/@form", readings=True),
            refused("form", images, VALUE_FORM, "text[2]/value[2]/@form", readings=True),
            accepted("form", images, VALUE_FORM, "text[1]/value[2]/@form", readings=True),
        ),
        "expressions-and-data/case-module-slug-unrelated-parent-select-case": (
            refused("app", slug_cases, "hashtag:#case", "/modules/0/forms/0/form_filter"),
            accepted("app", slug_cases, "hashtag:#case", "/modules/0/forms/1/form_filter"),
        ),
        "expressions-and-data/here-in-a-form": (
            refused("form", functions, "jr-handler:here", "bind[1]/@calculate", readings=True),
            accepted("suite", here_suite, "jr-handler:here", "xpath[1]/@function", readings=True),
        ),
        "expressions-and-data/session-context-window-width-in-form-logic": (
            refused(
                "form", window_width, "session-path:session/context/window_width", "bind[1]/@calculate", readings=True
            ),
            accepted(
                "suite",
                window_width_suite,
                "session-path:session/context/window_width",
                "xpath[1]/@function",
                readings=True,
            ),
        ),
        "expressions-and-data/jr-choice-name-on-a-lookup-itemset-select": (
            refused("form", functions, "jr-handler:jr:choice-name", "bind[2]/@calculate", readings=True),
            accepted("form", functions, "jr-handler:jr:choice-name", "bind[3]/@calculate", readings=True),
        ),
        "expressions-and-data/ledgerdb-vellum-id-ledger": (
            refused("form", ledger_sources, "instance-source:ledgerdb", "instance[4]/@src", readings=True),
            accepted("form", ledger_sources, "instance-source:ledgerdb", "instance[5]/@src", readings=True),
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
            accepted("suite", SYSTEM_DATES_SUITE, "xpath-expr:XPathCmpExpr", "menu[1]/@relevant", readings=True),
            unsettled("suite", SYSTEM_DATES_SUITE, "xpath-expr:XPathCmpExpr", "menu[2]/@relevant", readings=True),
            *(
                Shape(
                    export,
                    source,
                    "xpath-expr:XPathCmpExpr",
                    f"{element}[{index}]/@{attribute}",
                    verdict,
                    readings=True,
                    case_types=CASE_PROPERTY_TYPES,
                )
                for export, source, element, attribute in (
                    ("suite", CASE_PROPERTY_SUITE, "datum", "nodeset"),
                    ("form", CASE_PROPERTY_FORM, "bind", "calculate"),
                )
                for index, verdict in enumerate(
                    # Two dates and times compare as moments (a first publish declares the instant-comparison
                    # rewrite), so only the time of day is the class: ``clock < 12``.
                    (False, True, False, False, None, None, None, False, None, None, None, None, False),
                    start=1,
                )
            ),
            accepted(
                "form",
                CASE_QUERY_COUNT_FORM,
                "xpath-expr:XPathCmpExpr",
                "bind[1]/@relevant",
                readings=True,
                case_types=CASE_PROPERTY_TYPES,
            ),
            *(
                unsettled(
                    "form",
                    CASE_PROPERTY_COLLISION_FORM,
                    "xpath-expr:XPathCmpExpr",
                    f"bind[{index}]/@relevant",
                    readings=True,
                    case_types=CASE_PROPERTY_TYPES,
                )
                for index in range(1, len(CASE_PROPERTY_COLLISION_PATHS) + 1)
            ),
            # An old control has no caseTypes metadata, so even the otherwise scoped read remains undecided.
            unsettled("suite", CASE_PROPERTY_SUITE, "xpath-token:LT", "datum[1]/@nodeset", readings=True),
            unsettled("form", CASE_PROPERTY_FORM, "xpath-token:LT", "bind[1]/@calculate", readings=True),
            refused(
                "suite",
                CASE_PROPERTY_SUITE,
                "xpath-token:LT",
                "datum[2]/@nodeset",
                readings=True,
                case_types=CASE_PROPERTY_TYPES,
            ),
            *(
                Shape(
                    "app",
                    time_columns,
                    "xpath-expr:XPathCmpExpr",
                    where,
                    verdict,
                    readings=True,
                    case_types=CASE_PROPERTY_TYPES,
                )
                for where, verdict in (
                    # A date and time against now() is two moments, which Nova compares as such.
                    ("/case_details/short/columns/0/field", False),
                    ("/case_details/short/columns/1/field", False),
                    ("/case_details/short/columns/2/field", True),
                    ("/case_details/short/columns/3/field", False),
                    ("/case_details/short/columns/4/field", True),
                    ("/modules/0/module_filter", None),
                )
            ),
            unsettled(
                "app", time_columns, "xpath-expr:XPathCmpExpr", "/case_details/short/columns/0/field", readings=True
            ),
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
            refused("form", unnamed, "xform:model/instance", "model[1]/instance[4]"),
            accepted("form", unnamed, "xform:model/instance", "model[1]/instance[1]"),
            refused("form", instance_question, "xform:model/instance", "model[1]/instance[1]"),
            accepted("form", inline, "xform:model/instance", "model[1]/instance[1]"),
        ),
        "expressions-and-data/session-data-supply-point-id-anywhere-except-in-an-advanced-form": (
            refused("app", supplied, "session-path:session/data/*", "bind[1]/@calculate", readings=True),
            accepted("app", supplied, "session-path:session/data/*", "bind[2]/@calculate", readings=True),
            refused("app", supplied_slots, "session-path:session/data/*", "/modules/0/module_filter", readings=True),
            accepted("app", supplied_slots, "session-path:session/data/*", "/form_links/0/xpath", readings=True),
            accepted("app", supplied_slots, "session-path:session/data/*", "/modules/1/module_filter", readings=True),
        ),
        "expressions-and-data/session-data-supply-point-id-in-an-advanced-form-whose-computed": (
            accepted("app", supplied, "session-path:session/data/*", "bind[1]/@calculate", readings=True),
            refused("app", supplied, "session-path:session/data/*", "bind[2]/@calculate", readings=True),
            accepted("app", supplied_slots, "session-path:session/data/*", "/modules/0/module_filter", readings=True),
            refused("app", supplied_slots, "session-path:session/data/*", "/form_links/0/xpath", readings=True),
            accepted("app", supplied_slots, "session-path:session/data/*", "/modules/1/module_filter", readings=True),
        ),
        "expressions-and-data/session-data-datum-the-entry-does-not-supply": (
            refused("suite", SESSION_DATUMS_SUITE, "session-path:session/data/*", "datum[1]/@nodeset", readings=True),
            accepted("suite", SESSION_DATUMS_SUITE, "session-path:session/data/*", "datum[2]/@nodeset", readings=True),
            accepted(
                "suite",
                SESSION_DATUMS_SUITE,
                "session-path:session/data/*",
                "field[1]/template[1]/text[1]/xpath[1]/@function",
                readings=True,
            ),
            refused(
                "suite",
                SESSION_DATUMS_SUITE,
                "session-path:session/data/*",
                "field[2]/template[1]/text[1]/xpath[1]/@function",
                readings=True,
            ),
            accepted(
                "suite",
                SESSION_LAUNCH_SUITE,
                "session-path:session/data/*",
                "remote-request[1]/session[1]/query[1]/data[2]/@ref",
                readings=True,
            ),
            refused(
                "suite",
                SESSION_LAUNCH_SUITE,
                "session-path:session/data/*",
                "remote-request[1]/session[1]/query[1]/data[3]/@ref",
                readings=True,
            ),
            accepted(
                "suite",
                SESSION_LAUNCH_SUITE,
                "session-path:session/data/*",
                "remote-request[2]/session[1]/datum[1]/@function",
                readings=True,
            ),
            accepted(
                "suite",
                SESSION_LAUNCH_SUITE,
                "session-path:session/data/*",
                "entry[2]/stack[1]/create[1]/@if",
                readings=True,
                uses=2,
            ),
            refused(
                "suite",
                SESSION_LAUNCH_SUITE,
                "session-path:session/data/*",
                "entry[2]/stack[1]/create[2]/@if",
                readings=True,
            ),
            accepted(
                "suite",
                SESSION_LAUNCH_SUITE,
                "session-path:session/data/*",
                "entry[2]/stack[1]/create[1]/datum[1]/@value",
                readings=True,
            ),
            refused(
                "suite",
                SESSION_LAUNCH_SUITE,
                "session-path:session/data/*",
                "entry[2]/stack[1]/create[3]/datum[1]/@value",
                readings=True,
            ),
        ),
        "expressions-and-data/var-in-a-form-expression": (
            refused("form", variables, "xpath-token:VAR", "bind[1]/@calculate", readings=True),
            accepted("suite", VARIABLES_SUITE, "xpath-token:VAR", "menu[1]/@relevant", readings=True),
            accepted("app", slot_variables, "xpath-token:VAR", "/modules/0/module_filter", readings=True),
        ),
        "menus-and-case-lists/any-other-undeclared-key": (
            refused("app", detail_keys, "schema:Detail.<undeclared>", f"{short}/foo"),
            accepted("app", reference_keys, "schema:Detail.<undeclared>", "/ref_details/short/foo"),
            accepted("app", detail_keys, "schema:Detail.<undeclared>", f"{short}/custom_variables"),
            refused("app", detail_keys, "schema:DetailColumn.<undeclared>", f"{short}/columns/0/foo"),
            accepted("app", detail_keys, "schema:DetailColumn.<undeclared>", f"{short}/columns/0/calc_xpath"),
            refused("app", detail_keys, "schema:DetailTab.<undeclared>", "/modules/0/case_details/long/tabs/0/foo"),
            accepted("app", detail_keys, "schema:DetailTab.<undeclared>", "/modules/0/case_details/long/tabs/0/isTab"),
        ),
        "forms-and-case-writes/any-other-undeclared-key": (
            refused("app", form_keys, "schema:Form.<undeclared>", "/modules/0/forms/0/bar"),
            accepted("app", form_keys, "schema:Form.<undeclared>", "/modules/0/forms/0/no_vellum"),
        ),
    }


def _held_new():
    """The shapes of the HELD-NEW classes beside an allowing class of their key: a use the class takes (``refused``:
    its reader says True, and the use stands held-new) and one beside it that the allowing class holds."""
    data = "{http://example.org/t}"
    case = f'<case xmlns="{CASE_NS}" case_id="" date_modified="" user_id="">'
    update_map = "schema:UpdateCaseAction.update"
    child_map = "schema:OpenSubCaseAction.case_properties"
    updates = "/modules/0/forms/0/actions/update_case/update"
    children = "/modules/0/forms/0/actions/subcases/0/case_properties"
    loads = "/modules/0/forms/0/actions/load_update_cases"
    opens = "/modules/0/forms/0/actions/open_cases"
    short = "/modules/0/case_details/short"
    prompts = "/modules/0/search_config/properties/0"

    def own_update(key, condition=ALWAYS):
        update = {"doc_type": "UpdateCaseAction", "condition": condition, "update": {key: _update("/data/q")}}
        return _with_forms(_app([_module([_form_json("case", update_case=update)])]), f=QUESTIONS)

    def child_update(key):
        subcase = _subcase(case_properties={key: _update("/data/q")})
        return _with_forms(_app([_module([_form_json("none", subcases=[subcase])])]), f=QUESTIONS)

    # A SaveToCase block of a patient whose own update rows are `location_id` and `size`.
    block = _form(
        data=f"""<op vellum:role="SaveToCase" vellum:case_type="patient">{case}<update><location_id/>
      <size/></update></case></op>"""
    )
    row = f"{data}op[1]/{{{CASE_NS}}}case[1]/{{{CASE_NS}}}update[1]/{{{CASE_NS}}}"
    household = _load("load_household_0", case_type="household")
    worker = _load("usercase", auto_select={"doc_type": "AutoSelectCase", "mode": "usercase", "value_key": ""})

    load_tag, open_tag = "schema:LoadUpdateAction.case_tag", "schema:AdvancedOpenCaseAction.case_tag"
    reference = "schema:CaseIndex.reference_id"

    def opened(identifier):
        index = _index("load_household_0", reference_id=identifier)
        return _advanced_app([household], [_open("open_visit_0", case_indices=[index])])

    def load_indexed(identifier):
        index = _index("load_household_0", reference_id=identifier)
        return _advanced_app([household, _load("load_patient_1", case_index=index)])

    def search(**prompt):
        return _app([_search_module(properties=[_prompt(**prompt)])])

    def columns(*listed, **short_fields):
        return _app([_detail_module(listed, short=short_fields)])

    def tile(identifier, template="custom"):
        group = {"doc_type": "CaseTileGroupConfig", "index_identifier": identifier, "header_rows": 2}
        return columns(_column(), case_tile_template=template, case_tile_group=group)

    def keyed(fmt, key):
        item = {"doc_type": "MappingItem", "key": key, "value": {"en": "A"}}
        return columns(_column(fmt=fmt, enum=[item]))

    profiled = _app([], build_profiles={"french": {"doc_type": "BuildProfile", "name": "French", "langs": ["fra"]}})
    choices = _form(
        data="<s/>",
        body="""<select1 ref="/data/s"><item><value>a'b"c</value></item><item><value>a'b</value></item></select1>""",
    )
    named = _form(data="<q/>").replace(b"<data ", b'<visit uiVersion="1" ').replace(b"</data>", b"</visit>")
    versioned = _form(data="<q/>").replace(b'name="T"', b'name="T" uiVersion="1"')
    # Hidden Values (data nodes no control names): a, b and c with a calculate and a default, a read by r's later
    # default, c through m's calculate by s's, b by nothing; h with both in a repeat; t with a calculate alone.
    hidden_values = _form(
        data="<a/><b/><c/><m/><r/><s/><t/><grp><h/><v/></grp>",
        model=(
            '<bind nodeset="/data/a" calculate="1 + 1"/><bind nodeset="/data/b" calculate="2 + 2"/>'
            '<bind nodeset="/data/c" calculate="3 + 3"/><bind nodeset="/data/m" calculate="/data/c * 2"/>'
            '<bind nodeset="/data/r"/><bind nodeset="/data/s"/><bind nodeset="/data/t" calculate="4"/>'
            '<bind nodeset="/data/grp/h" calculate="5"/>'
            '<setvalue event="xforms-ready" ref="/data/a" value="5"/>'
            '<setvalue event="xforms-ready" ref="/data/b" value="6"/>'
            '<setvalue event="xforms-ready" ref="/data/c" value="7"/>'
            '<setvalue event="xforms-ready" ref="/data/grp/h" value="8"/>'
            '<setvalue event="xforms-ready" ref="/data/r" value="/data/a + 1"/>'
            '<setvalue event="xforms-ready" ref="/data/s" value="/data/m"/>'
        ),
        body="""<group ref="/data/grp"><label>G</label><repeat nodeset="/data/grp">
          <input ref="/data/grp/v"><label>V</label></input></repeat></group>""",
    )

    # A query repeat's count placement as Nova writes it (``countPlacementRow.ts``): each row's id holds a
    # calculate and a ``jr-insert`` default that give the row one id, which the count repeat's own entry holds. In
    # ``s`` the row's default is another value, which the row's calculate replaces only later.
    def count_placement(name, row_default):
        ids, count, row_id, index = (f"nova_query_{part}_{name}" for part in ("ids", "count", "id", "index"))
        data = f'<{name}><{ids}/><{count}/><item jr:template=""><{row_id}/><{index}/><note/></item></{name}>'
        model = (
            f"<bind nodeset=\"/data/{name}/{ids}\" calculate=\"join(' ', 'a b')\"/>"
            f'<bind nodeset="/data/{name}/{count}" type="xsd:int" calculate="count-selected(../{ids})"/>'
            f'<bind nodeset="/data/{name}/item/{row_id}"'
            f" calculate=\"if(../{index} &lt; ../../{count}, selected-at(../../{ids}, ../{index}), '')\"/>"
            f'<bind nodeset="/data/{name}/item/{index}" type="xsd:int"/>'
            f'<setvalue event="jr-insert" ref="/data/{name}/item/{row_id}" value="{row_default}"/>'
            f'<setvalue event="jr-insert" ref="/data/{name}/item/{index}" value="position(..)"/>'
        )
        body = (
            f'<group ref="/data/{name}"><group><repeat nodeset="/data/{name}/item" jr:noAddRemove="true()"'
            f' jr:count="/data/{name}/{count}"><input ref="/data/{name}/item/note"><label>N</label></input>'
            "</repeat></group></group>"
        )
        return data, model, body

    placed = [
        count_placement(
            "r",
            "if(position(..) &lt; int(../../nova_query_count_r),"
            " selected-at(../../nova_query_ids_r, position(..)), '')",
        ),
        count_placement("s", "if(position(..) &lt; 5, ../../nova_query_ids_s, '')"),
    ]
    count_rows = _form(
        data="".join(data for data, _, _ in placed),
        model="".join(model for _, model, _ in placed),
        body="".join(body for _, _, body in placed),
    )

    def hidden(*names):
        return "data[1]/" + "/".join(f"{{http://example.org/t}}{name}[1]" for name in names)

    # A SaveToCase block's ``<case>`` attribute HQ's reader lists as a Hidden Value (``get_questions``), here with a
    # calculate and a default, is the block's own property to Vellum, never a Hidden Value.
    case_attribute = _form(
        data=(
            '<stc><case xmlns="http://commcarehq.org/case/transaction/v2" case_id="" date_modified="">'
            "<create><case_type/></create></case></stc>"
        ),
        model=(
            '<bind nodeset="/data/stc/case/@case_id" calculate="uuid()"/>'
            '<bind nodeset="/data/stc/case/create/case_type" calculate="\'patient\'"/>'
            '<setvalue event="xforms-ready" ref="/data/stc/case/@case_id" value="uuid()"/>'
        ),
    )
    case_id = "{http://example.org/t}stc[1]/{http://commcarehq.org/case/transaction/v2}case[1]/@case_id"

    hidden_type = "mug:DataBindOnly"
    return {
        "questions/hidden-value-with-both-calculate-and-a-default-by-any-expression": (
            refused("form", hidden_values, hidden_type, hidden("a"), readings=True),
            refused("form", hidden_values, hidden_type, hidden("c"), readings=True),
            refused("form", hidden_values, hidden_type, hidden("grp", "h"), readings=True),
            accepted("form", hidden_values, hidden_type, hidden("b"), readings=True),
            accepted("form", hidden_values, hidden_type, hidden("t"), readings=True),
            accepted("form", hidden_values, hidden_type, hidden("r"), readings=True),
            # A count placement's row id is the count repeat's, and a row whose default its calculate does not give
            # is a Hidden Value in a repeat.
            accepted("form", count_rows, hidden_type, hidden("r", "item", "nova_query_id_r"), readings=True),
            refused("form", count_rows, hidden_type, hidden("s", "item", "nova_query_id_s"), readings=True),
            accepted("form", case_attribute, hidden_type, case_id, readings=True),
        ),
        "forms-and-case-writes/update-keys-location-id-hq-user-id": (
            refused("app", own_update("location_id"), update_map, updates),
            accepted("app", own_update("district"), update_map, updates),
            # Under the condition never, HQ's build writes no key of the map, the inert class beside it.
            accepted("app", own_update("location_id", NEVER), update_map, updates),
            refused("app", child_update("hq_user_id"), child_map, children),
            # A child case's key with an index step is refused before its property is read.
            accepted("app", child_update("parent/location_id"), child_map, children),
            refused("form", block, "xform:model/instance//*", f"{row}location_id[1]"),
            accepted("form", block, "xform:model/instance//*", f"{row}size[1]"),
        ),
        "forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character": (
            refused("app", own_update("größe"), update_map, updates),
            refused("app", child_update("größe"), child_map, children),
            accepted("app", own_update("size"), update_map, updates),
            # ``ª`` is a letter to HQ's grammar and no name character to Core: HQ's build refuses it (the bar's).
            accepted("app", own_update("aª"), update_map, updates),
        ),
        "forms-and-case-writes/case-tag-holding-a-hyphen": (
            refused("app", _advanced_app([_load("load-patient")]), load_tag, f"{loads}/0/case_tag"),
            refused("app", _advanced_app([household], [_open("open-visit")]), open_tag, f"{opens}/0/case_tag"),
            accepted("app", _advanced_app([_load("load_patient")]), load_tag, f"{loads}/0/case_tag"),
            # An auto-selected load's tag is read by no tag check.
            accepted("app", _advanced_app([{**worker, "case_tag": "user-case"}]), load_tag, f"{loads}/0/case_tag"),
            # Nor is a shadow form's, which Nova's reader refuses whole.
            accepted(
                "app",
                _shadow_app([_load("load_patient")], [_load("load-patient")]),
                load_tag,
                "/modules/0/forms/1/extra_actions/load_update_cases/0/case_tag",
            ),
        ),
        "forms-and-case-writes/index-identifier-outside-an-xml-element-name": (
            refused("app", opened("my-parent"), reference, f"{opens}/0/case_indices/0/reference_id"),
            accepted("app", opened("my_parent"), reference, f"{opens}/0/case_indices/0/reference_id"),
            # A load's index is another class's.
            accepted("app", load_indexed("my-parent"), reference, f"{loads}/1/case_index/reference_id"),
        ),
        "case-search/prompt-key-outside-nova-s-name-grammar": (
            refused("app", search(name="parent/dob"), "schema:CaseSearchProperty.name", f"{prompts}/name"),
            refused("app", search(name="_x"), "schema:CaseSearchProperty.name", f"{prompts}/name"),
            accepted("app", search(name="dob"), "schema:CaseSearchProperty.name", f"{prompts}/name"),
            # Excluded from the search, the prompt names no case property.
            accepted("app", search(name="_x", exclude=True), "schema:CaseSearchProperty.name", f"{prompts}/name"),
        ),
        "case-search/default-value-on-a-date-range-input": (
            refused(
                "app",
                search(name="dob", input_="daterange", default_value="today()"),
                "schema:CaseSearchProperty.default_value",
                f"{prompts}/default_value",
            ),
            accepted(
                "app",
                search(name="dob", input_="date", default_value="today()"),
                "schema:CaseSearchProperty.default_value",
                f"{prompts}/default_value",
            ),
            accepted(
                "app",
                search(name="dob", input_="daterange", default_value="today()", hidden=True),
                "schema:CaseSearchProperty.default_value",
                f"{prompts}/default_value",
            ),
        ),
        "questions/choice-value-holding-both-an-apostrophe-and-a-double-quote": (
            refused("form", choices, "xform:select1/item/value", "select1[1]/item[1]/value[1]"),
            accepted("form", choices, "xform:select1/item/value", "select1[1]/item[2]/value[1]"),
        ),
        "questions/data-root-element-named-other-than-data": (
            refused("form", named, "xform:model/instance/*", f"instance[1]/{data}visit[1]"),
            accepted("form", versioned, "xform:model/instance/*", f"instance[1]/{data}data[1]"),
        ),
        "menus-and-case-lists/detail-max-select-value-above-100": (
            refused(
                "app",
                columns(multi_select=True, max_select_value=150),
                "schema:Detail.max_select_value",
                f"{short}/max_select_value",
            ),
            accepted(
                "app",
                columns(multi_select=True, max_select_value=99),
                "schema:Detail.max_select_value",
                f"{short}/max_select_value",
            ),
            # A list that selects one case reads no maximum.
            accepted(
                "app",
                columns(multi_select=False, max_select_value=150),
                "schema:Detail.max_select_value",
                f"{short}/max_select_value",
            ),
            # Null is HQ's model's None, which Core reads as 100.
            accepted(
                "app",
                columns(multi_select=True, max_select_value=None),
                "schema:Detail.max_select_value",
                f"{short}/max_select_value",
            ),
            # No number is a value HQ's model refuses as it wraps the app, which Nova's reader leaves unclaimed.
            unsettled(
                "app",
                columns(multi_select=True, max_select_value="150"),
                "schema:Detail.max_select_value",
                f"{short}/max_select_value",
            ),
        ),
        "menus-and-case-lists/mapping-condition-outside-predicate": (
            refused(
                "app",
                keyed("conditional-enum", ". > ("),
                "schema:MappingItem.key",
                f"{short}/columns/0/enum/0/key",
                readings=True,
            ),
            # A key Core parses may still read a value Nova has no binding for, so its class is not the key's alone.
            unsettled(
                "app",
                keyed("conditional-enum", ". > 3"),
                "schema:MappingItem.key",
                f"{short}/columns/0/enum/0/key",
                readings=True,
            ),
            # Without Core's parse of the key the class is not settled.
            unsettled("app", keyed("conditional-enum", ". > ("), "schema:MappingItem.key", f"{short}/columns/0/enum/0/key"),
            # A plain value is no condition, and an ID mapping's key is compared as a value.
            accepted("app", keyed("conditional-enum", "urgent"), "schema:MappingItem.key", f"{short}/columns/0/enum/0/key"),
            accepted("app", keyed("enum", ". > ("), "schema:MappingItem.key", f"{short}/columns/0/enum/0/key"),
        ),
        "menus-and-case-lists/case-tile-group-identifier-outside-an-xml-element-name": (
            refused(
                "app",
                tile("my-group"),
                "schema:CaseTileGroupConfig.index_identifier",
                f"{short}/case_tile_group/index_identifier",
            ),
            accepted(
                "app",
                tile("my_group"),
                "schema:CaseTileGroupConfig.index_identifier",
                f"{short}/case_tile_group/index_identifier",
            ),
            # A list with no custom tile groups nothing.
            accepted(
                "app",
                tile("my-group", template=None),
                "schema:CaseTileGroupConfig.index_identifier",
                f"{short}/case_tile_group/index_identifier",
            ),
        ),
        "menus-and-case-lists/column-reading-an-unknown-hash-property": (
            refused("app", columns(_column(field="#visit")), "schema:DetailColumn.field", f"{short}/columns/0/field"),
            refused("app", columns(_column(field="site-link/#visit")), "schema:DetailColumn.field", f"{short}/columns/0/field"),
            accepted("app", columns(_column(field="site-link/#owner_name")), "schema:DetailColumn.field", f"{short}/columns/0/field"),
            accepted("app", columns(_column(field="a" * 256)), "schema:DetailColumn.field", f"{short}/columns/0/field"),
            accepted("app", columns(_column(field="visit")), "schema:DetailColumn.field", f"{short}/columns/0/field"),
            accepted(
                "app", columns(_column(field="#owner_name")), "schema:DetailColumn.field", f"{short}/columns/0/field"
            ),
        ),
        "application-and-settings/build-profiles-non-empty": (
            refused("app", profiled, "schema:Application.build_profiles", "/build_profiles"),
            refused("app", profiled, "schema:BuildProfile.name", "/build_profiles/french/name"),
        ),
    }


SHAPES = {
    **_questions(),
    **_settings_and_forms(),
    **_advanced_actions(),
    **_search_and_menus(),
    **_data_binds_and_itext(),
    **_held_new(),
}

# Classes whose refused shape no export holds, by why: the export leaves the class open (None) where it would be in it.
UNSETTLED = {}
# Classes that take every use of their keys, by why: they have no accepted shape.
EVERY_USE_TAKEN = {
    "questions/authored-orx-pollsensor": (
        "every pollsensor a form's source holds is authored, since HQ's build writes its own only into what it builds"
    ),
    "case-search/search-button-label-any-other-value": (
        "every value but HQ's default is in the class, and HQ's default is no use"
    ),
    "menus-and-case-lists/module-with-is-training-module-true-training-menu-root-training": (
        "is_training_module is a use only where it is true, which is the class; a suite's menu root it does not read"
    ),
    "application-and-settings/build-profiles-non-empty": (
        "an empty build_profiles is HQ's default and no use, and every use of the keys is a profile or its part"
    ),
    "forms-and-case-writes/form-type-other-than-the-form-s-own-kind": (
        "form_type is a use only where it is not its class's default, the form's own kind, so every use is another"
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
        manifest_usage.app_json_uses(shape.source, manifest, artifact, found, configurations=shape.configurations)
    else:
        manifest_usage.runtime_xml_uses(shape.source, "SuiteParser", manifest, artifact, found)
    for document in found.documents:
        if isinstance(document, (classes.App, classes.Form, classes.Runtime)):
            document.case_types = shape.case_types
    if readings is not None:
        manifest_usage.read_observed(found, manifest, readings)
    return found


def _holds_its_shapes(entry_id, manifest, readings=None):
    entry = next(entry for held in manifest.entries.values() for entry in held if entry.id == entry_id)
    for shape in SHAPES[entry_id]:
        found = _shape_uses(shape, manifest, readings if shape.readings else None)
        uses = [use for use in found.uses if use.key == shape.key and use.where.endswith(shape.where)]
        assert len(uses) == shape.uses, (
            f"{entry_id}: {shape.key} at {shape.where} is {len(uses)} uses, not {shape.uses}"
        )
        named = entry in manifest.entries.get(shape.key, ())
        # A key the entry should name and does not is a gap listed in UNCONSULTED; one it names now moves its shape.
        assert named is shape.named, f"{entry_id} {'does not name' if shape.named else 'now names'} {shape.key}"
        for use in uses:
            verdict = classes.VALUE_CLASSES[entry_id](use, manifest)
            assert verdict is shape.verdict, f"{entry_id} reads {shape.key} at {shape.where} as {verdict}"
            if not named:
                continue
            # The check consults the reader for that use: the use stands in the class where the reader takes it.
            kind, held = manifest_usage.standing(manifest, use)
            if shape.verdict and entry.disposition == "HELD-NEW":
                assert kind == manifest_usage.HELD_NEW and entry in held, f"{entry_id} stands {kind} at {shape.where}"
            elif shape.verdict:
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


def test_a_held_new_reader_decides_by_the_uses_own_value(manifest):
    """Contract: a HELD-NEW class's reader decides by the use's own value and the objects or elements that hold it,
    never by another part of the app or by what the observation read. Each of its shapes is read again with no app
    beside the use (an app JSON's slot keeps its own objects, from the root down to the slot, and loses every read
    of the app as a whole) and with no readings, and gives the same verdict. The plausible failure: a reader that
    reads the app's languages, its other menus or a parse, so its class is no longer one value's, and parity's join
    over a variant's added uses compares a reading the use alone does not settle."""
    readers = sorted(entry.id for entry in _held_new_readers(manifest))
    assert readers, "the registry holds no HELD-NEW reader"
    for entry_id in readers:
        reader = classes.VALUE_CLASSES[entry_id]
        for shape in SHAPES[entry_id]:
            if _made_by_readings(shape):
                continue  # read with the readings that make its use (the next test)
            found = _shape_uses(shape, manifest)
            uses = [use for use in found.uses if use.key == shape.key and use.where.endswith(shape.where)]
            assert uses, f"{entry_id}: no use of {shape.key} at {shape.where}"
            for use in uses:
                at = use.at
                if isinstance(at, classes.JsonAt):
                    alone = classes.JsonAt(None, at.scope, at.key)
                else:
                    at.document.readings = None
                    alone = at
                verdict = reader(replace(use, at=alone), manifest)
                assert verdict is shape.verdict, f"{entry_id} reads more than the use at {shape.where}"


def _made_by_readings(shape):
    """Whether a shape's use exists only as the observation's readings make it: a question's type, as HQ's question
    reader reads the form (``manifest_usage._question_uses``), and a session path, as Core's parse of the expression
    gives its instance paths."""
    return shape.key.startswith(("mug:", "session-path:"))


def test_a_held_new_reader_of_a_use_the_readings_make_reads_its_own_form_alone(manifest, observed):
    """Contract: a HELD-NEW class of a use the observation's readings make (a question's type, a session path)
    decides by the form or slot the use stands in, read with the readings that make the use and give its
    expressions' structure, and with no app beside it: an XForm keeps the form object that names it, its own, and
    an app JSON's slot its objects from the root down to it. Each such shape is read again so, and gives the same
    verdict. The plausible failure: a reader that reads another form, a menu or the app's languages, so its class is
    no longer one form's or one slot's."""
    shapes = [
        (entry.id, shape)
        for entry in _held_new_readers(manifest)
        for shape in SHAPES[entry.id]
        if _made_by_readings(shape)
    ]
    assert {shape.key.split(":", 1)[0] for _, shape in shapes} == {"mug", "session-path"}
    for entry_id, shape in shapes:
        found = _shape_uses(shape, manifest, observed)
        uses = [use for use in found.uses if use.key == shape.key and use.where.endswith(shape.where)]
        assert uses, f"{entry_id}: no use of {shape.key} at {shape.where}"
        for use in uses:
            at = use.at
            if isinstance(at, classes.JsonAt):
                bare = classes.App({}, at.app.artifact)
                bare.readings = at.app.readings
                use = replace(use, at=classes.JsonAt(bare, at.scope, at.key))
            elif at.document.app_form is not None:
                _, form_json = at.document.app_form
                at.document.app_form = None if shape.key.startswith("mug:") else (None, form_json)
            verdict = classes.VALUE_CLASSES[entry_id](use, manifest)
            assert verdict is shape.verdict, f"{entry_id} reads more than the use's own form at {shape.where}"


def _entry_suite(*datum_ids):
    """A suite whose one entry opens the form ``FORM`` writes (namespace ``http://example.org/t``), writing
    ``datum_ids`` into the session."""
    datums = "".join(
        f"<datum id={quoteattr(datum_id)} value='./@case_id'"
        f" nodeset=\"instance('casedb')/casedb/case[@case_type='patient']\"/>"
        for datum_id in datum_ids
    )
    return (
        '<suite version="1"><entry><form>http://example.org/t</form><command id="m0-f0"><text><locale id="c"/>'
        f'</text></command><instance id="casedb" src="jr://instance/casedb"/><session>{datums}</session></entry>'
        "</suite>"
    ).encode()


def test_an_app_json_forms_session_reads_are_judged_by_the_entries_hq_built_of_its_upload(hq, core_runner, manifest):
    """Contract: ``expressions-and-data/session-data-datum-the-entry-does-not-supply`` reads an app JSON form's
    ``session/data/<id>`` against the entries that open the form in HQ's build of the upload that carried it
    (``manifest_usage.export_uses``: A's state for a first publish), falls back to the local archive Nova built of
    the same export only where HQ built nothing, and is undecided only where neither says. The plausible failures:
    a document that declares no Android, so Nova hands it no local archive, whose every session read is undecided
    (which no register entry may hold); and a judge that reads Nova's own suite where HQ's build, which is what
    runs the app JSON, writes other datums. A form link's condition and carried value, which HQ's build writes into
    the stack of the form's own entry (``m0-f0``), are read against that entry's datums the same way."""
    from types import SimpleNamespace

    from proof.observe.record import ConfigurationRecords, DocumentRecords

    form = _form(
        data="<c/><p/>",
        model="""<bind nodeset="/data/c" calculate="instance('commcaresession')/session/data/case_id"/>
          <bind nodeset="/data/p" calculate="instance('commcaresession')/session/data/parent_id"/>""",
    )
    link = {
        "doc_type": "FormLink",
        "xpath": "instance('commcaresession')/session/data/case_id = ''",
        "form_id": "f",
        "datums": [
            {"doc_type": "FormDatum", "name": "case_id", "xpath": "instance('commcaresession')/session/data/parent_id"}
        ],
    }
    app = _with_forms(_app([_module([{**_form_json("none"), "unique_id": "f", "form_links": [link]}])]), f=form)
    built_suite, local_suite = _entry_suite("case_id"), _entry_suite("parent_id", "case_id")
    table = observed_manifest.readings(core_runner, forms=[form], runtimes=[local_suite], apps=[app])
    document = SimpleNamespace(
        id="datum-reads",
        exports={"minimum": SimpleNamespace(two_imports=False, republish=None, configuration=PLAIN)},
        edit=None,
        migration_witness=False,
        hq_side=None,
    )
    reader = classes.VALUE_CLASSES["expressions-and-data/session-data-datum-the-entry-does-not-supply"]
    binds = {"bind[1]/@calculate": "case_id", "bind[2]/@calculate": "parent_id"}
    slots = {"/form_links/0/xpath": "link case_id", "/form_links/0/datums/0/xpath": "link parent_id"}

    def judged(built, local):
        records = DocumentRecords(document.id, "corpus")
        blobs = records.blobs
        a = {"kind": "a"}
        if built is not None:  # HQ built A: its files, each a blob, as ``outcome_record`` keeps them
            a["state"] = {"build": {"files": {"suite.xml": blobs.put(built)}}}
        records.configurations["minimum"] = ConfigurationRecords("minimum", {}, a=a)
        observed = {
            "uploads": {"minimum/create": blobs.put(json.dumps(app).encode())},
            "archives": {} if local is None else {"local.ccz": {"suite.xml": blobs.put(local)}},
            "readings": blobs.put_json(table),
        }
        records.local = {"kind": "local", "hooks": {"manifest": observed}}
        found = manifest_usage.export_uses(document, records, manifest)
        uses = [use for use in found.uses if use.key == "session-path:session/data/*"]
        return {
            read: reader(use, manifest)
            for use in uses
            for where, read in (binds if use.artifact == "form:0.0" else slots).items()
            if use.where.endswith(where) and use.artifact in ("form:0.0", "app.json")
        }

    def both(case_id, parent_id):
        return {"case_id": case_id, "parent_id": parent_id, "link case_id": case_id, "link parent_id": parent_id}

    # No local archive (an app declared for Web Apps alone): HQ's build of the upload decides.
    assert judged(built_suite, None) == both(False, True)
    # HQ's build decides where Nova's local archive writes more.
    assert judged(built_suite, local_suite) == both(False, True)
    # HQ built nothing (it refused the publish, which the bar reports): the local archive of the same export.
    assert judged(None, local_suite) == both(False, False)
    # Neither says what opens the form: the reader cannot tell.
    assert judged(None, None) == both(None, None)


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
        "application-and-settings/non-empty-custom-assertions-app",
        "case-search/instance-name-containing-casedb-ledgerdb-fixture-or-session",
        "expressions-and-data/commtrack-products-commtrack-programs",
        "expressions-and-data/reports-commcare-reports-commcare-reports-commcare-reports",
        "expressions-and-data/tag-containing-casedb-or-ledgerdb",
        "expressions-and-data/tag-or-field-name-core-s-xpath-lexer-does-not-read-as-a-name-any",
        "forms-and-case-writes/custom-assertions-form-non-empty",
        "forms-and-case-writes/is-release-notes-form-true-with-or-without-enable-release-notes",
        "forms-and-case-writes/shadow-parent-form-id-naming-a-basic-form-or-another-shadowform",
        "forms-and-case-writes/show-count-true",
        "forms-and-case-writes/unknown-form-doc-type",
        "menus-and-case-lists/a-shadow-menu-s-own-or-mirror-form-endpoint-id-with-surrounding",
        "menus-and-case-lists/advancedmodule-has-schedule-true-or-schedule-phases-non-empty",
        "menus-and-case-lists/attachment-name-with-any-other-format",
        "menus-and-case-lists/callout-with-no-extras-or-no-responses",
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
        "menus-and-case-lists/report-context-tile-true",
        "menus-and-case-lists/shadowmodule-version-1-or-key-absent-model-default-1",
        "questions/a-choice-bind-type-contradicting-the-control-listitem-select1-on",
        "questions/a-connect-learn-module-or-task-id-longer-than-50-characters-or",
        # Its keys are a Connect block's mug types and Vellum's Connect plugin, and the extraction makes a use of
        # neither: HQ's reader types a question from its body control (``xform.py::_infer_vellum_type``), and a
        # Connect block is data with none, whose leaves ``get_questions`` lists as ``DataBindOnly``; no family reads
        # a ``vellum-plugin:`` key.
        "questions/connect-block-text-read-as-an-instance",
        "questions/connect-deliver-unit-and-task-in-one-form",
        "questions/a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does",
        "questions/a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-starts",
        # Their one key is ``mug:SaveToCase``, of which the extraction makes no use: HQ's reader types a question
        # from its body control (``xform.py::_infer_vellum_type``), a SaveToCase node has none, and ``get_questions``
        # lists its leaves and its case's attributes as ``DataBindOnly``. Nova's gate refuses each class, so no export
        # holds one.
        "questions/a-savetocase-case-type-outside-the-case-type-grammar-or-longer-than-255-characters",
        "questions/a-savetocase-change-a-device-refuses-a-blank-case-id-or-a-link-of-its-case-to-itself",
        "questions/a-savetocase-change-that-reads-the-case-a-menu-chooses-on-a-form-whose-menu-chooses-none",
        "questions/a-savetocase-link-name-longer-than-commcare-hq-stores",
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
    ``<Class>.`` before it aside), so a row added or renamed fails here rather than its key staying refused. A row
    that also names a declared key of the class holds the object whole by where it sits (a menu's ``ref_details``),
    not keys by name, and spells none."""
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
                whole = any(other.startswith(f"schema:{cls}.") and other != key for other in entry["surfaceKeys"])
                if entry["id"] in catch_alls:
                    named.setdefault(cls, set())
                elif entry["disposition"] != "REFUSED" and not whole:
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


@pytest.mark.parametrize("ref", [None, "/data/place"])
def test_the_pollsensor_hqs_build_writes_is_held_in_a_local_archive_and_refused_in_a_source(manifest, ref):
    """The ``pollsensor`` HQ's build writes (bare, and capturing the location) is a held use of a local archive:
    every key it uses stands held there (``questions/hq-generated-pollsensor``), and each of the four setvalue
    readers answers False for the event it carries, which no setvalue carries. In a form's source the refused
    entry's two keys rest on ``questions/authored-orx-pollsensor``, and the element's other keys are held."""
    xml = _pollsensor_form(ref)
    refused_keys = {"jr-action:pollsensor", "jr-extension:PollSensorExtensionParser"}
    for artifact in ("local.ccz/form:0.0", "form:0.0"):
        found = manifest_usage.Uses()
        manifest_usage.xform_uses(xml, manifest, artifact, found)
        uses = [use for use in found.uses if "pollsensor" in use.where]
        keys = {use.key for use in uses}
        assert refused_keys <= keys and "xform:pollsensor@event" in keys, keys
        assert ("xform:pollsensor@ref" in keys) is (ref is not None)
        for use in uses:
            kind, held = manifest_usage.standing(manifest, use)
            source = artifact == "form:0.0" and use.key in refused_keys
            assert kind == (manifest_usage.REFUSED if source else manifest_usage.HELD), (artifact, use.key, kind)
            if source:
                assert "questions/authored-orx-pollsensor" in [entry.id for entry in held]
            if use.key == "jr-event:xforms-ready":
                for reader in (
                    classes.default_event_mismatching_placement,
                    classes.form_level_setvalue,
                    classes.savetocase_blank_create_id,
                    classes.second_default,
                ):
                    assert reader(use, manifest) is False, (reader.__name__, use.where)
