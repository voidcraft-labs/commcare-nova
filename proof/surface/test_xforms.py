"""Core's XForm vocabulary and the itext forms the runtimes read.

Contracts and the failures they catch:
- An attribute the family records as parsed as XPath is one Core's parser
  refuses a malformed expression in, and one it records on one element but
  not another is read only there: Core's own form check (the Core runner's
  validate_form, the check HQ's build asks Formplayer for) refuses ``1 +`` in a
  repeat's ``jr:count``, a bind's ``relevant``, a model ``setvalue``'s
  ``value`` and a control label's ``ref``, and accepts it in a group's
  ``jr:count``, a bind's ``jr:constraintMsg`` and an unknown child of a
  control. An extractor that put ``isRepeat()`` reads on ``group``, missed the
  XPath sink of a value, or invented children fails on one side or the other.
- Every element and attribute is keyed by where Core reads it, with its
  namespace, whose modes are kXML's own answers (a read naming no namespace
  finds an attribute in any; the empty namespace finds only one in none): a
  repeat caption is ``repeat/jr:...``, never a group's; an item and an itemset
  sit under the two select controls only; ``model/instance``'s ``src`` and the
  main instance's namespace are read.
- An element a handler table dispatches, or a name test picks, is matched by
  its local name in any namespace, as its ``namespace`` fact says: Core reads a
  ``bind`` written in a namespace of its own as a bind, refusing a malformed
  ``relevant`` there as it does in the XForms namespace. A ``jr:`` step is one
  whose namespace Core tests.
- Core reads ``jr:template`` on instance nodes at every depth, not only the
  data root: its own check refuses two templates of one repeated node nested
  below the root and accepts one, and the family records ``jr:template`` on a
  path that reaches that depth. A reader that took a flag Core sets in a loop
  for one it never sets (and skipped the recursion it guards) fails.
- A planted attribute read and a planted child test, in a temporary copy of
  ``XFormParser``, are each read at the element they are on; the unplanted
  source does not have them.
- An element's namespace is read under the tests Core made before it reads
  it, and only where its value is used: a model child's in ``parseModel``'s
  last ``else``, after every name test (Core's own check refuses an unknown
  model child in the XForms namespace for that, and no child a test takes);
  a group child's by ``parseElement`` for an element no group-level handler
  takes, while the caption comparison is the repeat's alone (``parseGroup``
  tests ``isRepeat()`` first, so swapping the two in a copy puts it back on
  the group); and an ``<instance>``'s own only where it stands for its own
  data (``saveInstanceNode``'s fallback for one with no element child, then
  parsed as the first or as one without a ``src``): without the fallback in a
  copy, no read of an ``<instance>``'s namespace remains. A reader that took
  every ``getNamespace()`` call for a read, or read the right side of an
  ``&&`` whose left side is false, fails.
- The data root's ``name``, which Core does not read, is an item HQ writes
  (``XForm.set_name``) and reads back from a submission (``XFormInstance.name``):
  HQ's own renaming writes it, and a copy of ``xform.py`` without that write
  has no such item.
- Every itext form constant Core's form entry API declares
  (``FormEntryCaption``'s strings, read by reflection over Core's compiled
  class) is an ``itext-form:core`` item, and a planted Android read of a form
  is an ``itext-form:android`` item.
"""

from __future__ import annotations

import json

from proof.surface.families.xforms import hq_data_root_attributes, itext_forms, xform
from proof.surface.java import run_java

XFORM_DIRS = ("src/main/java/org/javarosa/xform", "src/main/java/org/javarosa/core/model")
ANDROID_DIRS = (
    "app/src/org/commcare/android/resource/installers",
    "app/src/org/commcare/android/javarosa",
    "app/src/org/commcare/engine/extensions",
)
PARSER = "src/main/java/org/javarosa/xform/parse/XFormParser.java"

FORM = """<?xml version="1.0" encoding="UTF-8"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
        xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <h:title>Probe</h:title>
    <model>
      <instance>
        <data xmlns="http://example.org/probe"><q/><r jr:template=""><x/></r></data>
      </instance>
      <bind nodeset="/data/q" type="xsd:string" {bind}/>
      {model}
    </model>
  </h:head>
  <h:body>
    <input ref="/data/q"><label {label}>Q</label>{control}</input>
    <group {group}><label>G</label></group>
    <group><label>R</label><repeat nodeset="/data/r" {repeat}>
      <input ref="/data/r/x"><label>X</label></input>
    </repeat></group>
  </h:body>
</h:html>
"""
SLOTS = ("bind", "model", "label", "control", "group", "repeat")


def validated(core_runner, **slots) -> bool:
    form = FORM.format(**{slot: slots.get(slot, "") for slot in SLOTS})
    return json.loads(core_runner.validate_form(form.encode("utf-8")))["validated"]


def test_cores_own_form_check_agrees_with_what_the_family_reads(items, core_runner):
    malformed = '"1 +"'
    assert validated(core_runner), "The probe form itself must pass Core's check."
    # Read and parsed as XPath: Core refuses a malformed expression there.
    assert items["xform:repeat@jr:count"]["parsedAs"] == ["xpath"]
    assert not validated(core_runner, repeat=f"jr:count={malformed}")
    assert items["xform:model/bind@relevant"]["parsedAs"] == ["xpath"]
    assert not validated(core_runner, bind=f"relevant={malformed}")
    assert items["xform:setvalue@value"]["parsedAs"] == ["xpath"]
    assert not validated(core_runner, model=f'<setvalue event="xforms-ready" ref="/data/q" value={malformed}/>')
    assert "startsWith jr:itext('" in items["xform:input/label@ref"]["compared"]
    assert not validated(core_runner, label='ref="not-itext"')
    # Not read, or read but not as XPath: Core accepts the same text there.
    assert "xform:group@jr:count" not in items
    assert validated(core_runner, group=f"jr:count={malformed}")
    assert "parsedAs" not in items["xform:model/bind@jr:constraintMsg"]
    assert validated(core_runner, bind=f"jr:constraintMsg={malformed}")
    assert not [key for key in items if key.startswith("xform:input/planted")]
    assert validated(core_runner, control=f"<planted ref={malformed}/>")


def test_namespace_modes_are_what_kxml_answers(sources):
    # XFormParser reads `getAttributeValue(null, name)` ("any") and `getAttributeValue("", name)` ("none").
    answered = run_java(sources, "probe", extra=["attribute-namespaces"])
    assert answered["inNamespace"] == {"null": "a", "empty": None, "namespace": "a"}
    assert answered["inNone"] == {"null": "b", "empty": "b", "namespace": None}


def test_elements_and_attributes_sit_where_core_reads_them(items):
    captions = [key for key in items if key.startswith("xform:") and "Caption" in key and "@" not in key]
    assert captions and all(key.startswith("xform:repeat/jr:") for key in captions)
    assert {"xform:select/item", "xform:select1/itemset"} <= set(items)
    assert not [key for key in items if key.startswith(("xform:input/item", "xform:upload/itemset"))]
    assert items["xform:model/bind@jr:preload"]["namespace"] == ["http://openrosa.org/javarosa"]
    assert items["xform:model/bind@id"]["namespace"] == ["none"]
    assert items["xform:model/bind@relevant"]["namespace"] == ["any"]
    assert "xform:model/instance@src" in items and "xform:model/instance/*@xmlns" in items
    assert items["xform:model/submission@method"]["compared"] == ["equals get"]
    assert set(items["xform:upload@mediatype"]["compared"]) >= {"equals image/*", "equals audio/*"}
    assert items["xform:setvalue"]["dispatchedBy"] == ["actionHandlers"]
    assert "model" in items["xform:setvalue"]["dispatchedUnder"]
    assert "xform:intent/extra@key" in items and "xform:upload@jr:imageDimensionScaledMax" in items


def test_a_handled_element_is_read_in_any_namespace(items, core_runner):
    assert items["xform:model/bind"]["namespace"] == ["any"]
    assert (
        items["xform:setvalue"]["namespace"] == ["any"] and "table actionHandlers" in items["xform:setvalue"]["match"]
    )
    assert items["xform:repeat/jr:addCaption"]["namespace"] == ["http://openrosa.org/javarosa"]
    elsewhere = '<bind xmlns="http://example.org/other" nodeset="/data/q" relevant={relevant}/>'
    assert validated(core_runner, model=elsewhere.format(relevant='"true()"'))
    assert not validated(core_runner, model=elsewhere.format(relevant='"1 +"'))


NESTED = """<?xml version="1.0" encoding="UTF-8"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
        xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <h:title>Nested</h:title>
    <model>
      <instance>
        <data xmlns="http://example.org/nested"><g>{templates}</g></data>
      </instance>
    </model>
  </h:head>
  <h:body>
    <group ref="/data/g"><label>G</label><group><label>R</label><repeat nodeset="/data/g/r">
      <input ref="/data/g/r/x"><label>X</label></input>
    </repeat></group></group>
  </h:body>
</h:html>
"""


def _covers(pattern: list[str], steps: list[str]) -> bool:
    """Whether an xform path's steps (``*`` any one element; an empty step, from ``//``, any number of
    elements before the next) reach the concrete steps."""
    if not pattern:
        return not steps
    if pattern[0] == "":
        return any(_covers(pattern[1:], steps[cut:]) for cut in range(len(steps)))
    return bool(steps) and pattern[0] in ("*", steps[0]) and _covers(pattern[1:], steps[1:])


def test_templates_are_read_at_every_depth(items, core_runner):
    one = '<r jr:template=""><x/></r>'

    def nested(templates: str) -> bool:
        form = NESTED.format(templates=templates).encode("utf-8")
        return json.loads(core_runner.validate_form(form))["validated"]

    assert nested(one)
    assert not nested(one + one), "Core refuses two templates of one repeated node below the data root."
    depth = ["model", "instance", "data", "g", "r"]
    reached = [
        key
        for key in items
        if key.startswith("xform:")
        and key.endswith("@jr:template")
        and _covers(key[len("xform:") :].rsplit("@", 1)[0].split("/"), depth)
    ]
    assert reached, "No jr:template item reaches an instance node below the data root."


def test_planted_reads_in_the_parser_are_read(plant, sources, items):
    core = plant(
        sources.core,
        list(XFORM_DIRS),
        {
            PARSER: (
                '        String mediaType = e.getAttributeValue(null, "mediatype");\n',
                '        String mediaType = e.getAttributeValue(null, "mediatype");\n'
                '        String planted = e.getAttributeValue(NAMESPACE_JAVAROSA, "plantedAttribute");\n',
            ),
        },
    )
    # A second plant in the same file: a child the itemset parser tests for.
    text = (core / PARSER).read_text(encoding="utf-8")
    anchor = "            } else if (SORT.equals(childName)) {\n"
    assert text.count(anchor) == 1
    (core / PARSER).write_text(
        text.replace(
            anchor,
            '            } else if ("plantedChild".equals(childName)) {\n'
            '                child.getAttributeValue(null, "plantedRef");\n' + anchor,
        ),
        encoding="utf-8",
    )
    android = plant(sources.android, list(ANDROID_DIRS), {})
    wanted = {"xform:upload@jr:plantedAttribute", "xform:select/itemset/plantedChild@plantedRef"}
    assert wanted <= {one.key for one in xform(sources, core, android)}
    assert not wanted & set(items)


def test_every_form_constant_core_declares_is_read(items, sources):
    declared = run_java(sources, "probe", extra=["text-forms"])
    assert declared, "FormEntryCaption declares no form constants."
    for form in declared:
        assert f"itext-form:core/{form}" in items, form
    assert "itext-form:android/video-inline" in items and "itext-form:android/big-image" in items


def test_a_planted_android_form_read_is_read(plant, sources, items):
    widget = "app/src/org/commcare/views/widgets/QuestionWidget.java"
    android = plant(
        sources.android,
        [widget, "app/assets/locales"],
        {
            widget: (
                'String ttsText = mPrompt.getSpecialFormQuestionText("tts");',
                'String ttsText = mPrompt.getSpecialFormQuestionText("tts");\n'
                '            String planted = mPrompt.getSpecialFormQuestionText("planted-form");',
            )
        },
    )
    core = plant(
        sources.core,
        [
            "src/main/java/org/javarosa/form/api",
            PARSER,
            "src/cli/java/org/commcare/util/screen/ScreenUtils.java",
        ],
        {},
    )
    planted = {one.key for one in itext_forms(sources, core, android)}
    assert "itext-form:android/planted-form" in planted
    assert "itext-form:android/planted-form" not in items


def _report(core_runner, **slots) -> dict:
    form = FORM.format(**{slot: slots.get(slot, "") for slot in SLOTS})
    return json.loads(core_runner.validate_form(form.encode("utf-8")))


UNRECOGNIZED = "Unrecognized top-level tag"


def test_a_model_childs_namespace_is_read_only_after_every_name_test(items, core_runner):
    (tests,) = items["xform:model/*@xmlns"]["when"]
    assert all(test.startswith("not-named:") for test in tests)
    names = {test.split(":", 1)[1] for test in tests}
    # Core's own action handlers: one Android alone registers (pollsensor) leaves Core reading the namespace.
    actions = {key.split(":", 1)[1] for key, facts in items.items() if key.startswith("jr-action:") and facts["core"]}
    assert names == {"itext", "instance", "bind", "submission"} | actions
    android = {
        key.split(":", 1)[1] for key, facts in items.items() if key.startswith("jr-action:") and not facts["core"]
    }
    for name in sorted(android):
        assert UNRECOGNIZED in _report(core_runner, model=f"<{name}/>").get("fatal_error", ""), name
    assert UNRECOGNIZED in _report(core_runner, model="<frob/>").get("fatal_error", "")
    assert UNRECOGNIZED not in _report(core_runner, model='<frob xmlns="http://example.org/other"/>').get(
        "fatal_error", ""
    )
    for name in sorted(names):
        assert UNRECOGNIZED not in _report(core_runner, model=f"<{name}/>").get("fatal_error", ""), name


def test_a_group_childs_namespace_is_read_for_an_element_no_handler_takes(items, plant, sources):
    group = items["xform:group/*@xmlns"]
    assert "compared" not in group
    assert items["xform:repeat/*@xmlns"]["compared"] == ["equals http://openrosa.org/javarosa"]
    assert "when" not in items["xform:repeat/*@xmlns"]
    # Core's own group-level handlers: an element only Android handles (intent) is one Core reads the namespace of.
    handled = {
        key.split(":", 1)[1] for key, facts in items.items() if key.startswith("jr-control:") and facts["inGroups"]
    }
    assert group["when"] == [sorted(f"not-named:{name}" for name in handled)]
    core = plant(
        sources.core,
        list(XFORM_DIRS),
        {
            PARSER: (
                "            if (group.isRepeat() && NAMESPACE_JAVAROSA.equals(childNamespace)) {\n",
                "            if (NAMESPACE_JAVAROSA.equals(childNamespace) && group.isRepeat()) {\n",
            )
        },
    )
    android = plant(sources.android, list(ANDROID_DIRS), {})
    swapped = {one.key: one.facts for one in xform(sources, core, android)}
    assert swapped["xform:group/*@xmlns"]["compared"] == ["equals http://openrosa.org/javarosa"]


# saveInstanceNode's fallback: an <instance> with no element child stands for its own data.
FALLBACK = (
    "        if (instanceNode == null) {\n            //no kids\n            instanceNode = instance;\n        }\n"
)


def test_an_instances_own_namespace_is_read_only_where_it_stands_for_its_data(items, plant, sources):
    assert items["xform:model/instance@xmlns"]["when"] == [["childless", "first"], ["childless", "without:src"]]
    assert items["xform:model/instance/*@xmlns"]["when"] == [["first"], ["without:src"]]
    core = plant(
        sources.core,
        list(XFORM_DIRS),
        {PARSER: (FALLBACK, "")},
    )
    android = plant(sources.android, list(ANDROID_DIRS), {})
    keys = {one.key for one in xform(sources, core, android)}
    assert "xform:model/instance@xmlns" not in keys and "xform:model/instance/*@xmlns" in keys


def test_hq_writes_the_data_roots_name_and_reads_it_back(items, sources, plant, hq):
    from corehq.apps.app_manager.xform import XForm
    from couchforms import const

    item = items["xform:model/instance/*@name"]
    assert item["readBy"] == ["hq"]
    assert item["hqWrites"] == ["commcare-hq/corehq/apps/app_manager/xform.py::XForm.set_name"]
    assert item["hqReads"] == ["commcare-hq/corehq/form_processor/models/forms.py::XFormInstance.name"]
    assert const.TAG_NAME == "@name"
    renamed = XForm(FORM.format(**dict.fromkeys(SLOTS, "")).encode("utf-8"))
    renamed.set_name("Renamed")
    assert renamed.data_node.xml.get("name") == "Renamed"
    # Core reads the data root's version itself, so that attribute is Core's item and not HQ's.
    assert "readBy" not in items["xform:model/instance/*@version"]
    xform_py = "corehq/apps/app_manager/xform.py"
    root = plant(
        sources.hq,
        [xform_py, "corehq/form_processor/models/forms.py", "corehq/ex-submodules/couchforms/const.py"],
        {xform_py: ("            self.data_node.set('name', \"%s\" % new_name)\n", "            pass\n")},
    )
    assert "xform:model/instance/*@name" not in {one.key for one in hq_data_root_attributes(sources, set(), root)}
