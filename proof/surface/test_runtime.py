"""JavaRosa's XForm vocabulary, the suite and profile parsers, and appearance tokens.

Contracts and the failures they catch:
- Every name ``buildFuncExpr`` switches on is a ``jr-fn`` item with the class
  it builds. The extractor reads the switch with JavaParser; the test asks
  Core's own XPath parser what it builds for a call of each name, so a label
  the pass misses or a fall-through it misreads (``selected`` builds what
  ``is-selected`` builds) fails. A name no label holds parses as a custom
  function, which the paired control shows.
- Each name's argument counts are those Core's parser accepts: for a class
  that leaves the check to ``XPathFuncExpr``, exactly its
  ``EXPECTED_ARG_COUNT`` (read by reflection); for one with its own check, the
  counts its source states (``substr`` two or three, ``uuid`` and
  ``position`` none or one). An extractor that records ``-1`` or the declared
  count alone fails.
- Parser attributes sit on the element Core reads them from: ``@if`` on
  each stack operation (not on ``<stack>``, where the operation parser is
  constructed), a datum's attributes on the three elements its guard allows,
  a callout's on ``<lookup>``, and ``<instance>``'s ``id`` and ``src`` in
  entries and menus, read by the static helper ``ParseInstance.parseInstance``.
  No key names an element the pass could not tell.
- A planted case label, planted parser attribute reads (in a parser, and in
  the static helper it hands the XML parser to) and planted appearance
  comparisons (Android, reached through a helper's parameter; Web Apps,
  through a script's method call and through a template's Knockout binding)
  in temporary copies of the sources are each read, and the unplanted sources
  do not have them.
- An appearance read names the elements whose appearance it compares, as the
  runtime's source decides them: Android's ``-`` and ``compact`` (a grid's
  column count, ``WidgetFactory.buildCompactSelectOne``, ``buildSelectMulti``)
  are a single and a multiple select's alone, ``editable`` a barcode's (its
  data type's case in ``buildBasicWidget``), ``numeric`` an input's or a
  secret's (the input's case falls through into the secret's) and ``intent:``
  an input's (read before it falls through), while a widget built in the
  default case too (``short``) and Web Apps' reads take any; Core's
  ``field-list`` is a group's (a ``GroupDef``'s). The failure: a read applied
  to every element, so a group's ``field-list`` reads as Android's select
  ``-`` and the manifest check holds what no reader reads. The planted helper
  reached from the single select's builder is a single select's.
- An attribute HQ's suite model writes on ``<suite>`` and no Core parser
  reads (``descriptor``; ``SuiteParser`` reads only ``version`` there) is an
  item that says so, with the values HQ's generators write, read from HQ's
  own classes after the boot.
- Restore-side parsers are not in the surface while ``FixtureXmlParser`` (a
  suite's ``<fixture>``) is, and Android's registrations and extension parsers
  are recorded with the element each attribute is read on.
- An attribute whose value reaches Core's XPath parser as an expression of its
  own says ``parsedAs: xpath``, and no other does: an id, a path or a profile's
  text never is, and neither is a value Core parses only in a branch the
  object's constants rule out (a query step's URL, a locale text's id) or one
  written into a longer expression (a prompt key in a path). The failures: a
  manifest that reads every attribute as an expression (ids would add grammar
  Core never builds), or misses one Core parses (its functions go
  unclassified). A planted read parsed whole, one parsed as a whole function
  argument, and one only concatenated into a path, in a temporary copy, are
  read as such.
"""

from __future__ import annotations

import dataclasses

from proof.surface.families.runtime import FORM_ENTRY, FORM_ENTRY_TEMPLATES, javarosa, parsers, web_apps
from proof.surface.java import run_java

FUNCTION_SOURCE = "src/main/java/org/javarosa/xpath/parser/ast/ASTNodeFunctionCall.java"
JAVAROSA_CORE = (
    "src/main/java/org/javarosa/xpath/parser/ast",
    "src/main/java/org/javarosa/xform/parse",
    "src/main/java/org/javarosa/core/model",
)
JAVAROSA_ANDROID = (
    "app/src/org/commcare/android/resource/installers",
    "app/src/org/commcare/android/javarosa",
    "app/src/org/commcare/engine/extensions",
)
PARSERS_CORE = (
    "src/main/java/org/commcare/xml",
    "src/main/java/org/commcare/data/xml",
    "src/main/java/org/javarosa/xml",
    "src/main/java/org/commcare/resources/model/installers",
)
PARSERS_ANDROID = ("app/src/org/commcare/xml", "app/src/org/commcare/android/resource/installers")


def test_function_names_build_what_cores_parser_builds(items, sources):
    functions = {key.split(":", 1)[1]: facts for key, facts in items.items() if key.startswith("jr-fn:")}
    built = run_java(sources, "parse-functions", extra=[*functions, "surface-unknown-function"])
    assert {name: built[name]["class"] for name in functions} == {name: f["class"] for name, f in functions.items()}
    assert functions["selected"]["class"] == functions["is-selected"]["class"]
    assert built["surface-unknown-function"]["class"] == "XPathCustomRuntimeFunc"
    for name, facts in functions.items():
        if not built[name]["validatesOwnArgCount"]:
            assert facts["acceptedArgCounts"] == [built[name]["expectedArgCount"]], name
    assert functions["substr"]["acceptedArgCounts"] == [2, 3]
    assert functions["uuid"]["acceptedArgCounts"] == [0, 1]
    assert functions["position"]["acceptedArgCounts"] == [0, 1]


def test_xform_tables_and_android_registrations(items):
    assert items["jr-type:geopoint"]["datatypes"] == ["DATATYPE_GEOPOINT"]
    assert items["jr-control:select1"]["core"] == {"calls": "parseControl", "passes": ["Constants.CONTROL_SELECT_ONE"]}
    assert items["jr-control:intent"]["android"] == {"handler": "IntentExtensionParser"}
    assert items["jr-control:intent"]["core"] is None
    assert items["jr-action:pollsensor"]["android"] == {"handler": "PollSensorExtensionParser"}
    intent = items["jr-extension:IntentExtensionParser"]
    assert intent["element"] == "intent"
    assert intent["attributes"]["intent/extra"] == intent["attributes"]["intent/response"] == ["key", "ref"]
    assert "appearance" in intent["attributes"]["intent"]
    assert items["jr-extension:UploadQuestionExtensionParser"]["attributes"] == {
        "upload": ["{http://openrosa.org/javarosa}imageDimensionScaledMax"]
    }
    assert [key for key in items if key.startswith("jr-event:")] == [
        "jr-event:jr-insert",
        "jr-event:xforms-ready",
        "jr-event:xforms-revalidate",
        "jr-event:xforms-value-changed",
    ]


def test_the_function_pass_reads_a_planted_label(plant, sources, items):
    core = plant(
        sources.core,
        list(JAVAROSA_CORE),
        {FUNCTION_SOURCE: ('case "count":', 'case "planted-fn":\n            case "count":')},
    )
    android = plant(sources.android, list(JAVAROSA_ANDROID), {})
    planted = {i.key: i.facts for i in javarosa(sources, core, android)}
    assert planted["jr-fn:planted-fn"]["class"] == planted["jr-fn:count"]["class"] == "XPathCountFunc"
    assert "jr-fn:planted-fn" not in items


def test_parsers_are_those_an_app_installs_through(items):
    installed = {key for key, facts in items.items() if key.startswith("parser:") and facts.get("installed")}
    assert installed == {"parser:SuiteParser", "parser:ProfileParser", "parser:AndroidSuiteParser"}
    assert "parser:FixtureXmlParser/fixture@id" in items
    assert "parser:CaseXmlParser" not in items and "parser:LedgerXmlParsers" not in items
    assert "parser:DetailFieldParser/field@sort" in items
    assert items["parser:SuiteParser/entry"]["match"] == ["lowercased"]


def test_parser_attributes_sit_on_the_element_core_reads_them_from(items):
    parser_keys = [key for key in items if key.startswith("parser:")]
    assert not [key for key in parser_keys if "?" in key or "|" in key]
    for operation in ("create", "push", "clear"):
        assert f"parser:StackOpParser/{operation}@if" in items
    assert "parser:StackOpParser/stack@if" not in items
    for element in ("datum", "form", "instance-datum"):
        assert f"parser:SessionDatumParser/{element}@nodeset" in items
    assert "parser:CalloutParser/lookup@action" in items
    for parser in ("EntryParser", "MenuParser"):
        assert f"parser:{parser}/instance@id" in items and f"parser:{parser}/instance@src" in items
    assert "parser:StackFrameStepParser/datum@value" in items
    assert "parser:StackFrameStepParser/create@value" not in items


def test_the_parser_pass_reads_a_planted_attribute(plant, sources, items):
    detail_field = "src/main/java/org/commcare/xml/DetailFieldParser.java"
    core = plant(
        sources.core,
        list(PARSERS_CORE),
        {
            detail_field: (
                'String printId = parser.getAttributeValue(null, "print-id");',
                'String printId = parser.getAttributeValue(null, "print-id");\n'
                '        String planted = parser.getAttributeValue(null, "planted-attribute");',
            )
        },
    )
    android = plant(sources.android, list(PARSERS_ANDROID), {})
    assert "parser:DetailFieldParser/field@planted-attribute" in {i.key for i in parsers(sources, core, android)}
    assert "parser:DetailFieldParser/field@planted-attribute" not in items


def test_the_parser_pass_follows_the_xml_parser_into_a_static_helper(plant, sources, items):
    helper = "src/main/java/org/commcare/xml/ParseInstance.java"
    core = plant(
        sources.core,
        list(PARSERS_CORE),
        {
            helper: (
                'String location = parser.getAttributeValue(null, "src");',
                'String location = parser.getAttributeValue(null, "src");\n'
                '        String planted = parser.getAttributeValue(null, "planted");',
            )
        },
    )
    android = plant(sources.android, list(PARSERS_ANDROID), {})
    keys = {i.key for i in parsers(sources, core, android)}
    assert "parser:EntryParser/instance@planted" in keys and "parser:MenuParser/instance@planted" in keys
    assert "parser:EntryParser/instance@planted" not in items


def test_appearance_tokens(items):
    assert items["appearance:android/minimal"]["reads"][0]["match"] == "whole"
    assert {read["case"] for read in items["appearance:android/numeric"]["reads"]} == {"ignore-case"}
    assert {read["case"] for read in items["appearance:android/gregorian"]["reads"]} == {"lowercased"}
    # Reached only by value flow: a constructor parameter, a Bundle key, a getter over an enum's constants.
    assert "appearance:android/editable" in items
    assert "appearance:android/long" in items
    assert "appearance:android/floating-good" in items
    assert {read["case"] for read in items["appearance:core/field-list"]["reads"]} == {"ignore-case"}
    # An intent's own appearance attribute is not the question's.
    assert "appearance:android-IntentExtensionParser/quick" in items
    assert items["appearance:web-apps/minimal"]["reads"][0]["match"] == 'token split on " "'
    assert "appearance:web-apps/text-align-center" in items


def test_an_appearance_read_names_the_elements_it_reads(items):
    def on(key):
        (read,) = items[key]["reads"]
        return read.get("holders"), read.get("controls"), read.get("datatypes")

    selects = ["CONTROL_SELECT_MULTI", "CONTROL_SELECT_ONE"]
    assert on("appearance:android/-") == (["question"], selects, None)
    assert on("appearance:android/compact") == (["question"], selects, None)
    assert on("appearance:android/combobox") == (["question"], ["CONTROL_SELECT_ONE"], None)
    # A data type's case in buildBasicWidget, reached from the secret's case and the input's that falls into it.
    assert on("appearance:android/editable") == (
        ["question"],
        ["CONTROL_INPUT", "CONTROL_SECRET"],
        ["DATATYPE_BARCODE"],
    )
    assert on("appearance:android/numeric") == (["question"], ["CONTROL_INPUT", "CONTROL_SECRET"], ["DATATYPE_TEXT"])
    # Read in the input's own case, before it falls through.
    assert on("appearance:android/intent:") == (["question"], ["CONTROL_INPUT"], None)
    # A widget the default case builds too reads any question's; Core's field-list is a group's.
    assert on("appearance:android/short") == (["question"], None, None)
    assert on("appearance:core/field-list") == (["group"], None, None)
    assert on("appearance:web-apps/minimal") == (None, None, None)


def test_the_appearance_passes_read_planted_comparisons(plant, sources, hq):
    widget_factory = "app/src/org/commcare/views/widgets/WidgetFactory.java"
    android = plant(
        sources.android,
        ["app/src/org/commcare/views/widgets"],
        {
            widget_factory: (
                'appearance.contains("combobox")) {',
                '(appearance.contains("combobox") || plantedCheck(appearance))) {',
            )
        },
    )
    (android / widget_factory).write_text(
        (android / widget_factory).read_text(encoding="utf-8").rstrip()[:-1]
        + "\n    private static boolean plantedCheck(String given) {\n"
        '        return given.startsWith("planted-prefix");\n    }\n}\n',
        encoding="utf-8",
    )
    core = plant(sources.core, ["src/main/java/org/javarosa/form/api"], {})
    reads = run_java(sources, "appearances", core, android)["reads"]
    planted = [read for read in reads if read["token"] == "planted-prefix"]
    assert planted and planted[0]["match"] == "prefix" and planted[0]["reader"] == "android"
    # Reached from buildSelectOne, which only the single select's case calls.
    assert planted[0]["controls"] == ["CONTROL_SELECT_ONE"]

    entries = f"{FORM_ENTRY}/entries.js"
    question = f"{FORM_ENTRY_TEMPLATES}/question.html"
    hq_root = plant(
        sources.hq,
        [FORM_ENTRY, FORM_ENTRY_TEMPLATES],
        {
            entries: (
                "isMinimal = question.stylesContains(constants.MINIMAL);\n            isCombobox",
                "isMinimal = question.stylesContains('planted-style');\n            isCombobox",
            ),
            question: (
                "'text-end': isButton && stylesContains('text-align-right'),",
                "'text-end': isButton && stylesContains('text-align-right'),\n"
                "                'planted': stylesContains('planted-template-style'),",
            ),
        },
    )
    planted_sources = dataclasses.replace(sources, hq=hq_root)
    tokens = {read["token"] for read in web_apps(planted_sources, hq_root / FORM_ENTRY, hq_root / FORM_ENTRY_TEMPLATES)}
    assert {"planted-style", "planted-template-style"} <= tokens
    unplanted = web_apps(sources, sources.hq / FORM_ENTRY, sources.hq / FORM_ENTRY_TEMPLATES)
    assert not {"planted-style", "planted-template-style"} & {read["token"] for read in unplanted}


def test_parser_attributes_core_parses_as_xpath_say_so(items):
    parsed = {
        key for key, facts in items.items() if key.startswith("parser:") and "xpath" in (facts.get("parsedAs") or ())
    }
    # Parsed as the model is built (EntityDatum's nodeset, a stack operation's condition, XPathText's function), and
    # where the session evaluates what the model holds (CommCareSession parses SessionDatum.getValue()).
    assert {
        "parser:SessionDatumParser/datum@nodeset",
        "parser:SessionDatumParser/datum@value",
        "parser:SessionDatumParser/datum@function",
        "parser:StackOpParser/create@if",
        "parser:StackFrameStepParser/datum@value",
        "parser:TextParser/xpath@function",
        "parser:CalloutParser/extra@value",
        "parser:MenuParser/menu@relevant",
    } <= parsed
    # Never an id or a profile's text; nor a query step's URL (StackFrameStep parses its value only where
    # valueIsXpath, which the query step's constructor leaves false), a locale text's id (Text parses its argument
    # only as an XPathText), a callout extra's key (the extras map's keys), or a prompt key written into a path.
    assert (
        not {
            "parser:EntryParser/command@id",
            "parser:SessionDatumParser/datum@id",
            "parser:StackFrameStepParser/query@value",
            "parser:TextParser/locale@id",
            "parser:CalloutParser/extra@key",
            "parser:SessionDatumParser/prompt@key",
            "parser:ProfileParser/property@value",
        }
        & parsed
    )


def test_the_value_pass_follows_a_planted_read_to_cores_parser(plant, sources, items):
    detail_field = "src/main/java/org/commcare/xml/DetailFieldParser.java"
    core = plant(
        sources.core,
        list(PARSERS_CORE),
        {
            detail_field: (
                'String printId = parser.getAttributeValue(null, "print-id");',
                'String printId = parser.getAttributeValue(null, "print-id");\n'
                '        String whole = parser.getAttributeValue(null, "planted-whole");\n'
                "        XPathParseTool.parseXPath(whole.trim());\n"
                '        String argument = parser.getAttributeValue(null, "planted-argument");\n'
                '        XPathParseTool.parseXPath("string(" + argument + ")");\n'
                '        String step = parser.getAttributeValue(null, "planted-step");\n'
                "        XPathParseTool.parseXPath(\"instance('planted')/\" + step);",
            )
        },
    )
    android = plant(sources.android, list(PARSERS_ANDROID), {})
    planted = {item.key: item.facts for item in parsers(sources, core, android)}
    assert planted["parser:DetailFieldParser/field@planted-whole"]["parsedAs"] == ["xpath"]
    assert planted["parser:DetailFieldParser/field@planted-argument"]["parsedAs"] == ["xpath"]
    assert "parsedAs" not in planted["parser:DetailFieldParser/field@planted-step"]
    assert "parsedAs" not in planted["parser:DetailFieldParser/field@print-id"]
    assert "parser:DetailFieldParser/field@planted-whole" not in items


def test_hq_writes_a_suite_descriptor_no_core_parser_reads(items, hq):
    from corehq.apps.app_manager.suite_xml.generator import MediaSuiteGenerator, SuiteGenerator
    from corehq.apps.app_manager.suite_xml.xml_models import Suite

    descriptor = items["parser:SuiteParser/suite@descriptor"]
    assert descriptor["readBy"] == [] and descriptor["hqField"] == "Suite.descriptor"
    assert Suite._fields["descriptor"].xpath == "@descriptor"
    assert {write["value"] for write in descriptor["hqWrites"]} == {
        SuiteGenerator.descriptor,
        MediaSuiteGenerator.descriptor,
    }
    # SuiteParser reads <suite>'s version, which is its item; HQ's version is not an HQ-written one.
    assert "readBy" not in items["parser:SuiteParser/suite@version"]
