"""What CommCare's runtimes read from an app: JavaRosa's XForm vocabulary, the suite and
profile parsers, and the appearance tokens each runtime acts on.

Keys:

- ``jr-fn:<name>``: each case label of Core's
  ``ASTNodeFunctionCall.buildFuncExpr`` (read with JavaParser), with the class
  it builds and the argument counts, from none to twelve, with which Core's
  own XPath parser builds that class (the class's constructor checks the
  count: ``XPathFuncExpr.validateArgCount`` against ``EXPECTED_ARG_COUNT``, or
  the class's own override, such as ``substr``'s two or three). A name no
  label holds parses as a custom function and fails at evaluation.
- ``jr-type:<type>``: each ``type`` a bind may name, from
  ``XFormParser.typeMappings`` (reflection over Core's compiled classes), with
  the ``Constants.DATATYPE_*`` it maps to.
- ``jr-control:<element>``: each body element ``XFormParser`` handles
  (``groupLevelHandlers``, ``topLevelHandlers``), with where it is accepted,
  the parse method its handler calls and the control constants it passes
  (read from the handler's source), and any handler Android registers for it
  (``XFormAndroidInstaller.registerAndroidLevelFormParsers``).
- ``jr-action:<element>``: each action element (``actionHandlers``, and those
  Android registers), with its handler.
- ``jr-event:<event>``: each event ``Action.allEvents`` accepts.
- ``jr-extension:<Parser>``: each extension parser Android adds
  (``XFormExtensionUtils.getAllAndroidExtensionParsers`` and the handlers
  ``registerAndroidLevelFormParsers`` registers), with the element it reads and
  the attributes it reads on that element and on each child it names
  (``intent/extra``), a namespaced attribute written ``{namespace}name``.
- ``parser:<Parser>``: each suite and profile parser Core's and Android's
  installers construct, and every parser those reach, with its platform, the
  class it extends, whether it reads every attribute by position (a fixture's
  tree elements), and the parsers that read its child elements (with the
  element each reads and how the parser reaches it: ``new``, a factory, an
  Android override of a factory, a local or a field holding it).
  Restore-side parsers (cases, ledgers, the user restore) are not reached from
  an installer and are not in the surface; ``FixtureXmlParser`` is, since
  ``SuiteParser`` parses a suite's ``<fixture>`` with it.
- ``parser:<Parser>/<element>``: each element the parser checks or tests for,
  with how the name is matched (``exact``, ``lowercased`` or ``ignore-case``).
- ``parser:<Parser>/<element>@<attribute>``: each attribute the parser reads,
  on the element it is on when it reads it (``parser:DetailFieldParser/field@sort``),
  including reads through a static helper handed the XML parser
  (``parser:EntryParser/instance@id``, read by ``ParseInstance.parseInstance``).
  An attribute read while the parser is on one of several elements is an item
  for each (``parser:StackOpParser/create@if``). ``<element>`` is ``X/*`` only
  for a child of ``X`` whose name no parser tests (a graph template's element,
  ``parser:GraphParser/template/*@type``); an attribute read on an element the
  Java helper cannot name refuses the extraction. ``parsedAs: xpath`` when the
  value it reads reaches Core's XPath parser as an expression of its own
  (``XPathParseTool.parseXPath``, ``XPathReference.getPathExpr``, ``new
  XPathReference``, ``new XPathConditional``), read over Core's and Android's
  whole Java by the Java helper's value flow (``ParserValues``): through
  locals, parameters, returns, collections, the String methods that keep a
  value, the model a parser builds (its constructors, the fields they set and
  the methods that read them, branch by branch on the constants the
  constructor sets: a ``Text`` parses its argument only as ``XPathText``, a
  stack step its value only where ``valueIsXpath``), and once out of the model
  through a getter (the session parsing a datum's value). A value only
  concatenated into a longer expression (a datum id in a session path) is not
  one, and one written as a whole function argument (``"string(" + function +
  ")"``) is.
- ``parser:SuiteParser/suite@<attribute>`` for an attribute no Core parser
  reads (only ``SuiteParser`` reads ``<suite>``'s): each attribute HQ's suite
  model writes on ``<suite>`` (``suite_xml/xml_models.py::Suite``, a field
  whose path is one attribute of the root, read from the model after the boot),
  with ``readBy: []``, the model field, and each value HQ's suite generators
  (``suite_xml/generator.py``) construct the model with (``descriptor="Suite
  File"``), read from their syntax trees.
- ``appearance:<reader>/<token>``: each appearance token a runtime compares a
  question's appearance with, where ``<reader>`` is ``android`` or ``core``
  (read by the Java helper's value flow over Android's and Core's sources),
  ``web-apps`` (read by the JavaScript helper over
  ``cloudcare/js/form_entry`` and the Knockout bindings of its templates), or
  ``android-<Parser>`` for a token compared with an appearance an extension
  parser reads from its own element (an intent's ``appearance="quick"``). Each
  records every read: how it matches (``whole``, ``contains``, ``prefix``,
  ``index``, ``split``, a token of the value split on a separator, or a word at
  a position), its case handling, and where; and, where the Java helper's walk
  tells, the form elements it compares the appearance of: what holds the value
  (``holders``: ``question``, a prompt's, or ``group``, a ``GroupDef``'s), and
  the control types and data types of the questions that reach it
  (``controls``, ``datatypes``: Core's ``Constants`` names, from each switch on
  a prompt's ``getControlType()`` or ``getDataType()`` on the way to the read,
  so Android's ``-`` and ``compact`` reads are a select's and a select1's alone,
  ``WidgetFactory.createWidgetFromPrompt``). A read with none of them reads any
  element's appearance.

Names percent-encode whitespace and ``%`` (``data.name``).
"""

from __future__ import annotations

import ast
import inspect
import json
import tempfile
from html.parser import HTMLParser
from pathlib import Path

from proof.surface import pyast
from proof.surface.families.data import name
from proof.surface.java import run_java
from proof.surface.model import Item, Sources, SurfaceError, item
from proof.surface.node import run_node

FORM_ENTRY = "corehq/apps/cloudcare/static/cloudcare/js/form_entry"
# What a read records of the form elements whose appearance it compares, where the Java helper's walk tells
# (proof/surface/java/.../Appearances.java): what holds the value, and the control and data types of the
# questions that reach it.
READ_ON = ("holders", "controls", "datatypes")
FORM_ENTRY_TEMPLATES = "corehq/apps/cloudcare/templates/cloudcare/partials/form_entry"


def extract(sources: Sources) -> list[Item]:
    read = parsers(sources)
    return [*javarosa(sources), *read, *hq_suite_attributes(sources, {one.key for one in read}), *appearances(sources)]


def javarosa(sources: Sources, core: Path | None = None, android: Path | None = None) -> list[Item]:
    read = run_java(sources, "javarosa", core, android)
    parse_source = "commcare-core/src/main/java/org/javarosa/xform/parse/XFormParser.java"
    functions_source = (
        "commcare-core/src/main/java/org/javarosa/xpath/parser/ast/ASTNodeFunctionCall.java::buildFuncExpr"
    )
    items = [
        item(
            f"jr-fn:{name(f['name'])}",
            functions_source,
            **{"class": f["class"], "acceptedArgCounts": f["acceptedArgCounts"]},
        )
        for f in read["functions"]
    ]
    for type_name, datatypes in sorted(read["types"].items()):
        items.append(item(f"jr-type:{name(type_name)}", f"{parse_source}::typeMappings", datatypes=datatypes))
    android = {}
    for registration in read["android"]:
        if registration["registers"] in ("registerHandler", "registerActionHandler") and registration["key"] is None:
            raise SurfaceError(
                f"Android registers {registration['keyExpression']} with XFormParser ({registration['at']}), and the "
                "surface extractor could not resolve it to a string."
            )
        android.setdefault(registration["registers"], {})[registration["key"]] = registration
    controls = sorted(set(read["groupHandlers"]) | set(read["topHandlers"]) | set(android.get("registerHandler", {})))
    for element in controls:
        registered = android.get("registerHandler", {}).get(element)
        items.append(
            item(
                f"jr-control:{name(element)}",
                ([f"{parse_source}::topLevelHandlers"] if element in read["topHandlers"] else [])
                + ([registered["at"]] if registered else []),
                inGroups=element in read["groupHandlers"],
                atTopLevel=element in read["topHandlers"],
                core=read["topHandlers"].get(element, read["groupHandlers"].get(element)),
                android=None if registered is None else {"handler": registered["value"]},
            )
        )
    actions = sorted(set(read["actionHandlers"]) | set(android.get("registerActionHandler", {})))
    for element in actions:
        registered = android.get("registerActionHandler", {}).get(element)
        items.append(
            item(
                f"jr-action:{name(element)}",
                ([f"{parse_source}::actionHandlers"] if element in read["actionHandlers"] else [])
                + ([registered["at"]] if registered else []),
                core=read["actionHandlers"].get(element),
                android=None if registered is None else {"handler": registered["value"]},
            )
        )
    for event in read["events"]:
        items.append(
            item(
                f"jr-event:{name(event)}",
                "commcare-core/src/main/java/org/javarosa/core/model/actions/Action.java::allEvents",
            )
        )
    registrations = {r["value"]: r for r in read["android"]}
    for parser_name, facts in sorted(read["extensionParsers"].items()):
        registration = registrations[parser_name]
        items.append(
            item(
                f"jr-extension:{parser_name}",
                [facts["at"], registration["at"]],
                registers=registration["registers"],
                registeredAs=registration["key"],
                element=facts["element"],
                attributes=facts["attributes"],
            )
        )
    return items


def parsers(sources: Sources, core: Path | None = None, android: Path | None = None) -> list[Item]:
    read = run_java(sources, "parsers", core, android)
    roots = set(read["roots"])
    values = read["values"]
    items = []
    for parser_name, facts in sorted(read["parsers"].items()):
        items.append(
            item(
                f"parser:{parser_name}",
                facts["at"],
                platform=facts["platform"],
                extends=facts["extends"],
                installed=parser_name in roots,
                readsAttributesByPosition=facts["readsAttributesByPosition"],
                children=facts["children"],
            )
        )
        for element, matches in facts["elements"].items():
            items.append(item(f"parser:{parser_name}/{name(element)}", facts["at"], match=matches))
        for attribute, elements in facts["attributes"].items():
            for element in elements:
                if "?" in element or "|" in element or attribute.startswith("<"):
                    raise SurfaceError(
                        f"{facts['at']} reads the attribute {attribute} on an element the surface extractor "
                        f"cannot name ({element}). The runtime parser family (proof/surface/java/.../Parsers.java) "
                        "must learn how this parser reaches the element, so the key names it."
                    )
                parsed = values.get(parser_name, {}).get(attribute, {}).get(element, {}).get("parsed")
                facts_of = {"parsedAs": ["xpath"]} if parsed else {}
                items.append(item(f"parser:{parser_name}/{name(element)}@{name(attribute)}", facts["at"], **facts_of))
    return items


def hq_suite_attributes(sources: Sources, parsed: set[str]) -> list[Item]:
    """Each attribute HQ's suite model writes on ``<suite>`` that no Core parser reads (``parsed``: the parser
    family's keys), with the values HQ's suite generators write."""
    from corehq.apps.app_manager.suite_xml import xml_models

    model = pyast.in_checkout(sources.hq, inspect.getsourcefile(xml_models))
    generators = model.parent / "generator.py"
    items = []
    for field_name, field in sorted(xml_models.Suite._fields.items()):
        path = field.xpath
        if not path.startswith("@") or "/" in path:
            continue
        key = f"parser:SuiteParser/suite@{name(path[1:])}"
        if key in parsed:
            continue
        writes = _suite_writes(sources, generators, field_name)
        if not writes:
            raise SurfaceError(
                f"HQ's suite model writes {path} on <suite> (Suite.{field_name}), and no suite generator in"
                f" {generators} constructs the model with it; the runtime family reads its value there."
            )
        items.append(
            item(
                key,
                [f"{sources.relative(model)}::Suite.{field_name}", *(write["at"] for write in writes)],
                readBy=[],
                hqField=f"Suite.{field_name}",
                hqWrites=writes,
            )
        )
    return items


def _suite_writes(sources: Sources, path: Path, field_name: str) -> list[dict]:
    """Each ``Suite(..., <field_name>=<value>)`` a generator class constructs, with the value: a literal, or the
    literal a ``self.<attribute>`` names among the class's own attributes, else the expression."""
    tree = pyast.parse(path)
    where = sources.relative(path)
    writes = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        own = {
            target.id: statement.value
            for statement in node.body
            if isinstance(statement, ast.Assign)
            for target in statement.targets
            if isinstance(target, ast.Name)
        }
        for call in ast.walk(node):
            if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "Suite"):
                continue
            for keyword in call.keywords:
                if keyword.arg != field_name:
                    continue
                value = keyword.value
                if (
                    isinstance(value, ast.Attribute)
                    and isinstance(value.value, ast.Name)
                    and value.value.id == "self"
                    and value.attr in own
                ):
                    value = own[value.attr]
                literal = pyast.string(value)
                writes.append(
                    {"at": f"{where}::{node.name}", "value": literal if literal is not None else ast.unparse(value)}
                )
    return sorted(writes, key=lambda write: write["at"])


class _Bindings(HTMLParser):
    """Every ``data-bind`` value in a template, including those inside ``<script type="text/html">`` templates."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.expressions: list[str] = []
        self._template = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if values.get("data-bind"):
            self.expressions.append(values["data-bind"])
        self._template = tag == "script" and values.get("type") == "text/html"

    def handle_data(self, data):
        if self._template:
            inner = _Bindings()
            inner.feed(data)
            inner.close()
            self.expressions.extend(inner.expressions)

    def handle_endtag(self, tag):
        if tag == "script":
            self._template = False


def _without_template_tags(text: str) -> str:
    """A Django template's text with its tags dropped and each variable read as ``null``, by Django's own lexer,
    so the Knockout bindings it holds read as the JavaScript they are in either branch of a tag."""
    from django.template.base import Lexer, TokenType

    return "".join(
        token.contents if token.token_type == TokenType.TEXT else "null" if token.token_type == TokenType.VAR else ""
        for token in Lexer(text).tokenize()
    )


def web_apps(sources: Sources, form_entry: Path, templates: Path) -> list[dict]:
    bindings = []
    for template in sorted(templates.rglob("*.html")):
        parser = _Bindings()
        parser.feed(_without_template_tags(template.read_text(encoding="utf-8")))
        parser.close()
        if parser.expressions:
            bindings.append({"file": sources.relative(template), "expressions": parser.expressions})
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8") as handle:
        json.dump(bindings, handle)
        handle.flush()
        read = run_node("web-apps-appearances", [str(form_entry), handle.name])
    prefix = sources.relative(form_entry)
    reads = []
    for entry in read["reads"]:
        at = [where if where.startswith("commcare-hq/") else f"{prefix}/{where}" for where in entry["at"]]
        reads.append({**entry, "at": sorted(at), "reader": "web-apps"})
    return reads


def appearances(sources: Sources, core: Path | None = None, android: Path | None = None) -> list[Item]:
    reads = list(run_java(sources, "appearances", core, android)["reads"])
    reads += web_apps(sources, sources.hq / FORM_ENTRY, sources.hq / FORM_ENTRY_TEMPLATES)
    tokens: dict[str, list[dict]] = {}
    for entry in reads:
        reader = entry["reader"]
        if "/attribute:" in reader:
            platform, parser_name = reader.split("/attribute:", 1)
            reader = f"{platform}-{parser_name}"
        key = f"appearance:{reader}/{name(entry['token'])}"
        on = {field: entry[field] for field in READ_ON if field in entry}
        tokens.setdefault(key, []).append({"match": entry["match"], "case": entry["case"], "at": entry["at"], **on})
    return [
        item(
            key,
            sorted({where for read in found for where in read["at"]}),
            reads=sorted(found, key=lambda read: (read["match"], read["case"])),
        )
        for key, found in sorted(tokens.items())
    ]
