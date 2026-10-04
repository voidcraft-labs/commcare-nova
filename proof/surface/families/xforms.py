"""What Core's XForm parser reads from a form, and the itext forms each runtime reads.

Keys:

- ``xform:<path>``: each element Core's ``XFormParser`` dispatches, tests for or
  walks, by its path from the element a handler table dispatches
  (``xform:model/itext/translation/text/value``, ``xform:repeat/jr:addCaption``),
  read with the Java helper's element flow over ``XFormParser`` and every helper
  it calls, the action handlers (``SetValueAction``, ``SendAction``) and the
  handlers and question extension parsers Android registers
  (``XFormAndroidInstaller.registerAndroidLevelFormParsers``,
  ``XFormExtensionUtils.getAllAndroidExtensionParsers``). A path step ``*`` is
  an element of any name, ``X//*`` any descendant of ``X``, and a handled
  element's path starts at its own name (``xform:setvalue``), with the tables
  that dispatch it and the paths it is dispatched under. Each element records
  how its name is matched (``exact``, ``lowercased``, a table's keys, an
  extension parser's element), its ``namespace``, and whether Core reads its
  text, its attributes by position, its namespace declarations, or writes it
  out whole. A handler table is keyed by an element's local name
  (``XFormParser.parseElement``: ``handlers.get(e.getName())``), and a name
  test compares the local name alone, so a bare step is an element Core matches
  in any namespace (``namespace: any``: ``<h:title>`` is dispatched as
  ``title``); a prefixed step (``repeat/jr:addCaption``, ``label/h:*``) is one
  whose namespace Core tests, and ``namespace`` names it.
- ``xform:<path>@<attribute>``: each attribute Core reads on that element, with
  the namespace it reads it in (``any`` for a read that names no namespace,
  ``none`` for the empty one, or the namespace), how it is read (``named``, or
  by position with its name tested), every constant Core compares the value
  with (``equals true()``, ``startsWith jr:itext('``), and ``parsedAs: xpath``
  when the value reaches Core's XPath parser. ``@xmlns`` is the element's own
  namespace, read where Core uses the value (a ``getNamespace()`` bound to a
  local is read where the local is used, and the right side of an ``&&`` or
  ``||`` the left side decides is not read: ``parseGroup`` compares a child's
  namespace only under ``group.isRepeat()``), with the namespaces Core
  compares it with and, where every read of it is taken under some test,
  ``when``: the alternatives, each the conditions one read is taken under
  (``not-named:<name>`` for a name test the element failed, as
  ``parseModel``'s last ``else`` reads a child no name test took, or a table
  with no handler for it; ``childless`` for an element standing where a test
  found none of its element children, as ``saveInstanceNode`` takes an
  ``<instance>`` itself; ``without:<attribute>`` where a test found the
  attribute absent; ``first`` for the first value a field takes, as
  ``mainInstanceNode``), which the manifest checks evaluate on an element.

Namespaced names use the prefixes HQ and Vellum write (the XForms namespace
bare; ``h``, ``jr``, ``orx``, ``cc``, ``vellum``, ``odkx``, ``xsd``), the
spelling the manifest checks read an export's XForm with
(``proof/checks/manifest_usage.py``); any other namespace is written ``{uri}``.

- ``xform:model/instance/*@<attribute>`` for an attribute of the main
  instance's data root that Core does not read but HQ does (``readBy:
  ["hq"]``): each attribute HQ's ``XForm`` writes on the data node itself
  (``self.data_node.set('<attribute>', ...)``, read from ``xform.py``'s syntax
  tree: ``XForm.set_name`` writes ``name`` with the form's name), with each
  ``XFormInstance`` property that reads the same attribute back from a
  submission's form data (``self.form_data.get(const.TAG_NAME)``, where
  ``couchforms/const.py`` binds ``TAG_NAME`` to ``@name``), read from
  ``form_processor/models/forms.py``'s syntax tree. An attribute Core reads
  there (``version``) is Core's item.
- ``itext-form:<reader>/<form>``: each itext form (``<value form="...">``) a
  reader reads, where ``<reader>`` is ``core``, ``android`` or ``hq``: for Core
  and Android, the ``form`` argument of a call to Core's form entry API (a
  method of ``FormEntryCaption`` or ``FormEntryPrompt`` taking a ``form``), a
  comparison with a constant such a call is passed, and the forms
  ``XFormParser`` checks a text id against (``itextKnownForms``); for HQ, read
  from ``xform.py``'s syntax tree, each form ``VALID_VALUE_FORMS`` lists, with
  the conditions ``XForm.localize`` consults it under (a text with no value of
  the form asked for, where HQ raises ``XFormException`` and names any form
  outside the list as unrecognized), and each form a ``media_references`` call
  passes (the media paths HQ collects for the app's multimedia). Each read
  records how and where. Every item also records ``hqValidValueForm``, whether
  ``VALID_VALUE_FORMS`` lists its form.
"""

from __future__ import annotations

import ast
from pathlib import Path

from proof.surface import pyast
from proof.surface.families.data import name
from proof.surface.java import run_java
from proof.surface.model import Item, Sources, SurfaceError, item

XFORM_PY = "corehq/apps/app_manager/xform.py"
VALID_VALUE_FORMS = "VALID_VALUE_FORMS"
# A submission's form, as HQ keeps it, and the constants its form data is read by.
FORM_MODEL = ("corehq/form_processor/models/forms.py", "XFormInstance")
FORM_CONSTANTS = "corehq/ex-submodules/couchforms/const.py"
DATA_ROOT = "model/instance/*"


def extract(sources: Sources) -> list[Item]:
    core = xform(sources)
    return [*core, *hq_data_root_attributes(sources, {one.key for one in core}), *itext_forms(sources)]


def xform(sources: Sources, core: Path | None = None, android: Path | None = None) -> list[Item]:
    read = run_java(sources, "xforms", core, android)
    elements, attributes = read["elements"], read["attributes"]
    attributed = {key.rsplit("@", 1)[0] for key in attributes}
    items = []
    for path, facts in sorted(elements.items()):
        recorded = {fact: value for fact, value in facts.items() if fact != "at"}
        if not set(recorded) - {"namespace"} and path not in attributed:
            # An element only passed through on the way to its children names nothing Core reads.
            continue
        items.append(item(f"xform:{name(path)}", facts["at"], **recorded))
    for key, facts in sorted(attributes.items()):
        if key.rsplit("@", 1)[0] not in elements:
            raise SurfaceError(f"The XForm reader recorded the attribute {key} on an element it did not record.")
        items.append(item(f"xform:{name(key)}", facts["at"], **{f: v for f, v in facts.items() if f != "at"}))
    return items


def hq_data_root_attributes(sources: Sources, core_keys: set[str], hq: Path | None = None) -> list[Item]:
    """Each attribute of the data root HQ writes and Core does not read, with where HQ reads it back."""
    root = hq or sources.hq
    xform_path = root / XFORM_PY
    writes: dict[str, list[str]] = {}
    for qualname, function in pyast.walk_functions(pyast.parse(xform_path)):
        for node in ast.walk(function):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "set"
                and pyast.dotted(node.func.value) == "self.data_node"
                and node.args
            ):
                attribute = pyast.string(node.args[0])
                if attribute is None:
                    raise SurfaceError(f"{xform_path}::{qualname} sets an attribute of the data node it does not name.")
                writes.setdefault(attribute, []).append(f"{sources.relative(xform_path)}::{qualname}")
    if not writes:
        raise SurfaceError(f"The surface extractor found no attribute {xform_path} writes on the data node.")
    reads = _submission_reads(sources, root)
    items = []
    for attribute, written in sorted(writes.items()):
        key = f"xform:{DATA_ROOT}@{name(attribute)}"
        if key in core_keys:
            continue
        read = reads.get(attribute, [])
        items.append(
            item(key, [*written, *read], readBy=["hq"], hqWrites=sorted(set(written)), hqReads=sorted(set(read)))
        )
    return items


def _submission_reads(sources: Sources, root: Path) -> dict[str, list[str]]:
    """Each attribute of a submission's form data an ``XFormInstance`` property reads
    (``self.form_data.get(const.X)`` or ``self.form_data[const.X]``, ``const.X`` being ``@<attribute>``)."""
    constants = pyast.module_constants(pyast.parse(root / FORM_CONSTANTS))
    path = root / FORM_MODEL[0]
    model = pyast.find(pyast.parse(path), FORM_MODEL[1])
    found: dict[str, list[str]] = {}
    for function in model.body:
        if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for node in ast.walk(function):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get":
                owner, keys = node.func.value, node.args[:1]
            elif isinstance(node, ast.Subscript):
                owner, keys = node.value, [node.slice]
            else:
                continue
            if pyast.dotted(owner) != "self.form_data" or not keys:
                continue
            constant = pyast.dotted(keys[0])
            if constant is None or not constant.startswith("const."):
                continue
            value = constants.get(constant.split(".", 1)[1])
            if isinstance(value, str) and value.startswith("@"):
                found.setdefault(value[1:], []).append(f"{sources.relative(path)}::{FORM_MODEL[1]}.{function.name}")
    return found


def itext_forms(
    sources: Sources, core: Path | None = None, android: Path | None = None, hq: Path | None = None
) -> list[Item]:
    read = run_java(sources, "wide", core, android)["itextForms"]
    forms: dict[str, list[dict]] = {}
    for entry in read:
        forms.setdefault(f"{entry['reader']}/{entry['form']}", []).append({"via": entry["via"], "at": entry["at"]})
    valid, hq_reads = hq_itext_forms(sources, (hq or sources.hq) / XFORM_PY)
    for form, reads in hq_reads.items():
        forms.setdefault(f"hq/{form}", []).extend(reads)
    items = []
    for key, reads in sorted(forms.items()):
        form = key.split("/", 1)[1]
        items.append(
            item(
                f"itext-form:{name(key)}",
                sorted({where for one in reads for where in one["at"]}),
                reads=sorted(reads, key=lambda r: (r["via"], r["at"])),
                hqValidValueForm=form in valid,
            )
        )
    return items


def hq_itext_forms(sources: Sources, path: Path) -> tuple[set[str], dict[str, list[dict]]]:
    """The forms HQ's ``xform.py`` names: ``VALID_VALUE_FORMS`` with the conditions each function that reads
    it consults it under, and the constant form of each ``media_references`` call."""
    tree = pyast.parse(path)
    relative = sources.relative(path)
    constants = pyast.module_constants(tree)
    valid = constants.get(VALID_VALUE_FORMS)
    if not isinstance(valid, tuple) or not valid or not all(isinstance(form, str) for form in valid):
        raise SurfaceError(f"The surface extractor found no tuple of forms bound to {VALID_VALUE_FORMS} in {path}.")
    reads: dict[str, list[dict]] = {}
    consulted = False
    for qualname, function in pyast.walk_functions(tree):
        where = f"{relative}::{qualname}"

        def names_list(statement: ast.stmt) -> bool:
            return not isinstance(statement, (ast.If, ast.For, ast.While, ast.Try)) and any(
                isinstance(node, ast.Name) and node.id == VALID_VALUE_FORMS for node in ast.walk(statement)
            )

        for statement, conditions in pyast.guarded(function.body, names_list):
            consulted = True
            for form in valid:
                reads.setdefault(form, []).append(
                    {"via": VALID_VALUE_FORMS, "at": [where], "when": conditions, "does": ast.unparse(statement)}
                )
        for node in ast.walk(function):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "media_references"
                and node.args
            ):
                form = pyast.string(node.args[0])
                if form is None:
                    raise SurfaceError(f"{where} calls media_references with a form that is not a constant.")
                reads.setdefault(form, []).append({"via": "media_references", "at": [where]})
    if not consulted:
        raise SurfaceError(f"The surface extractor found no function of {path} that reads {VALID_VALUE_FORMS}.")
    return set(valid), reads
