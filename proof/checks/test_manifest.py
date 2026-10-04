"""The manifest checks: nothing Nova emits is unclassified (decision 7, plan work item 11).

Contract: every surface item one of Nova's exports uses (a schema field at a
value other than HQ's default, a format, a question type, a function, a
parser element or attribute, an appearance token, a setting, the XForm
vocabulary, an instance's source and scheme, a session path, a hashtag, the
XPath grammar Core builds, a search's keys and the CSQL it sends) is named by
an inventory entry, and every flag HQ reads while it builds the export has a
gate entry. The plausible failures: an export that starts using
something no one classified (a new key, a new function, a new appearance)
passes unnoticed; a flag HQ newly reads while building Nova's apps is never
classified as a gate; and an extractor that misreads its artifact (a default
compared wrongly, a control mistaken for data, an expression's call missed,
a use keyed under a name no entry could ever name) makes the check pass or
fail for the wrong reason.

The corpus test holds each document's unclassified uses and ungated reads
to the register (they are real findings until classified). An entry holds a
use only as its disposition and value class say: a use a REFUSED entry's
class takes is refused, one the check cannot tell apart from a REFUSED class
is undecided under that class's name, and an allowing class holds the rest
of its key's values; a key only the bar's entries name (refused only because
HQ's build refuses the state) is the bar's to report, and in Nova's own local
archives an entry refused for how HQ's editors treat the source takes its
class's uses as the source's and leaves the rest unheld (the value class
readers' own tests are ``test_manifest_value_classes``); a check that passed
every use of a named key would let Nova emit what its own reader refuses, and
one that reported a refusal on both the source and the archive built from it
would split one symptom in two. An appearance is a use only on the elements
its reader reads (a group's ``field-list`` is no select's ``-``). The judge
holds a part's flags to the gates only from what the unit counted over HQ's
build (``flagsReadByBuild``), never from what HQ read while importing the
publish; a stack query is a request to HQ's case fixture view, not a search;
Core's namespace reads hold only under the conditions it reads them in; and
Vellum's own markup is keyed by what Vellum's parser asks. The other tests
pin each extractor to an independent reader: HQ's own model for schema
defaults and HQ's own question reader for question types, Core's XPath
parser and lexer for functions, session paths and grammar, HQ's CSQL parser
for what a search sends, Core's parser graph (as the surface records it) for
a suite HQ built, and the readers' own matching rules for appearances and
instance sources, each refusal paired with an accepted case.

The check is split in two: the observation (``proof.observe.manifest``)
records every export and what HQ's and Core's readers make of it, without
the manifest, and the judge (``proof.checks.manifest_usage``) walks the
records with the manifest. The plausible failures there: a judge that
reaches HQ, so records cannot be judged again without it; an observation
that reads only what today's surface names, so a surface that names one more
expression would need the exports observed again (or would pass over it); an
observation that reads a publish it does not declare, so a change to Nova's
HQ JSON that leaves the local archives alone keeps the local part's key and
its stored record is judged again over the old export; and a judgment that
reads something the records lose when written to disk. Each publish file the
corpus layout holds is changed in turn in a copy of a document, against the
local part's key.
"""

from __future__ import annotations

import json
import shutil
import zipfile

import pytest

from proof.checks import cases, manifest_usage, observations
from proof.checks.corpus import Document
from proof.checks.differences import pointer_token
from proof.core.artifacts import BASIC_APP, read_archive_entry
from proof.observe import manifest as observed_manifest
from proof.observe import unit
from proof.observe.record import DocumentRecords


@pytest.fixture(scope="module")
def manifest():
    return manifest_usage.load_manifest()


@pytest.mark.parametrize("document", cases.document_params() + cases.control_params("manifest"))
def test_every_item_novas_exports_use_is_classified(document, hq, core_runner, editor_driver):
    records = observations.records_for(document, core_runner, editor_driver=editor_driver)
    found = manifest_usage.manifest_differences(document, records)
    reads = manifest_usage.flag_reads(document, records)
    cases.hold("manifest", document, found, cases.load_register(), flags=sorted(reads))


def _uses(found):
    return {(use.key, use.where) for use in found.uses}


def _keys(found):
    return {use.key for use in found.uses}


BASELINE = {
    ("schema:Application", "/"),
    ("schema:Application.domain", "/domain"),
    ("schema:Application.name", "/name"),
    ("schema:Application.modules", "/modules"),
    # ModuleBase.wrap dispatches the Module by its doc_type; Module.forms declares Form itself.
    ("schema:Module", "/modules/0"),
    ("schema:Module.name", "/modules/0/name"),
    ("schema:Module.forms", "/modules/0/forms"),
    ("schema:Form.name", "/modules/0/forms/0/name"),
}


def test_a_schema_field_is_used_exactly_where_hqs_own_model_writes_another_value(hq, manifest):
    """An app HQ's own model builds: only the fields the test sets are used, and setting one more uses it."""
    from corehq.apps.app_manager.models import Application, Form, Module

    app = Application(domain="nova-proof", name="Defaults")
    module = Module(name={"en": "Menu"})
    module.forms.append(Form(name={"en": "Form"}))
    app.modules.append(module)
    found = manifest_usage.Uses()
    manifest_usage.app_json_uses(app.to_json(), manifest, "app.json", found)
    assert _uses(found) == BASELINE

    module.case_type = "patient"
    changed = app.to_json()
    changed["modules"][0]["forms"][0]["surprise"] = True
    found = manifest_usage.Uses()
    manifest_usage.app_json_uses(changed, manifest, "app.json", found)
    # A key Form does not declare uses Form's undeclared-key item (jsonobject keeps it as a dynamic property),
    # the key itself kept in where it is used.
    assert _uses(found) - BASELINE == {
        ("schema:Module.case_type", "/modules/0/case_type"),
        ("schema:Form.<undeclared>", "/modules/0/forms/0/surprise"),
    }
    assert "schema:Form.surprise" not in manifest.items


def test_values_the_schemas_slots_name_are_used_by_value(hq, manifest):
    from corehq.apps.app_manager.models import (
        Application,
        CaseSearch,
        CaseSearchProperty,
        DefaultCaseSearchProperty,
        DetailColumn,
        Module,
    )

    app = Application(domain="nova-proof", name="Values")
    module = Module(name={"en": "Menu"}, case_type="patient")
    columns = module.case_details.short.columns
    columns.append(DetailColumn(header={"en": "Name"}, field="name", format="plain"))
    columns.append(DetailColumn(header={"en": "Place"}, field="location:district", format="plain"))
    columns.append(DetailColumn(header={"en": "Calc"}, field="if(a, 'b:c', '')", useXpathExpression=True))
    columns.append(DetailColumn(header={"en": "Own"}, field="name", format="calculate"))
    module.search_config = CaseSearch(
        properties=[
            CaseSearchProperty(name="dob", input_="date"),
            CaseSearchProperty(name="owner_id", appearance="barcode_scan"),
        ],
        default_properties=[
            DefaultCaseSearchProperty(property="_xpath_query", defaultValue="'match-all()'"),
            DefaultCaseSearchProperty(property="indices.parent", defaultValue="'x'"),
            DefaultCaseSearchProperty(property="region", defaultValue="'north'"),
        ],
    )
    app.modules.append(module)
    doc = app.to_json()
    doc["add_ons"] = {"calc_xpaths": True, "subcases": False}
    doc["profile"] = {
        "properties": {"cc-show-saved": "no", "brand-banner-web-apps": "jr://file/b.png", "unheard-of": "1"},
        "features": {"users": "true"},
        "custom_properties": {"cc-index-case-search-results": "yes"},
    }
    doc["multimedia_map"] = {"jr://file/b.png": {"doc_type": "HQMediaMapItem", "media_type": "CommCareImage"}}
    found = manifest_usage.Uses()
    manifest_usage.app_json_uses(doc, manifest, "app.json", found)
    keys = _keys(found)
    assert {
        "format:plain",
        "add-on:calc_xpaths",
        "setting:features.users",
        "media-class:CommCareImage",
        # HQ registers no class for a slug its table does not hold, and builds it with the fallback.
        "format:<unregistered>",
        # A custom property is a profile property HQ's profile writes as it is.
        "profile-property:cc-index-case-search-results",
        # HQ's settings hold cc-show-saved; HQ's profile writes brand-banner-web-apps itself; neither holds the
        # third, which keeps the settings spelling and no item.
        "setting:properties.cc-show-saved",
        "profile-property:brand-banner-web-apps",
        "setting:properties.unheard-of",
        # DetailColumn.field_type: the field's prefix, or "property".
        "detail-field-type:property",
        "detail-field-type:location",
        # The keys HQ's search reads as its own, a prompt's input and appearance.
        "csql-key:_xpath_query",
        "csql-key:indices.*",
        "csql-key:owner_id",
        "prompt-input:date",
        "prompt-appearance:barcode_scan",
    } <= keys
    assert "add-on:subcases" not in keys  # an add-on turned off is not used
    assert "format:calculate" not in keys and "format:calculate" not in manifest.items
    assert "setting:properties.brand-banner-web-apps" not in keys
    assert "setting:properties.unheard-of" not in manifest.items
    # A calculated column's field is an expression, not a typed field; a case property's key is the app's data.
    assert not {key for key in keys if key.startswith("detail-field-type:if")}
    assert not {"csql-key:region", "csql-key:dob"} & keys
    # The _xpath_query's expression is kept for HQ's CSQL parser.
    assert [(where, text) for _, where, text in found.csql] == [
        ("/modules/0/search_config/default_properties/0/defaultValue", "'match-all()'")
    ]


FORM = b"""<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml"
 xmlns:jr="http://openrosa.org/javarosa" xmlns:xsd="http://www.w3.org/2001/XMLSchema"
 xmlns:vellum="http://commcarehq.org/xforms/vellum">
 <h:head><h:title>Visit</h:title><model>
  <instance><data xmlns="http://example.org/visit" name="Visit"><q/><g><r/></g><input/></data></instance>
  <instance id="casedb" src="jr://instance/casedb"/>
  <instance id="commcaresession" src="jr://instance/session"/>
  <bind nodeset="/data/q" type="xsd:int" constraint=". &gt; count(instance('casedb')/casedb/case[selected(@x, 'y')])"
        jr:constraintMsg="Must be (positive)" vellum:nodeset="#form/q"/>
  <bind nodeset="/data/g/r" type="barcode" relevant="if(true(), jr:choice-name(/data/q, '/data/q') != '', 0)"/>
  <setvalue ref="/data/q" value="today()" event="xforms-ready jr-insert"/>
  <setvalue ref="/data/g/r" event="xforms-ready" value="concat(instance('commcaresession')/session/context/deviceid,
     instance('commcaresession')/session/data/case_id, here())"/>
  <itext><translation lang="en" default=""><text id="q"><value>Q</value><value form="markdown">**Q**</value>
  </text></translation></itext>
 </model>
 <vellum:hashtags>{"#case/dob": null, "#case/parent/edd": null}</vellum:hashtags>
 <vellum:hashtagTransforms>{"prefixes": {"#case/": "instance('casedb')/casedb/case"}}</vellum:hashtagTransforms>
 </h:head>
 <h:body>
  <input ref="/data/q" appearance="numeric minimal frobnicate">
   <label ref="jr:itext('q')"><output value="/data/q"/></label></input>
  <group ref="/data/g"><label>G</label><vellum:comment>H</vellum:comment>
   <input ref="/data/g/r"><label>R</label></input></group>
 </h:body></h:html>"""


def _readings(core_runner, **artifacts):
    """What HQ's and Core's readers make of the artifacts, as the observation records it."""
    return manifest_usage.Readings.of(observed_manifest.readings(core_runner, **artifacts))


def _read(core_runner, manifest, read, **artifacts):
    found = manifest_usage.Uses()
    read(found)
    manifest_usage.read_observed(found, manifest, _readings(core_runner, **artifacts))
    return found


def test_an_xform_uses_what_cores_parser_and_hqs_reader_read_and_its_answer_data_is_not_vocabulary(
    hq, manifest, core_runner
):
    found = _read(
        core_runner,
        manifest,
        lambda found: manifest_usage.xform_uses(FORM, manifest, "form:0.0", found),
        forms=[FORM],
    )
    keys = _keys(found)
    uses = _uses(found)
    # XFormParser.parseElement: the body's input, the group and, through parseGroup, its label and its input;
    # an input's own label is the input's, not a control.
    controls = sorted(where for key, where in uses if key == "jr-control:input")
    assert controls == ["/h:html/h:body[1]/group[1]/input[1]", "/h:html/h:body[1]/input[1]"]
    assert ("jr-control:label", "/h:html/h:body[1]/group[1]/label[1]") in uses
    assert not any(key == "jr-control:label" and where.endswith("input[1]/label[1]") for key, where in uses)
    assert {"jr-control:model", "jr-control:title", "jr-control:group"} <= keys
    # Bind types as XFormParser.getDataType reads them, with or without a prefix; actions and their events.
    assert {
        "jr-type:int",
        "jr-type:barcode",
        "jr-action:setvalue",
        "jr-event:xforms-ready",
        "jr-event:jr-insert",
    } <= keys
    # Functions through Core's parser, inside predicates and arguments; instance() is a path root, not a call,
    # and the constraint message and the itext label reference are not expressions Core parses. A function Core
    # builds as a custom runtime function that a runtime's handler answers is that handler's.
    functions = {key for key in keys if key.startswith(("jr-fn:", "jr-handler:"))}
    assert functions == {
        "jr-fn:count",
        "jr-fn:selected",
        "jr-fn:if",
        "jr-fn:true",
        "jr-fn:today",
        "jr-fn:concat",
        "jr-handler:jr:choice-name",
        "jr-handler:here",
    }
    assert found.roots == {"instance"}
    # Paths through the session instance, by the surface's items (a datum's id is any step there).
    assert {"session-path:session/context/deviceid", "session-path:session/data/*"} <= keys
    # Each instance's source by Core's dispatch; a form's instance ids are no scheme HQ's build reads.
    assert {"instance-source:casedb", "instance-source:session"} <= keys
    assert not {key for key in keys if key.startswith("instance-scheme:")}
    # Vellum's hashtags, each as the longest hashtag the surface holds that it starts with.
    assert {key for key in keys if key.startswith("hashtag:")} == {"hashtag:#case/", "hashtag:#case/parent"}
    # Question types as HQ's own reader types them (xform.py::_infer_vellum_type), and a form whose questions
    # HQ's reader refuses (a group's hint with no ref) is a use no item holds.
    assert {("mug:Int", "/data/q"), ("mug:Barcode", "/data/g/r"), ("mug:Group", "/data/g")} <= uses
    hinted = FORM.replace(b"<label>G</label>", b"<label>G</label><hint>H</hint>")
    assert set(observed_manifest.question_types(hinted)) == {"unreadable"}
    unread = manifest_usage.Uses()
    manifest_usage.question_type_uses(hinted, "f", unread)
    manifest_usage.read_observed(unread, manifest, _readings(core_runner, forms=[hinted]))
    assert [use.key for use in unread.uses] == ["mug:(unreadable)"]
    # The grammar Core's parser builds, the head of an instance path being part of its path.
    assert {
        "xpath-expr:XPathCmpExpr",
        "xpath-expr:XPathPathExpr",
        "xpath-axis:AXIS_SELF",
        "xpath-axis:AXIS_ATTRIBUTE",
        "xpath-test:TEST_TYPE_NODE",
        "xpath-token:GT",
        "xpath-token:LBRACK",
    } <= keys
    assert "xpath-expr:XPathFilterExpr" not in keys
    # Appearance tokens by each reader's own rule, and a token no reader reads.
    assert {"appearance:web-apps/numeric", "appearance:web-apps/minimal"} <= keys
    # Android reads numeric and minimal only as the whole appearance (WidgetFactory.buildBasicWidget, buildSelectOne).
    assert not {"appearance:android/numeric", "appearance:android/minimal"} & keys
    assert "appearance:*/frobnicate" in keys and "appearance:*/numeric" not in keys
    # The XForm vocabulary, each element and attribute as the surface keys it: a dispatched element by its
    # handler table's name, whatever its namespace (h:title is title), attributes whatever family also
    # classifies their value, and the namespaces Core reads.
    assert {
        "xform:title",
        "xform:input",
        "xform:input@appearance",
        "xform:input/label/output",
        "xform:model/bind@nodeset",
        "xform:model/bind@type",
        "xform:model/bind@jr:constraintMsg",
        "xform:model/instance/*",
        "xform:model/instance/*@xmlns",
        "xform:setvalue@event",
        "xform:model/itext/translation/text/value",
        "xform:model/itext/translation/text/value@form",
        "xform:group/*@xmlns",
    } <= keys
    # Core reads a model child's namespace only for one no name test takes, and an <instance>'s only where it
    # stands for its own data; every model child here is a bind, a setvalue, an instance or the itext.
    assert not {"xform:model/*@xmlns", "xform:model/instance@xmlns"} & keys
    # A group's child no group-level handler takes is the surface's "any element" there, and Core reads its
    # namespace (XFormParser.parseElement, for an element no handler takes); a handled child's it does not.
    assert ("xform:group/*", "/h:html/h:body[1]/group[1]/vellum:comment[1]") in uses
    assert {where for key, where in uses if key == "xform:group/*@xmlns"} == {
        "/h:html/h:body[1]/group[1]/vellum:comment[1]/namespace()"
    }
    # Every piece of the XForm vocabulary resolves to an item, HQ's data-root name among them; Vellum's own
    # markup is keyed by what Vellum's parser asks of each element.
    assert {key for key in keys if key.startswith("xform:") and key not in manifest.items} == set()
    assert manifest.items["xform:model/instance/*@name"]["readBy"] == ["hq"]
    markup = {key for key in keys if key.startswith("vellum-markup:")}
    assert markup == {
        "vellum-markup:bind@vellum:nodeset",
        "vellum-markup:h:head/vellum:hashtags",
        "vellum-markup:h:head/vellum:hashtagTransforms",
        "vellum-markup:group/vellum:comment",
    }
    # Vellum's parser asks for the first three; nothing of it looks for a vellum:comment element in a group.
    assert {key for key in markup if key not in manifest.items} == {"vellum-markup:group/vellum:comment"}
    # Answer data is the app's: the data root's children are instance nodes Core walks
    # (XFormParser.buildInstanceStructure), keyed by the instance content's item, never by the app's own names.
    assert {key for key in keys if key.startswith("xform:model/instance/*/")} == {"xform:model/instance/*/*"}
    # An itext value's form is classified by value too: each runtime's item for it, or one no runtime reads.
    readers = {key for key in manifest.items if key.startswith("itext-form:") and key.endswith("/markdown")}
    assert {key for key in keys if key.startswith("itext-form:")} == (readers or {"itext-form:*/markdown"})
    assert not any(key.startswith("xform:h:") for key in keys)  # the wrappers XFormParser passes over


REPEATED = b"""<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml"
 xmlns:jr="http://openrosa.org/javarosa" xmlns:x="http://example.org/elsewhere">
 <h:head><h:title>R</h:title><model>
  <instance><data xmlns="http://example.org/r" name="R" version="1"><visits jr:template=""><note/></visits>
   <case xmlns="http://commcarehq.org/case/transaction/v2" case_id="" date_modified="" user_id="">
   <update><note/></update></case></data></instance>
  <bind nodeset="/data/visits/note" type="string"/><frob/><x:thing/>
 </model></h:head>
 <h:body><repeat nodeset="/data/visits"><input ref="/data/visits/note"><x:label>N</x:label></input></repeat></h:body>
</h:html>"""


def test_an_instances_content_is_read_at_every_depth_by_what_core_reads_there(manifest):
    """XFormParser.buildInstanceStructure and loadInstanceData walk every node of an instance: each node, its
    namespace and the attributes Core reads by name there (jr:template) are used, at any depth; the other
    attributes of its content are answer data (a case block's case_id), while the data root's are vocabulary."""
    found = manifest_usage.Uses()
    manifest_usage.xform_uses(REPEATED, manifest, "form:0.0", found)

    def wheres(key):
        return {use.where for use in found.uses if use.key == key}

    # The data root's children, and every node below them.
    children = wheres("xform:model/instance/*/*")
    assert {"r}visits[1]", "v2}case[1]"} <= {where.rsplit("/", 1)[-1] for where in children}
    below = wheres("xform:model/instance//*")
    assert any(where.endswith("}visits[1]/{http://example.org/r}note[1]") for where in below)
    assert any(where.endswith("v2}update[1]") for where in below)
    assert wheres("xform:model/instance/*/*@jr:template") and all(
        where.endswith("/@jr:template") for where in wheres("xform:model/instance/*/*@jr:template")
    )
    assert any(where.endswith("/namespace()") for where in wheres("xform:model/instance//*@xmlns"))
    # Answer data is the app's; the data root's attributes are vocabulary, an item or not.
    keys = {use.key for use in found.uses}
    assert not {key for key in keys if key.endswith(("@case_id", "@date_modified", "@user_id"))}
    assert {"xform:model/instance/*@version", "xform:model/instance/*@name"} <= keys


INLINE_INSTANCE = b"""<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml">
 <h:head><h:title>I</h:title><model>
  <instance><data xmlns="http://example.org/i" name="I"><q/></data></instance>
  <instance id="inline"/>
  <instance id="casedb" src="jr://instance/casedb"/>
 </model></h:head><h:body><input ref="/data/q"/></h:body></h:html>"""


def test_core_reads_an_instances_own_namespace_only_where_it_stands_for_its_own_data(manifest):
    """XFormParser.saveInstanceNode takes an ``<instance>`` itself as its node where it holds no element child,
    and parseInstance then reads that node's namespace for a main instance or one without ``src`` (the
    item's ``when``: childless and first, or childless and without src): a childless inline instance's own
    namespace is read, a childless instance with a ``src`` and one holding its data root are not."""
    found = manifest_usage.Uses()
    manifest_usage.xform_uses(INLINE_INSTANCE, manifest, "form:0.0", found)
    reads = {use.where for use in found.uses if use.key == "xform:model/instance@xmlns"}
    assert reads == {"/h:html/h:head[1]/model[1]/instance[2]/namespace()"}


def test_a_bare_step_matches_any_namespace_unless_its_item_names_one(manifest):
    """A name test compares the local name alone (XFormParser.parseElement, getLabel), so a label in another
    namespace is an input's label; an item that names the namespace Core tests (xform:model/*, the XForms
    namespace) takes no element of another."""
    found = manifest_usage.Uses()
    manifest_usage.xform_uses(REPEATED, manifest, "form:0.0", found)
    keys = {use.key for use in found.uses}
    assert "xform:input/label" in keys
    assert not [key for key in keys if "elsewhere}label" in key]
    assert "xform:model/*" in keys  # the XForms namespace's <frob/>
    assert "xform:model/{http://example.org/elsewhere}thing" in keys
    assert (
        manifest_usage.xform_candidates(
            manifest, ["model", "{http://example.org/elsewhere}thing"], "http://example.org/elsewhere"
        )
        == []
    )


APPEARANCES = b"""<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml">
 <h:head><h:title>A</h:title><model>
  <instance><data xmlns="http://example.org/a" name="A"><g><s/><m/><t/><b/><d/></g></data></instance>
  <bind nodeset="/data/g/b" type="barcode"/><bind nodeset="/data/g/d" type="xsd:date"/>
 </model></h:head>
 <h:body><group ref="/data/g" appearance="field-list">
  <select1 ref="/data/g/s" appearance="compact-2"><item><value>a</value></item></select1>
  <select ref="/data/g/m" appearance="compact-2"><item><value>a</value></item></select>
  <input ref="/data/g/t" appearance="editable"/>
  <input ref="/data/g/b" appearance="editable"/>
  <input ref="/data/g/d" appearance="field-list"/>
 </group></h:body></h:html>"""


def test_an_appearance_is_used_only_on_the_elements_its_reader_reads(manifest):
    """Android's ``-`` and ``compact`` are a select's grid (WidgetFactory.buildCompactSelectOne, buildSelectMulti),
    ``editable`` a barcode's (BarcodeWidget, under buildBasicWidget's barcode case), and Core's ``field-list`` a
    group's (FormEntryController.isHostWithAppearance), as the surface records each read: a group's ``field-list``
    is Core's and no select's ``-``, and a token no reader reads on its element is ``appearance:*/<token>`` there."""
    found = manifest_usage.Uses()
    manifest_usage.xform_uses(APPEARANCES, manifest, "form:0.0", found)
    on = {}
    for use in found.uses:
        if use.key.startswith("appearance:"):
            on.setdefault(use.where.rsplit("/", 2)[-2], set()).add(use.key)
    assert on == {
        "group[1]": {"appearance:core/field-list"},
        "select1[1]": {"appearance:android/compact", "appearance:android/-"},
        "select[1]": {"appearance:android/compact", "appearance:android/-"},
        "input[1]": {"appearance:*/editable"},  # untyped: Android's plain text widget reads no appearance
        "input[2]": {"appearance:android/editable"},
        "input[3]": {"appearance:*/field-list"},
    }


def test_the_judge_spells_a_name_in_a_key_as_the_extractor_does():
    """The judge and the extractor each keep their own percent-encoding of a name in a key (their code is
    keyed apart: proof/store/fingerprints.py, proof/lane/extraction.py); a key the judge spells otherwise than
    the surface names no item."""
    from proof.surface.families.data import name

    for text in ("CommCare App Name", "cc-app-version", "100%", "tab\there", "plain"):
        assert manifest_usage.key_name(text) == name(text)


def test_a_ui_string_is_used_where_a_runtime_reads_it(manifest):
    """An app strings id is a use where the surface records a runtime reading it (readBy), by the id or a prefix
    a runtime reads ids under; an id only HQ's catalogs hold is the app's own text."""
    assert not manifest.items["ui-string:Back"].get("readBy")
    found = manifest_usage.Uses()
    strings = b"Back=Return\napp.display.name=Clinic\nandroid.package.name.org.example.tool=Tool\n"
    manifest_usage.archive_uses({"default/app_strings.txt": strings}, manifest, "local.ccz", found)
    assert _uses(found) == {
        ("ui-string:app.display.name", "app.display.name"),
        ("ui-string:android.package.name.*", "android.package.name.org.example.tool"),
    }


def _runtime(xml, root_parser, manifest, core_runner, artifact="suite.xml"):
    def read(found):
        manifest_usage.runtime_xml_uses(xml, root_parser, manifest, artifact, found)

    return _read(core_runner, manifest, read, runtimes=[xml])


def test_a_suite_hq_built_walks_cores_parser_graph(hq, manifest, core_runner):
    """HQ's own build of Core's test app: each element named by the parser Core hands it to."""
    suite = read_archive_entry(BASIC_APP, "suite.xml")
    keys = _keys(_runtime(suite, "SuiteParser", manifest, core_runner))
    assert {
        "parser:SuiteParser/suite",
        "parser:SuiteParser/entry",
        "parser:EntryParser/command@id",
        "parser:ResourceParser/resource@id",
        "parser:SessionDatumParser/datum@nodeset",
        "parser:DetailParser/detail@id",
        "parser:DetailFieldParser/field",
        "parser:TextParser/locale@id",
        "parser:GraphParser/series@nodeset",
        "instance-source:casedb",
        "instance-scheme:casedb",
        "jr-fn:current",
    } - keys == {"jr-fn:current"}  # current() roots a path; it is grammar, not a call
    # Every element and attribute of HQ's build is one a Core parser reads, but the descriptor HQ's suite model
    # writes on <suite>, which no Core parser reads (SuiteParser.parse reads only its version): its item says so.
    unknown = sorted(key for key in keys if key not in manifest.items and key.startswith("parser:"))
    assert unknown == []
    descriptor = manifest.items["parser:SuiteParser/suite@descriptor"]
    assert descriptor["readBy"] == [] and {write["value"] for write in descriptor["hqWrites"]} >= {"Suite File"}
    # A suite's grammar is read where Core parses the attribute as XPath (a datum's nodeset), and an id never is.
    assert manifest.items["parser:SessionDatumParser/datum@nodeset"]["parsedAs"] == ["xpath"]
    assert "parsedAs" not in manifest.items["parser:EntryParser/command@id"]
    uses = _uses(_runtime(suite, "SuiteParser", manifest, core_runner))
    nodesets = {where for key, where in uses if key == "parser:SessionDatumParser/datum@nodeset"}
    grammar = {where for key, where in uses if key.startswith("xpath-")}
    assert nodesets and nodesets <= grammar
    commands = {where for key, where in uses if key == "parser:EntryParser/command@id"}
    assert commands and not commands & grammar

    # An attribute no Core parser reads is used as named, and its value is never evaluated, so it calls nothing.
    surprised = suite.replace(b"<entry>", b'<entry surprise="frobnicate(1)">', 1)
    assert _keys(_runtime(surprised, "SuiteParser", manifest, core_runner)) - keys == {
        "parser:EntryParser/entry@surprise"
    }


SEARCH = b"""<suite version="1"><remote-request>
 <post url="https://example.org/claim" relevant="true()">
  <data key="case_id" ref="instance('commcaresession')/session/data/search_case_id"/></post>
 <command id="search_command.m0"><display><text><locale id="s"/></text></display></command>
 <instance id="commcaresession" src="jr://instance/session"/>
 <instance id="search-input:results" src="jr://instance/search-input/results"/>
 <session><query url="https://example.org/search" storage-instance="results" template="case" default_search="false">
  <data key="case_type" ref="'patient'"/>
  <data key="_xpath_query" ref="if(count(instance('search-input:results')/input/field[@name='first_name']),
   concat('first_name = &quot;', instance('search-input:results')/input/field[@name='first_name'],
   '&quot; and @status = &quot;open&quot;'), 'within-distance(location, &quot;0 0&quot;, 5, &quot;miles&quot;)')"/>
  <data key="_xpath_query" ref="'broken ( query'"/>
  <data key="x_commcare_include_all_related_cases" ref="'true'"/>
  <prompt key="first_name" input="select1" appearance="barcode_scan">
   <display><text><locale id="p"/></text></display></prompt>
  <prompt key="owner_id"><display><text><locale id="o"/></text></display></prompt>
 </query>
 <datum id="search_case_id" nodeset="instance('results')/results/case" value="./@case_id"/></session>
 <stack/></remote-request></suite>"""


def test_a_search_uses_its_keys_its_prompts_and_the_csql_it_can_send(hq, manifest, core_runner):
    found = _runtime(SEARCH, "SuiteParser", manifest, core_runner)
    keys = _keys(found)
    # The query keys HQ's search reads as its own (a prompt named like one is HQ's too); a prompt naming a case
    # property, and the claim's own parameter, are not search keys.
    assert {key for key in keys if key.startswith("csql-key:")} == {
        "csql-key:case_type",
        "csql-key:_xpath_query",
        "csql-key:x_commcare_include_all_related_cases",
        "csql-key:owner_id",
    }
    assert {"prompt-input:select1", "prompt-appearance:barcode_scan"} <= keys
    # The CSQL each branch of the _xpath_query sends, read by HQ's own CSQL parser: the input's value is a hole.
    csql = {key for key in keys if key.startswith(("csql-fn:", "csql-op:", "csql-metadata:", "csql-unit:"))}
    assert csql == {
        "csql-op:=",
        "csql-op:and",
        "csql-metadata:@status",
        "csql-fn:within-distance",
        "csql-unit:miles",
    }
    # A query none of whose strings HQ's parser reads is a use no item holds.
    unparsed = {(use.key, use.where) for use in found.uses if use.key == "csql:(unparsed)"}
    assert unparsed == {("csql:(unparsed)", "/suite/remote-request[1]/session[1]/query[1]/data[3]/@ref")}
    # The suite's instances: Core's source for each, HQ's scheme for each id; the session paths it reads.
    assert {
        "instance-source:session",
        "instance-source:jr://instance/search-input",
        "instance-scheme:commcaresession",
        "instance-scheme:search-input",
        "session-path:session/data/*",
    } <= keys


STACK_QUERY = b"""<suite version="1"><entry><form>http://example.org/f</form>
 <command id="m0-f0"><text><locale id="f"/></text></command>
 <instance id="commcaresession" src="jr://instance/session"/>
 <session><datum id="case_id_new_patient_0" function="uuid()"/></session>
 <stack><create><command value="'m0'"/>
  <query id="results:inline" value="https://www.commcarehq.org/a/demo/phone/case_fixture/__APP_ID__/">
   <data key="case_type" ref="'patient'"/>
   <data key="case_id" ref="instance('commcaresession')/session/data/case_id_new_patient_0"/>
   <data key="surprise" ref="'x'"/>
  </query></create></stack></entry></suite>"""


def test_a_stack_query_is_a_request_to_the_case_fixture_view_not_a_search(hq, manifest, core_runner):
    """HQ's build points the stack query that reloads a search's chosen case at /phone/case_fixture/
    (suite_xml/post_process/workflow.py::WorkflowQueryMeta.to_stack_datum), which ota/views.py::case_fixture
    answers: its keys are that view's parameters, never search keys, and a key the view never reads is one no
    item holds."""
    found = _runtime(STACK_QUERY, "SuiteParser", manifest, core_runner)
    uses = _uses(found)
    assert not {key for key, _ in uses if key.startswith("csql-key:")}
    assert ("hq-api:case_fixture", "/suite/entry[1]/stack[1]/create[1]/query[1]/@value") in uses
    keyed = {
        where.rsplit("/", 2)[-2]: key for key, where in uses if where.endswith("/@key") and key.startswith("hq-api:")
    }
    assert keyed == {
        "data[1]": "hq-api:case_fixture",
        "data[2]": "hq-api:case_fixture",
        "data[3]": "hq-api:case_fixture/surprise",
    }
    assert {"GET.case_id", "GET.case_type"} <= set(manifest.items["hq-api:case_fixture"]["requestReads"])
    assert manifest_usage.endpoint_key(manifest, "https://example.org/nowhere/") == "hq-api:(unresolved)"


def test_the_csql_strings_are_each_branchs_over_the_expressions_literals(core_runner):
    """The runner's xpathStrings op: concat() combines its arguments' strings, if() gives either branch's, and
    any other value is the hole; a number literal is the text Core's string() gives it."""
    result = core_runner.request(
        "xpathStrings",
        deadline=60.0,
        hole="H",
        expressions=["if(/a = 1, concat('x = ', /v, ' and y = ', 2), 'match-all()')", "/v", "'one'", "1 +"],
    )["results"]
    assert result[0] == {"strings": ["match-all()", "x = H and y = 2"], "truncated": False}
    assert result[1] == {"strings": ["H"], "truncated": False}
    assert result[2] == {"strings": ["one"], "truncated": False}
    assert "error" in result[3]


def test_one_element_two_parsers_read_is_named_by_each(manifest):
    """DetailFieldParser.parseStyle hands one style element to StyleParser, then GridParser reads its grid."""
    suite = b"""<suite version="1"><detail id="m0_case_short"><title><text><locale id="t"/></text></title>
      <field><style font-size="small"><grid grid-x="0" grid-y="0" grid-width="1" grid-height="1"/></style>
      <header><text><locale id="h"/></text></header><template><text><xpath function="name"/></text></template>
      </field></detail></suite>"""
    found = manifest_usage.Uses()
    manifest_usage.runtime_xml_uses(suite, "SuiteParser", manifest, "suite.xml", found)
    keys = _keys(found)
    assert {"parser:StyleParser/style@font-size", "parser:GridParser/grid", "parser:GridParser/grid@grid-x"} <= keys
    assert all(key in manifest.items for key in keys)


def test_a_profile_is_text_to_core_so_its_values_call_nothing(manifest, core_runner):
    profile = b"""<profile xmlns="http://cihi.commcarehq.org/jad" version="1" uniqueid="u" name="Inline(1) visits"
      update="http://localhost/update"><property key="cc-show-saved" value="no"/><property key="Shown(2)" value="x"/>
      <property key="brand-banner-home" value="jr://file/b.png"/><features><users active="true"/></features>
      </profile>"""
    keys = _keys(_runtime(profile, "ProfileParser", manifest, core_runner, "profile.ccpr"))
    assert not any(key.startswith(("jr-fn:", "xpath-")) for key in keys)
    assert {
        "setting:properties.cc-show-saved",
        "setting:properties.Shown(2)",
        "profile-property:brand-banner-home",
        "setting:features.users",
    } <= keys
    # A property only Nova's local profile sets is the surface's authored item, its key spelled as the surface's.
    named = _keys(
        _runtime(
            b'<profile version="1"><property key="CommCare App Name" value="Clinic"/></profile>',
            "ProfileParser",
            manifest,
            core_runner,
            "profile.ccpr",
        )
    )
    assert "profile-property:CommCare%20App%20Name" in named
    assert manifest.items["profile-property:CommCare%20App%20Name"]["authored"] is True
    assert {"parser:ProfileParser/profile@name", "parser:ProfileParser/property@key"} <= keys


def _local_records(document, core_runner):
    """A document's records holding only what the manifest observation reads with its local part."""
    records = DocumentRecords(document.id, document.kind)
    ctx = unit.LocalContext(document, unit.local_archives(document), core_runner, records.blobs)
    records.local = {"kind": "local", "hooks": {"manifest": observed_manifest.observe_local(ctx)}}
    return records


def test_each_local_archive_is_its_own_artifact(tmp_path, hq, manifest, core_runner):
    """Two local exports of one document are two artifacts: a use only the second makes is the second's."""
    root = tmp_path / "two-archives"
    root.mkdir()
    for name, appearance in (("local.ccz", b"minimal"), ("local-again.ccz", b"minimal frobnicate")):
        with zipfile.ZipFile(root / name, "w") as archive:
            archive.writestr("modules-0/forms-0.xml", FORM.replace(b"numeric minimal frobnicate", appearance))
            archive.writestr("media/logo.png", b"not read")
    document = Document(id="two-archives", source="test", root=root)
    records = _local_records(document, core_runner)
    # The observation keeps the entries the manifest reads, and no others.
    held = records.local["hooks"]["manifest"]["archives"]
    assert {name: sorted(entries) for name, entries in held.items()} == {
        "local.ccz": ["modules-0/forms-0.xml"],
        "local-again.ccz": ["modules-0/forms-0.xml"],
    }
    found = manifest_usage.export_uses(document, records, manifest)
    frobnicated = {use.artifact for use in found.uses if use.key == "appearance:*/frobnicate"}
    assert frobnicated == {"local-again.ccz/form:0.0"}
    assert {use.artifact for use in found.uses} == {"local.ccz/form:0.0", "local-again.ccz/form:0.0"}


def test_the_ui_strings_an_app_overrides_are_used_and_its_own_text_is_not(manifest):
    """An app strings id a runtime reads as its own UI string is used; the app's own ids (HQ's id_strings
    families) are its text. Read with HQ's reader of the format, which strips comments."""
    assert "ui-string:app.display.name" in manifest.items and "ui-string:forms.m0f0" not in manifest.items
    strings = b"# app.comment=x\napp.display.name=Clinic\nforms.m0f0=Register\n"
    found = manifest_usage.Uses()
    manifest_usage.archive_uses({"default/app_strings.txt": strings}, manifest, "local.ccz", found)
    assert _uses(found) == {("ui-string:app.display.name", "app.display.name")}

    overridden = manifest_usage.Uses()
    doc = {"doc_type": "Application", "translations": {"en": {"app.display.name": "Clinic", "my.own": "x"}}}
    manifest_usage.app_json_uses(doc, manifest, "app.json", overridden)
    assert ("ui-string:app.display.name", "/translations/en/app.display.name") in _uses(overridden)
    assert not [use for use in overridden.uses if use.key == "ui-string:my.own"]


def test_a_use_no_entry_names_is_one_difference_per_artifact_and_key(manifest):
    # A key only allowing entries name, so every use of it is held.
    named = next(
        key
        for key, entries in sorted(manifest.entries.items())
        if all(entry.disposition != "REFUSED" for entry in entries)
    )
    unnamed = next(key for key in sorted(manifest.items) if key not in manifest.entries)
    uses = [
        manifest_usage.Use(named, "app.json", "/a"),
        manifest_usage.Use(unnamed, "app.json", "/b"),
        manifest_usage.Use(unnamed, "app.json", "/c"),
        manifest_usage.Use(unnamed, "local.ccz/suite.xml", "/d"),
        manifest_usage.Use("jr-fn:frobnicate", "form:0.0", "/e"),
    ]
    found = manifest_usage.unclassified("doc", uses, manifest)
    assert [(d.artifact, d.path, d.after["surfaceItem"], d.after["uses"]) for d in found] == [
        ("app.json", f"/{pointer_token(unnamed)}", True, 2),
        ("form:0.0", "/jr-fn:frobnicate", False, 1),
        ("local.ccz/suite.xml", f"/{pointer_token(unnamed)}", True, 1),
    ]


def _flag_records(*, b_build=("CASE_LIST_TILE",)):
    """One configuration's records: A's build read CASE_LIST_TILE; B's build read ``b_build``; B aligned built and
    read SYNC_SEARCH_CASE_CLAIM; B-edit is B's. A and B also carry ``flagReads``, the reads of each part's import
    and build together (as the unit once recorded them: the import's save reads PROJECT_DB and its media mapping
    CAUTIOUS_MULTIMEDIA), which the judge must not take for the build's."""
    from types import SimpleNamespace

    from proof.observe.record import ConfigurationRecords, DocumentRecords

    records = DocumentRecords("doc", "corpus")
    imports = ["CAUTIOUS_MULTIMEDIA", "PROJECT_DB"]
    b = {"kind": "b", "state": {}, "flagReads": imports}
    if b_build is not None:
        b["flagsReadByBuild"] = list(b_build)
    records.configurations["minimum"] = ConfigurationRecords(
        "minimum",
        {},
        a={"kind": "a", "state": {}, "flagsReadByBuild": ["CASE_LIST_TILE"], "flagReads": [*imports, "CASE_LIST_TILE"]},
        b=b,
        b_aligned={"kind": "b_aligned", "aligned": {}, "flagsReadByBuild": ["SYNC_SEARCH_CASE_CLAIM"]},
        b_edit={"same_as": "b"},
    )
    exports = {"minimum": object()}
    document = SimpleNamespace(id="doc", exports=exports, edit=SimpleNamespace(exports=exports))
    return document, records


def test_only_the_flags_hq_reads_while_building_are_gates():
    """Decision 8 and work item 11 hold the flags HQ reads while it builds an export. The judge takes them from each
    built part's ``flagsReadByBuild`` alone (A's, B's, B aligned's and B-edit's), which the unit counts over HQ's
    build of the state (proof/observe/unit.py::_build), never from a record of what the part's import read too:
    PROJECT_DB (project_db/signals.py::_sync_domain, from the import's save) and CAUTIOUS_MULTIMEDIA (the import's
    _update_valid_domains_for_media) are no gate. The corpus test runs the unit's count end to end."""
    document, records = _flag_records(b_build=("CASE_LIST_TILE", "USH_EMPTY_CASE_LIST_TEXT"))
    assert manifest_usage.flag_reads(document, records) == {
        "CASE_LIST_TILE": ["minimum", "edit/minimum"],
        "SYNC_SEARCH_CASE_CLAIM": ["minimum"],
        "USH_EMPTY_CASE_LIST_TEXT": ["minimum", "edit/minimum"],
    }
    # A built part whose record does not count its build's reads apart is refused, not read as none.
    document, records = _flag_records(b_build=None)
    with pytest.raises(manifest_usage.ObservationMissing, match="flagsReadByBuild"):
        manifest_usage.flag_reads(document, records)


def _built(entries, readers=None):
    """A manifest whose entries are ``entries`` ({key: [(id, disposition, value class, reasons)]}) and whose
    value class readers are ``readers`` ({entry id: reader})."""
    held = {key: tuple(sorted(manifest_usage.Entry(*entry) for entry in listed)) for key, listed in entries.items()}
    return manifest_usage.Manifest({}, frozenset(), {}, held, readers or {})


def _placed(*verdicts):
    """A reader that gives each use the verdict its ``where`` names (``where`` is the verdict's index)."""
    return lambda use, manifest: verdicts[int(use.where)]


EDITOR = ("not-hq-editable",)
RUNTIME = ("broken-at-runtime",)
BUILD = ("not-hq-buildable",)


def test_an_entry_holds_only_the_uses_its_value_class_takes():
    """A use a REFUSED class takes is refused; one a REFUSED class may take, its reader not saying (or the check
    holding none), is undecided under that class; an allowing class holds every use no REFUSED class takes;
    and a use of a key only REFUSED classes name, each ruling it out, is unheld. A REFUSED entry with no value
    class takes every use of its keys."""
    refusing = ("questions/refusing", "REFUSED", "refused-class", EDITOR)
    allowing = ("questions/allowing", "HELD", "held-class")
    unread = ("questions/unread", "REFUSED", "unread-class", EDITOR)
    whole = ("questions/whole", "REFUSED", None, EDITOR)
    entries = {
        "jr-type:int": [refusing, allowing],
        "jr-type:date": [refusing, unread, allowing],
        "jr-type:time": [refusing],
    }
    # The refusing class's reader: in it, outside it, does not say.
    built = _built(entries, {"questions/refusing": _placed(True, False, None)})

    def standing(key, where):
        kind, held = manifest_usage.standing(built, manifest_usage.Use(key, "form:0.0", str(where)))
        return kind, [entry.value_class for entry in held]

    assert [standing("jr-type:int", where) for where in range(3)] == [
        (manifest_usage.REFUSED, ["refused-class"]),
        # Outside the refused class, so in the rest of the key's values: the allowing class's.
        (manifest_usage.HELD, []),
        (manifest_usage.UNDECIDED, ["refused-class"]),
    ]
    # A REFUSED class the check reads nothing of leaves every use it does not see refused undecided under it.
    assert [standing("jr-type:date", where) for where in range(3)] == [
        (manifest_usage.REFUSED, ["refused-class"]),
        (manifest_usage.UNDECIDED, ["unread-class"]),
        (manifest_usage.UNDECIDED, ["refused-class", "unread-class"]),
    ]
    assert standing("jr-type:time", 1) == (manifest_usage.UNHELD, ["refused-class"])
    whole_built = _built({"jr-type:long": [whole, allowing]}, {})
    assert manifest_usage.standing(whole_built, manifest_usage.Use("jr-type:long", "form:0.0", "1"))[0] == (
        manifest_usage.REFUSED
    )
    assert manifest_usage.standing(built, manifest_usage.Use("jr-type:string", "form:0.0", "0"))[0] == (
        manifest_usage.UNNAMED
    )


def test_the_bar_and_the_local_archives_take_their_refusals_from_the_entries_reasons():
    """A REFUSED entry refused only because HQ's build refuses the state refuses nothing here: an export in it fails
    HQ's build, which the bar reports. In a local archive Nova built, only a REFUSED entry refused for what
    a runtime does refuses; one refused for how HQ's editors hold the source is judged on the app JSON."""
    entries = {
        "jr-action:setvalue": [
            ("questions/editor", "REFUSED", "editor-class", EDITOR),
            ("questions/runtime", "REFUSED", "runtime-class", RUNTIME),
            ("questions/build", "REFUSED", "build-class", BUILD),
            ("questions/held", "HELD", "held-class"),
        ]
    }
    always = {
        "questions/editor": lambda use, manifest: True,
        "questions/runtime": lambda use, manifest: use.where == "runtime",
        "questions/build": lambda use, manifest: True,
    }
    built = _built(entries, always)

    def standing(artifact, where):
        kind, held = manifest_usage.standing(built, manifest_usage.Use("jr-action:setvalue", artifact, where))
        return kind, [entry.value_class for entry in held]

    assert standing("form:0.0", "editor") == (manifest_usage.REFUSED, ["editor-class"])
    assert standing("local.ccz/form:0.0", "editor") == (manifest_usage.HELD, [])
    assert standing("edit/local.ccz/form:0.0", "runtime") == (manifest_usage.REFUSED, ["runtime-class"])
    assert standing("form:0.0", "runtime") == (manifest_usage.REFUSED, ["editor-class", "runtime-class"])
    assert manifest_usage.is_build("local-again.ccz/suite.xml") and not manifest_usage.is_build("edit/app.json")


def test_a_use_no_entry_refuses_where_it_sits_stands_by_where_its_class_is_judged():
    """A key only the bar's entries name is the bar's: every use of it is an export HQ's build refuses, which the bar
    reports. In a local archive, a key named only by entries refused for how HQ's editors treat the source still has
    its uses placed by their classes: one an editor class takes is the source's (the same choice in the app JSON is
    refused there), one none takes is the build's own and unheld, and one a class may take is undecided."""
    built = _built(
        {
            "schema:OpenCaseAction.conflicts": [("forms-and-case-writes/conflicts", "REFUSED", "non-empty", BUILD)],
            "jr-event:xforms-revalidate": [("questions/form-level", "REFUSED", "form-level-setvalue", EDITOR)],
        },
        {"questions/form-level": _placed(True, False, None)},
    )

    def standing(key, artifact, where="0"):
        kind, held = manifest_usage.standing(built, manifest_usage.Use(key, artifact, where))
        return kind, [entry.value_class for entry in held]

    assert standing("schema:OpenCaseAction.conflicts", "app.json") == (manifest_usage.BAR, ["non-empty"])
    archive = "local.ccz/form:0.0"
    assert [standing("jr-event:xforms-revalidate", archive, where) for where in "012"] == [
        (manifest_usage.SOURCE, ["form-level-setvalue"]),  # an authored setvalue, refused on the source
        (manifest_usage.UNHELD, ["form-level-setvalue"]),  # HQ's build's own timeEnd: no entry holds it
        (manifest_usage.UNDECIDED, ["form-level-setvalue"]),
    ]
    assert [standing("jr-event:xforms-revalidate", "form:0.0", where)[0] for where in "01"] == [
        manifest_usage.REFUSED,
        manifest_usage.UNHELD,
    ]
    found = manifest_usage.unclassified(
        "doc",
        [
            manifest_usage.Use("schema:OpenCaseAction.conflicts", "app.json", "0"),
            manifest_usage.Use("jr-event:xforms-revalidate", archive, "0"),
            manifest_usage.Use("jr-event:xforms-revalidate", archive, "1"),
        ],
        built,
    )
    assert [(d.artifact, d.path) for d in found] == [(archive, "/jr-event:xforms-revalidate/unheld")]


def test_each_standing_is_its_own_class_named_by_its_value_class():
    """One difference per (artifact, path): a refused or undecided use once per class that takes it, named in
    the path; an unheld use once, resting on every entry; an unnamed key alone."""
    head = ("questions/head-children", "REFUSED", "head-child", EDITOR)
    form_level = ("questions/form-level", "REFUSED", "form-level-setvalue", EDITOR)
    nested = ("questions/nested", "REFUSED", "action-nested-in-control", EDITOR)
    entries = {
        "jr-control:model": [head],
        "jr-action:setvalue": [form_level, nested, ("questions/default", "HELD", "default-value")],
    }
    readers = {
        "questions/head-children": lambda use, manifest: False,
        "questions/form-level": lambda use, manifest: use.where != "/c",
        "questions/nested": lambda use, manifest: True if use.where == "/a" else None,
        "questions/default": lambda use, manifest: False,
    }
    found = manifest_usage.unclassified(
        "doc",
        [
            manifest_usage.Use("jr-control:model", "form:0.0", "/h:html/h:head[1]/model[1]"),
            manifest_usage.Use("jr-action:setvalue", "form:0.0", "/a"),
            manifest_usage.Use("jr-action:setvalue", "form:0.0", "/b"),
            manifest_usage.Use("jr-action:setvalue", "form:0.0", "/c"),
            manifest_usage.Use("jr-fn:frobnicate", "form:0.0", "/d"),
        ],
        _built(entries, readers),
    )
    assert [(d.path, d.after["uses"], [e["id"] for e in d.after.get("entries", [])]) for d in found] == [
        ("/jr-action:setvalue/refused/action-nested-in-control", 1, ["questions/nested"]),
        ("/jr-action:setvalue/refused/form-level-setvalue", 2, ["questions/form-level"]),
        ("/jr-action:setvalue/undecided/action-nested-in-control", 1, ["questions/nested"]),
        ("/jr-control:model/unheld", 1, ["questions/head-children"]),
        ("/jr-fn:frobnicate", 1, []),
    ]


def test_a_flag_hq_reads_needs_a_gate_entry(manifest):
    gated = next(key.split(":", 1)[1] for key in sorted(manifest.gated) if key.startswith("toggle:"))
    ungated = next(
        key.split(":", 1)[1]
        for key in sorted(manifest.items)
        if key.startswith("toggle:") and key not in manifest.gated
    )
    found = manifest_usage.ungated("doc", {gated: ["minimum"], ungated: ["minimum", "maximum"]}, manifest)
    assert [(d.artifact, d.path, d.after["configurations"]) for d in found] == [
        ("flags", f"/toggle:{ungated}", ["maximum", "minimum"])
    ]
    preview = next(key.split(":", 1)[1] for key in sorted(manifest.items) if key.startswith("feature-preview:"))
    assert manifest_usage.flag_key(preview, manifest) == f"feature-preview:{preview}"


def test_the_surfaces_matching_rules_choose_one_item(manifest):
    """Each reader's rule as the surface records it: Core's instance dispatch in its order (a lookup table
    whose tag holds casedb is read as the case database, defect 5), HQ's instance schemes, the most specific
    session path and XForm item, and the longest hashtag."""
    assert manifest_usage.instance_source(manifest, "jr://fixture/item-list:casedb_regions") == (
        "instance-source:casedb"
    )
    assert manifest_usage.instance_source(manifest, "jr://fixture/item-list:regions") == "instance-source:fixture"
    assert manifest_usage.instance_source(manifest, "jr://elsewhere") == "instance-source:(none)"
    assert [manifest_usage.instance_scheme(i) for i in ("item-list:regions", "casedb", "my_selected_cases")] == [
        "item-list",
        "casedb",
        "selected_cases",
    ]
    assert manifest_usage.session_path_key(manifest, ["session", "data", "case_id"]) == "session-path:session/data/*"
    assert manifest_usage.session_path_key(manifest, ["session", "data", "stringquery"]) == (
        "session-path:session/data/stringquery"
    )
    assert manifest_usage.session_path_key(manifest, ["session", "elsewhere"]) == "session-path:session/elsewhere"
    assert manifest_usage.xform_candidates(manifest, ["input", "label", "output"])[0] == "xform:input/label/output"
    assert "xform:input/label//output" in manifest_usage.xform_candidates(manifest, ["input", "label", "b", "output"])
    assert manifest_usage.hashtag_key(manifest, "#case/parent/edd") == "hashtag:#case/parent"
    assert manifest_usage.hashtag_key(manifest, "#nowhere/x") == "hashtag:#nowhere/x"
    assert manifest_usage.search_key(manifest, "region") is None


# The observation and the judge ----------------------------------------------------------


def test_the_observation_reads_every_attribute_so_a_surface_naming_another_expression_is_judged_again(
    hq, manifest, core_runner
):
    """The observation reads every attribute value through Core's parser, not only those today's surface marks
    as XPath, so a surface that marks one more is judged from the same records: the itext reference in a
    label, which no item marks, uses what Core's parser builds of it once its item says Core parses it."""
    readings = _readings(core_runner, forms=[FORM])

    def walk(surface):
        found = manifest_usage.Uses()
        manifest_usage.xform_uses(FORM, surface, "form:0.0", found)
        manifest_usage.read_observed(found, surface, readings)
        return found

    found = walk(manifest)
    (label,) = [use.key for use in found.uses if use.where.endswith("/input[1]/label[1]/@ref")]
    assert "xpath" not in (manifest.items[label].get("parsedAs") or ())
    items = {**manifest.items, label: {**manifest.items[label], "parsedAs": ["xpath"]}}
    marked = manifest_usage.Manifest(items, manifest.gated, manifest.parsers, manifest.entries)
    added = {(use.key, use.where) for use in walk(marked).uses} - {(use.key, use.where) for use in found.uses}
    assert {key for key, where in added if where.endswith("/label[1]/@ref")} >= {
        manifest_usage.function_key(manifest, "jr:itext", True)
    }
    # What the observation never read is refused, not passed over.
    unread = manifest_usage.Uses()
    unread.expression("form:0.0", "/x", "count(/data/never-read)")
    with pytest.raises(manifest_usage.ObservationMissing, match="never-read"):
        manifest_usage.read_observed(unread, manifest, readings)


def test_cores_refusal_of_a_text_is_recorded_by_its_class_alone(core_runner):
    """Core's parse errors name parser nodes by their JVM identity hash, which differs from run to run, so a
    record keeps the exception's class: a refused text is ``{"error": <class>}``, an accepted one its parse."""
    table = observed_manifest.readings(core_runner, runtimes=[b'<suite><x a="1 +" b="count(/a)"/></suite>'])
    refused, accepted = table["expressions"]["1 +"], table["expressions"]["count(/a)"]
    assert set(refused) == {"error"} and ":" not in refused["error"] and "@" not in refused["error"]
    assert accepted["functions"] == ["count"]


# Each captured publish request in a document's directory (``proof/checks/corpus.py``: a request's body and the
# sidecar naming its content type), by the corpus layout: D's create and republish, and D′'s update.
PUBLISHES = ("export/*/create", "export/*/republish", "edit/export/*/update")


def test_each_publish_the_observation_reads_keys_the_local_part(tmp_path):
    """The local part's key covers every publish the manifest observation reads: a byte more in any captured
    request's body or sidecar, each local archive unchanged (a change to Nova's HQ JSON alone, say), keys the
    part anew, so it is observed again; the copy as it is keeps the document's key."""
    from proof.checks.test_judge_purity import _cheapest_edited

    source = _cheapest_edited()
    root = tmp_path / source.id
    shutil.copytree(source.root, root)
    # A copy's inputs are computed from its files (unit.document_inputs), as the corpus writes them.
    (root / "inputs.json").unlink()

    def keyed(document):
        inputs = unit.document_inputs(document)
        return inputs["local"], unit.local_key(inputs, unit.hook_inputs(document))

    def copied():
        return keyed(Document(id=source.id, source="test", root=root))

    # The copy as it is keys as the corpus's document does: the key names no place.
    archives, key = keyed(source)
    assert copied() == (archives, key)
    published = sorted(
        path for request in PUBLISHES for suffix in (".body", ".json") for path in root.glob(request + suffix)
    )
    edited = [path for path in published if path.relative_to(root).parts[0] == "edit"]
    assert edited and len(published) > len(edited), f"{source.id} lacks D's or D′'s publishes: {published}"
    unkeyed = []
    for path in published:
        original = path.read_bytes()
        path.write_bytes(original + b"\n")
        try:
            changed_archives, changed = copied()
        finally:
            path.write_bytes(original)
        assert changed_archives == archives, path
        if changed == key:
            unkeyed.append(path.relative_to(root).as_posix())
    assert unkeyed == [], f"A change to {unkeyed} leaves the local part's key as it was."


JUDGMENT = """
import json, sys
from proof.checks import manifest_usage
from proof.checks.corpus import load, corpus_root
from proof.observe.record import DocumentRecords

records = DocumentRecords.load(sys.argv[2])
document = load(corpus_root()).document(sys.argv[3])
judged = manifest_usage.manifest_differences(document, records)
print(json.dumps(sorted(json.dumps(d.as_json(), sort_keys=True) for d in judged)))
"""


def test_the_judge_gives_records_read_back_where_hq_cannot_be_imported_what_it_gives_them_here(
    hq, core_runner, editor_driver, tmp_path
):
    """The manifest judge reads records alone: in a process that refuses HQ, over records written to disk and
    read back, it finds what it finds here."""
    from proof.checks.test_judge_purity import _cheapest_edited, _refusing

    document = _cheapest_edited("manifest")
    records = observations.records_for(document, core_runner, editor_driver=editor_driver)
    here = sorted(
        json.dumps(d.as_json(), sort_keys=True) for d in manifest_usage.manifest_differences(document, records)
    )
    ran = _refusing(JUDGMENT, str(records.save(tmp_path / "records")), document.id)
    assert ran.returncode == 0, ran.stderr
    assert json.loads(ran.stdout) == here
    assert here, f"{document.id} gives the manifest judge no difference, so nothing is compared."
