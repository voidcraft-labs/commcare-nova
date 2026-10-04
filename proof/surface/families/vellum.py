"""HQ's form builder: the Vellum build HQ vendors, and what HQ tells it.

Keys:

- ``vellum-feature:<key>``: each key of Vellum's ``features`` option the
  vendored build reads (``vellum/main.js``), found by the JavaScript helper's
  syntax-tree pass, which follows the features object from each
  ``X.features`` read through variables, assignments, destructuring and the
  parameters of the functions it is passed to (a read through a parameter,
  such as ``custom_intents`` and ``templated_intents``, counts). Each records
  what HQ sets it to: the expression ``views/formdesigner.py::_get_vellum_features``
  assigns, or the toggle whose slug ``toggles_dict`` gives it, or nothing.
- ``vellum-plugin:<name>``: each plugin ``views/formdesigner.py::_get_vellum_plugins``
  passes, with the condition it is passed under (``null`` for always).
- ``vellum-configuration:<name>``: each configuration the build is opened
  with: the plugins it passes and the features it turns on.
- ``mug:<Type>``: each question type in Vellum's registry
  (``data.core.mugTypes``) in any configuration, with whether it is auxiliary
  (not insertable), the configurations whose registry lacks it, the question
  menu groups that offer it (named by each group's lead type), and the
  configurations that register it without offering it in any menu.
- ``vellum-markup:<element>@vellum:<name>``: each attribute in Vellum's own
  namespace Vellum's parser asks of an element while it loads a form
  (``vellum:relevant`` of a ``<bind>``, ``vellum:jr__count`` of a
  ``<repeat>``), with how it asks (``popAttr``: read, and dropped from what it
  keeps of the element; ``xmlAttr``: read and kept). ``<element>`` is the
  element's name as XForms write it (``bind``, ``h:html``; the XForms
  namespace bare), or ``model/instance//*`` for any element inside an
  instance, whose names are the app's. Vellum renames a form's root
  ``h:xdoc`` before it parses it (``xml.js::parseXML``); its key names the
  root as the form does, ``h:html``.
- ``vellum-markup:<parent>/vellum:<name>``: each element in Vellum's
  namespace Vellum's parser looks for among an element's children or
  descendants (``h:head/vellum:hashtags``), by the selector it passes.

  Both are read by loading a probe form (``MARKUP_PROBE``: every control,
  model element and instance kind HQ's forms hold, with the attributes
  Vellum's writer adds) into the vendored build headless, as HQ's form
  designer page loads a form, with every plugin and every feature on, and
  recording each name and selector in Vellum's namespace Vellum asks through
  the jQuery methods it reads form XML with: once with Vellum's data sources
  answered before the form loads and once with them still pending, the one
  state in which it reads the form's own hashtag elements
  (``parser.js::parseXForm``). What Vellum asks of an element depends on the
  element and on how it names its node: a control is read by ``ref``, else
  ``nodeset``, else ``bind`` (``parser.js::getPathFromControlElement``), and a
  bind by ``nodeset``, else ``ref`` (``parser.js::parseBindList``), each name
  through its ``vellum:`` shadow first (``parseVellumAttrs``), so Vellum asks
  for a shadow only where the names before it are missing. The probe holds
  each element kind, and a control and a bind for each way of naming a node.

The build is opened headless in the image's Chromium on the Vellum host page
of the image's editor build (``static/vellum/host.html``, made by
``proof/image/editors/build.mjs`` with HQ's own jQuery, Bootstrap 3, select2 and
underscore and the options HQ's form designer page adds), the page the editor
driver opens forms on; the files Vellum's webpack runtime asks for beside its
script come from HQ's vendored Vellum directory. Vellum is started as HQ's form
designer page starts it, on an empty form in a fresh browser context per
configuration, waiting on Vellum's own ``onReady``: with every feature off,
under the plugins HQ always passes (``plugins:base``) and under every plugin HQ
can pass (``plugins:all``); with every feature on (``features:all``); with each
feature alone on (``feature:<key>``); and with each of HQ's conditional plugins
alone beside the ones it always passes (``plugin:<name>``). The feature
configurations pass every plugin.
"""

from __future__ import annotations

import ast
from pathlib import Path

from proof.surface import pyast
from proof.surface.model import Item, Sources, SurfaceError, item
from proof.surface.node import run_node

VELLUM_DIR = "corehq/apps/app_manager/static/app_manager/js/vellum"
VELLUM_PREFIX = "vellum:"
INSTANCE_CONTENT = "model/instance//*"
# The name Vellum's parser gives a form's root (Vellum's xml.js::parseXML), and the root's own.
VELLUM_ROOT, FORM_ROOT = "h:xdoc", "h:html"
# A form holding each element kind HQ's forms hold once: the head's title, Vellum's hashtag elements, the main
# instance with a data node per control kind (a group, a repeat, a hidden value, a SaveToCase case block), a
# case database and a lookup table instance, binds with every expression Vellum shadows, model setvalues for a
# form load and a repeat insert, itext with an output, and a body with each control: input, select1 and select
# with items, select1 with an itemset, trigger, upload, secret, a group with a label, and a counted repeat. Each
# way an element names its node is held once more: an input by ``nodeset`` and one by ``bind`` (an id), and a
# bind by ``ref``.
MARKUP_PROBE = """<?xml version="1.0" encoding="UTF-8"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns:orx="http://openrosa.org/jr/xforms" \
xmlns="http://www.w3.org/2002/xforms" xmlns:xsd="http://www.w3.org/2001/XMLSchema" \
xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="http://commcarehq.org/xforms/vellum">
<h:head>
<h:title>Probe</h:title>
<model>
<instance>
<data xmlns:jrm="http://dev.commcarehq.org/jr/xforms" xmlns="http://openrosa.org/formdesigner/probe" \
uiVersion="1" version="1" name="Probe">
<text/><number/><choice/><many/><lookup/><note/><photo/><secret/><hidden/>
<group><inner/></group>
<rows jr:template=""><cell/></rows>
<count/>
<bynodeset/><bybind/><byref/>
<save vellum:role="SaveToCase" vellum:case_type="patient">\
<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="" date_modified="" user_id="">\
<update><note/></update></case></save>
</data>
</instance>
<instance id="casedb" src="jr://instance/casedb"/>
<instance id="item-list:places" src="jr://fixture/item-list:places"/>
<bind vellum:nodeset="#form/text" nodeset="/data/text" type="xsd:string" required="true()" \
vellum:relevant="#form/number &gt; 1" relevant="/data/number &gt; 1" \
vellum:constraint="#form/text != ''" constraint="/data/text != ''" \
jr:constraintMsg="jr:itext('text-constraintMsg')"/>
<bind vellum:nodeset="#form/number" nodeset="/data/number" type="xsd:int" \
vellum:requiredCondition="#form/text = 'x'" required="/data/text = 'x'"/>
<bind vellum:nodeset="#form/choice" nodeset="/data/choice"/>
<bind vellum:nodeset="#form/many" nodeset="/data/many"/>
<bind vellum:nodeset="#form/lookup" nodeset="/data/lookup"/>
<bind vellum:nodeset="#form/note" nodeset="/data/note"/>
<bind vellum:nodeset="#form/photo" nodeset="/data/photo" type="binary"/>
<bind vellum:nodeset="#form/secret" nodeset="/data/secret" type="xsd:string"/>
<bind vellum:nodeset="#form/hidden" nodeset="/data/hidden" vellum:calculate="#form/text" calculate="/data/text"/>
<bind vellum:nodeset="#form/group" nodeset="/data/group"/>
<bind vellum:nodeset="#form/group/inner" nodeset="/data/group/inner" type="xsd:string"/>
<bind vellum:nodeset="#form/rows" nodeset="/data/rows"/>
<bind vellum:nodeset="#form/rows/cell" nodeset="/data/rows/cell" type="xsd:string"/>
<bind vellum:nodeset="#form/count" nodeset="/data/count" type="xsd:int"/>
<bind vellum:nodeset="#form/bynodeset" nodeset="/data/bynodeset" type="xsd:string"/>
<bind id="bybind" vellum:nodeset="#form/bybind" nodeset="/data/bybind" type="xsd:string"/>
<bind vellum:ref="#form/byref" ref="/data/byref" type="xsd:string"/>
<bind nodeset="/data/save/case/@case_id" calculate="instance('casedb')/casedb/case[1]/@case_id"/>
<bind nodeset="/data/save/case/@date_modified" type="xsd:dateTime" calculate="now()"/>
<bind nodeset="/data/save/case/@user_id" calculate="''"/>
<bind nodeset="/data/save/case/update/note" vellum:calculate="#form/text" calculate="/data/text"/>
<setvalue event="xforms-ready" vellum:ref="#form/text" ref="/data/text" vellum:value="#form/note" \
value="/data/note"/>
<setvalue event="jr-insert" vellum:ref="#form/rows/cell" ref="/data/rows/cell" vellum:value="#form/text" \
value="/data/text"/>
<itext>
<translation lang="en" default="">
<text id="text-label"><value>Text <output value="/data/number" vellum:value="#form/number"/></value></text>
<text id="text-constraintMsg"><value>Bad</value></text>
<text id="number-label"><value>Number</value></text>
<text id="choice-label"><value>Choice</value></text>
<text id="choice-a-label"><value>A</value></text>
<text id="many-label"><value>Many</value></text>
<text id="many-a-label"><value>A</value></text>
<text id="lookup-label"><value>Lookup</value></text>
<text id="note-label"><value>Note</value></text>
<text id="photo-label"><value>Photo</value></text>
<text id="secret-label"><value>Secret</value></text>
<text id="group-label"><value>Group</value></text>
<text id="inner-label"><value>Inner</value></text>
<text id="rows-label"><value>Rows</value></text>
<text id="cell-label"><value>Cell</value></text>
<text id="count-label"><value>Count</value></text>
<text id="bynodeset-label"><value>By nodeset</value></text>
<text id="bybind-label"><value>By bind</value></text>
<text id="byref-label"><value>By ref</value></text>
</translation>
</itext>
</model>
<vellum:hashtags>{"#form/text":null}</vellum:hashtags>
<vellum:hashtagTransforms>{"prefixes":{}}</vellum:hashtagTransforms>
</h:head>
<h:body>
<input vellum:ref="#form/text" ref="/data/text"><label ref="jr:itext('text-label')"/></input>
<input vellum:ref="#form/number" ref="/data/number"><label ref="jr:itext('number-label')"/></input>
<select1 vellum:ref="#form/choice" ref="/data/choice"><label ref="jr:itext('choice-label')"/>\
<item><label ref="jr:itext('choice-a-label')"/><value>a</value></item></select1>
<select vellum:ref="#form/many" ref="/data/many"><label ref="jr:itext('many-label')"/>\
<item><label ref="jr:itext('many-a-label')"/><value>a</value></item></select>
<select1 vellum:ref="#form/lookup" ref="/data/lookup"><label ref="jr:itext('lookup-label')"/>\
<itemset vellum:nodeset="instance('item-list:places')/places_list/places" \
nodeset="instance('item-list:places')/places_list/places"><label ref="name"/><value ref="id"/></itemset></select1>
<trigger vellum:ref="#form/note" ref="/data/note" appearance="minimal"><label ref="jr:itext('note-label')"/></trigger>
<upload vellum:ref="#form/photo" ref="/data/photo" mediatype="image/*"><label ref="jr:itext('photo-label')"/></upload>
<secret vellum:ref="#form/secret" ref="/data/secret"><label ref="jr:itext('secret-label')"/></secret>
<group vellum:ref="#form/group" ref="/data/group"><label ref="jr:itext('group-label')"/>\
<input vellum:ref="#form/group/inner" ref="/data/group/inner"><label ref="jr:itext('inner-label')"/></input></group>
<input vellum:ref="#form/count" ref="/data/count"><label ref="jr:itext('count-label')"/></input>
<input vellum:nodeset="#form/bynodeset" nodeset="/data/bynodeset"><label ref="jr:itext('bynodeset-label')"/></input>
<input bind="bybind"><label ref="jr:itext('bybind-label')"/></input>
<input vellum:ref="#form/byref" ref="/data/byref"><label ref="jr:itext('byref-label')"/></input>
<group><label ref="jr:itext('rows-label')"/>\
<repeat vellum:nodeset="#form/rows" nodeset="/data/rows" vellum:jr__count="#form/count" jr:count="/data/count" \
jr:noAddRemove="true()"><input vellum:ref="#form/rows/cell" ref="/data/rows/cell">\
<label ref="jr:itext('cell-label')"/></input></repeat></group>
</h:body>
</h:html>
"""
FORM_DESIGNER = "corehq/apps/app_manager/views/formdesigner.py"
HOST_PAGE = "static/vellum/host.html"


def extract(sources: Sources) -> list[Item]:
    import corehq.toggles as toggles

    main = sources.hq / VELLUM_DIR / "main.js"
    keys = feature_keys(main)
    set_by_hq = _hq_features(sources.hq / FORM_DESIGNER)
    toggle_slugs = {
        value.slug: name
        for name, value in vars(toggles).items()
        if isinstance(value, toggles.StaticToggle) and not isinstance(value, toggles.FrozenPrivilegeToggle)
    }
    relative_main = f"{sources.relative(main)}"
    items = []
    for key in keys:
        facts = {"hqSets": set_by_hq.get(key), "hqToggle": toggle_slugs.get(key)}
        items.append(item(f"vellum-feature:{key}", relative_main, **facts))
    plugins = _hq_plugins(sources.hq / FORM_DESIGNER)
    designer = sources.relative(sources.hq / FORM_DESIGNER)
    for name, condition in plugins:
        items.append(item(f"vellum-plugin:{name}", f"{designer}::_get_vellum_plugins", condition=condition))
    items.extend(mugs(sources, keys, plugins))
    items.extend(markup(sources, keys, plugins))
    return items


def feature_keys(main: Path) -> list[str]:
    return run_node("vellum-features", [str(main)])["keys"]


def _hq_features(path: Path) -> dict[str, str]:
    """The feature keys ``_get_vellum_features`` sets, with the expression it sets each to."""
    function = pyast.find_in(path, "_get_vellum_features")
    found = {}
    for node in ast.walk(function):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values, strict=True):
                name = pyast.string(key) if key is not None else None
                if name is not None:
                    found[name] = ast.unparse(value)
    if not found:
        raise SurfaceError(
            f"The surface extractor found no feature assignments in {FORM_DESIGNER}::_get_vellum_features."
        )
    return found


def _hq_plugins(path: Path) -> list[tuple[str, str | None]]:
    """Each plugin ``_get_vellum_plugins`` passes, with the test it is appended under."""
    function = pyast.find_in(path, "_get_vellum_plugins")
    plugins: list[tuple[str, str | None]] = []

    def visit(statements, condition):
        for statement in statements:
            if isinstance(statement, ast.Assign) and isinstance(statement.value, ast.List):
                for element in statement.value.elts:
                    name = pyast.string(element)
                    if name is not None:
                        plugins.append((name, condition))
            elif isinstance(statement, ast.If):
                test = ast.unparse(statement.test)
                visit(statement.body, test if condition is None else f"({condition}) and ({test})")
                visit(statement.orelse, f"not ({test})" if condition is None else f"({condition}) and not ({test})")
            elif (
                isinstance(statement, ast.Expr)
                and isinstance(statement.value, ast.Call)
                and isinstance(statement.value.func, ast.Attribute)
                and statement.value.func.attr == "append"
            ):
                name = pyast.string(statement.value.args[0]) if statement.value.args else None
                if name is not None:
                    plugins.append((name, condition))

    visit(function.body, None)
    if not plugins:
        raise SurfaceError(f"The surface extractor found no plugins in {FORM_DESIGNER}::_get_vellum_plugins.")
    return plugins


def configurations(keys: list[str], plugins: list[tuple[str, str | None]]) -> list[dict]:
    always = [name for name, condition in plugins if condition is None]
    optional = [name for name, condition in plugins if condition is not None]
    everything = always + optional
    off = {key: False for key in keys}
    found = [
        {"name": "plugins:base", "plugins": always, "features": off},
        {"name": "plugins:all", "plugins": everything, "features": off},
        {"name": "features:all", "plugins": everything, "features": {key: True for key in keys}},
    ]
    found += [{"name": f"feature:{key}", "plugins": everything, "features": {**off, key: True}} for key in keys]
    found += [{"name": f"plugin:{name}", "plugins": [*always, name], "features": off} for name in optional]
    return found


def mugs(sources: Sources, keys: list[str], plugins: list[tuple[str, str | None]]) -> list[Item]:
    host = sources.editors / HOST_PAGE
    if not host.is_file():
        raise SurfaceError(
            f"The surface extractor opens HQ's vendored Vellum on the editor build's host page, {host}, which "
            "is not there. The proof image builds it (proof/image/editors/build.mjs); PROOF_EDITORS names "
            "another editor build."
        )
    request = _vellum_request(sources, keys, plugins)
    read = run_node("read", [], script="vellum_registry.mjs", stdin=request)
    return _registry_items(sources, request, read)


def _vellum_request(sources: Sources, keys: list[str], plugins: list[tuple[str, str | None]]) -> dict:
    from corehq.apps.app_manager.form_action_diff import get_case_mappings
    from corehq.apps.app_manager.helpers.validators import load_case_reserved_words
    from corehq.apps.app_manager.models import Form

    callouts = next(_callouts())
    return {
        "staticDir": str(sources.editors / "static"),
        "vellumDir": str(sources.hq / VELLUM_DIR),
        # What HQ's server renders for the form designer in every configuration
        # (views/formdesigner.py::_get_base_vellum_options and _get_vellum_core_context), for an empty form;
        # the plugins that need an options object get the one HQ builds for a basic form with no case
        # properties. The host page adds what HQ's form designer page adds.
        "options": {
            "intents": {"templates": callouts},
            "javaRosa": {"langs": ["en"], "displayLanguage": "en", "showOnlyCurrentLang": False},
            "uploader": {"uploadUrls": {}, "objectMap": {}},
            "caseManagement": {
                "mappings": get_case_mappings(Form().actions),
                "properties": [],
                "view_form_url": "",
                "reserved_words": load_case_reserved_words(),
                "is_registration_form": False,
            },
            "saveToCase": {"existingCaseTypes": []},
            "core": {
                "form": "",
                "formId": "surface",
                "formName": "Surface",
                "formComment": "",
                "saveType": "patch",
                "hasSubmissions": False,
                "allowedDataNodeReferences": [],
                "externalLinks": {},
                "invalidCaseProperties": ["name"],
            },
        },
        "configurations": configurations(keys, plugins),
    }


def _registry_items(sources: Sources, request: dict, read: dict) -> list[Item]:
    names = sorted(read)
    registered: dict[str, dict] = {}
    for configuration_name, configuration in read.items():
        auxiliary = set(configuration["auxiliary"])
        for mug in configuration["all"]:
            entry = registered.setdefault(mug, {"auxiliary": mug in auxiliary, "in": set(), "menus": {}})
            entry["in"].add(configuration_name)
            if entry["auxiliary"] != (mug in auxiliary):
                raise SurfaceError(f"Vellum's {mug} is auxiliary in some configurations and not in others.")
        for group in configuration["menus"]:
            for mug in group["questions"]:
                if mug not in configuration["all"]:
                    raise SurfaceError(
                        f"Vellum's question menu offers {mug} with {configuration_name}, but its registry has no {mug}."
                    )
                registered[mug]["menus"].setdefault(group["group"], set()).add(configuration_name)
    relative = sources.relative(sources.hq / VELLUM_DIR / "main.js")
    items = [
        item(
            f"vellum-configuration:{configuration['name']}",
            relative,
            plugins=configuration["plugins"],
            featuresOn=sorted(key for key, on in configuration["features"].items() if on),
        )
        for configuration in request["configurations"]
    ]
    for mug, entry in sorted(registered.items()):
        offered = set().union(*entry["menus"].values()) if entry["menus"] else set()
        items.append(
            item(
                f"mug:{mug}",
                relative,
                auxiliary=entry["auxiliary"],
                notRegisteredIn=sorted(set(names) - entry["in"]),
                menuGroups=sorted(entry["menus"]),
                notOfferedIn=sorted(entry["in"] - offered),
            )
        )
    return items


def markup(
    sources: Sources, keys: list[str], plugins: list[tuple[str, str | None]], form: str = MARKUP_PROBE
) -> list[Item]:
    """What Vellum's parser asks of its own markup while it loads ``form`` (``MARKUP_PROBE``), everything on."""
    request = _vellum_request(sources, keys, plugins)
    everything = next(c for c in request.pop("configurations") if c["name"] == "features:all")
    request.update(configuration=everything, form=form)
    states = run_node("markup", [], script="vellum_registry.mjs", stdin=request)
    for state, read in sorted(states.items()):
        if read["parseErrors"]:
            raise SurfaceError(
                "Vellum could not load the surface extractor's markup probe (proof/surface/families/vellum.py::"
                f"MARKUP_PROBE) with its data sources {state}: {read['parseErrors']}. The probe must be a form"
                " Vellum loads as HQ's forms load."
            )
    found: dict[str, dict] = {}
    for entry in (entry for _, read in sorted(states.items()) for entry in read["reads"]):
        element = markup_element(entry["path"], entry["element"])
        if "attribute" in entry:
            names = [entry["attribute"]]
            keys_read = [f"vellum-markup:{element}@{entry['attribute']}"]
        else:
            names = [one for one in _selected(entry["selector"]) if one.startswith(VELLUM_PREFIX)]
            keys_read = [f"vellum-markup:{element}/{one}" for one in names]
        for key in keys_read:
            facts = found.setdefault(key, {"via": set(), "selectors": set()})
            facts["via"].add(entry["via"])
            if "selector" in entry:
                facts["selectors"].add(entry["selector"])
    if not found:
        raise SurfaceError("Vellum asked nothing of its own markup while it loaded the surface extractor's probe.")
    relative = sources.relative(sources.hq / VELLUM_DIR / "main.js")
    items = []
    for key, facts in sorted(found.items()):
        selected = {"selectors": sorted(facts["selectors"])} if facts["selectors"] else {}
        items.append(item(key, relative, via=sorted(facts["via"]), **selected))
    return items


def markup_element(path: str, element: str) -> str:
    """How a ``vellum-markup`` key names the element Vellum asked: ``model/instance//*`` inside an instance, whose
    elements are the app's; the form's root by its own name, ``h:html`` (Vellum parses a form with its root
    renamed ``h:xdoc``, ``xml.js::parseXML``, so that jQuery reads the document as XML); else the element's name
    as the probe writes it (its prefix and local name)."""
    steps = path.split("/")
    if "instance" in steps[:-1] and "model" in steps[: steps.index("instance")]:
        return INSTANCE_CONTENT
    if path == VELLUM_ROOT:
        return FORM_ROOT
    return element


def _selected(selector: str) -> list[str]:
    """The element names a selector list of plain type selectors names (``vellum\\:hashtags, hashtags``), each
    escaped colon read as the name's colon, as CSS reads it."""
    names = []
    for part in selector.split(","):
        text = part.strip()
        name, escaped = [], False
        for character in text:
            if escaped:
                name.append(character)
                escaped = False
            elif character == "\\":
                escaped = True
            elif character.isalnum() or character in "_-":
                name.append(character)
            else:
                raise SurfaceError(
                    f"Vellum asks for its markup with the selector {selector!r}, which holds more than element names;"
                    " the vellum family reads only element names there."
                )
        names.append("".join(name))
    return names


def _callouts():
    from corehq.apps.app_manager.util import _app_callout_templates

    return _app_callout_templates()
