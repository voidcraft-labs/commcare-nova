"""The value classes the manifest check reads of a use (plan decision 6: one entry per value class).

An inventory entry names surface keys and, where the inventory splits an item
by value (its rule 3), the value class it covers: ``questions/long-xsd-long``
covers an ``<input>`` whose bind type is ``xsd:long`` among the uses of
``jr-control:input``, which other entries' classes share. Which class a use
falls in is read here from what the manifest check parsed of the export
(``proof.checks.manifest_usage``): each use carries where it sits (``Use.at``),
an element of a parsed XForm or suite (``XmlAt``), a slot of the app JSON
(``JsonAt``) or a CSQL string HQ's parser read (``CsqlAt``), and a reader
(``VALUE_CLASSES``, by the entry's id) tells whether that use falls in its
REFUSED entry's class: True, False, or None where the export alone does not
say. An allowing entry's class is never read: it is the rest of its key's
values (``manifest_usage.standing``). A HELD-NEW entry that splits one value
of a key an allowing entry also names, by that value's grammar or bound, has
a reader too, which decides by the use's own value and the objects or
elements that hold it: a use it takes is one Nova does not hold yet.

Each reader follows its inventory row and, where the row names a reader of
the value, that reader's own test at source: Core's parser for an XForm's
structure and types (``XFormParser``), Vellum's parser for what a save keeps
(``parser.js``, ``saveToCase.js``, ``modeliteration.js``), HQ's for what its
build and search read. A row's class is about an app's source as HQ holds
it; what HQ's build adds to that source (its meta block and the case blocks
``XForm.add_case_and_meta`` writes, which Nova's local archives carry as
HQ's build does) is the build's, in no source class.
"""

from __future__ import annotations

import json
import html
import re
import posixpath
import unicodedata
from dataclasses import dataclass
from functools import cache, cached_property

from lxml import etree

from proof.checks.compare.app_strings import is_locale_file_key
from proof.checks.compare.names import nova_name
from proof.observe.manifest import CSQL_HOLES, expression_tree, form_language_profiles
from proof.rules._xpath import tokens as xpath_tokens

XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"
JAVAROSA = "http://openrosa.org/javarosa"
VELLUM = "http://commcarehq.org/xforms/vellum"
OPENDATAKIT = "http://opendatakit.org/xforms"
OPENROSA = "http://openrosa.org/jr/xforms"
CASE = "http://commcarehq.org/case/transaction/v2"

# The controls Core's XFormParser hands a bind's node to (its control handlers), by local name.
SELECTS = frozenset({"select", "select1"})
# The project-space flag under which HQ's build writes no index from a child case to a parent of its own type
# (``corehq/toggles/__init__.py::DONT_INDEX_SAME_CASETYPE``).
DONT_INDEX_SAME_CASETYPE = "DONT_INDEX_SAME_CASETYPE"


# Where a use sits ------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class XmlAt:
    """A use in a parsed XML artifact: its document (``Form`` or ``Runtime``), the element and, for an
    attribute's use, the attribute's name as lxml spells it."""

    document: object
    element: object
    attribute: str | None = None


@dataclass(frozen=True, eq=False)
class JsonAt:
    """A use in an app JSON: the app (``App``), the schema objects from the root down to the slot's own, each
    ``(class, object)``, and the slot's key (None where the use is the object itself)."""

    app: object
    scope: tuple
    key: str | None = None

    @property
    def owner(self):
        return self.scope[-1][1]

    @property
    def value(self):
        return self.owner.get(self.key) if self.key is not None else self.owner

    def nearest(self, *classes):
        """The innermost object of one of the classes, or None."""
        return next((value for cls, value in reversed(self.scope) if cls in classes), None)


@dataclass(frozen=True, eq=False)
class CsqlAt:
    """A use in a CSQL string a search can send: the string and what HQ's CSQL parser read in it
    (``proof.observe.manifest.csql_reading``)."""

    string: str
    reading: tuple


# The documents a use sits in ---------------------------------------------------


def _local(element):
    return etree.QName(element).localname


def _children(element):
    return [child for child in element if isinstance(child.tag, str)]


def _core_control_path(control):
    """The attribute Core binds a body element to its node by, and its text: ``bind`` wherever the element holds
    one, else a repeat's ``nodeset`` and any other element's ``ref`` (``XFormParser.parseControl`` and
    ``parseGroup`` read ``bind`` first, a repeat's ``nodeset`` alone and a group's or a question's ``ref`` alone;
    the reader's ``xform/body.ts::coreControlPath``), as ``(attribute, text)``; None where it holds none of them. A
    group holding only ``nodeset`` binds no node of its own, and a question holding only ``nodeset`` none."""
    bind = control.get("bind")
    if bind is not None:
        return "bind", bind
    attribute = "nodeset" if _local(control) == "repeat" else "ref"
    text = control.get(attribute)
    return None if text is None else (attribute, text)


def scanned_instance_names(text):
    """HQ suite_xml/post_process/instances.py::get_instance_names on one emitted XPath or full XForm."""
    return set(re.findall(r"""instance\(\s*['"]([\w\-:]+)['"]\s*\)""", html.unescape(text)))


class Form:
    """One XForm as the value classes read it: its tree and, built once, the relations its readers follow (a
    control to its bind, a path to its instance node). Paths are matched as the text HQ, Vellum and Nova
    write them, absolute from the data root (``/data/q``, ``/data/q/@x``); a ``ref`` or ``nodeset`` written any
    other way names no node here, and a reader that needs one says None."""

    kind = "xform"

    def __init__(self, root, artifact):
        self.root = root
        self.artifact = artifact
        self.readings = None  # proof.checks.manifest_usage.Readings, once the check reads the observation's
        self.app_form = None  # (App, its form object) where an app JSON carries the form
        self.scans = {}  # per-language-profile readings from HQ's pre-factory pipeline
        self.read_built_instances = None  # lazily, for an undeclared read in an actual HQ build
        self.case_types = None  # the document's declared types, or the optional metadata a control retained
        # The suites (their roots) whose entries open the form, where the check reads any: HQ's builds of an app
        # JSON's upload, or a local archive's own suite (``manifest_usage.link_entry_suites``).
        self.entry_suites = ()

    @cached_property
    def scanned_instance_ids(self):
        """The names HQ actually scanned on every installed language profile of this source."""
        if self.app_form is None:
            return set()
        from proof.checks.manifest_usage import ObservationMissing

        app, _ = self.app_form
        sets = []
        for key in form_language_profiles(app.doc):
            if key not in self.scans:
                raise ObservationMissing(f"The manifest observation lacks the built form instance scan for {self.artifact}, languages {key}")
            sets.append(set(self.scans[key].get("names", [])))
        names = set.intersection(*sets) if sets else set()
        if self.model is not None:
            names -= {element.get("id") for element in self.model if element.tag in ("instance", f"{{{XFORMS}}}instance")}
        return names

    @cached_property
    def built_instances(self):
        return self.read_built_instances() if self.read_built_instances is not None else ()

    @cached_property
    def working_instances(self):
        """External declarations present in every recorded build and available across language profiles.
        A declaration present without a default-profile scan was added by HQ's concrete form build."""
        if not self.built_instances or self.app_form is None:
            return {}
        app, form = self.app_form
        first_profile = next(iter(form_language_profiles(app.doc)), None)
        default_scan = set(self.scans.get(first_profile, {}).get("names", []))
        all_profiles = self.scanned_instance_ids
        direct = {"commcaresession"}
        actions = form.get("actions") or {}
        if form.get("doc_type") == "Form" and (
            (_requires(form) != "none" and (actions.get("case_preload") or {}).get("preload"))
            or (actions.get("usercase_preload") or {}).get("preload")
        ):
            direct.add("casedb")
        if form.get("doc_type") == "AdvancedForm" and any(
            isinstance(load, dict) and load.get("preload") for load in actions.get("load_update_cases") or []
        ):
            direct.add("casedb")
        return {
            name: source
            for name, source in self.built_instances[0].items()
            if (name in direct or name in all_profiles or name not in default_scan)
            and all(instances.get(name) == source for instances in self.built_instances[1:])
        }

    @cached_property
    def xmlns(self):
        """The form's namespace: its data root's, which a suite entry's ``<form>`` names."""
        return etree.QName(self.data_root).namespace if self.data_root is not None else None

    @cached_property
    def head(self):
        return self.root.find(f"{{{XHTML}}}head")

    @cached_property
    def model(self):
        """The model Core reads: the head's first XForms ``<model>``."""
        return self.head.find(f"{{{XFORMS}}}model") if self.head is not None else None

    @cached_property
    def data_root(self):
        """The main instance's root: the model's first instance's first element."""
        if self.model is None:
            return None
        instance = self.model.find(f"{{{XFORMS}}}instance")
        children = _children(instance) if instance is not None else []
        return children[0] if children else None

    @cached_property
    def nodes(self):
        """Each node of the main instance by its absolute path: an element, or ``(element, attribute)``."""
        found = {}
        if self.data_root is None:
            return found

        def walk(element, path):
            found.setdefault(path, element)
            for attribute in element.attrib:
                if etree.QName(attribute).namespace is None:
                    found.setdefault(f"{path}/@{attribute}", (element, attribute))
            for child in _children(element):
                walk(child, f"{path}/{_local(child)}")

        walk(self.data_root, f"/{_local(self.data_root)}")
        return found

    @cached_property
    def paths(self):
        """Each element of the main instance's path (the inverse of ``nodes``)."""
        return {node: path for path, node in self.nodes.items() if not isinstance(node, tuple)}

    def node(self, path):
        return self.nodes.get((path or "").strip())

    @cached_property
    def binds(self):
        """The model's binds by their nodeset's text."""
        found = {}
        for bind in self.model.iterfind(f"{{{XFORMS}}}bind") if self.model is not None else ():
            if bind.get("nodeset"):
                found.setdefault(bind.get("nodeset").strip(), []).append(bind)
        return found

    @cached_property
    def binds_by_id(self):
        found = {}
        for binds in self.binds.values():
            for bind in binds:
                if bind.get("id"):
                    found.setdefault(bind.get("id"), bind)
        return found

    @cached_property
    def controls(self):
        """The body's elements that name a node, by the text of the path Core binds each to (``control_path``)."""
        found = {}
        body = self.root.find(f"{{{XHTML}}}body")
        for element in body.iter() if body is not None else ():
            if not isinstance(element.tag, str):
                continue
            path = self.control_path(element)
            if path:
                found.setdefault(path, []).append(element)
        return found

    def bind(self, path):
        """The bind Core applies to a path's node: the last of the binds naming it (``XFormParser.parseBind``
        applies each in turn)."""
        binds = self.binds.get((path or "").strip())
        return binds[-1] if binds else None

    def control_path(self, control):
        """The path Core binds a body element to (``_core_control_path``): its ``bind``'s bind's nodeset, else a
        repeat's ``nodeset`` or any other element's ``ref``; None where it names none, or names a bind id no bind
        with a nodeset holds."""
        found = _core_control_path(control)
        if found is None:
            return None
        attribute, path = found
        if attribute == "bind":
            bind = self.binds_by_id.get(path)
            path = bind.get("nodeset") if bind is not None else None
        return path.strip() if path else None

    def control_bind(self, control):
        return self.bind(self.control_path(control))

    def question_controls(self, path):
        """The body controls (not labels, hints or items) that name a path."""
        return [
            control for control in self.controls.get((path or "").strip(), []) if _local(control) in QUESTION_CONTROLS
        ]

    @cached_property
    def repeat_paths(self):
        """Each path a repeat stands for, as Vellum's ``isInRepeat`` sees one: a body ``<repeat>``'s nodeset,
        and each model iteration's container (an element with ``vellum:role="Repeat"``)."""
        found = set()
        body = self.root.find(f"{{{XHTML}}}body")
        for repeat in body.iter(f"{{{XFORMS}}}repeat") if body is not None else ():
            if repeat.get("nodeset"):
                found.add(repeat.get("nodeset").strip())
        for container in self.model_repeats:
            found.add(self.paths[container])
        return frozenset(found)

    def in_repeat(self, path):
        return any(path == repeat or path.startswith(f"{repeat}/") for repeat in self.repeat_paths)

    @cached_property
    def model_repeats(self):
        """Each model iteration's container in the main instance (``modeliteration.js``)."""
        return tuple(element for element in self.paths if element.get(f"{{{VELLUM}}}role") == "Repeat")

    @cached_property
    def save_to_case(self):
        """Each SaveToCase node of the main instance (``saveToCase.js``)."""
        return tuple(element for element in self.paths if element.get(f"{{{VELLUM}}}role") == "SaveToCase")

    def holder(self, element):
        """The SaveToCase node, HQ case block or HQ meta block an element of the main instance sits in, as
        ``("save-to-case" | "case-block" | "meta", that element)``, or None."""
        node = element
        while node is not None and node is not self.data_root:
            if node.get(f"{{{VELLUM}}}role") == "SaveToCase":
                return "save-to-case", node
            node = node.getparent()
        node = element
        while node is not None and node is not self.data_root:
            if node.tag == f"{{{CASE}}}case":
                return "case-block", node
            if node.tag == f"{{{OPENROSA}}}meta" and node.getparent() is self.data_root:
                return "meta", node
            node = node.getparent()
        return None

    @cached_property
    def intents(self):
        """The head's ``<odkx:intent>`` elements by id."""
        found = {}
        for intent in self.head.iter(f"{{{OPENDATAKIT}}}intent") if self.head is not None else ():
            found.setdefault(intent.get("id"), intent)
        return found

    def parsed(self, text):
        """Core's parse of an expression's text, as the observation read it, or None where it holds none."""
        if self.readings is None or text is None:
            return None
        return self.readings.expressions.get(text)

    @cached_property
    def body(self):
        return self.root.find(f"{{{XHTML}}}body")

    @cached_property
    def body_elements(self):
        """Every element under the body."""
        body = self.body
        return (
            frozenset(element for element in body.iter() if isinstance(element.tag, str))
            if body is not None
            else frozenset()
        )

    @cached_property
    def vellum_nodes(self):
        """Each main-instance element Vellum's parser makes a question of, with the data-node role it reads there
        (None for a node it reads no role of, a ``DataBindOnly`` mug until a control names it): every child of the
        data root, and the children each one's ``parseDataNode`` hands on, which a node with a role it supports
        (``DATA_ROLES``) never does but a model iteration, which hands on its ``item``'s (``parser.js::parseDataTree``,
        ``parseDataElement``)."""
        found = {}

        def walk(element):
            role = element.get(f"{{{VELLUM}}}role")
            role = role if role in DATA_ROLES else None
            found[element] = role
            if role is None:
                children = _children(element)
            elif role == "Repeat":
                children = [child for item in _children(element) if _local(item) == "item" for child in _children(item)]
            else:
                children = []
            for child in children:
                walk(child)

        for child in _children(self.data_root) if self.data_root is not None else ():
            walk(child)
        return found

    @cached_property
    def named_instance_elements(self):
        """Every element whose DOM name is ``instance``, where Vellum's parser looks for instances
        (``parser.js::_getInstances``: ``xml.find("instance")``)."""
        return tuple(
            element
            for element in self.root.iter()
            if isinstance(element.tag, str) and element.prefix is None and _local(element) == "instance"
        )

    @cached_property
    def declared_instances(self):
        """Each ``(id, src)`` the form declares, in order."""
        return (
            tuple(
                (element.get("id"), element.get("src"))
                for element in self.model
                if element.tag == f"{{{XFORMS}}}instance" and element.get("id") and element.get("src")
            )
            if self.model is not None
            else ()
        )

    @cached_property
    def counted_repeats(self):
        """Each body ``<repeat>`` with a ``jr:count``: ``(its nodeset, its count)``."""
        repeats = self.body.iter(f"{{{XFORMS}}}repeat") if self.body is not None else ()
        return tuple(
            (repeat.get("nodeset").strip(), repeat.get(f"{{{JAVAROSA}}}count"))
            for repeat in repeats
            if repeat.get("nodeset") and (repeat.get(f"{{{JAVAROSA}}}count") or "").strip()
        )

    @cached_property
    def translations(self):
        """The itext translations, in order."""
        itext = self.model.find(f"{{{XFORMS}}}itext") if self.model is not None else None
        return tuple(child for child in _children(itext) if _local(child) == "translation") if itext is not None else ()

    @cached_property
    def default_translation(self):
        """The translation Core reads as the default: the one marked ``default``, else the first."""
        marked = [translation for translation in self.translations if translation.get("default") is not None]
        return (marked or list(self.translations) or [None])[0]

    @cached_property
    def itext_ids(self):
        return frozenset(
            text.get("id")
            for translation in self.translations
            for text in _children(translation)
            if _local(text) == "text" and text.get("id")
        )

    @cached_property
    def question_references(self):
        """Each attribute value by which a question names its itext as Vellum reads it, with what the text is:
        its controls' ``label``, ``hint``, ``help`` and ``alert``, the labels of a group or repeat
        (``container-label``), the choices' labels (``choice``), its repeat captions (``caption``;
        ``javaRosa/plugin.js::populateControlMug``, ``parseRepeatItexts``), and its binds' validation messages
        (``message``, ``getITextID``), in document order."""
        found = []
        for element in self.body.iter() if self.body is not None else ():
            if not isinstance(element.tag, str):
                continue
            parent = element.getparent()
            local = _local(element)
            parent_kind = _local(parent)
            if local in ("label", "hint", "help", "alert") and parent_kind in QUESTION_CONTROLS | {"item"}:
                kind = local
                if local == "label":
                    if parent_kind == "item":
                        kind = "choice"
                    elif parent_kind in {"group", "repeat"}:
                        kind = "container-label"
                found.append((element.get("ref"), kind))
            elif element.tag in (f"{{{JAVAROSA}}}addCaption", f"{{{JAVAROSA}}}addEmptyCaption"):
                found.append((element.get("ref"), "caption"))
        for binds in self.binds.values():
            found += [(bind.get(f"{{{JAVAROSA}}}constraintMsg"), "message") for bind in binds]
        return tuple((value, kind) for value, kind in found if value is not None)

    @cached_property
    def long_text_owners(self):
        """The text IDs named by the form's question references, retaining the kind of each owner.

        The same XPath grammar as the observer reads the owning references directly from the form.
        These classes can therefore judge the authored variants before device observations exist.
        """
        kinds = {}
        for reference, kind in self.question_references:
            if (text_id := _question_text_id(reference)) is not None:
                kinds.setdefault(text_id, set()).add(kind)
        return kinds

    def tree(self, text):
        """HQ's XPath grammar's structure of an expression (the observation's ``trees``), or None where the records
        hold none."""
        if self.readings is None or text is None:
            return None
        return self.readings.trees.get(text)

    @cached_property
    def protected_constraint_messages(self):
        """The protected messages whose expression, itext group and technical question own one another.

        Read the exported structure, not Nova's emitter. Core registers arbitrary nonempty form names
        (``XFormParser.parseTextHandle``), evaluates a constraint's message (``Constraint``), and appends
        the requested output form to an itext id (``FormDef.initEvalContext``). Vellum retains arbitrary
        forms and raw constraint messages, but keeps a group only through a question's direct itext
        reference (``javaRosa/plugin.js::{loadXML,populateControlMug,contributeToModelXML}``). The empty,
        irrelevant, readonly sibling input supplies that reference. Its identity form prevents HQ's
        ``XForm.normalize_itext`` from merging equal groups while rewriting only their base references.

        This is a finite structural class, never an exemption for a name prefix. Piece ordinals need
        not be contiguous; language values can be empty; the composition's typed expressions can use
        any XPath Core accepts. Their function and grammar uses are judged separately by the manifest.
        """
        if self.readings is None:
            return {}
        found = {}
        for binds in self.binds.values():
            for bind in binds:
                message = bind.get(f"{{{JAVAROSA}}}constraintMsg")
                parsed, tree = self.parsed(message), self.tree(message)
                source = self.node(bind.get("nodeset"))
                controls = self.question_controls(bind.get("nodeset"))
                if (
                    parsed is None
                    or "error" in parsed
                    or tree is None
                    or not bind.get("constraint")
                    or source is None
                    or isinstance(source, tuple)
                    or len(controls) != 1
                    or self.bind(bind.get("nodeset")) is not bind
                ):
                    continue
                # The outer media choice must name exactly the same base in its test and true branch.
                if tree[:2] != ["call", "if"] or len(tree[2]) != 3:
                    continue
                condition, media, composition = tree[2]
                base = _exact_itext_id(media)
                if base is None or condition != [
                    "binary",
                    "=",
                    ["call", "jr:itext", [["text", f"{base};__nova_mode"]]],
                    ["text", "media"],
                ]:
                    continue
                values = _protected_message_values(self, base)
                if values is None:
                    continue
                forms, elements = values
                runtime_ids = {base, f"{base};__nova_mode", f"{base};__nova_locale"} | {
                    f"{base};{name}" for name in forms if name.startswith("__nova_piece_") and ";" not in name
                }
                if any(
                    len(arguments) != 1 or arguments[0][0] != "text" or arguments[0][1] not in runtime_ids
                    for arguments in _calls(composition, "jr:itext")
                ):
                    continue
                for path, node in self.nodes.items():
                    if (
                        isinstance(node, tuple)
                        or node.getparent() is not source.getparent()
                        or not _constraint_carrier_name(_local(node), _local(source))
                        or node.attrib
                        or _children(node)
                        or (node.text or "").strip()
                    ):
                        continue
                    carrier = self.bind(path)
                    inputs = self.question_controls(path)
                    if (
                        carrier is None
                        or len(self.binds[path]) != 1
                        or dict(carrier.attrib)
                        != {"nodeset": path, "type": "xsd:string", "relevant": "false()", "readonly": "true()"}
                        or len(inputs) != 1
                        or inputs[0].tag != f"{{{XFORMS}}}input"
                        or dict(inputs[0].attrib) != {"ref": path}
                        or (inputs[0].text or "").strip()
                        or inputs[0].getparent() is not controls[0].getparent()
                    ):
                        continue
                    children = _children(inputs[0])
                    if len(children) != 1 or children[0].tag != f"{{{XFORMS}}}label":
                        continue
                    label = children[0]
                    label_ref = label.get("ref")
                    label_parse = self.parsed(label_ref)
                    if (
                        set(label.attrib) != {"ref"}
                        or _children(label)
                        or (label.text or "").strip()
                        or (label.tail or "").strip()
                        or label_parse is None
                        or "error" in label_parse
                        or _exact_itext_id(self.tree(label_ref)) != base
                    ):
                        continue
                    found[bind] = (carrier, elements)
                    break
        return found

    @cached_property
    def itext_references(self):
        """``(kinds, unplaced)``: each itext id a question reference names (``question_references``), with what
        the text is there, and whether a reference holds no structure in the records. A reference names the id
        Vellum's ``getITextID`` reads in it (``javaRosa/plugin.js``: an expression that is a ``jr:itext`` call
        names its first argument's value, ``_itext_id``; any other names none), read over the reference's
        structure as HQ's XPath grammar reads it (the observation's ``trees``, which hold every expression Core's
        parse reads a ``jr:itext`` call in); one Core's parse reads no such call in names none."""
        kinds, unplaced = {}, False
        for value, kind in self.question_references:
            parsed = self.parsed(value)
            if parsed is None:
                unplaced = unplaced or bool(value.strip())
                continue
            if "error" in parsed or "jr:itext" not in parsed["functions"]:
                continue
            tree = self.tree(value)
            if tree is None:
                unplaced = True
                continue
            text_id = _itext_id(tree)
            if text_id is not None:
                kinds.setdefault(text_id, set()).add("label" if kind == "container-label" else kind)
        return {text_id: frozenset(held) for text_id, held in kinds.items()}, unplaced

    @cached_property
    def question_itext(self):
        """``(ids, unplaced)``: the itext ids a question reference names, and whether a reference holds no
        structure in the records (``itext_references``)."""
        kinds, unplaced = self.itext_references
        return frozenset(kinds), unplaced

    def itext_blank(self, text_id):
        """Whether no value of a text holds content in any language (Vellum's ``isEmpty``)."""
        for translation in self.translations:
            for text in _children(translation):
                if _local(text) == "text" and text.get("id") == text_id:
                    if any(value.text or _children(value) for value in _children(text) if _local(value) == "value"):
                        return False
        return True

    @cached_property
    def itext_reads(self):
        """``(ids, unplaced)``: the itext ids every other expression reads (an attribute value Core's parse reads a
        ``jr:itext`` call in, a question's reference aside), each such call's string argument over the
        expression's structure as HQ's XPath grammar reads it, and whether one holds no structure in the records or
        calls ``jr:itext`` on a value only the run time knows; None where the form holds no readings."""
        if self.readings is None:
            return None
        questions = {value for value, _ in self.question_references}
        ids, unplaced = set(), False
        for element in self.root.iter():
            if not isinstance(element.tag, str):
                continue
            for value in element.attrib.values():
                if value in questions or not value.strip():
                    continue
                parsed = self.parsed(value)
                if parsed is None:
                    unplaced = True
                    continue
                if "error" in parsed or "jr:itext" not in parsed["functions"]:
                    continue
                tree = self.tree(value)
                if tree is None:
                    unplaced = True
                    continue
                for arguments in _calls(tree, "jr:itext"):
                    if arguments and arguments[0][0] == "text":
                        ids.add(arguments[0][1])
                    else:
                        unplaced = True
        return frozenset(ids), unplaced

    @cached_property
    def vellum_hashtags(self):
        """What Vellum's parser reads of the form's hashtags (``parser.js::initHashtags``, ``form.js``): ``(map,
        prefixes)``, the head's ``vellum:hashtags`` (a hashtag to the XPath it stands for, or null) and its
        ``vellum:hashtagTransforms`` prefixes (a hashtag prefix to the XPath its last segment is appended to)."""
        found = []
        for name in ("hashtags", "hashtagTransforms"):
            element = self.head.find(f"{{{VELLUM}}}{name}") if self.head is not None else None
            try:
                value = json.loads((element.text or "").strip()) if element is not None else {}
            except ValueError:
                value = {}
            found.append(value if isinstance(value, dict) else {})
        prefixes = found[1].get("prefixes")
        return found[0], prefixes if isinstance(prefixes, dict) else {}

    @cached_property
    def mug_hashtags(self):
        """The path each question's hashtag stands for (``form.js::_fixMugState``: ``#form/<its path below the
        data root>``, and ``#form`` for the data root), by the hashtag."""
        found = {"#form": f"/{_local(self.data_root)}"} if self.data_root is not None else {}
        root = f"/{_local(self.data_root)}" if self.data_root is not None else ""
        for element in self.vellum_nodes:
            path = _path_of(self, element)
            found.setdefault(f"#form{path[len(root) :]}", path)
        return found


# The data-node roles Vellum's parser reads in Nova's configurations (``parser.js::parseDataElement`` reads
# ``vellum:role`` only where the role's mug type ``supportsDataNodeRole``, and a mug type exists only where HQ loads
# its plugin, ``views/formdesigner.py::_get_vellum_plugins``): a model iteration's Repeat (``modeliteration.js``,
# always loaded), SaveToCase (``saveToCase.js``, under the VELLUM_SAVE_TO_CASE privilege, which a configuration
# grants where the form holds a SaveToCase block, ``proof.checks.configurations``) and the Connect blocks
# (``commcareConnect.js``, under the COMMCARE_CONNECT flag of the configurations that export them). The CommTrack
# transactions (``commtrack.js``: Balance, Transfer, Dispense, Receive, with the ledger blocks its
# ``parseDataElement`` gives a role to) load only under COMMTRACK, which no configuration turns on
# (``proof/corpus/configurations.ts::documentConfigurations``: no document's publish needs it, and its gate entry,
# ``toggle/COMMTRACK``, is retiring, not target-owned), so their roles are read as no role. Each hands its
# parser none of its children (``parseDataNode``) but a model iteration, which hands on its ``item``'s.
DATA_ROLES = frozenset(
    {
        "SaveToCase",
        "Repeat",
        "ConnectLearnModule",
        "ConnectAssessment",
        "ConnectDeliverUnit",
        "ConnectTask",
        "ConnectWorkAreaUpdate",
    }
)


@cache
def _question_text_id(reference):
    tree = expression_tree(reference)
    return _itext_id(tree) if tree is not None else None


def _itext_id(tree):
    """The text id Vellum's ``getITextID`` reads in an expression (``javaRosa/plugin.js``: an expression that is a
    ``jr:itext`` call names its first argument's value), from its structure: the call's first argument where that
    is a string, else None (it names none)."""
    if tree[0] == "call" and tree[1] == "jr:itext" and tree[2] and tree[2][0][0] == "text":
        return tree[2][0][1]
    return None


def _exact_itext_id(tree):
    """A direct one-string-argument itext call, from HQ's recorded XPath structure."""
    if tree is not None and tree[:2] == ["call", "jr:itext"] and len(tree[2]) == 1 and tree[2][0][0] == "text":
        return tree[2][0][1]
    return None


def _constraint_carrier_name(name, source):
    """The generated sibling's stem, with an optional canonical positive collision suffix."""
    stem = f"nova_constraint_message_{source}"
    suffix = name.removeprefix(f"{stem}_")
    return name == stem or (
        name.startswith(f"{stem}_") and suffix.isascii() and suffix.isdecimal() and not suffix.startswith("0")
    )


def _protected_message_values(form, base):
    """All translations' finite helper forms and payloads, or None for a group outside this class.

    A message holds its four media modes (``__nova_mode;image``, ``;audio``, ``;video``, ``;video-inline``) all
    or none, the same in every translation: Nova writes none, since a validation message carries no media
    (defect 16), and a retained control keeps the four it was emitted with."""
    media_modes = {f"__nova_mode;{media}": "media" for media in ("image", "audio", "video", "video-inline")}
    modes = {"__nova_mode": "plain", "__nova_mode;markdown": "plain"} | media_modes
    always = {"__nova_mode", "__nova_mode;markdown", "__nova_identity", "__nova_locale", "__nova_locale;markdown"}
    allowed = {None, "markdown", "image", "audio", "video", "video-inline"}
    held, elements = None, set()
    if not form.translations:
        return None
    for translation in form.translations:
        texts = [text for text in _children(translation) if _local(text) == "text" and text.get("id") == base]
        if len(texts) != 1 or translation.get("lang") is None:
            return None
        values = {}
        for value in _children(texts[0]):
            name = value.get("form")
            if _local(value) != "value" or name in values:
                return None
            values[name] = value
        # The message's own markdown copy is optional: Nova writes none, and a retained control holds the one it
        # was emitted with.
        if None not in values:
            return None
        internal = set(values) - allowed
        held_media = internal & set(media_modes)
        if held_media and held_media != set(media_modes):
            return None
        required = always | held_media
        pieces = set()
        for name in internal - required:
            ordinal = name.removesuffix(";markdown").removeprefix("__nova_piece_")
            if not (
                name.startswith("__nova_piece_")
                and ordinal.isascii()
                and ordinal.isdecimal()
                and (ordinal == "0" or not ordinal.startswith("0"))
                and name in (f"__nova_piece_{ordinal}", f"__nova_piece_{ordinal};markdown")
            ):
                return None
            pieces.add(f"__nova_piece_{ordinal}")
        expected = required | pieces | {f"{piece};markdown" for piece in pieces}
        if internal != expected or (held is not None and internal != held):
            return None
        held = internal
        payloads = modes | {
            "__nova_identity": base,
            "__nova_locale": translation.get("lang"),
            "__nova_locale;markdown": translation.get("lang"),
        }
        for name in internal:
            value = values[name]
            if _children(value) or set(value.attrib) != {"form"}:
                return None
            content = value.text or ""
            if name in payloads:
                if content != payloads[name]:
                    return None
            else:
                try:
                    payload = json.loads(content)
                except ValueError:
                    return None
                if not content.isascii() or not isinstance(payload, dict) or set(payload) != {"v"}:
                    return None
                if not isinstance(payload["v"], str):
                    return None
                plain = name.removesuffix(";markdown")
                if content != (values[plain].text or "") or f"{plain};markdown" not in values:
                    return None
            elements.add(value)
    return held, frozenset(elements)


def protected_constraint_form(use):
    """A dynamically named itext form owned by a fully classified protected message graph."""
    form, value = _itext_value(use)
    return (
        value is not None
        and form.readings is not None
        and any(value in elements for _, elements in form.protected_constraint_messages.values())
    )


def _calls(tree, name):
    """The arguments of each call to ``name`` an expression's structure holds, at any depth."""
    kind = tree[0]
    if kind == "call":
        if tree[1] == name:
            yield tree[2]
        for argument in tree[2]:
            yield from _calls(argument, name)
    elif kind == "binary":
        yield from _calls(tree[2], name)
        yield from _calls(tree[3], name)
    elif kind == "negative":
        yield from _calls(tree[1], name)
    elif kind == "path":
        for predicate in tree[3]:
            yield from _calls(predicate, name)


def _paths(tree):
    """Each location path an expression's structure holds, at any depth (its predicates' and arguments' too)."""
    kind = tree[0]
    if kind == "path":
        yield tree
        for predicate in tree[3]:
            yield from _paths(predicate)
    elif kind == "binary":
        yield from _paths(tree[2])
        yield from _paths(tree[3])
    elif kind == "negative":
        yield from _paths(tree[1])
    elif kind == "call":
        for argument in tree[2]:
            yield from _paths(argument)


def _shape(tree):
    """An expression's structure without the text eulxml serializes each path as, so two spellings of one
    expression (white space, a hashtag Vellum resolves) compare alike."""
    kind = tree[0]
    if kind == "path":
        return ("path", tree[1], tuple(_shape(predicate) for predicate in tree[3]), tuple(map(tuple, tree[4])))
    if kind == "binary":
        return ("binary", tree[1], _shape(tree[2]), _shape(tree[3]))
    if kind == "negative":
        return ("negative", _shape(tree[1]))
    if kind == "call":
        return ("call", tree[1], tuple(_shape(argument) for argument in tree[2]))
    return tuple(tree)


def _declared_instances(root):
    """Each ``(id, src)`` a document's ``<instance>`` elements declare with both, in order."""
    return tuple(
        (element.get("id"), element.get("src"))
        for element in root.iter()
        if isinstance(element.tag, str)
        and etree.QName(element).localname == "instance"
        and element.get("id") is not None
        and element.get("src") is not None
    )


def instance_scheme(instance_id):
    """The scheme HQ's build reads in an instance id (``suite_xml/post_process/instances.py::get_instance_factory``).

    The id's part before its first ``:``, or the whole id; an id holding
    ``selected_cases`` without a ``:`` is that scheme.
    """
    if ":" in instance_id:
        return instance_id.split(":", 1)[0]
    return "selected_cases" if "selected_cases" in instance_id else instance_id


def preset_source(manifest, instance_id):
    """The source HQ's build declares an app JSON slot's read of ``instance_id`` under in the suite it writes: the
    source of the preset instance its scheme's factory gives that id (``instances.py::preset_instances``, recorded
    as the scheme item's ``preset``), or None where no preset of that id is the scheme's."""
    item = manifest.item(f"instance-scheme:{instance_scheme(instance_id)}") or {}
    preset = item.get("preset")
    if isinstance(preset, dict) and preset.get("id") == instance_id:
        return preset.get("src")
    return None


def instance_source(manifest, src):
    """The branch of ``CommCareInstanceInitializer.generateRoot`` an instance's ``src`` reaches.

    The surface records each branch with its place in the dispatch order and
    its test (``contains`` or ``startsWith`` its token); the first branch whose
    test holds is the instance's source, and none is ``(none)``.
    """
    branches = []
    for token in manifest.family("instance-source"):
        item = manifest.item(f"instance-source:{token}")
        if item.get("match") is None:
            continue
        branches.append((item["order"], token, item["match"]))
    for _, token, match in sorted(branches):
        if match == "contains" and token in src:
            return f"instance-source:{token}"
        if match == "startsWith" and src.startswith(token):
            return f"instance-source:{token}"
        if match not in ("contains", "startsWith"):
            raise InstanceSourceUnknown(
                f"The surface records the instance source {token!r} as matched by {match!r}, which the manifest"
                " check does not know how to apply; teach proof/checks/manifest_value_classes.py::instance_source"
                " that rule."
            )
    return "instance-source:(none)"


class InstanceSourceUnknown(ValueError):
    """The surface records an instance source matched by a rule the check cannot apply."""


# The body elements a question is (XFormParser's control handlers, with the groups and repeats Vellum makes
# questions of).
QUESTION_CONTROLS = frozenset({"input", "secret", "select", "select1", "trigger", "upload", "range", "group", "repeat"})


class Runtime:
    """A suite or a profile as the value classes read it."""

    kind = "runtime"

    def __init__(self, root, artifact):
        self.root = root
        self.artifact = artifact
        self.readings = None
        self.case_types = None  # the document's declared types, or the optional metadata a control retained

    @cached_property
    def declared_instances(self):
        """Each ``(id, src)`` the document declares, in order."""
        return _declared_instances(self.root)

    def parsed(self, text):
        """Core's parse of an expression's text, as the observation read it, or None where it holds none."""
        if self.readings is None or text is None:
            return None
        return self.readings.expressions.get(text)

    def tree(self, text):
        """HQ's XPath grammar's structure of an expression (the observation's ``trees``), or None where the records
        hold none."""
        if self.readings is None or text is None:
            return None
        return self.readings.trees.get(text)


class App:
    """An app JSON as the value classes read it: the document, each form's XForm (``Form``) and the
    configurations Nova's publishes sent it under (``proof.checks.corpus.Configuration``; None where the reading
    was given none), which a class that turns on a project-space flag reads."""

    kind = "app"

    def __init__(self, doc, artifact, configurations=None, authored=False, read=False):
        self.doc = doc
        self.artifact = artifact
        self.configurations = None if configurations is None else tuple(configurations)
        # The app HQ made, on a document made in CommCare HQ: its multimedia map names the files HQ holds for it
        # (``Readings.authored_media``), never those of Nova's local archive.
        self.authored = authored
        # The app HQ made of a corpus document: the corpus holds a base only where Nova's reader reads it
        # (``proof/corpus/hqAuthored.ts``, ``expected.json``'s ``reads``), so a use only that reader settles is one
        # it held. A variant's app, which parity reads, may be refused, and is not.
        self.read = read
        self.forms = {}  # a form's unique_id -> Form
        self.readings = None
        self.case_types = None  # the document's declared types, or the optional metadata a control retained

    @cached_property
    def detail_sources(self):
        """Each named detail's common external instance sources across all built entries and suites."""
        suites = _app_suites(self)
        if not suites:
            return None
        scopes = {}
        detail_attributes = ("detail-select", "detail-confirm", "detail-inline", "detail-persistent")
        for suite in suites:
            known = {detail.get("id") for detail in suite.root.findall("detail")}
            for entry in suite.root:
                if entry.tag not in ("entry", "remote-request"):
                    continue
                reached = {
                    datum.get(attr) for datum in entry.iterfind("./session/*")
                    if datum.tag in ("datum", "instance-datum") for attr in detail_attributes
                } & known
                declared = {}
                for instance in entry.findall("instance"):
                    name = instance.get("id")
                    declared[name] = None if name in declared else instance.get("src")
                sources = {(name, src) for name, src in declared.items() if name and src}
                for name in reached:
                    if name in scopes:
                        scopes[name].intersection_update(sources)
                    else:
                        scopes[name] = sources.copy()
        return {name: dict(values) for name, values in scopes.items()}

    @cached_property
    def modules(self):
        return [module for module in self.doc.get("modules") or [] if isinstance(module, dict)]

    @cached_property
    def modules_by_id(self):
        return {module.get("unique_id"): module for module in self.modules if module.get("unique_id")}

    @cached_property
    def form_modules(self):
        """Each form's module, by the form object's identity."""
        return {id(form): module for module in self.modules for form in _forms(module)}

    @cached_property
    def forms_by_id(self):
        return {form.get("unique_id"): form for module in self.modules for form in _forms(module)}

    def module_of(self, form):
        return self.form_modules.get(id(form))

    def xform(self, form):
        """The parsed XForm of a form, or None."""
        return self.forms.get((form or {}).get("unique_id"))

    def root(self, module):
        """The module a module sits under (``root_module_id``), or None."""
        return self.modules_by_id.get(module.get("root_module_id")) if module.get("root_module_id") else None

    def parsed(self, text):
        if self.readings is None or text is None:
            return None
        return self.readings.expressions.get(text)

    def tree(self, text):
        """HQ's XPath grammar's structure of an expression (the observation's ``trees``), or None where the records
        hold none."""
        if self.readings is None or text is None:
            return None
        return self.readings.trees.get(text)

    @cached_property
    def endpoint_ids(self):
        return _gather_endpoint_ids(self)


def _forms(module):
    return [form for form in module.get("forms") or [] if isinstance(form, dict)]


# Readers ----------------------------------------------------------------------


def _xml(use, kind=None):
    at = use.at
    if not isinstance(at, XmlAt) or (kind is not None and at.document.kind != kind):
        return None
    return at


def _form_element(use):
    """The XForm element a use sits on, with its form, or (None, None)."""
    at = _xml(use, "xform")
    return (at.document, at.element) if at is not None else (None, None)


def _type_bind(use):
    """The bind a ``jr-type`` use sits on (its ``type``), with its form, or (None, None)."""
    form, element = _form_element(use)
    if form is None or _local(element) != "bind" or element.get("type") is None:
        return None, None
    return form, element


def _data_type(text):
    """A bind type as Core reads it (``XFormParser.getDataType``: the part after the first ``:``)."""
    return text.split(":", 1)[1] if ":" in text else text


def _core_datatypes(manifest, type_text):
    """The datatype Core gives a bind type, as the surface records ``XFormParser.typeMappings`` (``jr-type``);
    a type it maps nowhere is ``DATATYPE_UNSUPPORTED`` (``getDataType``)."""
    item = manifest.item(f"jr-type:{_data_type(type_text)}") or {}
    return tuple(item.get("datatypes") or ("DATATYPE_UNSUPPORTED",))


# Vellum's input mugs by the type its parser reads (``parser.js::buildControlNodeAdaptorMap``'s
# ``inputAdaptors``: the type with its first ``xsd:`` removed, lowercased), with the type each writes back
# (``mugs/types/*.js`` ``dataType``; ``intentManager.js`` for the callout).
VELLUM_INPUT_TYPES = {
    "string": "xsd:string",
    "long": "xsd:long",
    "int": "xsd:int",
    "double": "xsd:double",
    "date": "xsd:date",
    "datetime": "xsd:dateTime",
    "time": "xsd:time",
    "geopoint": "geopoint",
    "barcode": "barcode",
    "intent": "intent",
}


def _vellum_type(type_text):
    """A bind type as Vellum's input adaptor reads it (``type.replace('xsd:', '').toLowerCase()``)."""
    return type_text.replace("xsd:", "", 1).lower()


def _question_control(use):
    """The question control a use names: the element itself (a ``jr-control`` use), or the control HQ's
    question reader found at the use's path (a ``mug`` use), with its form; (None, None) otherwise."""
    form, element = _form_element(use)
    if form is None:
        return None, None
    if _local(element) in QUESTION_CONTROLS and element.getparent() is not None:
        return form, element
    return None, None


def _bind_controls(form, bind):
    return form.question_controls(bind.get("nodeset"))


def head_child(use, manifest):
    """``questions/other-h-head-children-…`` (head-child-dispatched-by-local-name): an element under an
    ``<h:head>`` child other than HQ's own head content, which Core dispatches by its local name all the same
    (``XFormParser.parseElement``'s ``topLevelHandlers``). HQ's own are the first ``<h:title>``, the first
    XForms ``<model>``, every ``<odkx:intent>`` and every element in Vellum's namespace (the INERT companion
    row, ``questions/h-head-children-other-than-hq-s-own-…``)."""
    form, element = _form_element(use)
    if form is None:
        return None
    head = form.head
    child = element
    while child is not None and child.getparent() is not head:
        child = child.getparent()
    if child is None:
        return False
    if child is form.model or child is head.find(f"{{{XHTML}}}title"):
        return False
    name = etree.QName(child)
    return not (name.namespace == VELLUM or (name.namespace == OPENDATAKIT and name.localname == "intent"))


def savetocase_leaf_type(use, manifest):
    """``questions/type-on-a-savetocase-property-leaf-…``: a bind ``type`` on a SaveToCase property leaf, a
    child of its case's ``create``, ``update`` or ``index`` (``saveToCase.js``, which drops it). The
    ``@date_modified`` Vellum types itself is no such leaf."""
    form, bind = _type_bind(use)
    if form is None:
        return None
    node = form.node(bind.get("nodeset"))
    if node is None:
        return None
    if isinstance(node, tuple):
        return False
    parent = node.getparent()
    case = parent.getparent() if parent is not None else None
    return bool(
        _local(parent) in ("create", "update", "index")
        and case is not None
        and case.tag == f"{{{CASE}}}case"
        and case.getparent() is not None
        and case.getparent().get(f"{{{VELLUM}}}role") == "SaveToCase"
    )


# Core's choice types (XFormParser.typeMappings: listItem, select1 as DATATYPE_CHOICE; listItems, select as
# DATATYPE_CHOICE_LIST) and its text.
CHOICE_OR_TEXT = frozenset({"DATATYPE_CHOICE", "DATATYPE_CHOICE_LIST", "DATATYPE_TEXT"})
NUMERIC = frozenset({"DATATYPE_INTEGER", "DATATYPE_LONG", "DATATYPE_DECIMAL"})


def non_choice_type_on_select(use, manifest):
    """``questions/a-select-whose-bind-type-is-neither-a-choice-type-nor-a-…``: a bind type on a select's node
    that Core reads as neither a choice type nor text (``XFormParser.typeMappings``); Vellum drops it."""
    form, bind = _type_bind(use)
    if form is None:
        return None
    if not any(_local(control) in SELECTS for control in _bind_controls(form, bind)):
        return False
    return not set(_core_datatypes(manifest, bind.get("type"))) & CHOICE_OR_TEXT


def numeric_type_on_secret(use, manifest):
    """``questions/secret-with-a-numeric-bind-type``: a ``<secret>``'s bind type Core reads as a number."""
    form, bind = _type_bind(use)
    if form is None:
        return None
    if not any(_local(control) == "secret" for control in _bind_controls(form, bind)):
        return False
    return bool(set(_core_datatypes(manifest, bind.get("type"))) & NUMERIC)


def _input_type_vellum_does_not_write(form, control, manifest):
    """Whether an ``<input>``'s bind type is one a Vellum save changes Core's reading of: a type Vellum's
    input adaptor does not know (it writes ``xsd:string``), or a spelling of one it knows that Core reads
    otherwise than the spelling Vellum writes (``xsd:Int``: Core's type names are case-sensitive)."""
    if control.get("readonly") == "true()":
        return False  # Vellum reads it as a label (readonly-input), before its type
    bind = form.control_bind(control)
    if bind is None or bind.get("type") is None:
        return False  # an untyped input is the untyped rows'
    raw = bind.get("type")
    written = VELLUM_INPUT_TYPES.get(_vellum_type(raw))
    if written is None:
        return True
    return _core_datatypes(manifest, raw) != _core_datatypes(manifest, written)


def type_vellum_does_not_write(use, manifest):
    """``questions/input-whose-bind-type-vellum-does-not-write-…``: an input whose bind type Vellum does not
    write (``parser.js::buildControlNodeAdaptorMap`` ``input``), read on the input (``jr-control:input``,
    ``mug:Text``) and on its bind's type (``jr-type``)."""
    form, element = _form_element(use)
    if form is None:
        return None
    if _local(element) == "bind":
        inputs = [control for control in _bind_controls(form, element) if _local(control) == "input"]
        return any(_input_type_vellum_does_not_write(form, control, manifest) for control in inputs)
    if _local(element) != "input":
        return False
    return _input_type_vellum_does_not_write(form, element, manifest)


def _untyped_numeric(local):
    def reader(use, manifest):
        form, control = _question_control(use)
        if form is None:
            return None
        if _local(control) != local:
            return False
        bind = form.control_bind(control)
        if bind is not None and bind.get("type") is not None:
            return False
        return (control.get("appearance") or "").lower() in ("numeric", "numbers")

    reader.__doc__ = (
        f"An ``<{local}>`` whose bind has no ``type``, with ``numeric`` or ``numbers``, ignoring case, as its"
        " whole appearance (Android's ``WidgetFactory.buildBasicWidget`` sends DATATYPE_NULL to its plain text"
        " widget, which ignores it)."
    )
    return reader


def long_input(use, manifest):
    """``questions/long-xsd-long``: an input Vellum reads as its Long (``inputAdaptors.long``), which it no
    longer lets anyone add; read on the input and on its bind's type."""
    form, element = _form_element(use)
    if form is None:
        return None
    if _local(element) == "bind":
        inputs = [control for control in _bind_controls(form, element) if _local(control) == "input"]
        return bool(inputs) and _vellum_type(element.get("type")) == "long"
    if _local(element) != "input" or element.get("readonly") == "true()":
        return False
    bind = form.control_bind(element)
    return bind is not None and bind.get("type") is not None and _vellum_type(bind.get("type")) == "long"


PRINT_ACTION = "org.commcare.dalvik.action.PRINT"


def _android_action_presence(use):
    """An input's appearance names its action. An intent-typed input using
    that name owns the definition; ordinary inputs may refer to that owner."""
    form, element = _form_element(use)
    if form is None:
        return None
    if element.tag != f"{{{XFORMS}}}input" or not (appearance := element.get("appearance", "")).startswith("intent:"):
        return "other"
    if appearance[len("intent:"):] not in form.intents:
        return "missing"
    if any(control.tag == f"{{{XFORMS}}}input" and control.get("appearance") == appearance
           and (bind := form.control_bind(control)) is not None and _vellum_type(bind.get("type") or "") == "intent"
           for controls in form.controls.values() for control in controls):
        return "owned"
    return "orphan"


def missing_android_action(use, _manifest):
    state = _android_action_presence(use)
    return None if state is None else state == "missing"


def orphan_android_action(use, _manifest):
    state = _android_action_presence(use)
    return None if state is None else state == "orphan"


def unreproducible_android_question(use, manifest):
    """Vellum takes the intent tagged with the question's node ID while Android
    takes the one named by its appearance. A named result has to resolve at
    every invoking input, including its concrete repeat row."""
    form, element = _form_element(use)
    if form is None:
        return None
    if element.tag == f"{{{OPENDATAKIT}}}intent":
        intent = element
        action_id = intent.get("id")
        invoking = None
    elif element.tag == f"{{{XFORMS}}}input" and (element.get("appearance") or "").startswith("intent:"):
        invoking = element
        action_id = element.get("appearance")[len("intent:"):]
        intent = form.intents.get(action_id)
    else:
        return False
    if intent is None:
        return False
    head = form.root.find(f"{{{XHTML}}}head")
    duplicates = head is not None and sum(
        el.get("id") == action_id for el in head.findall(f"{{{OPENDATAKIT}}}intent")
    ) > 1
    using = [control for controls in form.controls.values() for control in controls
             if control.tag == f"{{{XFORMS}}}input" and control.get("appearance") == f"intent:{action_id}"]
    owners = [control for control in using if (bind := form.control_bind(control)) is not None
              and _vellum_type(bind.get("type") or "") == "intent"]
    if not owners:
        return False  # An orphan tag has its own entry.
    owner = owners[0]
    owner_path = form.control_path(owner)
    if len(owners) != 1 or duplicates:
        return True
    if intent.get("appearance") == "quick" or intent.get("class") == PRINT_ACTION:
        return False
    if (owner_path or "").rsplit("/", 1)[-1] != action_id:
        return True
    if not intent.get("class") or set(intent.attrib) - {"id", "class"} or (intent.text or "").strip():
        return True
    if intent is not form.intents.get(action_id):
        return True
    for tag in ("extra", "response"):
        keys = [arg.get("key") for arg in _children(intent) if arg.tag == f"{{{XFORMS}}}{tag}"]
        if "__proto__" in keys or "hasOwnProperty" in keys[:-1]:
            return True
    for arg in _children(intent):
        if arg.tag not in {f"{{{XFORMS}}}extra", f"{{{XFORMS}}}response"} or not arg.get("key") or not arg.get("ref"):
            return True
        if set(arg.attrib) - {"key", "ref", f"{{{VELLUM}}}ref"} or _children(arg) or (arg.text or "").strip():
            return True
        if arg.tag == f"{{{XFORMS}}}response":
            ref = arg.get("ref")
            target = posixpath.normpath(posixpath.join(owner_path, ref))
            node = form.node(target)
            if node is None or isinstance(node, tuple) or _children(node):
                return True
            for source in ([invoking] if invoking is not None else [owner]):
                here = form.control_path(source)
                if here is None or posixpath.normpath(posixpath.join(here, ref)) != target:
                    return True
                if any(target.startswith(row + "/") and not here.startswith(row + "/") for row in form.repeat_paths):
                    return True
    return False


def print_callout(use, manifest):
    """``questions/print-callout-…``: an input Vellum reads as an Android callout (bind type ``intent``)
    whose ``<odkx:intent>`` (by the question's node name, ``intentManager.js::syncMugWithIntent``) has the
    print action's class, which Vellum turns into its Print question."""
    form, element = _form_element(use)
    if form is None:
        return None
    if element.tag != f"{{{XFORMS}}}input":
        return False
    if use.key == "appearance:android/intent:":
        # Android follows the input's named action, including an adopted
        # callout whose action ID differs from Vellum's question node name.
        appearance = element.get("appearance", "")
        intent = form.intents.get(appearance.removeprefix("intent:"))
        return intent is not None and intent.get("class") == PRINT_ACTION and _android_action_presence(use) == "owned"
    if not any(intent.get("class") == PRINT_ACTION for intent in form.intents.values()):
        return False
    bind = form.control_bind(element)
    if bind is None or _vellum_type(bind.get("type") or "") != "intent":
        return False
    node = form.node(form.control_path(element))
    if node is None or isinstance(node, tuple):
        return None
    intent = form.intents.get(_local(node))
    return intent is not None and intent.get("class") == PRINT_ACTION


# The itext forms that carry a file, as Core's Localizer keys them (``<id>;<form>``): a question label's inline
# video (``video-inline``) among them, whose file HQ ships beside a video's (``xform.py::video_references``).
MEDIA_ITEXT_FORMS = frozenset({"image", "audio", "video", "video-inline"})


# A question label's other texts, as Core's Localizer keys them (``<id>;<form>``): ``long``, ``qrcode`` and
# ``tts`` (``lib/domain/labelForms.ts``).
LABEL_TEXT_ITEXT_FORMS = frozenset({"long", "qrcode", "tts"})


def _media_itext_group(use, forms=MEDIA_ITEXT_FORMS):
    """The value of one of ``forms`` a use sits on and every value of the same text id and form across the form's
    translations, as ``(form, values by translation)``; None where the use sits on no such value."""
    form, element = _form_element(use)
    if form is None or _local(element) != "value":
        return None
    kind = element.get("form")
    text = element.getparent()
    if kind not in forms or text is None or _local(text) != "text" or not text.get("id"):
        return None
    text_id = text.get("id")
    values = {}
    for translation in form.translations:
        for candidate in _children(translation):
            if _local(candidate) != "text" or candidate.get("id") != text_id:
                continue
            for value in _children(candidate):
                if _local(value) == "value" and value.get("form") == kind:
                    values[translation] = value
    return form, values


def media_missing_in_default(use, manifest):
    """``questions/media-form-missing-in-default-language``: an image, audio, video or inline video value whose text the
    form's default translation holds without that form. Core keys each locale's forms over the default's
    (``Localizer.getLocaleData`` raises ``NoLocalizedTextException`` for a key the default lacks)."""
    group = _media_itext_group(use)
    if group is None:
        return None if _form_element(use)[0] is None else False
    form, values = group
    return form.default_translation is not None and form.default_translation not in values


def label_text_missing_in_default(use, manifest):
    """``questions/long-qrcode-or-tts-form-missing-in-default-language``: a ``long``, ``qrcode`` or ``tts`` value
    whose text the form's default translation holds without that form. Core keys each locale's forms over the
    default's (``Localizer.getLocaleData`` raises ``NoLocalizedTextException`` for a key the default lacks)."""
    group = _media_itext_group(use, LABEL_TEXT_ITEXT_FORMS)
    if group is None:
        return None if _form_element(use)[0] is None else False
    form, values = group
    return form.default_translation is not None and form.default_translation not in values


def inline_video_off_question_label(use, manifest):
    """An inline video referenced by a text Android does not read as a question label."""
    form, value = _itext_value(use)
    if form is None:
        return None
    if value is None or value.get("form") != "video-inline":
        return False
    owners = form.long_text_owners.get(value.getparent().get("id"), ())
    if inline_video_on_empty_help(use, manifest) and owners == {"help"}:
        return False
    return not {"hint", "help", "alert", "message", "choice", "container-label", "caption"}.isdisjoint(owners)


def inline_video_on_empty_help(use, manifest):
    """An otherwise empty help element keeps Android's help affordance."""
    form, value = _itext_value(use)
    if form is None:
        return None
    if value is None or value.get("form") != "video-inline":
        return False
    text_id = value.getparent().get("id")
    if "help" not in form.long_text_owners.get(text_id, ()):
        return False
    for translation in form.translations:
        for text in _children(translation):
            if _local(text) != "text" or text.get("id") != text_id:
                continue
            for candidate in _children(text):
                if _local(candidate) != "value":
                    continue
                role = candidate.get("form") or "default"
                if role == "long" or (
                    role in {"default", "audio", "image", "video"}
                    and (len(candidate) or (candidate.text or "").strip())
                ):
                    return False
    return True


def _long_form_on(owners):
    """A ``long`` value whose itext entry is referenced by one of these question text owners."""

    def reader(use, manifest):
        form, value = _itext_value(use)
        if form is None:
            return None
        if value is None or value.get("form") != "long":
            return False
        return not owners.isdisjoint(form.long_text_owners.get(value.getparent().get("id"), ()))

    return reader


def media_blank_beside_file(use, manifest):
    """``questions/empty-media-form-beside-a-translated-file``: an image, audio, video or inline video value of a text one
    translation holds blank and another holds a file of. Vellum's save fills the blank one from the file
    (``javaRosa/itext.js::getValueOrDefault``); Core keeps the empty string as that translation's own."""
    group = _media_itext_group(use)
    if group is None:
        return None if _form_element(use)[0] is None else False
    _, values = group
    blank = [value for value in values.values() if not "".join(value.itertext()).strip()]
    return bool(blank) and len(blank) < len(values)


def readonly_input(use, manifest):
    """``questions/input-readonly-true-control-attribute``: an ``<input readonly="true()">``, which Vellum
    turns into a label (``parser.js::buildControlNodeAdaptorMap``: ``popAttr('readonly') === 'true()'`` takes the
    trigger's adaptor). Read on the element a use sits on: HQ's question reader types such an input ``Text``
    (``xform.py::_infer_vellum_type`` reads the tag, the bind's type, the mediatype and the appearance, never
    ``readonly``), so a ``mug:Trigger`` use is a ``<trigger>``'s, outside the class."""
    form, element = _form_element(use)
    if form is None:
        return None
    return _local(element) == "input" and element.get("readonly") == "true()"


# The upload mediatypes Vellum reads (parser.js::buildControlNodeAdaptorMap ``upload``, after lowercasing), as
# Core matches them: exactly (XFormParser.parseUpload).
UPLOAD_MEDIATYPES = frozenset({"image/*", "audio/*", "video/*", "application/*,text/*"})


def other_upload_mediatype(use, manifest):
    """``questions/upload-with-any-other-mediatype-or-none``: an ``<upload>`` whose mediatype is none of the
    four Vellum reads, spelled as Core matches them."""
    form, element = _form_element(use)
    if form is None:
        return None
    if _local(element) != "upload":
        return False
    return element.get("mediatype") not in UPLOAD_MEDIATYPES


def invalid_image_dimension(use, manifest):
    """The numeric extension is consumed on every upload. Only ordinary ImageWidget
    and FaceCaptureWidget use a positive setting to resize a photo."""
    form, element = _form_element(use)
    if form is None or _local(element) != "upload":
        return None
    raw = element.get(f"{{{JAVAROSA}}}imageDimensionScaledMax")
    if raw is None:
        return False
    digits = raw.removesuffix("px")
    if not re.fullmatch(r"[+-]?[0-9]+", digits):
        return True
    significant = digits.lstrip("+-").lstrip("0") or "0"
    if len(significant) > 10:
        return True
    value = (-1 if digits.startswith("-") else 1) * int(significant)
    image = element.get("mediatype") == "image/*" and element.get("appearance") != "signature"
    if value < -2147483648 or value > 2147483647 or (image and (value == 0 or value < -1)):
        return True
    return False


# Setvalues ----------------------------------------------------------------------


def authored_pollsensor(use, manifest):
    """``questions/authored-orx-pollsensor``: an ``<orx:pollsensor>`` in a form's source, which Vellum drops
    (HQ's build writes its own from ``auto_gps_capture`` and the form's ``geopoint`` binds,
    ``xform.py::XForm._add_meta_2``). HQ's build appends its own to what it builds and never to the source, so
    every ``pollsensor`` a source holds is authored, wherever it sits and whatever it carries: a use on one is in
    the class. In a local archive the element is the one HQ's build writes, which
    ``questions/hq-generated-pollsensor`` holds before this entry is asked (``manifest_usage.standing``)."""
    form, element = _form_element(use)
    if form is None:
        return None
    return _local(element) == "pollsensor"


def _setvalue(use):
    """The setvalue element a use sits on (``jr-action:setvalue``, or its ``@event``), with its form: ``(form,
    None)`` for a use on another element of a form (an event a ``pollsensor`` carries, which names the same
    ``jr-event`` as a setvalue's), and ``(None, None)`` outside a form."""
    form, element = _form_element(use)
    if form is None:
        return None, None
    if _local(element) != "setvalue":
        return form, None
    return form, element


# What HQ's build writes into a form's meta block (xform.py::XForm._add_meta_2): each setvalue's target under
# the data root's meta, its event and its value.
HQ_META_SETVALUES = frozenset(
    {
        ("deviceID", "xforms-ready", "instance('commcaresession')/session/context/deviceid"),
        ("timeStart", "xforms-ready", "now()"),
        ("timeEnd", "xforms-revalidate", "now()"),
        ("username", "xforms-ready", "instance('commcaresession')/session/context/username"),
        ("userID", "xforms-ready", "instance('commcaresession')/session/context/userid"),
        ("instanceID", "xforms-ready", "uuid()"),
        ("appVersion", "xforms-ready", "instance('commcaresession')/session/context/appversion"),
        (
            "drift",
            "xforms-revalidate",
            "if(count(instance('commcaresession')/session/context/drift) = 1, "
            "instance('commcaresession')/session/context/drift, '')",
        ),
    }
)


def _core_action_attribute(element, local):
    """The attribute Core reads as an action's ``local``, as ``(its name, its value)``: the first of that local
    name in any namespace (``XFormParser.parseSetValueAction`` asks kxml2's ``Element.getAttributeValue(null,
    local)``, which matches a name whatever its namespace), the form builder's ``vellum:`` shadows left out, since
    HQ's build and Nova's local archive strip them before a device reads the form (``strip_vellum_ns_attributes``);
    None where it holds none."""
    for name, value in element.attrib.items():
        qualified = etree.QName(name)
        if qualified.localname == local and qualified.namespace != VELLUM:
            return name, value
    return None


def _xml_whitespace(text):
    """Whether ``text`` is XML's whitespace alone, which Core's parser drops between elements (``getXMLDocument``)."""
    return all(character in " \t\n\r" for character in text or "")


SETVALUE_HELD, SETVALUE_OTHER = "held", "other"


def _setvalue_spelling(setvalue):
    """Whether Core reads a setvalue as Nova writes one, the only spelling Nova's reader gives a target
    (``xform/model.ts::heldSetvalueRef``): no ``bind``, which Core reads in place of ``ref``; a plain ``ref`` that
    is an absolute path, where Core resolves a relative one from ``/``; a plain ``value``, where Core sets the
    element's text when it has none; a plain ``event`` or none; and nothing inside it. ``SETVALUE_HELD``,
    ``SETVALUE_OTHER``, or None where the port of Core's lexer does not read the ``ref``."""
    if _core_action_attribute(setvalue, "bind") is not None:
        return SETVALUE_OTHER
    ref = _core_action_attribute(setvalue, "ref")
    value = _core_action_attribute(setvalue, "value")
    event = _core_action_attribute(setvalue, "event")
    if ref is None or ref[0] != "ref" or value is None or value[0] != "value":
        return SETVALUE_OTHER
    if event is not None and event[0] != "event":
        return SETVALUE_OTHER
    if len(setvalue) or not _xml_whitespace(setvalue.text):
        return SETVALUE_OTHER
    found = xpath_tokens(ref[1])
    if found is None:
        return None
    return SETVALUE_HELD if found and found[0].kind == "SLASH" else SETVALUE_OTHER


def _held_ref(setvalue):
    """A setvalue's ``ref``, stripped, where Core reads it as Nova writes one (``_setvalue_spelling``), else None."""
    return setvalue.get("ref").strip() if _setvalue_spelling(setvalue) == SETVALUE_HELD else None


def _target(form, setvalue):
    """A setvalue's target node (an element, or ``(element, attribute)``) where Core reads it as Nova writes one
    (``_held_ref``), or None."""
    return form.node(_held_ref(setvalue))


def _unplaced_target(form, setvalue):
    """What a class of a setvalue's target says of one ``_target`` places nowhere: False outside the model, and for
    one Core reads otherwise than Nova writes, which is a form-level setvalue (``form_level_setvalue``) and no
    question's default; None for a model setvalue in Nova's spelling whose ``ref`` names no node here, or whose
    ``ref`` the port of Core's lexer does not read."""
    if not _model_level(form, setvalue) or _setvalue_spelling(setvalue) == SETVALUE_OTHER:
        return False
    return None


def _target_element(target):
    return target[0] if isinstance(target, tuple) else target


def _built_by_hq(form, setvalue, target):
    """Whether a setvalue is one HQ's build writes: one of its meta block's, or one into a case block it built
    from the form's actions (``XForm.add_case_and_meta``)."""
    held = form.holder(_target_element(target))
    if held is None:
        return False
    kind, holder = held
    if kind == "meta":
        name = _local(target) if not isinstance(target, tuple) else None
        return (name, setvalue.get("event") or "xforms-ready", setvalue.get("value")) in HQ_META_SETVALUES
    return kind == "case-block"


def _is_mug(form, target):
    """Whether Vellum's parser makes a question of a node (``form.getMugByPath`` finds one): an element of the
    main instance below its root, outside a SaveToCase node's content (``saveToCase.js``'s
    ``parseDataNode`` reads none of it) and outside the blocks HQ's build writes, and not a model
    iteration's ``item`` (the iteration's own path)."""
    if isinstance(target, tuple) or target is form.data_root:
        return False
    held = form.holder(target)
    if held is not None and not (held[0] == "save-to-case" and held[1] is target):
        return False
    parent = target.getparent()
    return not (_local(target) == "item" and parent is not None and parent in form.model_repeats)


def _model_iteration_setvalue(form, setvalue):
    """Whether a setvalue is one Vellum's model iteration takes as its own (``modeliteration.js``
    ``setvalueData``, matched by event and ref): the container's ``@ids`` and ``@count`` (``xforms-ready``, or
    ``jr-insert`` where the container is nested in a repeat) and its ``item/@index`` and ``item/@id``
    (``jr-insert``), each spelled as Nova writes one (``_held_ref``)."""
    for container in form.model_repeats:
        path = form.paths[container]
        parent = container.getparent()
        nested = parent is not None and parent in form.paths and form.in_repeat(form.paths[parent])
        top = "jr-insert" if nested else "xforms-ready"
        if (setvalue.get("event"), _held_ref(setvalue)) in {
            (top, f"{path}/@ids"),
            (top, f"{path}/@count"),
            ("jr-insert", f"{path}/item/@index"),
            ("jr-insert", f"{path}/item/@id"),
        }:
            return True
    return False


def _creates(node):
    """Whether a SaveToCase node creates its case (``saveToCase.js::createsCase``: its case holds a
    ``create``)."""
    case = node.find(f"{{{CASE}}}case")
    return case is not None and case.find(f"{{{CASE}}}create") is not None


def _save_to_case_create_id(form, setvalue, target):
    """The SaveToCase node whose created case's id a setvalue sets (``saveToCase.js::handleMugParseFinish``
    takes it as the node's Case ID), or None."""
    if not isinstance(target, tuple) or target[1] != "case_id":
        return None
    case = target[0]
    node = case.getparent()
    if case.tag != f"{{{CASE}}}case" or node is None or node.get(f"{{{VELLUM}}}role") != "SaveToCase":
        return None
    return node if _creates(node) else None


def _model_level(form, setvalue):
    """Whether a setvalue is one Vellum's parser reads as a setvalue at all (``head > model > setvalue``)."""
    return setvalue.getparent() is form.model and setvalue.tag == f"{{{XFORMS}}}setvalue"


def _default_value(form, setvalue, target):
    """Whether Vellum reads a setvalue as its question's Default Value (``parser.js::parseSetValue``: a
    question at its ref, and the event ``xforms-ready`` or ``jr-insert``)."""
    return (
        _model_level(form, setvalue)
        and setvalue.get("event") in ("xforms-ready", "jr-insert")
        and target is not None
        and _is_mug(form, target)
    )


def default_other_than_blank_on_a_capture_question(use, manifest):
    """``questions/default-other-than-blank-on-a-capture-question``: an attachment question's Default Value
    anything but the blank string literal, or nonempty text on its data node.
    Web Apps clears a starting file as the form opens and submits nothing for it, and Android's ``MediaWidget``
    looks for the named file in the form's own folder and stops the form. A value Core's lexer refuses, or this
    port does not read, is not settled here: None."""
    form, setvalue = _setvalue(use)
    if form is None:
        return None
    if setvalue is None:
        _, data = _data_node(use)
        return _instance_text_value(form, data) and _attachment_answer(form, data)
    target = _target(form, setvalue)
    if target is None:
        return _unplaced_target(form, setvalue)
    if not _default_value(form, setvalue, target) or isinstance(target, tuple):
        return False
    if not _attachment_answer(form, target):
        return False
    found = xpath_tokens(setvalue.get("value") or "")
    if found is None:
        return None
    return not (len(found) == 1 and found[0].kind == "STR" and found[0].text[1:-1] == "")


def default_event_mismatching_placement(use, manifest):
    """``questions/a-default-value-s-setvalue-whose-event-does-not-match-…``: a setvalue Vellum reads as a
    Default Value whose event does not match where the question sits, which a save rewrites
    (``defaultOptions.getSetValues``: ``jr-insert`` in a repeat, ``xforms-ready`` outside one, by
    ``isInRepeat``)."""
    form, setvalue = _setvalue(use)
    if form is None:
        return None
    if setvalue is None:
        return False  # an event on another element of the form, no setvalue
    target = _target(form, setvalue)
    if target is None:
        return _unplaced_target(form, setvalue)
    if not _default_value(form, setvalue, target):
        return False
    inside = form.in_repeat(form.paths[target])
    return (setvalue.get("event") == "jr-insert") != inside


def form_level_setvalue(use, manifest):
    """``questions/setvalue-event-xforms-value-changed-authored-xforms-revalidate``: a setvalue Vellum keeps
    only as a form-level setvalue: one its parser reads (``head > model > setvalue``) that is no question's
    Default Value (``parser.js::parseSetValue``) and that no plugin takes as its own (a model iteration's,
    ``modeliteration.js``; a SaveToCase create's Case ID, ``saveToCase.js``); and one Core reads otherwise than
    Nova writes a setvalue (``_setvalue_spelling``: a ``bind``, a relative ``ref``, a ``ref``, ``value`` or
    ``event`` of another namespace before the plain one, no ``value``, or content), whose target Core and the form
    builder read apart, so no question's default is what Core sets. What HQ's build writes is no authored
    setvalue."""
    form, setvalue = _setvalue(use)
    if form is None:
        return None
    if setvalue is None:
        return False  # an event on another element of the form, no setvalue
    if not _model_level(form, setvalue):
        return False  # an action nested in a control is that row's
    if _setvalue_spelling(setvalue) == SETVALUE_OTHER:
        return True
    target = _target(form, setvalue)
    if target is None:
        return None
    if _built_by_hq(form, setvalue, target):
        return False
    if _default_value(form, setvalue, target):
        return False
    if _model_iteration_setvalue(form, setvalue) or _save_to_case_create_id(form, setvalue, target) is not None:
        return False
    return True


def savetocase_blank_create_id(use, manifest):
    """``questions/savetocase-create-at-the-form-root-whose-authored-case-id-…``: the Case ID of a SaveToCase
    create at the form root (its ``xforms-ready`` setvalue, ``saveToCase.js::getSetValues``) that is blank on
    every opening. Read where Core's parse of the value decides it: a call to ``uuid()`` alone, or a read of
    the session or another instance, can give a value on some opening (not blank); an empty string literal is
    blank. A read of the form's own answers depends on the load's order (README, "Load-time values"), which
    the export alone does not settle: None."""
    form, setvalue = _setvalue(use)
    if form is None:
        return None
    if setvalue is None:
        return False  # an event on another element of the form, no setvalue
    target = _target(form, setvalue)
    if target is None:
        return _unplaced_target(form, setvalue)
    node = _save_to_case_create_id(form, setvalue, target)
    if node is None or form.in_repeat(form.paths[node]) or setvalue.get("event") != "xforms-ready":
        return False
    parsed = form.parsed(setvalue.get("value"))
    if parsed is None or "error" in parsed:
        return None
    if parsed["functions"] == ["uuid"] and not parsed["expressions"]:
        return False
    if parsed["roots"] == ["instance"] and parsed["instancePaths"] and not parsed["functions"]:
        return False
    if parsed["expressions"] == ["XPathStringLiteral"] and not parsed["functions"]:
        return setvalue.get("value").strip() in ("''", '""')
    return None


def action_nested_in_control(use, manifest):
    """``questions/actions-nested-inside-controls``: an action inside a body control (Vellum drops it, or keeps
    it as a read-only control)."""
    form, element = _form_element(use)
    if form is None:
        return None
    body = form.root.find(f"{{{XHTML}}}body")
    node = element.getparent()
    while node is not None:
        if node is body:
            return True
        node = node.getparent()
    return False


def foreign_namespace_model_child(use, manifest):
    """``questions/unknown-namespace-model-children-…``: a ``<model>`` child Core dispatches by its local name
    (``XFormParser.parseModel``) in a namespace other than XForms'."""
    form, element = _form_element(use)
    if form is None:
        return None
    parent = element.getparent()
    return parent is not None and _local(parent) == "model" and etree.QName(element).namespace != XFORMS


# Repeat counts ------------------------------------------------------------------


def _counted_repeat(use):
    """The ``<repeat>`` a use stands for (``jr-control:repeat``; ``jr-control:group`` for the group around
    one, which Vellum reads with it as one Repeat; ``mug:Repeat`` at the group or the repeat), with its
    form; (form, None) for a use that stands for no repeat."""
    form, element = _form_element(use)
    if form is None:
        return None, None
    if _local(element) == "repeat":
        return form, element
    if _local(element) == "group":
        repeats = [child for child in _children(element) if _local(child) == "repeat"]
        return form, (repeats[0] if len(repeats) == 1 else None)
    return form, None


def _count_target(use):
    """A repeat's ``jr:count`` and what it names: (form, count text, Core's parse, whether it is one path,
    node), or a verdict where the use stands for no counted repeat."""
    form, repeat = _counted_repeat(use)
    if form is None:
        return None
    if repeat is None or repeat.get(f"{{{JAVAROSA}}}count") is None:
        return False
    text = repeat.get(f"{{{JAVAROSA}}}count")
    parsed = form.parsed(text)
    if parsed is None:
        return None
    tree = form.readings.trees.get(text) if form.readings is not None else None
    return form, text, parsed, _path_kind(parsed, tree), form.node(text)


def _path_kind(parsed, tree):
    """Whether an expression is one location path, as ``XPathReference.getPathExpr`` requires a count to be:
    False where Core refuses it, else by its structure as HQ's XPath grammar reads it (a predicate's parts
    are the path's), else by Core's parse where that holds a path alone; None where neither tells."""
    if "error" in parsed:
        return False
    if tree is not None:
        return tree[0] == "path"
    if parsed["expressions"] == ["XPathPathExpr"] and not parsed["functions"]:
        return True
    return None


def count_outside_form_data(use, manifest):
    """``questions/jr-count-naming-a-node-in-a-secondary-instance-or-no-node``: a ``jr:count`` path through
    another instance, or naming no node of the form's own data."""
    held = _count_target(use)
    if not isinstance(held, tuple):
        return held
    _, _, parsed, path, node = held
    if not path:
        return path  # a count that is no path is HQ's build's (count-not-a-path, which the bar reports)
    if "instance" in parsed["roots"]:
        return True
    if parsed["roots"]:
        return None  # a path from current(), which names its node by where it is read
    return node is None


def _count_question(held):
    """What a ``jr:count`` path names: ``(form, its control or None, its bind or None, node)``, or None."""
    if not isinstance(held, tuple):
        return None
    form, text, parsed, path, node = held
    if not path or parsed["roots"] or node is None:
        return None
    controls = form.question_controls(text)
    return form, (controls[0] if controls else None), form.bind(text), node


def count_from_decimal_question(use, manifest):
    """``questions/jr-count-naming-a-decimal-question``: a ``jr:count`` naming a question Core reads as a
    decimal."""
    held = _count_target(use)
    if isinstance(held, tuple) and held[3] is None:
        return None  # whether the count is one path is not read
    named = _count_question(held)
    if named is None:
        return held if not isinstance(held, tuple) else False
    _, control, bind, _ = named
    if control is None or bind is None or bind.get("type") is None:
        return False
    return "DATATYPE_DECIMAL" in _core_datatypes(manifest, bind.get("type"))


def _integer_choices(control):
    """Whether every choice of a single select is an integer's text (Core parses the chosen value as it parses
    an integer answer)."""
    items = [child for child in _children(control) if _local(child) == "item"]
    if not items or len(items) != len(_children(control)) - sum(
        1 for child in _children(control) if _local(child) in ("label", "hint", "help", "alert")
    ):
        return False
    for item in items:
        value = item.find(f"{{{XFORMS}}}value")
        text = (value.text or "").strip() if value is not None else ""
        if not text or not text.lstrip("-").isdigit():
            return False
    return True


def count_from_other_question(use, manifest):
    """``questions/jr-count-naming-any-other-question-kind-…``: a ``jr:count`` naming a question that is
    neither an integer one, a decimal one (its own row), nor a single select whose every choice is an
    integer, or naming a label or a group. A node no control names is no question here (a hidden value, or
    an attribute such as a model iteration's ``@count``)."""
    held = _count_target(use)
    if isinstance(held, tuple) and held[3] is None:
        return None  # whether the count is one path is not read
    named = _count_question(held)
    if named is None:
        return held if not isinstance(held, tuple) else False
    _, control, bind, _ = named
    if control is None:
        return False
    local = _local(control)
    if local in ("group", "repeat", "trigger"):
        return True
    if local == "select1" and _integer_choices(control):
        return False
    datatypes = set(_core_datatypes(manifest, bind.get("type"))) if bind is not None and bind.get("type") else set()
    if local == "input" and datatypes & {"DATATYPE_INTEGER", "DATATYPE_LONG"}:
        return False
    return "DATATYPE_DECIMAL" not in datatypes or local != "input"


def count_from_non_integer_hidden_value(use, manifest):
    """``questions/jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer…``: a ``jr:count`` naming
    a hidden value (an element no control names, whose bind calculates it) whose calculate is not an
    integer in Nova's types, read over the calculate's structure as HQ's XPath grammar reads it (the
    observation's ``trees``, ``_integer``)."""
    held = _count_target(use)
    if isinstance(held, tuple) and held[3] is None:
        return None  # whether the count is one path is not read
    named = _count_question(held)
    if named is None:
        return held if not isinstance(held, tuple) else False
    form, control, bind, node = named
    if control is not None or isinstance(node, tuple) or bind is None or bind.get("calculate") is None:
        return False
    integer = _integer_calculate(form, bind.get("calculate"), manifest, frozenset())
    return None if integer is None else not integer


def _integer_calculate(form, text, manifest, seen):
    tree = form.readings.trees.get(text) if form.readings is not None else None
    if tree is None or text in seen:
        return None
    return _integer(form, tree, manifest, seen | {text})


# Nova's types of expression values (lib/domain/expression/typeChecker.ts: a number
# literal is an integer when Number.isInteger holds of it, ``literalType``; ``+``, ``-``, ``*`` and ``mod`` of
# two integers are an integer and of anything else a decimal, ``arith``; ``count`` is an integer; ``if`` is
# its branches' type), with XPath's ``div``, true division, a decimal (the row's own example, ``/data/a div
# 2``) and a comparison or ``and``/``or`` a truth value, which is no integer. ``int()`` gives an integer
# (Core's ``XPathIntFunc``, the explicit spelling Nova's own count rule asks for).
INTEGER_CALLS = frozenset({"count", "count-selected", "int"})
TRUTH_OPERATORS = frozenset({"=", "!=", "<", "<=", ">", ">=", "and", "or"})


def _integer(form, tree, manifest, seen):
    """Whether Nova's types read an expression's value as an integer: True, False (a decimal, text or truth
    value), or None where it holds a part whose type this does not read."""
    kind = tree[0]
    if kind == "number":
        return float(tree[1]).is_integer()
    if kind == "text":
        return False
    if kind == "negative":
        return _integer(form, tree[1], manifest, seen)
    if kind == "binary":
        op = tree[1]
        if op in TRUTH_OPERATORS or op == "div":
            return False
        if op in ("+", "-", "*", "mod"):
            sides = [_integer(form, side, manifest, seen) for side in tree[2:]]
            if False in sides:
                return False
            return True if all(sides) else None
        return None
    if kind == "call":
        name, arguments = tree[1], tree[2]
        if name in INTEGER_CALLS:
            return True
        if name == "if" and len(arguments) == 3:
            branches = [_integer(form, branch, manifest, seen) for branch in arguments[1:]]
            if False in branches:
                return False
            return True if all(branches) else None
        return None
    if kind == "path":
        return _integer_node(form, tree[2], manifest, seen) if tree[1] == "absolute" else None
    return None


def _integer_node(form, path, manifest, seen):
    """Whether Nova's types read a node a path names as an integer: an integer question, a single select whose
    every choice is an integer, or a hidden value whose calculate is one."""
    node = form.node(path)
    if node is None:
        return None
    controls = form.question_controls(path)
    if controls:
        control = controls[0]
        if _local(control) == "select1" and _integer_choices(control):
            return True
        bind = form.bind(path)
        datatypes = set(_core_datatypes(manifest, bind.get("type"))) if bind is not None and bind.get("type") else set()
        return _local(control) == "input" and bool(datatypes & {"DATATYPE_INTEGER", "DATATYPE_LONG"})
    bind = form.bind(path)
    if bind is None or bind.get("calculate") is None:
        return None
    return _integer_calculate(form, bind.get("calculate"), manifest, seen)


# Appearances --------------------------------------------------------------------


@dataclass(frozen=True)
class AppearanceRule:
    """One runtime read of an appearance as the surface records it (an ``appearance:<reader>/<token>`` item's
    ``reads``): the item, its reader and token, how the read matches and its case handling, and the elements
    whose appearance it reads (``holders``, ``controls`` and ``datatypes``, each empty where it reads any)."""

    key: str
    reader: str
    token: str
    match: str
    case: str
    holders: frozenset = frozenset()
    controls: frozenset = frozenset()
    datatypes: frozenset = frozenset()

    def reads(self, facts):
        """Whether the read compares the appearance of an element of these facts (``element_facts``)."""
        holder, control, datatype = facts
        return (
            (not self.holders or holder in self.holders)
            and (not self.controls or control in self.controls)
            and (not self.datatypes or datatype in self.datatypes)
        )


@cache
def appearance_rules(manifest):
    """Every appearance read the surface records, one rule each."""
    rules = []
    for key, item in sorted(manifest.items.items()):
        if not key.startswith("appearance:"):
            continue
        reader, token = key.split(":", 1)[1].split("/", 1)
        for read in item.get("reads") or ():
            rules.append(
                AppearanceRule(
                    key,
                    reader,
                    token,
                    read["match"],
                    read["case"],
                    frozenset(read.get("holders") or ()),
                    frozenset(read.get("controls") or ()),
                    frozenset(read.get("datatypes") or ()),
                )
            )
    return tuple(rules)


def _cased(text, case):
    return text.lower() if case in ("lowercased", "ignore-case") else text


def appearance_matches(value, rule):
    """Whether a read's rule, as the surface records it, acts on this appearance value."""
    text = _cased(value, rule.case)
    wanted = rule.token.lower() if rule.case == "ignore-case" else rule.token
    match = rule.match
    if match == "whole":
        return text == wanted
    if match in ("contains", "index"):
        return wanted in text
    if match == "prefix":
        return text.startswith(wanted)
    if match == 'token split on " "':
        return wanted in text.split(" ")
    if match == "token split on /\\s+/":
        return wanted in text.split()
    if match == 'token-regex split on " "':
        return any(re.search(rule.token, part) for part in text.split(" "))
    if match == 'word 1 split on " "':
        words = text.split(" ")
        return len(words) > 1 and words[1] == wanted
    raise AppearanceRuleUnknown(
        f"The surface records an appearance read matched by {match!r}, which the manifest check does not know how"
        " to apply; teach proof/checks/manifest_value_classes.py::appearance_matches that rule."
    )


class AppearanceRuleUnknown(ValueError):
    """The surface records an appearance read by a rule the check cannot apply."""


# The control type Core gives an ``<upload>`` by its mediatype (XFormParser.parseUpload, which compares the whole
# attribute); any other mediatype keeps the handler's CONTROL_UPLOAD.
UPLOAD_CONTROLS = {
    "image/*": "CONTROL_IMAGE_CHOOSE",
    "audio/*": "CONTROL_AUDIO_CAPTURE",
    "video/*": "CONTROL_VIDEO_CAPTURE",
    "application/*,text/*": "CONTROL_DOCUMENT_UPLOAD",
}
# What XFormParser.parseGroup builds a GroupDef for (a ``jr-control`` handler's ``core.passes``).
CONTAINERS = frozenset({"CONTAINER_GROUP", "CONTAINER_REPEAT"})


def element_facts(manifest, form, element):
    """What Core builds of a body element whose appearance a runtime reads, as the appearance reads name it:
    ``(holder, control type, data type)``. A group or repeat is ``("group", None, None)`` (a ``GroupDef``,
    ``XFormParser.parseGroup``); a question is ``("question", control, datatype)``: the control type its handler
    passes (``jr-control``'s ``core.passes``; an ``<upload>``'s by its mediatype, ``UPLOAD_CONTROLS``) and the data
    type Core reads its bind's ``type`` as (``jr-type``'s ``datatypes``; ``DATATYPE_NULL`` where its bind gives
    none, ``XFormParser.getDataType``); any other element is ``(None, None, None)``, whose appearance no read
    restricted to questions or groups compares."""
    local = _local(element)
    item = manifest.item(f"jr-control:{local}") or {}
    passes = {constant.rsplit(".", 1)[-1] for constant in ((item.get("core") or {}).get("passes") or ())}
    if passes & CONTAINERS:
        return "group", None, None
    controls = sorted(constant for constant in passes if constant.startswith("CONTROL_"))
    if not controls:
        return None, None, None
    control = UPLOAD_CONTROLS.get(element.get("mediatype"), controls[0]) if local == "upload" else controls[0]
    bind = form.control_bind(element) if isinstance(form, Form) else None
    kind = bind.get("type") if bind is not None else None
    datatype = _core_datatypes(manifest, kind)[0] if kind else "DATATYPE_NULL"
    return "question", control, datatype


# The values Android matches inside an appearance (``contains`` and ``index`` reads) on each element it reads them
# on, by the widget that reads them (``WidgetFactory``, ``BarcodeWidget``, ``DatePrototypeFactory``, ``ImageWidget``).
INSIDE_MATCHES = frozenset({"contains", "index"})
ANDROID_INSIDE = {
    "select1": frozenset({"compact", "quick", "-", "combobox", "multiword", "fuzzy"}),
    "select": frozenset({"compact", "-"}),
    "barcode": frozenset({"editable"}),
    "date": frozenset({"gregorian", "cancel"}),
    "image": frozenset({"acquire", "overlay-small"}),
    "audio": frozenset({"legacy"}),
}


def _android_kind(facts):
    """The widget family Android builds a question of these facts with, among those that match values inside an
    appearance (``WidgetFactory.createWidgetFromPrompt`` by control type, ``buildBasicWidget`` by data type)."""
    holder, control, datatype = facts
    by_control = {
        "CONTROL_SELECT_ONE": "select1",
        "CONTROL_SELECT_MULTI": "select",
        "CONTROL_IMAGE_CHOOSE": "image",
        "CONTROL_AUDIO_CAPTURE": "audio",
    }
    if control in by_control:
        return by_control[control]
    if control in ("CONTROL_INPUT", "CONTROL_SECRET"):
        return {"DATATYPE_BARCODE": "barcode", "DATATYPE_DATE": "date"}.get(datatype)
    return None


def android_inside_match_other(use, manifest):
    """``questions/any-other-single-string-no-row-names-that-holds-a-value-android…``: a single string (one token)
    no row names that holds a value Android matches inside it, other than one Android reads exactly as it reads a
    held value while Web Apps ignores each value inside it (the HELD row beside it,
    ``android-inside-match-as-held-value``). Android's inside matches are the ``contains`` and ``index`` reads the
    surface records on the element's control and data type (none on a group); which of them Android takes, and
    so how it reads the string, is its widget's choice:

    - a single select (``WidgetFactory.buildSelectOne``): a string holding ``compact`` is a grid
      (``buildCompactSelectOne``: auto-advancing where it holds ``quick``, its column count the text after its
      first ``-`` where that is an integer, else none), as ``compact``, ``compact-N``, ``quick compact-N`` and the
      multi-token ``quick compact`` are, and Web Apps reads none of ``compact``, ``quick`` and ``-``; otherwise a
      string holding ``combobox`` (not ``minimal``) is a combobox (``buildComboboxSelectOne`` reads ``multiword``
      and ``fuzzy`` inside it), while Web Apps reads ``combobox`` only as a whole token
      (``form_ui.js::getMatchingStyles``), so every such string but ``combobox`` itself is in the class
      (``combobox2``); Android reads nothing else inside it.
    - a multiple select (``buildSelectMulti``): a string holding ``compact`` is a grid, as ``compact`` and
      ``compact-N`` are.
    - a barcode (``BarcodeWidget``: ``editable``), a date (``buildBasicWidget``: ``gregorian``, and
      ``DatePrototypeFactory``: ``cancel``), an image (``ImageWidget``: ``acquire``, ``overlay-small``) and an
      audio capture (``createWidgetFromPrompt``: ``legacy``): Android reads each value inside the string as it
      reads the value alone, which a row holds.

    Where Android matches a value inside the string that this does not know of on that element, or Web Apps reads
    one it takes Web Apps to ignore, the export alone does not settle it here: None."""
    form, element = _form_element(use)
    if form is None:
        return None
    value = element.get("appearance")
    if value is None:
        return None
    if len(value.split()) != 1 or value != value.strip():
        return False  # a multi-token string, or one holding white space, is other rows'
    facts = element_facts(manifest, form, element)
    rules = appearance_rules(manifest)
    inside = {
        rule.token
        for rule in rules
        if rule.reader == "android"
        and rule.match in INSIDE_MATCHES
        and rule.reads(facts)
        and appearance_matches(value, rule)
    }
    if not inside:
        return False
    kind = _android_kind(facts)
    if kind is None or inside - ANDROID_INSIDE[kind]:
        return None
    if kind == "select1":
        if "compact" not in value and value != "minimal" and "combobox" in value:
            return value != "combobox"
        inside -= {"combobox", "multiword", "fuzzy"}  # read only in a combobox, which a grid is not
    web_apps = {rule.token for rule in rules if rule.reader == "web-apps"}
    return None if inside & web_apps else False


# The app JSON -------------------------------------------------------------------

FORMS = ("Form", "AdvancedForm", "ShadowForm")
MODULES = ("Module", "AdvancedModule", "ShadowModule")


def _json(use):
    return use.at if isinstance(use.at, JsonAt) else None


def _scope_reader(classes, test):
    """A reader of the innermost object of one of ``classes`` the use sits in: ``test(at, that object)``, or
    None for a use that sits in no such object (or in no app JSON)."""

    def reader(use, manifest):
        at = _json(use)
        if at is None:
            return None
        held = at.nearest(*classes)
        if held is None:
            return None
        return test(at, held)

    return reader


def _condition(action):
    """An action's condition type as HQ reads it (``FormActionCondition``, ``never`` by default)."""
    condition = (action or {}).get("condition") or {}
    return condition.get("type") or "never"


def _active(action):
    """Whether HQ reads an action as active (``FormAction.is_active``: its condition is ``if`` or
    ``always``)."""
    return _condition(action) in ("if", "always")


def _actions(form):
    return form.get("actions") or {}


def _subcases(form):
    return [subcase for subcase in _actions(form).get("subcases") or [] if isinstance(subcase, dict)]


def _requires(form):
    return form.get("requires") or "none"


def _in_actions(at, form, *names):
    """Whether a use sits in one of a form's actions named ``names`` (in it, on its slot of the form's
    ``actions``, or on the form or its ``actions`` as a whole, which hold every action): a use in another
    action is in no class about these."""
    actions = _actions(form)
    held = []
    for name in names:
        action = actions.get(name)
        held += action if isinstance(action, list) else [action]  # subcases are a list of actions
    for cls, value in reversed(at.scope):
        if any(value is action for action in held if action is not None):
            return True
        if cls == "FormActions":
            return at.key in (None, *names) if value is at.owner else False
        if cls in FORMS:
            return True
    return True


# Nova's floor for an app's CommCare version (application-and-settings/34-hq-build-spec-at-or-above-nova-s-floor-2-57).
VERSION_FLOOR = (2, 57)


def _version(text):
    parts = []
    for part in str(text).split("."):
        if not part.isdigit():
            return None
        parts.append(int(part))
    return tuple(parts)


def below_floor(use, manifest):
    """``application-and-settings/34p-hq-build-spec-below-nova-s-floor``: an app whose ``build_spec`` version is
    below Nova's floor (2.57, the row above's)."""
    at = _json(use)
    if at is None:
        return None
    spec = at.app.doc.get("build_spec")
    if not isinstance(spec, dict) or spec.get("version") in (None, ""):
        return False
    version = _version(spec["version"])
    return None if version is None else version < VERSION_FLOOR


def only_hierarchical_fixture(use, manifest):
    """``application-and-settings/50pp-…``: ``location_fixture_restore`` = ``only_hierarchical_fixture``."""
    at = _json(use)
    return None if at is None else at.app.doc.get("location_fixture_restore") == "only_hierarchical_fixture"


# HQ's grammar of a language code (models/applications.py::validate_lang).
LANGUAGE_CODE = re.compile(r"^[a-z]{2,3}(-[a-z]*)?$")


def invalid_or_repeated_code(use, manifest):
    """``application-and-settings/a-non-empty-langs-code-outside-that-grammar-or-repeated``: a non-empty
    ``langs`` code outside HQ's grammar (``validate_lang``), or one listed twice."""
    at = _json(use)
    if at is None:
        return None
    langs = [code for code in at.app.doc.get("langs") or [] if isinstance(code, str)]
    codes = [code for code in langs if code]
    return any(not LANGUAGE_CODE.match(code) for code in codes) or len(set(codes)) != len(codes)


def _hq_spelled(text):
    """A text as HQ's build writes it into an app strings file (``commcare_translations.dumps``,
    ``lib/commcare/localeFile.ts::hqLocaleFileValue``): a Python-blank text as one non-breaking space, each line break
    as ``\\n``, then each ``#`` no backslash precedes as ``\\#``."""
    if not text.strip():
        return "\u00a0"
    lines = text.replace("\n", "\\n")
    return "".join(
        "\\#" if unit == "#" and (index == 0 or lines[index - 1] != "\\") else unit for index, unit in enumerate(lines)
    )


def _core_locale_key(line):
    """The key one line of a locale file defines as Core's ``LocalizationUtils.parseAndAdd`` reads it
    (``lib/commcare/localeFile.ts::readLocaleLineAsCore``): the line trimmed as Java's ``String.trim()`` does, cut at
    its first ``#`` no backslash precedes, then what stands before its first ``=``; None where no ``=`` stands there or
    nothing follows it."""
    read = line.strip(CORE_LINE_END_TRIMMED)
    start = 0
    while (at := read.find("#", start)) != -1:
        if at == 0 or read[at - 1] != "\\":
            read = read[:at]
            break
        start = at + 1
    equal = read.find("=")
    if equal == -1 or equal == len(read) - 1:
        return None
    return read[:equal]


def _key_defined_after_line_end(text):
    """The app string the rest of a text after a carriage return defines in the file HQ's build writes it into, or
    None (``lib/commcare/reader/heldText.ts::keyDefinedAfterLineEnd``): ``dumps`` leaves a carriage return as it is,
    and Core reads each line after it as a line of its own."""
    if not text.strip():
        return None
    for line in _hq_spelled(text).split("\r")[1:]:
        key = _core_locale_key(line)
        if key:
            return key
    return None


def translation_key_not_its_own(use, manifest):
    """``application-and-settings/translations-key-that-is-no-locale-record-under-its-own-name``: a key of an app
    language's ``translations`` that is no locale record under its own name (``app_strings.is_locale_file_key``,
    ``lib/commcare/localeFile.ts::isLocaleFileKey``), which HQ's build writes stripped and on one line, so it sets
    another string or none (``lib/commcare/reader/appShell.ts::readTranslations``). A language the app does not hold
    is read by nothing (another class), and a key whose value's rest after a carriage return defines an app string is
    the carriage-return entry's, which the reader refuses at that key first."""
    at = _json(use)
    if at is None or at.key != "translations" or at.scope[-1][0] not in ("Application", "LinkedApplication"):
        return None
    translations = at.value
    if not isinstance(translations, dict):
        return None
    langs = at.owner.get("langs")
    held = {code for code in langs if isinstance(code, str)} if isinstance(langs, list) else set()
    for lang, strings in translations.items():
        if lang not in held or not isinstance(strings, dict):
            continue
        for key, value in strings.items():
            if isinstance(value, str) and _key_defined_after_line_end(value) is not None:
                continue
            if not is_locale_file_key(key):
                return True
    return False


def path_not_from_uploader(use, manifest):
    """``application-and-settings/logo-refs-slot-path-other-than-the-uploader-s-…``: a logo slot HQ's uploader
    did not write: an entry that is no object or holds no ``m_id``, which the uploader always stores
    (``ProcessLogoFileUploadView.process_upload`` stores ``CommCareMultimedia.get_media_info``), or whose path
    is not the one the uploader writes (``ProcessLogoFileUploadView.form_path``:
    ``jr://file/commcare/logo/data/<slot><ext>``)."""
    at = _json(use)
    if at is None:
        return None
    for slot, ref in (at.app.doc.get("logo_refs") or {}).items():
        if not isinstance(ref, dict):
            return True
        media_id = ref.get("m_id")
        if not isinstance(media_id, str) or not media_id:
            return True
        path = ref.get("path")
        prefix = f"jr://file/commcare/logo/data/{slot}"
        if not isinstance(path, str) or not path.startswith(prefix):
            return True
        rest = path[len(prefix) :]
        if rest and (not rest.startswith(".") or "/" in rest):
            return True
    return False


# The custom profile property Nova's row holds (application-and-settings/profile-custom-properties-cc-index-…).
HELD_CUSTOM_PROPERTIES = frozenset({"cc-index-case-search-results"})


def custom_property_other(use, manifest):
    """``application-and-settings/profile-custom-properties-any-other-entry-…``: a custom profile property
    other than the one Nova derives."""
    at = _json(use)
    if at is None:
        return None
    custom = ((at.app.doc.get("profile") or {}).get("custom_properties")) or {}
    return any(name not in HELD_CUSTOM_PROPERTIES for name in custom)


def sense_or_review_entry_mode(use, manifest):
    """``application-and-settings/profile-features-sense-true-or-…``: ``profile.features.sense`` =
    ``'true'``, or ``profile.properties.cc-entry-mode`` = ``'cc-entry-review'``."""
    at = _json(use)
    if at is None:
        return None
    profile = at.app.doc.get("profile") or {}
    return (profile.get("features") or {}).get("sense") == "true" or (profile.get("properties") or {}).get(
        "cc-entry-mode"
    ) == "cc-entry-review"


def child_menu_separated_from_its_parent(use, manifest):
    """``menus-and-case-lists/menu-order-that-separates-a-child-from-its-parent``: a child menu not in the run
    of menus that follows its parent, the only order HQ's menu moves keep without LEGACY_CHILD_MODULES
    (``Application.rearrange_modules`` moves a menu with its children right after it)."""
    at = _json(use)
    if at is None:
        return None
    modules = at.app.modules
    index = {module.get("unique_id"): position for position, module in enumerate(modules)}
    for position, module in enumerate(modules):
        parent = module.get("root_module_id")
        if not parent or parent not in index:
            continue
        start = index[parent]
        if start > position:
            return True
        if any(between.get("root_module_id") != parent for between in modules[start + 1 : position]):
            return True
    return False


def missing_module_id(use, manifest):
    """``menus-and-case-lists/module-unique-id-missing``: a module with no ``unique_id``."""
    return _scope_reader(MODULES, lambda at, module: not module.get("unique_id"))(use, manifest)


RESERVED_CASE_TYPES = frozenset({"commcare-user", "user-owner-mapping-case"})


def reserved_word_on_a_basic_module(use, manifest):
    """``menus-and-case-lists/case-type-commcare-user-or-user-owner-mapping-case-on-a-basic``: a basic module
    whose case type is one the menu settings page marks reserved."""
    at = _json(use)
    if at is None:
        return None
    module = at.nearest(*MODULES)
    if module is None:
        return None
    basic = (module.get("doc_type") or "Module") == "Module"
    return basic and module.get("case_type") in RESERVED_CASE_TYPES


# What the menu settings page admits as a case type (`app_manager.js::valueIncludeInvalidCharacters`, the
# browser's ASCII `^[\w-]*$`, after the page turns each space into `_`).
MENU_PAGE_CASE_TYPE = re.compile(r"[A-Za-z0-9_-]+")


def case_type_outside_the_menu_page(use, manifest):
    """``menus-and-case-lists/case-type-outside-the-menu-page-s-grammar``: a module whose case type is not empty and
    holds a character the menu settings page marks an error, though the server's check admits any Unicode word
    character (``util.py::is_valid_case_type``)."""
    at = _json(use)
    if at is None:
        return None
    module = at.nearest(*MODULES)
    if module is None:
        return None
    case_type = module.get("case_type") or ""
    return bool(case_type) and MENU_PAGE_CASE_TYPE.fullmatch(case_type) is None


def _slugify(value):
    """Django's ``slugify`` (``django/utils/text.py``, ``allow_unicode=False``), which HQ checks an endpoint id
    against (``views/utils.py::get_cleaned_session_endpoint_id``)."""
    value = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^\w\s-]", "", value.lower())
    return re.sub(r"[-\s]+", "-", value).strip("-_")


ENDPOINT_SLOTS = ("session_endpoint_id", "case_list_session_endpoint_id")


def not_a_slugify_fixed_point(use, manifest):
    """``menus-and-case-lists/module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed``: a module's
    endpoint id that Django's ``slugify`` changes (a shadow menu's own ids are the next row's)."""
    at = _json(use)
    if at is None:
        return None
    module = at.nearest(*MODULES)
    if module is None or at.key not in ENDPOINT_SLOTS:
        return None
    value = module.get(at.key)
    return bool(value) and _slugify(value) != value


def not_a_slug_or_duplicated(use, manifest):
    """``forms-and-case-writes/session-endpoint-id-not-a-slug-fixed-point-or-duplicated``: a form's endpoint
    id that ``slugify`` changes, or that another module, form or mirror form also has
    (``views/utils.py::_duplicate_endpoint_ids``)."""
    at = _json(use)
    if at is None:
        return None
    form = at.nearest(*FORMS)
    if form is None:
        return None
    value = form.get("session_endpoint_id")
    if not value:
        return False
    if _slugify(value) != value:
        return True
    return _endpoint_ids(at.app).count(value) > 1


def _endpoint_ids(app):
    """Every endpoint id the app's modules, case lists, forms and mirror forms hold."""
    return app.endpoint_ids


def _gather_endpoint_ids(app):
    """Every endpoint id the app's modules, case lists, forms and mirror forms hold (``App.endpoint_ids``)."""
    found = []
    for module in app.modules:
        for slot in ENDPOINT_SLOTS:
            if module.get(slot):
                found.append(module[slot])
        for endpoint in module.get("form_session_endpoints") or []:
            if isinstance(endpoint, dict) and endpoint.get("session_endpoint_id"):
                found.append(endpoint["session_endpoint_id"])
        for form in _forms(module):
            if form.get("session_endpoint_id"):
                found.append(form["session_endpoint_id"])
    return found


def shared_with_another_endpoint(use, manifest):
    """``menus-and-case-lists/two-endpoints-sharing-an-id-…``: an endpoint id another module, case list, form
    or mirror form also has; in a suite, an ``<endpoint>`` id another endpoint also has (Core keys
    endpoints by id, ``SuiteParser``)."""
    at = use.at
    if isinstance(at, XmlAt) and at.document.kind == "runtime":
        if _local(at.element) != "endpoint":
            return False
        ids = [
            endpoint.get("id")
            for endpoint in at.document.root.iter()
            if isinstance(endpoint.tag, str) and _local(endpoint) == "endpoint"
        ]
        return ids.count(at.element.get("id")) > 1
    at = _json(use)
    if at is None:
        return None
    owner = at.owner
    value = owner.get(at.key) if at.key is not None else None
    if not value:
        return False
    return _endpoint_ids(at.app).count(value) > 1


def _load_target(app, module, load):
    """The menu whose case list an advanced form's load lists cases from, by HQ's build
    (``suite_xml/sections/entries.py::get_datum_meta_assertions_advanced``, its ``get_target_module``): the menu its
    ``details_module`` names (the form's own where it names that), else the form's own menu where the load's case
    type is that menu's, else the first menu of the load's case type; None where none is."""
    named = load.get("details_module")
    if named:
        return module if named == module.get("unique_id") else app.modules_by_id.get(named)
    case_type = load.get("case_type")
    if case_type == module.get("case_type"):
        return module
    return next((each for each in app.modules if each.get("case_type") == case_type), None)


def auto_select_on_a_load_target(use, manifest):
    """``menus-and-case-lists/auto-select-case-true-on-a-basic-module-an-advanced-form-s-load``: a basic menu's
    ``auto_select_case: true`` where an advanced form's load lists its cases from that menu's case list
    (``_load_target``), so HQ's build writes the load's datum ``autoselect`` (``get_manual_datum``). Only a load
    that chooses its case does: one that selects its case itself (``auto_select`` with a mode) or chooses it from a
    lookup table (``load_case_from_fixture``) takes another branch. Every other basic menu's is the inert class
    beside it. A suite's datum does not say which menu set it (None)."""
    at = _json(use)
    if at is None:
        return None
    menu = at.nearest(*MODULES)
    if menu is None or menu.get("doc_type", "Module") != "Module" or menu.get("auto_select_case") is not True:
        return False
    for module in at.app.modules:
        if module.get("doc_type") != "AdvancedModule":
            continue
        for form in _forms(module):
            loads, _ = _advanced_lists(form)
            for load in loads:
                if ((load.get("auto_select") or {}).get("mode")) or _from_fixture(load):
                    continue
                if _load_target(at.app, module, load) is menu:
                    return True
    return False


def task_list_shown(use, manifest):
    """``menus-and-case-lists/module-task-list-show-true``: ``Module.task_list.show: true``."""
    at = _json(use)
    if at is None:
        return None
    module = at.nearest(*MODULES)
    return None if module is None else bool((module.get("task_list") or {}).get("show"))


def shown_on_a_shadow_module(use, manifest):
    """``menus-and-case-lists/shadowmodule-case-list-show-true``: ``ShadowModule.case_list.show: true``."""
    at = _json(use)
    if at is None:
        return None
    module = at.nearest(*MODULES)
    if module is None:
        return None
    return module.get("doc_type") == "ShadowModule" and bool((module.get("case_list") or {}).get("show"))


def _puts_off_the_menu(text):
    """Whether a menu's display condition is ``false()``, or ``false() and <rest>``: the condition Nova's reader
    reads as the menu off the menu (``reader/menus/modules.ts``: ``match-none``, or an ``and`` whose first clause
    is), read over Core's tokens of it. ``and`` binds tighter than ``or``, so an ``or`` outside every bracket makes
    the whole an ``or``. None where Core's lexer does not read the text."""
    if not isinstance(text, str):
        return False
    found = xpath_tokens(text)
    if found is None:
        return None
    kinds = [token.kind for token in found]
    if kinds[:3] != ["QNAME", "LPAREN", "RPAREN"] or found[0].text != "false":
        return False
    if len(kinds) == 3:
        return True
    if kinds[3] != "AND":
        return False
    depth = 0
    for kind in kinds[4:]:
        if kind in ("LPAREN", "LBRACK"):
            depth += 1
        elif kind in ("RPAREN", "RBRACK"):
            depth -= 1
        elif kind == "OR" and depth == 0:
            return False
    return True


# Nova's after-submit destination of each workflow word (``reader/menus/afterSubmit.ts``: ``WORDS``, and
# ``FALLBACK_WORDS`` for the fallback, which holds no ``default``).
WORKFLOW_DESTINATIONS = {
    "default": "app_home",
    "root": "firstMenu",
    "module": "module",
    "parent_module": "parentMenu",
    "previous_screen": "previous",
}


def _folded_forms(app):
    """Each form a host's case list offers after a search finds nothing, with that host: the form of a hidden menu
    Nova's reader folds into the host (``reader/menus/registration.ts::fold``), read beside the host's own forms.
    Such a ``case_list_form`` carries the relevancy that offers it only then; one offered always names a form in a
    menu of its own."""
    folded = {}
    for host in app.modules:
        offer = host.get("case_list_form")
        if not isinstance(offer, dict) or not offer.get("form_id") or not offer.get("relevancy_expression"):
            continue
        form = app.forms_by_id.get(offer["form_id"])
        if form is not None and app.module_of(form) is not host:
            folded[id(form)] = host
    return folded


def _offered_when_shown(app, module, destination, folded):
    """Whether Nova offers ``destination`` to a form of ``module`` once the menu off the menu is shown: whether no
    other reason withholds it (``lib/domain/postSubmit.ts::WITHHELD_BY``). None where only
    ``menu-opens-with-first-menu-case`` could, which reads every form the first menu lists."""
    root = app.root(module)
    root_several = root is not None and _multi_select(root)
    if destination == "module":
        own = [form for form in _forms(module) if id(form) not in folded]
        bare = not own and bool((module.get("case_list") or {}).get("show"))
        if root_several or bare or module.get("put_in_root"):
            return False
        return None if root is not None and root.get("put_in_root") else True
    if destination == "previous":
        on_first_menu = bool(module.get("put_in_root")) and (root is None or bool(root.get("put_in_root")))
        return not (_multi_select(module) or root_several or _inline_search(module) or on_first_menu)
    if destination == "parentMenu":
        return root is not None and not root_several and not root.get("put_in_root")
    return False


def _opens_off_the_menu(app, hidden):
    """Whether something opens the menu ``hidden``, which its display condition puts off the menu
    (``reader/menus/modules.ts::opensOffTheMenu``): an entry point of its own or of its case list, an after-submit
    link whose target is the menu, or a form's return, its workflow or its fallback, that the menu's being off the
    menu leaves unoffered and that would be offered with it shown: the return to the menu from one of its forms
    (``module``, ``previous_screen``), or from a form of a child menu to its parent (``parent_module``). True, False,
    or None where the export alone does not say."""
    if any(hidden.get(slot) for slot in ENDPOINT_SLOTS):
        return True
    folded = _folded_forms(app)
    unsure = False
    for module in app.modules:
        for form in _forms(module):
            menu = folded.get(id(form), module)
            linked = form.get("post_form_workflow") == "form" and bool(form.get("form_links"))
            for link in (form.get("form_links") or []) if linked else []:
                link = link or {}
                if not link.get("form_id") and link.get("module_unique_id") == hidden.get("unique_id"):
                    return True
            words = [form.get("post_form_workflow_fallback")] if linked else [form.get("post_form_workflow")]
            for word in words:
                destination = WORKFLOW_DESTINATIONS.get(word or "default")
                if destination in ("module", "previous"):
                    held_back = menu is hidden
                elif destination == "parentMenu":
                    held_back = app.root(menu) is hidden
                else:
                    held_back = False
                if not held_back:
                    continue
                offered = _offered_when_shown(app, menu, destination, folded)
                if offered:
                    return True
                unsure = unsure or offered is None
    return None if unsure else False


def _frames_ending_in(root, menu_id):
    """Whether a suite's stack frame (a ``<create>`` or ``<push>``, an entry's or an endpoint's) ends with the
    command of the menu ``menu_id`` or of its case list (``m<n>-case-list``), which opens that menu's screen. None
    where a frame's last command names its value other than as one literal."""
    unsure = False
    for frame in root.iter():
        if not isinstance(frame.tag, str) or _local(frame) not in ("create", "push"):
            continue
        commands = [child for child in _children(frame) if _local(child) == "command"]
        if not commands:
            continue
        found = xpath_tokens(commands[-1].get("value") or "")
        if found is None or len(found) != 1 or found[0].kind != "STR":
            unsure = True
            continue
        if found[0].text[1:-1] in (menu_id, f"{menu_id}-case-list"):
            return True
    return None if unsure else False


def filter_off_the_menu_on_a_destination(use, manifest):
    """``menus-and-case-lists/module-filter-false-on-a-menu-something-opens``: a menu whose display condition puts it
    off the menu (``_puts_off_the_menu``) while something opens it (``_opens_off_the_menu``): Android opens it as a
    screen that lists nothing, and Web Apps lands on the app's first screen. A hidden menu a host's case list folds
    in is never read as off the menu. In a suite, a ``<menu>`` that holds its id alone is opened where a stack frame
    ends with its command (``_frames_ending_in``); one whose id another ``<menu>`` shares (a menu whose forms show in
    the menu above writes its parent's) names that screen, not its own, and the same condition's use in the app JSON
    is the one judged."""
    at = use.at
    if isinstance(at, XmlAt) and at.document.kind == "runtime":
        if _local(at.element) != "menu" or at.attribute != "relevant":
            return False
        hides = _puts_off_the_menu(at.element.get("relevant"))
        if not hides:
            return hides
        menu_id = at.element.get("id")
        if menu_id is None:
            return None
        menus = [
            element
            for element in at.document.root.iter()
            if isinstance(element.tag, str) and _local(element) == "menu" and element.get("id") == menu_id
        ]
        return False if len(menus) > 1 else _frames_ending_in(at.document.root, menu_id)
    at = _json(use)
    if at is None:
        return None
    module = at.nearest(*MODULES)
    if module is None:
        return None
    hides = _puts_off_the_menu(module.get("module_filter"))
    if not hides:
        return hides
    folded = _folded_forms(at.app)
    if any(id(form) in folded for form in _forms(module)):
        return False
    return _opens_off_the_menu(at.app, module)


# Forms and case writes -----------------------------------------------------------------


def _form(use):
    at = _json(use)
    if at is None:
        return None, None
    return at, at.nearest(*FORMS)


# The kind each form class fixes as its ``form_type`` default (``models/forms.py::Form``, ``AdvancedForm``,
# ``ShadowForm``).
FORM_TYPES = {"Form": "module_form", "AdvancedForm": "advanced_form", "ShadowForm": "shadow_form"}


def form_type_of_another_kind(use, manifest):
    """``forms-and-case-writes/form-type-other-than-the-form-s-own-kind``: a form whose ``form_type`` is not the kind
    its class fixes, which no page writes and by which HQ's build chooses the form's session values and after-submit
    frames (``reader/structure.ts::readFormKeys`` refuses every value but the class's default)."""
    at = _json(use)
    if at is None:
        return None
    for cls, value in reversed(at.scope):
        if cls in FORM_TYPES:
            return "form_type" in value and value["form_type"] != FORM_TYPES[cls]
    return None


def referral(use, manifest):
    """``forms-and-case-writes/form-requires-referral``: ``requires: referral``."""
    at, form = _form(use)
    return None if form is None else _requires(form) == "referral"


def child_cases_without_open(use, manifest):
    """``forms-and-case-writes/form-requires-none-with-child-cases-but-no-open``: a ``requires: none`` form with
    an active child case and no active open."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "subcases", "open_case"):
        return False
    return (
        _requires(form) == "none"
        and any(_active(subcase) for subcase in _subcases(form))
        and not _active(_actions(form).get("open_case"))
    )


def subcase_never(use, manifest):
    """``forms-and-case-writes/subcases-condition-never``: a child case whose condition is ``never``."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "subcases"):
        return False
    subcase = at.nearest("OpenSubCaseAction")
    subcases = [subcase] if subcase is not None else _subcases(form)
    return any(_condition(each) == "never" for each in subcases)


def _subcase_reader(test):
    def reader(use, manifest):
        at, form = _form(use)
        if form is None:
            return None
        if not _in_actions(at, form, "subcases"):
            return False
        subcase = at.nearest("OpenSubCaseAction")
        subcases = [subcase] if subcase is not None else _subcases(form)
        return any(test(form, each) for each in subcases)

    return reader


custom_index_name = _subcase_reader(lambda form, subcase: subcase.get("reference_id") not in (None, "", "parent"))
custom_index_name.__doc__ = """``forms-and-case-writes/subcases-reference-id-any-other-value``: a child case's
``reference_id`` other than ``''``, ``null`` or ``parent``."""

extension = _subcase_reader(lambda form, subcase: subcase.get("relationship") == "extension")
extension.__doc__ = """``forms-and-case-writes/subcases-relationship-extension``: ``relationship: extension``."""


def not_name_question_repeat(use, manifest):
    """``forms-and-case-writes/subcases-repeat-context-other-than-the-name-question-s-innermost``: a child
    case whose ``repeat_context`` is not its name question's innermost repeat (``get_repeat_context``), read
    in the form's XForm."""
    at, form = _form(use)
    if form is None:
        return None
    xform = at.app.xform(form)
    subcase = at.nearest("OpenSubCaseAction")
    for each in [subcase] if subcase is not None else _subcases(form):
        name = (
            (each.get("name_update") or {}).get("question_path") if isinstance(each.get("name_update"), dict) else None
        )
        if not name:
            continue
        if xform is None:
            return None
        innermost = max(
            (path for path in xform.repeat_paths if name == path or name.startswith(f"{path}/")), key=len, default=""
        )
        if (each.get("repeat_context") or "") != innermost:
            return True
    return False


# An advanced form's actions (``models/form_actions.py::AdvancedFormActions``): its loads
# (``LoadUpdateAction``) and its open actions (``AdvancedOpenCaseAction``), each in its list's order.
ADVANCED_ACTIONS = ("LoadUpdateAction", "AdvancedOpenCaseAction")
# The tag format the advanced Case Management page accepts (``advanced/actions.js::actionBase.validate``), with
# JavaScript's ``\w``, which is ASCII. It is matched whole (``fullmatch``): Python's ``$`` also matches before a
# trailing newline, which JavaScript's does not.
EDITOR_TAG = re.compile(r"[a-zA-Z][\w_-]*(/[a-zA-Z][\w_-]*)*", re.ASCII)


def _advanced_lists(form):
    """A form's loads and open actions, or two empty lists for a form that holds neither. A shadow form's own are
    its ``extra_actions`` (``ShadowForm.extra_actions``), each in the list a use of it sits in."""
    actions = (form.get("extra_actions") or {}) if form.get("doc_type") == "ShadowForm" else _actions(form)
    loads = [action for action in actions.get("load_update_cases") or [] if isinstance(action, dict)]
    opens = [action for action in actions.get("open_cases") or [] if isinstance(action, dict)]
    return loads, opens


def _is_load(action, loads):
    return any(action is load for load in loads)


def _auto_selected(load):
    """Whether a load selects its case itself (``LoadUpdateAction.auto_select``, which HQ wraps as ``None`` where
    it is absent): the advanced editor checks no tag of such a load (``actions.js``, its ``validate``)."""
    return isinstance(load.get("auto_select"), dict)


def _from_fixture(load):
    """Whether a load chooses its case from a lookup table (``load_case_from_fixture``), whose editor accepts a
    blank tag (``actions.js::loadCaseFromFixture.validate``)."""
    return isinstance(load.get("load_case_from_fixture"), dict)


def _indices(action, loads):
    """An action's indices as HQ reads them: a load's one ``case_index`` where its tag is set
    (``LoadUpdateAction.case_indices``), an open action's ``case_indices``."""
    if _is_load(action, loads):
        index = action.get("case_index")
        return [index] if isinstance(index, dict) and index.get("tag") else []
    return [index for index in action.get("case_indices") or [] if isinstance(index, dict)]


def _verdict(verdicts):
    """True where any verdict is, else None where any is, else False."""
    verdicts = list(verdicts)
    return True if True in verdicts else None if None in verdicts else False


def _advanced_reader(test):
    """A reader of an advanced form's actions: ``test(at, form, loads, opens, action, index)`` for the action a
    use sits in (and the index, where it sits in one, else None), or for each of the form's actions where the use
    sits on the form or its action lists as a whole. A use of no advanced form is in no such class."""

    def reader(use, manifest):
        at, form = _form(use)
        if form is None:
            return None
        loads, opens = _advanced_lists(form)
        held = at.nearest(*ADVANCED_ACTIONS)
        index = at.nearest("CaseIndex") if held is not None else None
        actions = [held] if held is not None else [*loads, *opens]
        return _verdict(test(at, form, loads, opens, action, index) for action in actions)

    return reader


def _tag_checked(action, loads):
    """Whether the advanced editor checks an action's tag: every open action, and a load that neither selects its
    case itself nor chooses it from a lookup table (None: that load's editor checks a tag only where one is set)."""
    if not _is_load(action, loads):
        return True
    if _auto_selected(action):
        return False
    return None if _from_fixture(action) else True


def _tag_with_slash(at, form, loads, opens, action, index):
    return "/" in (action.get("case_tag") or "")


tag_with_slash = _advanced_reader(_tag_with_slash)
tag_with_slash.__doc__ = """``forms-and-case-writes/a-load-or-open-action-s-case-tag-containing-which-the-advanced``:
a load's or open action's ``case_tag`` holding ``/``, which the editor's tag format accepts and which HQ builds into
an element name (``xform.py::_make_elem``) and a session datum id ``case_id_<a>/<b>``."""


def _blank_tag(at, form, loads, opens, action, index):
    checked, blank = _tag_checked(action, loads), not action.get("case_tag")
    if checked is None:
        return None if blank else False
    return checked and blank


blank_tag = _advanced_reader(_blank_tag)
blank_tag.__doc__ = """``forms-and-case-writes/case-tag-blank-on-a-non-auto-select-action``: a blank ``case_tag``
on an action whose tag the advanced editor checks, which it marks "Case Tag required"
(``advanced/actions.js::actionBase.validate``); a lookup-table load's editor checks no blank tag, so its blank tag
is left open."""


def _tag_failing_editor_check(at, form, loads, opens, action, index):
    tag = action.get("case_tag")
    if not tag or _tag_checked(action, loads) is not True:
        return False
    if not EDITOR_TAG.fullmatch(tag):
        return True
    return sum(1 for other in [*opens, *loads] if other.get("case_tag") == tag) > 1


tag_failing_editor_check = _advanced_reader(_tag_failing_editor_check)
tag_failing_editor_check.__doc__ = """``forms-and-case-writes/case-tag-of-a-non-auto-select-action-failing-actions-js``:
a non-blank tag on an action whose tag the advanced editor checks, outside its format (letters, digits, ``_`` and
``-``, after a letter, in ``/``-separated parts) or held by another of the form's actions (``getCaseTags('all')``:
its loads and open actions alike), each an error the page marks (``advanced/actions.js::actionBase.validate``). A
blank tag is ``blank-tag``'s."""


def _same_tag(at, form, loads, opens, action, index):
    tag = action.get("case_tag")
    return bool(tag) and sum(1 for other in (*loads, *opens) if other.get("case_tag") == tag) > 1


case_actions_using_the_same_tag = _advanced_reader(_same_tag)
case_actions_using_the_same_tag.__doc__ = """``forms-and-case-writes/case-actions-using-the-same-tag``: a nonblank
``case_tag`` another of the form's loads or open actions also holds, whatever the editor checks of either; HQ's
build resolves an index or a connection by tag (``actions_meta_by_tag``), so the second action is lost."""


# The automatic modes the advanced editor offers (``advanced/case_config_ui.js::getAutoSelectModes``): ``case``
# only after the first load, which ``auto-select-mode-case-naming-itself-a-later-load-or-an-open`` reads.
EDITOR_AUTO_SELECT_MODES = frozenset({"raw", "user", "fixture", "usercase", "case"})


def _auto_select(action, loads):
    """A load's ``auto_select`` object, or None for an open action or a load that chooses its case."""
    if not _is_load(action, loads) or not _auto_selected(action):
        return None
    return action["auto_select"]


def _worker_mode_with_another_type(at, form, loads, opens, action, index):
    auto = _auto_select(action, loads)
    return auto is not None and auto.get("mode") == "usercase" and action.get("case_type") != "commcare-user"


worker_mode_with_another_type = _advanced_reader(_worker_mode_with_another_type)
worker_mode_with_another_type.__doc__ = """``forms-and-case-writes/worker-record-selection-with-another-case-type``:
a load selected in the ``usercase`` mode whose ``case_type`` is not ``commcare-user``, which the editor sets as it
chooses that mode (``advanced/actions.js``)."""


def _unknown_auto_mode(at, form, loads, opens, action, index):
    auto = _auto_select(action, loads)
    mode = auto.get("mode") if auto is not None else None
    return bool(mode) and mode not in EDITOR_AUTO_SELECT_MODES


unknown_auto_mode = _advanced_reader(_unknown_auto_mode)
unknown_auto_mode.__doc__ = """``forms-and-case-writes/automatic-choice-with-an-unknown-mode``: a load's nonblank
``auto_select.mode`` the editor does not offer (``EDITOR_AUTO_SELECT_MODES``), ``location`` among them. A blank mode
is ``an-auto-select-load-with-a-blank-mode-or-a-blank-case-type``'s."""


def _table_choice_without_its_source(at, form, loads, opens, action, index):
    auto = _auto_select(action, loads)
    if auto is None or auto.get("mode") != "fixture":
        return False
    if not auto.get("value_source") or not auto.get("value_key"):
        return True
    # A named table and field: whether the project space holds them is the lookup catalog's.
    return None


table_choice_without_its_source = _advanced_reader(_table_choice_without_its_source)
table_choice_without_its_source.__doc__ = """
``forms-and-case-writes/automatic-table-choice-without-its-table-or-column``: a ``fixture`` load with no table tag
(``value_source``) or no field (``value_key``). A table the project space holds is read where the reading resolves
the tag against its lookup catalog; the app's JSON alone names it and says nothing of whether it is there, so a
named table and field are left undecided here (None)."""


def _opening_ids(form, loads, opens):
    """The session ids an advanced form's entry writes before parent alignment, in HQ's order
    (``EntriesHelper.configure_entry_advanced_form``): each load's ``case_id_<tag>``, each computed datum's id, and
    each root open action's ``case_id_new_<type>_<i>``."""
    ids = [f"case_id_{load.get('case_tag')}" for load in loads if load.get("case_tag")]
    ids += [datum.get("datum_id") for datum in form.get("arbitrary_datums") or [] if isinstance(datum, dict)]
    ids += [
        f"case_id_new_{action.get('case_type')}_{i}"
        for i, action in enumerate(opens)
        if not action.get("repeat_context")
    ]
    return [value for value in ids if value]


def _aligned(at):
    """Whether the form's menu sits under another menu, whose first form's datums HQ aligns the form's own to
    (``EntriesHelper.add_parent_datums``)."""
    module = at.nearest("AdvancedModule", "Module")
    return isinstance(module, dict) and bool(module.get("root_module_id"))


def _aligned_entry_ids(app, module, form, loads, opens):
    """The session ids of an advanced form's entry once HQ aligns it to its root's first form, in HQ's order, or
    None where the root's datums are not followed here (``_root_selection_datums``) or a load chooses from a lookup
    table. HQ's datums are each load's (``case_id_<tag>``; one selected in a mode of its own loads no case type and
    asks for no selection) and each computed datum's (``get_datum_meta_assertions_advanced``), aligned to the
    root's (``add_parent_datums``): a datum whose id a root datum holds, as first read, is renamed
    ``<id>_<case type>``; a root datum that asks for no selection joins the entry under its own id; and each that
    asks for one takes the child's next datum where both load one case type, which takes the root's id. Each root
    open action's new case id follows, unaligned (``get_new_case_id_datums_meta``)."""
    root = app.root(module)
    parents = _root_selection_datums(app, root) if root is not None else []
    if parents is None:
        return None
    datums = []
    for load in loads:
        if _from_fixture(load):
            return None
        auto = _auto_selected(load) and (load["auto_select"].get("mode") or None)
        tag = load.get("case_tag")
        datums.append({"id": f"case_id_{tag}", "type": None if auto else load.get("case_type"), "action": True})
    for datum in form.get("arbitrary_datums") or []:
        if isinstance(datum, dict) and datum.get("datum_id"):
            datums.append({"id": datum.get("datum_id"), "type": None, "action": False})
    by_id = {datum["id"]: datum for datum in datums}
    joined = []
    remaining = list(datums)
    for parent_id, parent_type, selects in parents:
        if parent_id in by_id:
            renamed = by_id[parent_id]
            renamed["id"] = f"{renamed['id']}_{renamed['type']}"
        if not selects:
            joined.append(parent_id)
            continue
        if remaining and remaining[0]["action"] and remaining[0]["type"] == parent_type:
            remaining[0]["id"] = parent_id
            joined.append(remaining.pop(0)["id"])
    ids = joined + [datum["id"] for datum in remaining]
    ids += [
        f"case_id_new_{action.get('case_type')}_{i}"
        for i, action in enumerate(opens)
        if not action.get("repeat_context")
    ]
    return ids


def opening_values_sharing_a_session_name(use, manifest):
    """``forms-and-case-writes/opening-values-sharing-a-physical-session-name``: an advanced form two of whose
    opening values (a load, a computed datum, a root open action's new case) take one session id. Read from the ids
    before alignment, and in a menu under another from the ids once HQ aligns them (``_aligned_entry_ids``), where
    alignment may rename a load onto another's id; None where that alignment is not followed here."""
    at, form = _form(use)
    if form is None or form.get("doc_type") != "AdvancedForm":
        return False if form is not None else None
    loads, opens = _advanced_lists(form)
    ids = _opening_ids(form, loads, opens)
    if len(set(ids)) < len(ids):
        return True
    if not _aligned(at):
        return False
    module = at.app.module_of(form)
    aligned = _aligned_entry_ids(at.app, module, form, loads, opens) if module is not None else None
    if aligned is None:
        return None
    return len(set(aligned)) < len(aligned)


def automatic_connection_renamed_by_parent(use, manifest):
    """``forms-and-case-writes/automatic-connection-to-a-load-renamed-by-its-parent``: a load selected in the
    ``case`` mode from an earlier load, in a form whose menu sits under another, where alignment may give that
    earlier load the root's id while the connection still names ``case_id_<tag>``. A form in a menu of its own
    holds none; under another menu, whether the earlier load keeps its id is the alignment's: None there."""
    at, form = _form(use)
    if form is None:
        return None
    loads, _ = _advanced_lists(form)
    connected = any(
        isinstance(load.get("auto_select"), dict) and load["auto_select"].get("mode") == "case" for load in loads
    )
    if not connected:
        return False
    return None if _aligned(at) else False


def _slash_property_on_indexed_load(at, form, loads, opens, action, index):
    if not _is_load(action, loads) or not _indices(action, loads):
        return False
    written = [key for key in (action.get("case_properties") or {})]
    preloaded = [value for value in (action.get("preload") or {}).values() if isinstance(value, str)]
    return any("/" in name for name in (*written, *preloaded))


slash_property_on_indexed_load = _advanced_reader(_slash_property_on_indexed_load)
slash_property_on_indexed_load.__doc__ = """
``forms-and-case-writes/loadupdateaction-preload-or-case-properties-property-with-on-a``:
a load with a ``case_index`` whose ``case_properties`` key or ``preload`` property (a preload maps a question
path to a property) holds ``/``, which HQ's validator checks as a child case's name
(``AdvancedFormValidator.check_actions``) and the editor refuses ("Parent property references not allowed for
subcases", ``advanced/case_properties.js``)."""


def _index_on_auto_select_or_first_load(at, form, loads, opens, action, index):
    if not _is_load(action, loads) or not _indices(action, loads):
        return False
    return _auto_selected(action) or action is loads[0]


index_on_auto_select_or_first_load = _advanced_reader(_index_on_auto_select_or_first_load)
index_on_auto_select_or_first_load.__doc__ = """
``forms-and-case-writes/loadupdateaction-case-index-on-an-auto-selected-load-or-on-the``:
a load's ``case_index`` on a load that selects its case itself or on the form's first load, where the editor
offers no "This case is a subcase of the previous case" (``case_config_advanced.html``)."""


def _tag_names_other_than_previous_load(at, form, loads, opens, action, index):
    if not _is_load(action, loads) or not _indices(action, loads):
        return False
    tag = action["case_index"].get("tag")
    if not any(other.get("case_tag") == tag for other in (*loads, *opens)):
        # A tag naming no action is HQ's build's own refusal (``missing parent tag``), another entry's.
        return False
    position = next(i for i, load in enumerate(loads) if load is action)
    previous = loads[position - 1].get("case_tag") if position > 0 else None
    return tag != previous


tag_names_other_than_previous_load = _advanced_reader(_tag_names_other_than_previous_load)
tag_names_other_than_previous_load.__doc__ = """
``forms-and-case-writes/loadupdateaction-case-index-tag-naming-a-load-other-than-the-one``:
a load's ``case_index.tag`` naming an action other than the load just before it in ``load_update_cases``, the
only action the editor links a load to (``advanced/actions.js``, the load's ``subcase`` write). A tag naming no
action is ``forms-and-case-writes/case-index-tag-naming-no-action``'s, which HQ's build refuses."""


def _open_action_slash_key(at, form, loads, opens, action, index):
    if _is_load(action, loads):
        return False
    return any("/" in key for key in action.get("case_properties") or {})


open_action_slash_key = _advanced_reader(_open_action_slash_key)
open_action_slash_key.__doc__ = """``forms-and-case-writes/advancedopencaseaction-case-properties-key-with-parent-p``:
an open action's ``case_properties`` key holding ``/``."""


def _shared_block_in_repeat(at, form, loads, opens, action, index):
    if _is_load(action, loads) or not action.get("repeat_context"):
        return False
    sharing = [other for other in opens if other.get("repeat_context") == action["repeat_context"]]
    indexed = [other for other in sharing if _indices(other, loads)]
    return len(sharing) > 1 and len(indexed) < 2


shared_block_in_repeat = _advanced_reader(_shared_block_in_repeat)
shared_block_in_repeat.__doc__ = """
``forms-and-case-writes/two-or-more-open-actions-whose-repeat-context-is-one-repeat``:
an open action in a repeat that another open action shares, where fewer than two of the repeat's open actions
carry ``case_indices``: HQ nests each block under ``case_<tag>`` only where the repeat holds two indexed open
actions (``xform.py::_create_casexml_advanced``, ``get_action_path``;
``AdvancedFormActions.count_subcases_per_repeat_context``), so otherwise their blocks share one path."""


def _innermost_repeat(xform, path):
    return max(
        (repeat for repeat in xform.repeat_paths if path == repeat or path.startswith(f"{repeat}/")),
        key=len,
        default="",
    )


def _open_action_not_name_question_repeat(at, form, loads, opens, action, index):
    if _is_load(action, loads):
        return False
    name = action.get("name_update")
    path = name.get("question_path") if isinstance(name, dict) else None
    if not path:
        return False
    xform = at.app.xform(form)
    if xform is None:
        return None
    return (action.get("repeat_context") or "") != _innermost_repeat(xform, path)


open_action_not_name_question_repeat = _advanced_reader(_open_action_not_name_question_repeat)
open_action_not_name_question_repeat.__doc__ = """
``forms-and-case-writes/advancedopencaseaction-repeat-context-other-than-the-name``:
an open action whose ``repeat_context`` is not its name question's innermost repeat, which the advanced save writes
from the name question (``advanced/actions.js``, ``openCaseAction.unwrap``; ``advanced/case_config_ui.js``,
``get_repeat_context``), read in the form's XForm."""


def _index_tags(action, loads, index):
    """The tags of the action's indices a use reads: the one it sits in, else every one."""
    return [index.get("tag")] if index is not None else [each.get("tag") for each in _indices(action, loads)]


def _tag_names_own_or_later_open_action(at, form, loads, opens, action, index):
    if _is_load(action, loads):
        return False
    position = next(i for i, other in enumerate(opens) if other is action)
    later = {other.get("case_tag") for other in opens[position:] if other.get("case_tag")}
    return any(tag in later for tag in _index_tags(action, loads, index))


tag_names_own_or_later_open_action = _advanced_reader(_tag_names_own_or_later_open_action)
tag_names_own_or_later_open_action.__doc__ = """
``forms-and-case-writes/advancedopencaseaction-case-indices-naming-its-own-or-a-later``:
an open action's index whose tag is its own or a later open action's, which the parent select never lists
(``advanced/case_config_ui.js::getCaseTags('subcase')``: the loads, and the open actions before it)."""


def _relationship_question_in_repeat(at, form, loads, opens, action, index):
    indices = [index] if index is not None else _indices(action, loads)
    paths = [each.get("relationship_question") for each in indices if each.get("relationship_question")]
    if not paths:
        return False
    xform = at.app.xform(form)
    if xform is None:
        return None
    return any(xform.in_repeat(path) for path in paths)


relationship_question_in_repeat = _advanced_reader(_relationship_question_in_repeat)
relationship_question_in_repeat.__doc__ = """``forms-and-case-writes/caseindex-relationship-question-inside-a-repeat``:
an index's ``relationship_question`` inside a repeat, which the editor's question picker leaves out
(``case_config_advanced.html``, ``getQuestions('all', false, false)``), read in the form's XForm."""


def _question_relationship_to_open_action(at, form, loads, opens, action, index):
    if _is_load(action, loads):
        return False
    opened = {other.get("case_tag") for other in opens if other.get("case_tag")}
    indices = [index] if index is not None else _indices(action, loads)
    return any(each.get("relationship") == "question" and each.get("tag") in opened for each in indices)


question_relationship_to_open_action = _advanced_reader(_question_relationship_to_open_action)
question_relationship_to_open_action.__doc__ = """
``forms-and-case-writes/caseindex-relationship-question-relationship-question-the-index-naming-an``:
an open action's index whose ``relationship`` is ``question`` and whose tag names an open action: HQ writes its
relationship and owner binds on the parent's block (``xform.py::_create_casexml_advanced``)."""


def _question_relationship_after_open_action_index(at, form, loads, opens, action, index):
    if _is_load(action, loads):
        return False
    opened = {other.get("case_tag") for other in opens if other.get("case_tag")}
    loaded = {load.get("case_tag") for load in loads if load.get("case_tag")}
    indices = _indices(action, loads)
    for position, each in enumerate(indices):
        if index is not None and each is not index:
            continue
        if each.get("relationship") != "question" or each.get("tag") not in loaded:
            continue
        if any(earlier.get("tag") in opened for earlier in indices[:position]):
            return True
    return False


question_relationship_after_open_action_index = _advanced_reader(_question_relationship_after_open_action_index)
question_relationship_after_open_action_index.__doc__ = """
``forms-and-case-writes/caseindex-relationship-question-on-an-index-to-a-load-that``:
an open action's index to a load whose ``relationship`` is ``question``, after an index of the same open action to
an open action: resolving that parent first replaces the child's path, so HQ writes this index's relationship and
owner binds on the parent's block (``xform.py::_create_casexml_advanced``)."""


def _outside_parent_repeat(at, form, loads, opens, action, index):
    if _is_load(action, loads):
        return False
    contexts = {other.get("case_tag"): other.get("repeat_context") or "" for other in opens if other.get("case_tag")}
    child = action.get("repeat_context") or ""
    for tag in _index_tags(action, loads, index):
        parent = contexts.get(tag)
        if parent and child != parent and not child.startswith(f"{parent}/"):
            return True
    return False


outside_parent_repeat = _advanced_reader(_outside_parent_repeat)
outside_parent_repeat.__doc__ = """
``forms-and-case-writes/an-advanced-open-action-indexed-to-an-open-action-that-has-a-neither``:
an open action indexed to an open action in a repeat, whose own ``repeat_context`` is neither that repeat nor a
path inside it (HQ's own check, ``AdvancedFormValidator.check_actions``, compares text prefixes, so ``/data/rep2``
passes it beside ``/data/rep``; the class reads paths by their steps)."""


def _root_selection_datums(app, root):
    """The datums of the first form of a child menu's root, as HQ aligns the child's datums to them
    (``suite_xml/sections/entries.py::EntriesHelper._get_first_forms_datums``): each ``(id, case type, whether
    it asks for a selection)``, or None where the root holds a shape this does not follow (a mirror menu, a
    parent selection or a several-case list before the form, a lookup-table load, CommCare Supply's product)."""
    forms = _forms(root)
    if not forms:
        return []
    if root.get("doc_type") not in ("Module", "AdvancedModule"):
        return None
    form = forms[0]
    if form.get("doc_type") == "AdvancedForm":
        loads, opens = _advanced_lists(form)
        datums = []
        for load in loads:
            if _from_fixture(load) or load.get("show_product_stock"):
                return None
            auto = _auto_selected(load) and (load["auto_select"].get("mode") or None)
            datums.append((f"case_id_{load.get('case_tag')}", None if auto else load.get("case_type"), not auto))
        for position, action in enumerate(opens):
            if not action.get("repeat_context"):
                datums.append((f"case_id_new_{action.get('case_type')}_{position}", action.get("case_type"), False))
        return datums
    if form.get("doc_type") != "Form":
        return None
    datums = []
    if _requires(form) == "case":
        if (root.get("parent_select") or {}).get("active"):
            return None
        if ((root.get("case_details") or {}).get("short") or {}).get("multi_select"):
            return None
        datums.append(("case_id", root.get("case_type"), True))
    actions = _actions(form)
    opens_case = _active(actions.get("open_case"))
    if opens_case:
        datums.append((f"case_id_new_{root.get('case_type')}_0", root.get("case_type"), False))
    for position, subcase in enumerate(_subcases(form)):
        if _active(subcase) and not subcase.get("repeat_context"):
            number = position + 1 if opens_case else position
            datums.append((f"case_id_new_{subcase.get('case_type')}_{number}", subcase.get("case_type"), False))
    return datums


def _aligned_load_datums(app, module, loads):
    """Each load's datum id in a form of ``module`` once HQ aligns it to its root's first form
    (``entries.py::EntriesHelper.add_parent_datums``), by the load's identity, or None where the root's datums
    are not followed here (``_root_selection_datums``). A datum whose id a root datum holds is renamed
    ``<id>_<case type>``; then each root datum that asks for a selection takes the child's next datum where both
    load one case type, and that datum takes the root's id."""
    root = app.root(module)
    if root is None:
        return {id(load): f"case_id_{load.get('case_tag')}" for load in loads}
    parents = _root_selection_datums(app, root)
    if parents is None:
        return None
    datums = []
    for load in loads:
        if _from_fixture(load) or load.get("show_product_stock"):
            return None
        auto = _auto_selected(load) and (load["auto_select"].get("mode") or None)
        datums.append({"id": f"case_id_{load.get('case_tag')}", "type": None if auto else load.get("case_type")})
    by_id = {datum["id"]: datum for datum in datums}
    remaining = list(datums)
    for parent_id, parent_type, selects in parents:
        if parent_id in by_id:
            renamed = by_id[parent_id]
            renamed["id"] = f"{renamed['id']}_{renamed['type']}"
        if not selects:
            continue
        if remaining and remaining[0]["type"] is not None and remaining[0]["type"] == parent_type:
            remaining.pop(0)["id"] = parent_id
    return {id(load): datum["id"] for load, datum in zip(loads, datums, strict=True)}


def _load_with_renamed_datum(at, form, loads, opens, action, index):
    if _is_load(action, loads):
        return False
    by_tag = {load.get("case_tag"): load for load in loads if load.get("case_tag")}
    named = [by_tag[tag] for tag in _index_tags(action, loads, index) if tag in by_tag]
    if not named:
        return False
    module = at.app.module_of(form)
    if module is None:
        return None
    aligned = _aligned_load_datums(at.app, module, loads)
    if aligned is None:
        return None
    return any(aligned[id(load)] != f"case_id_{load.get('case_tag')}" for load in named)


load_with_renamed_datum = _advanced_reader(_load_with_renamed_datum)
load_with_renamed_datum.__doc__ = """
``forms-and-case-writes/an-advanced-open-action-s-index-to-a-load-whose-datum-hq-renames``:
an open action's index to a load whose datum HQ renames in a child menu (``entries.py::add_parent_datums``),
while the index reads ``case_id_<tag>`` (``xform.py::_create_casexml_advanced``), which the entry then never sets."""


def _auto_select_blank_mode_or_case_type(at, form, loads, opens, action, index):
    if not _is_load(action, loads) or not _auto_selected(action):
        return False
    return not action["auto_select"].get("mode") or not action.get("case_type")


auto_select_blank_mode_or_case_type = _advanced_reader(_auto_select_blank_mode_or_case_type)
auto_select_blank_mode_or_case_type.__doc__ = """
``forms-and-case-writes/an-auto-select-load-with-a-blank-mode-or-a-blank-case-type``:
a load that selects its case itself whose ``auto_select.mode`` or ``case_type`` is blank, which the advanced editor
marks "Autoselect mode required" or "Expected case type required" (``advanced/actions.js``,
``loadUpdateAction.validate``). A load that does not select its case itself is in no such class."""


def _auto_select_case_not_an_earlier_load(at, form, loads, opens, action, index):
    if not _is_load(action, loads) or not _auto_selected(action):
        return False
    if action["auto_select"].get("mode") != "case":
        return False
    position = next(i for i, load in enumerate(loads) if load is action)
    earlier = {load.get("case_tag") for load in loads[:position] if load.get("case_tag")}
    return action["auto_select"].get("value_source") not in earlier


auto_select_case_not_an_earlier_load = _advanced_reader(_auto_select_case_not_an_earlier_load)
auto_select_case_not_an_earlier_load.__doc__ = """
``forms-and-case-writes/auto-select-mode-case-naming-itself-a-later-load-or-an-open``:
an ``auto_select`` in ``case`` mode whose ``value_source`` is not the tag of a load before it, since the source
select lists only the earlier loads (``advanced/case_config_ui.js::getCaseTags('auto-select')``). Every other
mode, the worker's ``usercase`` among them, is in no such class."""


def _shows_product_stock(load):
    """Whether a load turns CommCare Supply's product stock on: ``show_product_stock`` true, or a
    ``product_program`` (``LoadUpdateAction``)."""
    return bool(load.get("show_product_stock")) or bool(load.get("product_program"))


def _commtrack_on(at, form, loads, opens, action, index):
    return _is_load(action, loads) and _shows_product_stock(action)


commtrack_on = _advanced_reader(_commtrack_on)
commtrack_on.__doc__ = """``forms-and-case-writes/show-product-stock-true-or-a-non-empty-product-program``: a load
whose ``show_product_stock`` is true or whose ``product_program`` is not blank (``LoadUpdateAction``), CommCare
Supply's content. HQ's advanced editor writes ``false`` and ``""`` (``advanced/case_config_ui.js``, its new load's
``show_product_stock`` and ``product_program``), which are no use of the class."""


def _shadow_extra_loads(form):
    """A mirror form's own loads (``ShadowForm.extra_actions.load_update_cases``)."""
    extra = form.get("extra_actions") or {}
    return [load for load in extra.get("load_update_cases") or [] if isinstance(load, dict)]


def _shadow_loads_read(use):
    """The mirror form a use sits in and the loads of its ``extra_actions`` the use reads (the one it sits in, else
    every one): ``(form, loads)``, the form None where the use sits in no mirror form (``ShadowForm``)."""
    at, form = _form(use)
    if form is None or form.get("doc_type") != "ShadowForm":
        return None, ()
    extra = _shadow_extra_loads(form)
    held = at.nearest("LoadUpdateAction")
    if held is not None and any(held is load for load in extra):
        return form, (held,)
    return form, tuple(extra)


def shadow_commtrack_on(use, manifest):
    """``forms-and-case-writes/extra-actions-load-update-cases-show-product-stock-true-or-a-non``: a mirror form's
    own load (``extra_actions``) whose ``show_product_stock`` is true or whose ``product_program`` is not blank,
    which ``ShadowForm._merge_actions`` writes over the source form's load. A load of any other form is in no such
    class (``commtrack-on`` reads it)."""
    if _json(use) is None:
        return None
    form, loads = _shadow_loads_read(use)
    if form is None:
        return False
    return any(_shows_product_stock(load) for load in loads)


def schedule_enabled(use, manifest):
    """``forms-and-case-writes/advancedform-schedule-with-enabled-true-visits-transition``: a form's visit schedule
    that is on. ``FormSchedule.enabled`` is true where the schedule leaves it out
    (``models/forms.py::FormSchedule``), and every reader of the schedule tests it (``xform.py``'s scheduler blocks,
    ``form.schedule.enabled``), so a schedule HQ writes on every new advanced or mirror form, ``enabled`` false, is
    the INERT class beside it. A use of a key inside the schedule (its visits, its conditions) is read in the
    schedule it sits in; a value of ``enabled`` that is no truth value, which HQ's model refuses as it wraps the
    app, is not settled."""
    at = _json(use)
    if at is None:
        return None
    schedule = at.value if at.key == "schedule" else at.nearest("FormSchedule")
    if not isinstance(schedule, dict):
        return None
    enabled = schedule.get("enabled", True)
    return enabled if isinstance(enabled, bool) else None


def _reads_through(load, opens):
    """Whether a source form's XForm reads or writes through a load: its preloads, its ``case_properties``, its
    close, or an open action's index to its tag (``xform.py::_create_casexml_advanced``)."""
    tag = load.get("case_tag")
    if load.get("preload") or load.get("case_properties") or _active({"condition": load.get("close_condition")}):
        return True
    return bool(tag) and any(
        index.get("tag") == tag
        for action in opens
        for index in action.get("case_indices") or []
        if isinstance(index, dict)
    )


def basic_or_shadow_parent(use, manifest):
    """``forms-and-case-writes/shadow-parent-form-id-naming-a-basic-form-or-another-shadowform``: a shadow form whose
    ``shadow_parent_form_id`` names a basic form or another shadow form, which HQ's form settings never offer
    (``ShadowForm.get_shadow_parent_options`` lists advanced forms alone). A parent the app does not hold is
    ``shadow-parent-form-id-missing-or-dangling``'s; a use of any other form is in no such class."""
    at, form = _form(use)
    if form is None:
        return None
    if form.get("doc_type") != "ShadowForm":
        return False
    parent = at.app.forms_by_id.get(form.get("shadow_parent_form_id"))
    return parent is not None and parent.get("doc_type") in ("Form", "ShadowForm")


def shadow_parent_tag_not_repeated(use, manifest):
    """``forms-and-case-writes/a-parent-load-tag-not-repeated-in-extra-actions-where-the-parent``: a mirror form
    whose ``extra_actions`` leave out the tag of a source form's load the source XForm reads or writes through
    (``_reads_through``): ``ShadowForm._merge_actions`` keeps only the loads ``extra_actions`` names, so that tag's
    datum is gone. A use of any other form is in no such class; a mirror whose source form the app does not hold
    leaves it open."""
    at = _json(use)
    if at is None:
        return None
    form, _ = _shadow_loads_read(use)
    if form is None:
        return False
    source = at.app.forms_by_id.get(form.get("shadow_parent_form_id"))
    if source is None:
        return None
    repeated = {load.get("case_tag") for load in _shadow_extra_loads(form)}
    loads, opens = _advanced_lists(source)
    return any(load.get("case_tag") not in repeated and _reads_through(load, opens) for load in loads)


def update_never_followup_alone(use, manifest):
    """``forms-and-case-writes/update-case-condition-never-on-a-follow-up-with-no-other-active``:
    ``update_case.condition: never`` on a follow-up whose ``Form.active_actions`` hold nothing else, outside
    a multi-select or data-registry-loading module."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "update_case"):
        return False
    if _requires(form) != "case" or _condition(_actions(form).get("update_case")) != "never":
        return False
    module = at.app.module_of(form) or {}
    if ((module.get("case_details") or {}).get("short") or {}).get("multi_select"):
        return False
    if (module.get("search_config") or {}).get("data_registry"):
        return None  # a data-registry-loading module also reads its workflow, which this does not settle
    # Form.active_actions on a follow-up: a FormAction is active by its condition, a PreloadAction by its preload.
    actions = _actions(form)
    if any(_active(actions.get(name)) for name in ("close_case", "usercase_update")):
        return False
    if any((actions.get(name) or {}).get("preload") for name in ("case_preload", "usercase_preload", "load_from_form")):
        return False
    return not any(_active(subcase) for subcase in _subcases(form))


# The update keys HQ's Case Management tab accepts as index segments (case_config_ui.js::caseProperty.validate).
INDEX_SEGMENTS = frozenset({"parent", "host"})


def unrecognized_index_key(use, manifest):
    """``forms-and-case-writes/update-key-with-any-other-index-segment-or-user-where-the``: an update key whose
    index segments are not each ``parent`` or ``host``; one through ``user`` depends on the project space's
    usercase access, which the export does not carry (None)."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "update_case") or not _writes_own_update(_actions(form).get("update_case")):
        return False
    keys = list((_actions(form).get("update_case") or {}).get("update") or {})
    unsure = False
    for key in keys:
        segments = str(key).split("/")[:-1]
        if any(segment not in INDEX_SEGMENTS | {"user"} for segment in segments):
            return True
        unsure = unsure or "user" in segments
    return None if unsure else False


def index_key_on_opened_case(use, manifest):
    """``forms-and-case-writes/an-update-key-with-an-index-segment-on-a-form-that-opens-its``: an update key
    with an index segment on a form that opens its case."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "update_case") or not _active(_actions(form).get("open_case")):
        return False
    if not _writes_own_update(_actions(form).get("update_case")):
        return False
    return any("/" in str(key) for key in (_actions(form).get("update_case") or {}).get("update") or {})


def usercase_preload_other(use, manifest):
    """``forms-and-case-writes/any-other-usercase-preload``: a ``usercase_preload`` the row above does not hold,
    read where Nova's reader draws the line (``caseManagement/preloads.ts``): beside an active ``usercase_update``
    that writes at least one property, the row above holds a load whose every path names a question of the form
    outside any repeat and whose every property a worker-record read spells (``_usercase_read``); any other load
    is in this class. A path naming a node whose name Nova's own generated nodes take (``nova_``) is left open:
    Nova's reader tells its own node from an author's by printing it again, which the export does not settle."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "usercase_preload"):
        return False
    preload = (_actions(form).get("usercase_preload") or {}).get("preload") or {}
    if not preload:
        return False
    update = _actions(form).get("usercase_update") or {}
    if not (_active(update) and update.get("update")):
        return True
    if any(_usercase_read(property_name) is None for property_name in preload.values()):
        return True
    xform = at.app.xform(form)
    if xform is None:
        return None
    verdicts = {_usercase_question(xform, path) for path in preload}
    if False in verdicts:
        return True
    return None if None in verdicts else False


def source_only_record_load(use, manifest):
    """``forms-and-case-writes/a-source-only-record-load-with-no-equivalent-editable-initial-value``: a record load
    Nova can hold neither as an ordered opening assignment nor as the question's own default, read where Nova's
    reader draws the line on a read of the app as it stands (``caseManagement/preloads.ts``,
    ``advancedActions.ts::readLoadPreloads``). A ``usercase_preload`` the next row holds (beside an active
    ``usercase_update`` that writes, each path a question outside any repeat, each property a worker-record read
    spells) into a question that takes no default value: a Hidden Value its bind calculates, or a group or
    repeat. And a ``case_preload`` or load ``preload`` whose property spells, with its trailing newline, a case
    child the plain spelling of which HQ's build refuses (``_unemittable``), which no assignment can name: into
    a question taking no default value, or (a ``case_preload``) through an index other than ``parent``, or (a
    load) in a repeat or through any index. A label is the picker's row, and a repeat a ``case_preload`` fills
    none of, so neither is this class. Which load an earlier read of the app had already folded into a default is
    the history of a bring-in, not the export's; on a read of the export as it stands the reader holds every
    other load as an assignment. A path naming a node Nova's generated nodes take (``nova_``) is left open, as
    in ``usercase_preload_other``."""
    at, form = _form(use)
    if form is None:
        return None
    actions = _actions(form)
    load = at.nearest("LoadUpdateAction")
    if load is not None:
        preload = load.get("preload") or {}
        kind = "load"
    elif _in_actions(at, form, "usercase_preload"):
        preload = (actions.get("usercase_preload") or {}).get("preload") or {}
        kind = "usercase"
    elif _in_actions(at, form, "case_preload"):
        preload = (actions.get("case_preload") or {}).get("preload") or {}
        kind = "own"
    else:
        return False
    if not isinstance(preload, dict) or not preload:
        return False
    xform = at.app.xform(form)
    if xform is None:
        return None
    if kind == "usercase":
        update = actions.get("usercase_update") or {}
        if not (_active(update) and update.get("update")):
            return False
        if any(_usercase_read(property_name) is None for property_name in preload.values()):
            return False
        verdicts = {_usercase_question(xform, path) for path in preload}
        if False in verdicts:
            return False
        if None in verdicts:
            return None
        defaults = {_takes_no_default(xform, _absolute(xform, path)) for path in preload}
        return True if True in defaults else None if None in defaults else False
    unsure = False
    for path, property_name in preload.items():
        if not isinstance(property_name, str) or not _unemittable(property_name):
            continue
        absolute = _absolute(xform, path)
        if absolute is None or xform.node(absolute) is None or _is_label(xform, absolute):
            continue
        *indices, _name = property_name[:-1].split("/")
        if kind == "own":
            if xform.in_repeat(absolute):
                continue
            if any(index != "parent" for index in indices):
                return True
        elif indices or xform.in_repeat(absolute):
            return True
        verdict = _takes_no_default(xform, absolute)
        if verdict:
            return True
        unsure = unsure or verdict is None
    return None if unsure else False


def _unemittable(property_name):
    """Whether a preloaded property spells, with the one trailing newline HQ's grammar admits, a case child Nova
    names (``preloads.ts::preloadReadOf``) whose plain spelling HQ's build refuses
    (``preloads.ts::hqBuildRefusesProperty``, ``name`` for ``case_name``): no opening assignment can spell it."""
    if not property_name.endswith("\n") or HQ_PROPERTY_PATH.fullmatch(property_name) is None:
        return False
    name = property_name[:-1].split("/")[-1]
    if name not in CASE_CHILD_ELEMENTS and (name in ("name", "owner_id") or name in HQ_CASE_RESERVED_WORDS):
        return False
    plain = "name" if name == "case_name" else name
    return HQ_PROPERTY_PATH.fullmatch(plain) is None or plain in HQ_CASE_RESERVED_WORDS


def _absolute(xform, path):
    """A preload path as the absolute path of the main instance's node it names, or None."""
    if not isinstance(path, str) or not path or xform.data_root is None:
        return None
    root = f"/{_local(xform.data_root)}"
    if path.startswith("/"):
        return path if path.startswith(f"{root}/") else None
    return f"{root}/{path}"


def _takes_no_default(xform, path):
    """Whether a question takes no default value Nova can give it (``preloads.ts::holdsDefault``): a group or a
    repeat, or a node no control names whose bind calculates it (a Hidden Value). None for a node whose name
    Nova's generated nodes take."""
    node = xform.node(path) if path else None
    if node is None or isinstance(node, tuple):
        return None
    if _local(node).startswith("nova_"):
        return None
    controls = xform.question_controls(path)
    if controls:
        return _local(controls[0]) in ("group", "repeat")
    bind = xform.bind(path)
    return bind is not None and bind.get("calculate") is not None


def _usercase_read(property_name):
    """The worker-case element a ``usercase_preload`` of ``property_name`` reads where a worker-record read prints
    it, else None (``preloads.ts::usercaseRead``): HQ's build refuses the property outside its grammar or in its
    reserved words (``helpers/validators.py::IndexedFormBaseValidator.check_case_properties``); a path through an
    index reads an ancestor of the worker's case; ``owner_id`` is the case's attribute; a name with the one trailing
    newline HQ's grammar admits reads the element of the name without it, which Nova names only where HQ's build
    reads the name so without the newline or the element is one of every case's (``preloads.ts::preloadReadOf``);
    and Nova's worker-record read spells only ``SESSION_USER_FIELD``'s names."""
    if not isinstance(property_name, str) or HQ_PROPERTY_PATH.fullmatch(property_name) is None:
        return None
    newline = property_name.endswith("\n")
    *indices, name = (property_name[:-1] if newline else property_name).split("/")
    if not newline and name in HQ_CASE_RESERVED_WORDS:
        return None
    if newline and name not in CASE_CHILD_ELEMENTS and (name in ("name", "owner_id") or name in HQ_CASE_RESERVED_WORDS):
        return None
    if not newline and name == "name":
        name = "case_name"
    if indices or name == "owner_id":
        return None
    return name if name == "case_name" or SESSION_USER_FIELD.fullmatch(name) else None


def _usercase_question(xform, path):
    """Whether a ``usercase_preload`` path names a question of the form outside any repeat, as Nova's reader reads
    one (``preloads.ts::fieldAt``, ``basicActions.ts::repeatOfField``): a node of the main instance under its data
    root, by its absolute path or its path from the root, that no Save to Case block, case block or meta block
    holds, and that no repeat holds; a repeat itself stands outside any repeat but its own. None for a node whose
    name Nova's generated nodes take, which Nova's reader reads as one of its own only where printing it again
    gives the node."""
    if not isinstance(path, str) or not path or xform.data_root is None:
        return False
    root = f"/{_local(xform.data_root)}"
    if path.startswith("/"):
        if not path.startswith(f"{root}/"):
            return False
        absolute = path
    else:
        absolute = f"{root}/{path}"
    node = xform.nodes.get(absolute)
    if node is None or isinstance(node, tuple) or xform.holder(node) is not None:
        return False
    if any(absolute.startswith(f"{repeat}/") for repeat in xform.repeat_paths):
        return False
    return None if _local(node).startswith("nova_") else True


def multi_select_top_level(use, manifest):
    """``forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-in-a-multi-select-module``: a
    ``case_preload`` into a question outside any repeat, in a multi-select module that is neither a child
    menu nor under a parent selection."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "case_preload"):
        return False
    preload = (_actions(form).get("case_preload") or {}).get("preload") or {}
    if not preload or _requires(form) != "case":
        return False
    module = at.app.module_of(form) or {}
    if not ((module.get("case_details") or {}).get("short") or {}).get("multi_select"):
        return False
    if module.get("root_module_id") or (module.get("parent_select") or {}).get("active"):
        return False
    xform = at.app.xform(form)
    if xform is None:
        return None
    return any(not xform.in_repeat(path) for path in preload)


def _computed(xform, path):
    """Whether a node's value or relevance is computed: it, or a node above it, has a bind with a calculate or
    a relevance condition (a path whose text names no node is taken as computed)."""
    if path not in xform.nodes:
        return True
    while path:
        bind = xform.bind(path)
        if bind is not None and (bind.get("calculate") is not None or bind.get("relevant") is not None):
            return True
        path = path.rsplit("/", 1)[0] if path.count("/") > 1 else ""
    return False


def _reads_form(tree, context):
    """Whether an expression reads a node of the form's own data: a path from the root or ``current()``, or
    one from the context node where that is the form's (``context``: ``form``; inside a path through another
    instance it is that instance's)."""
    kind = tree[0]
    if kind == "path":
        root = tree[1]
        if root in ("absolute", "call:current"):
            return True
        if root == "relative" and context == "form":
            return True
        inner = "instance" if root.startswith("instance:") else context
        return any(_reads_form(predicate, inner) for predicate in tree[3])
    if kind == "binary":
        return _reads_form(tree[2], context) or _reads_form(tree[3], context)
    if kind == "negative":
        return _reads_form(tree[1], context)
    if kind == "call":
        return tree[1] == "current" or any(_reads_form(argument, context) for argument in tree[2])
    return False


def _quoted(text):
    """``text`` without the one pair of like quotes around it, as Vellum's ``parseBindElement`` strips a case
    type's (``/^(['"])(.*)\\1$/``); ``text`` itself where it is no such literal."""
    if len(text) >= 2 and text[0] in "'\"" and text[-1] == text[0]:
        return text[1:-1]
    return text


def _property_name(text):
    """Whether a bind's last step names a case property Vellum reads (``[\\w-]+``)."""
    return bool(text) and all(character.isalnum() or character in "_-" for character in text)


def vellum_case_references(xform):
    """What Vellum computes for a form's ``case_references_data.save`` from its SaveToCase blocks
    (``logic.js::LogicManager.caseReferences``, ``saveToCase.js::parseDataNode``, ``parseBindElement``,
    ``handleMugParseFinish`` and ``getCaseSaveData``), by each block's data path, ``doc_type`` aside:

    1. one entry per data element carrying ``vellum:role="SaveToCase"``, in document order;
    2. ``case_type`` from the ``create/case_type`` bind: its text without its quotes where it is one quoted
       literal, ``""`` where it holds another non-empty expression, else the element's ``vellum:case_type``;
    3. ``create`` and ``close`` where a ``create`` or a ``close`` lies anywhere below one of the block's children;
    4. each bind of ``<block>/case/create/<name>`` or ``<block>/case/update/<name>``, in document order, its
       ``case_type``, ``case_name`` and ``owner_id`` create binds read apart;
    5. ``properties``: for a block that creates, the create binds' names then the update binds', each once,
       then ``case_type`` where the type is set or an expression, ``case_name`` and ``owner_id`` where their
       binds hold a ``calculate``; for any other block, the update binds' names, each once.
    """
    found = {}
    binds = list(xform.model.iterfind(f"{{{XFORMS}}}bind")) if xform.model is not None else []
    for node in xform.save_to_case:
        path = xform.paths[node]
        # saveToCase.js::parseDataNode reads both as $node.children().find(...): anywhere below a child.
        creates = node.find(f"*//{{{CASE}}}create") is not None
        closes = node.find(f"*//{{{CASE}}}close") is not None
        case_type = node.get(f"{{{VELLUM}}}case_type") or ""
        type_expression = False
        named = {"create": [], "update": []}
        case_name = owner_id = None
        for bind in binds:
            nodeset = (bind.get("nodeset") or "").strip()
            for action, names in named.items():
                prefix = f"{path}/case/{action}/"
                name = nodeset[len(prefix) :] if nodeset.startswith(prefix) else ""
                if not _property_name(name):
                    continue
                calculate = bind.get("calculate")
                if action == "create" and name == "case_type":
                    text = calculate or ""
                    stripped = _quoted(text)
                    if stripped and stripped == text:
                        type_expression, case_type = True, ""
                    elif stripped:
                        case_type = stripped
                elif action == "create" and name == "case_name":
                    case_name = calculate
                elif action == "create" and name == "owner_id":
                    owner_id = calculate
                else:
                    names.append(name)
        if creates:
            properties = list(dict.fromkeys(named["create"] + named["update"]))
            if case_type or type_expression:
                properties.append("case_type")
            if case_name:
                properties.append("case_name")
            if owner_id:
                properties.append("owner_id")
        else:
            properties = list(dict.fromkeys(named["update"]))
        found[path] = {
            "case_type": case_type,
            "properties": [name for name in properties if name],
            "create": creates,
            "close": closes,
        }
    return found


def menu_layout_outside_choices(use, manifest):
    at = _json(use)
    if at is None:
        return None
    if at.key == "use_grid_menus":
        return not isinstance(at.value, bool)
    if at.key == "grid_form_menus":
        return at.value not in ("none", "all", "some")
    if at.key == "display_style":
        return at.value not in ("list", "grid")
    return False


def repeated_android_app(use, manifest):
    at = _json(use)
    if at is None or use.key != "setting:features.dependencies":
        return None
    choices = (manifest.items.get(use.key) or {}).get("values") or []
    value = ((at.app.doc.get("profile") or {}).get("features") or {}).get("dependencies")
    return isinstance(value, list) and all(isinstance(item, str) and item in choices for item in value) and len(set(value)) < len(value)


def setting_outside_choices(use, manifest):
    """``application-and-settings/profile-properties-or-features-dependencies-value-outside-its``: a stored
    setting whose value is none of the setting's own choices (the ``values`` of its ``setting:properties.<key>``
    item, ``commcare-profile-settings.yml``), which HQ's settings page marks an error
    (``commcare_settings.js``, ``widgets.select.valueIsLegal``). The number ``10`` HQ's own save stores for the
    GPS accuracy is the row before's (``within-choices-or-numeric-10``), so it is no use of this class. A custom
    property is no setting the page shows; a feature, and a use outside an app JSON, the export leaves open."""
    at = _json(use)
    if at is None:
        return None
    if use.key == "setting:features.dependencies":
        choices = (manifest.items.get(use.key) or {}).get("values") or []
        value = ((at.app.doc.get("profile") or {}).get("features") or {}).get("dependencies")
        return not (
            isinstance(value, list)
            and all(isinstance(item, str) and item in choices for item in value)
        )
    if not use.key.startswith("setting:properties."):
        return None
    if "/custom_properties/" in use.where:
        return False
    name = use.key.removeprefix("setting:properties.")
    choices = (manifest.items.get(use.key) or {}).get("values")
    if not choices:
        return None
    value = (((at.app.doc.get("profile") or {}).get("properties")) or {}).get(name)
    if name == "cc-gps-auto-capture-accuracy" and value == 10 and not isinstance(value, bool):
        return False
    return value not in [str(choice) for choice in choices]


def save_differing_from_vellum(use, manifest):
    """``forms-and-case-writes/case-references-data-save-differing-from-that-computation``:
    ``case_references_data.save`` other than what Vellum computes from the form's SaveToCase blocks
    (``vellum_case_references``), compared key by key with each reference's ``doc_type`` aside: a difference is
    in the class, equality is not."""
    at, form = _form(use)
    if form is None:
        return None
    save = ((form.get("case_references_data") or {}).get("save")) or {}
    xform = at.app.xform(form)
    if xform is None:
        return None
    if not isinstance(save, dict):
        return True
    stored = {
        key: {name: value for name, value in reference.items() if name != "doc_type"}
        if isinstance(reference, dict)
        else reference
        for key, reference in save.items()
    }
    return stored != vellum_case_references(xform)


def own_case_condition_not_offered_or_quoted(use, manifest):
    """``forms-and-case-writes/a-basic-form-s-own-case-s-close-or-open-condition-on-another``: a basic form's
    own case's open or close condition (``if``) on a question the picker does not offer (other than a
    select, single select, hidden value or label outside repeats), or whose answer starts or ends with a
    quote mark. Read on the action a use sits in, else on both (``_actions_holding``)."""
    at, form = _form(use)
    if form is None:
        return None
    if (form.get("doc_type") or "Form") != "Form" or not _in_actions(at, form, "open_case", "close_case"):
        return False
    xform = at.app.xform(form)
    for name in _actions_holding(at, form, "open_case", "close_case"):
        condition = (_actions(form).get(name) or {}).get("condition") or {}
        if condition.get("type") != "if":
            continue
        answer = condition.get("answer") or ""
        if answer[:1] in ("'", '"') or answer[-1:] in ("'", '"'):
            return True
        if xform is None:
            return None
        if not _picker_offers(xform, condition.get("question"), repeats=False):
            return True
    return False


def _picker_offers(xform, path, *, repeats):
    """Whether HQ's condition picker offers a question: a select, single select, hidden value (a calculated
    node no control names) or label (``case_config_ko_templates.html`` ``case-config:condition``), outside
    repeats unless the transaction takes them."""
    if not path:
        return False
    if not repeats and xform.in_repeat(path):
        return False
    controls = xform.question_controls(path)
    if controls:
        return _local(controls[0]) in ("select", "select1", "trigger")
    bind = xform.bind(path)
    return xform.node(path) is not None and bind is not None and bind.get("calculate") is not None


def subcase_or_advanced_condition_not_offered(use, manifest):
    """``forms-and-case-writes/a-subcase-or-advanced-action-condition-on-a-question-the-picker``: a child
    case's condition or close condition on a question the picker does not offer. Read on the condition a use sits
    on or in (``_use_conditions``), else on each condition of the child case it sits in, else on every child
    case's."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "subcases"):
        return False
    xform = at.app.xform(form)
    subcase = at.nearest("OpenSubCaseAction")
    for each in [subcase] if subcase is not None else _subcases(form):
        own = _use_conditions(at, form) if subcase is not None else None
        for slot in ("condition", "close_condition"):
            condition = each.get(slot) or {}
            if own is not None and not any(condition is one for one in own):
                continue
            if condition.get("type") != "if":
                continue
            if xform is None:
                return None
            if not _picker_offers(xform, condition.get("question"), repeats=bool(each.get("repeat_context"))):
                return True
    return False


def answer_with_apostrophe(use, manifest):
    """``forms-and-case-writes/an-open-close-child-case-or-advanced-action-condition-with``: an action
    condition with operator ``=`` or ``selected`` whose answer holds ``'`` (``XForm.action_relevance`` writes
    it unescaped). Read on the condition a use sits on or in, else on the conditions of the action it sits in,
    else on every condition of the form (``_use_conditions``)."""
    at, form = _form(use)
    if form is None:
        return None
    conditions = _use_conditions(at, form)
    return any(
        (each.get("type") == "if")
        and (each.get("operator") or "=") in ("=", "selected")
        and "'" in (each.get("answer") or "")
        for each in conditions
    )


def _actions_holding(at, form, *names):
    """Which of a form's actions named ``names`` a use sits in (on its slot of the form's ``actions``, or inside
    it): that one, or all of them for a use on the form or on its ``actions`` as a whole, which hold every
    action."""
    actions = _actions(form)
    for name in names:
        action = actions.get(name)
        if action is not None and (at.value is action or any(value is action for _, value in at.scope)):
            return (name,)
    return names


def _action_conditions(action):
    return [action[key] for key in ("condition", "close_condition") if isinstance(action.get(key), dict)]


def _use_conditions(at, form):
    """The conditions a use reads: the condition it sits on or in, else those of the action it sits on or in
    (its ``condition`` and a child case's ``close_condition``), else every one of the form's (``_conditions``)."""
    condition = at.nearest("FormActionCondition")
    if condition is not None:
        return [condition]
    if at.key in ("condition", "close_condition") and isinstance(at.value, dict):
        return [at.value]
    actions = _actions(form)
    held = [actions[name] for name in ("open_case", "close_case", "update_case") if isinstance(actions.get(name), dict)]
    held += [subcase for subcase in _subcases(form) if isinstance(subcase, dict)]
    for action in held:
        if at.value is action or any(value is action for _, value in at.scope):
            return _action_conditions(action)
    return list(_conditions(form))


def _conditions(form):
    actions = _actions(form)
    for name in ("open_case", "close_case", "update_case"):
        if isinstance(actions.get(name), dict):
            yield actions[name].get("condition") or {}
    for subcase in _subcases(form):
        yield subcase.get("condition") or {}
        yield subcase.get("close_condition") or {}


def question_not_offered_by_picker(use, manifest):
    """``forms-and-case-writes/a-case-write-name-or-preload-on-a-question-the-picker-does-not``: a basic
    form's case write, name or preload on a label, or on a repeat question for its own case or the usercase
    (``case_config_utils.js::getQuestions``), or a child case's on a question in another repeat than its own
    (``case_config_ui.js``: "Inside the wrong repeat!"); in an advanced form, a load's write or preload on a
    repeat question, or an open action's name or write on a question in another repeat than its own
    (``_advanced_write_not_offered``). Read on the write or preload a use sits on, else on every one of the
    form's."""
    at, form = _form(use)
    if form is None:
        return None
    doc_type = form.get("doc_type") or "Form"
    if doc_type not in ("Form", "AdvancedForm"):
        return None
    xform = at.app.xform(form)
    if xform is None:
        return None
    if doc_type == "AdvancedForm":
        return _advanced_write_not_offered(at, form, xform)
    subcase = at.nearest("OpenSubCaseAction")
    written = at.nearest("ConditionalCaseUpdate")
    preload = at.nearest("PreloadAction")
    if subcase is not None:
        return _child_write_not_offered(xform, subcase, written)
    if written is not None:
        return _own_write_not_offered(xform, written.get("question_path"))
    if preload is not None:
        return any(_preload_not_offered(xform, path) for path in preload.get("preload") or {})
    actions = _actions(form)
    own = [
        update.get("question_path") if isinstance(update, dict) else None
        for name in ("update_case", "usercase_update")
        for update in ((actions.get(name) or {}).get("update") or {}).values()
    ]
    open_name = (actions.get("open_case") or {}).get("name_update") or {}
    own.append(open_name.get("question_path") if isinstance(open_name, dict) else None)
    preloads = list((actions.get("case_preload") or {}).get("preload") or {})
    return (
        any(_own_write_not_offered(xform, path) for path in filter(None, own))
        or any(_preload_not_offered(xform, path) for path in preloads)
        or any(_child_write_not_offered(xform, each, None) for each in _subcases(form))
    )


def _advanced_write_not_offered(at, form, xform):
    """An advanced form's write or preload a use sits on (else every one of the action it sits in, else of the
    form's), on a question the advanced picker does not offer. That picker offers labels and, where its action
    takes repeats, repeat questions (``advanced/case_config_ui.js::getQuestions`` excludes no trigger, and
    ``case-config:case-properties:question`` passes the action's ``allow.repeats()``): a load takes none
    (``advanced/actions.js::loadUpdateAction``), so its write or preload on a repeat question is not offered; an
    open action takes them, and its name or write on a question in another repeat than its own is marked "Inside
    the wrong repeat!" (``advanced/case_properties.js``)."""
    loads, opens = _advanced_lists(form)
    held = at.nearest(*ADVANCED_ACTIONS)
    written = at.nearest("ConditionalCaseUpdate")
    for action in [held] if held is not None else [*loads, *opens]:
        load = _is_load(action, loads)
        if written is not None:
            paths = [written.get("question_path")]
        else:
            slots = ("case_properties", "preload") if load else ("name_update", "case_properties")
            if at.owner is action and at.key in slots:
                slots = (at.key,)
            paths = [path for slot in slots for path in _advanced_slot_paths(action, slot)]
        paths = [path for path in paths if path]
        if load and any(xform.in_repeat(path) for path in paths):
            return True
        context = action.get("repeat_context") or ""
        if not load and any(_innermost_repeat(xform, path) not in ("", context) for path in paths):
            return True
    return False


def _advanced_slot_paths(action, slot):
    """The question paths one slot of an advanced action names: a name's, each write's, or each preload's (a
    preload maps a question path to a property)."""
    value = action.get(slot)
    if slot == "name_update":
        return [value.get("question_path")] if isinstance(value, dict) else []
    if slot == "preload":
        return list(value or {})
    return [update.get("question_path") for update in (value or {}).values() if isinstance(update, dict)]


def _own_write_not_offered(xform, path):
    return bool(path) and (xform.in_repeat(path) or _is_label(xform, path))


def _preload_not_offered(xform, path):
    """A basic form's preload on a label outside any repeat. A preload into a repeat question is the INERT class
    ``forms-and-case-writes/case-preload-into-a-question-inside-a-repeat`` (HQ's ``xforms-ready`` load runs before
    any row exists, ``XForm.add_case_preloads``), as Nova's reader reads it before it reads a label
    (``caseManagement/preloads.ts``)."""
    return bool(path) and not xform.in_repeat(path) and _is_label(xform, path)


def _child_write_not_offered(xform, subcase, written):
    context = subcase.get("repeat_context") or ""
    if written is not None:
        paths = [written.get("question_path")]
    else:
        paths = [
            update.get("question_path")
            for update in (subcase.get("case_properties") or {}).values()
            if isinstance(update, dict)
        ]
        name = subcase.get("name_update") or {}
        paths.append(name.get("question_path") if isinstance(name, dict) else None)
    for path in filter(None, paths):
        if _is_label(xform, path):
            return True
        innermost = max((r for r in xform.repeat_paths if path.startswith(f"{r}/")), key=len, default="")
        if innermost and innermost != context:
            return True
    return False


def _is_label(xform, path):
    controls = xform.question_controls(path)
    return bool(controls) and _local(controls[0]) == "trigger"


def upload_question(use, manifest):
    """``forms-and-case-writes/update-from-an-upload-question-attachment-mode``: an update from an
    ``<upload>`` question (attachment mode)."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "update_case") or not _writes_own_update(_actions(form).get("update_case")):
        return False
    xform = at.app.xform(form)
    written = at.nearest("ConditionalCaseUpdate")
    paths = [
        update.get("question_path")
        for update in (
            [written] if written is not None else (_actions(form).get("update_case") or {}).get("update", {}).values()
        )
        if isinstance(update, dict)
    ]
    if not any(paths):
        return False
    if xform is None:
        return None
    return any(
        any(_local(control) == "upload" for control in xform.question_controls(path)) for path in filter(None, paths)
    )


def own_case_type_where_same_type_unindexed(use, manifest):
    """``forms-and-case-writes/subcase-of-the-module-s-own-case-type-in-a-project-space-with``: a child case of
    the module's own case type, sent to a project space with DONT_INDEX_SAME_CASETYPE on, where HQ's build
    writes no index from the child to the case the form updates (``xform.py::XForm._create_casexml``:
    ``index_same_casetype``). The flag is the project space's, which the export does not carry, so the class
    reads the configurations the app was sent under (``App.configurations``): a child of another type is not
    in the class, one of the module's own type is where a configuration turns the flag on, and None where the
    reading names no configuration. Nova's publish requires the flag off for such a child (its verdict's
    ``flagsOff``), so no checked configuration of a corpus export turns it on."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "subcases"):
        return False
    module = at.app.module_of(form) or {}
    subcase = at.nearest("OpenSubCaseAction")
    same = any(
        each.get("case_type") == module.get("case_type")
        for each in ([subcase] if subcase is not None else _subcases(form))
    )
    if not same:
        return False
    configurations = at.app.configurations
    if configurations is None:
        return None
    return any(DONT_INDEX_SAME_CASETYPE in configuration.flags for configuration in configurations)


def multi_select_case_sharing_without_owner(use, manifest):
    """``forms-and-case-writes/subcases-on-such-a-form-in-an-app-that-shares-cases-where-a``: child cases on a
    multi-select or data-registry-loading follow-up that opens no case, in an app that shares cases
    (``case_sharing``), where a child case writes no ``owner_id``."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "subcases"):
        return False
    subcases = [subcase for subcase in _subcases(form) if _active(subcase)]
    if not subcases or not at.app.doc.get("case_sharing"):
        return False
    module = at.app.module_of(form) or {}
    multi = bool(((module.get("case_details") or {}).get("short") or {}).get("multi_select"))
    if not multi or _active(_actions(form).get("open_case")):
        return False
    return any("owner_id" not in (subcase.get("case_properties") or {}) for subcase in subcases)


def _select_chain(app, module):
    """The case selections a basic menu's case form asks for, outermost first, each ``(session variable, case
    type)`` (``suite_xml/utils.py::get_select_chain_with_sessions``, ``get_select_chain_meta``): the menu's own
    ``case_id``, then one more for each parent selection, ``case_id_<type>`` for an other-relation parent of the
    same case type and ``parent_id``, ``parent_parent_id`` and so on otherwise. None where a step is not followed
    here: a several-case list, a lookup-table selection (``get_datum_meta_module`` adds a datum for it), or a
    parent menu the app does not hold or that repeats."""
    if _multi_select(module) or (module.get("fixture_select") or {}).get("active"):
        return None
    chain = [("case_id", module.get("case_type"))]
    seen = {module.get("unique_id")}
    child = module
    while (child.get("parent_select") or {}).get("active"):
        select = child["parent_select"]
        parent = app.modules_by_id.get(select.get("module_id"))
        if parent is None or parent.get("unique_id") in seen:
            return None
        if _multi_select(parent) or (parent.get("fixture_select") or {}).get("active"):
            return None
        other = select.get("relationship", "parent") is None
        if other and parent.get("case_type") == child.get("case_type"):
            variable = f"case_id_{child.get('case_type')}"
        else:
            variable = "parent_" * len(chain) + "id"
        chain.append((variable, parent.get("case_type")))
        seen.add(parent.get("unique_id"))
        child = parent
    return list(reversed(chain))


def _advanced_selection_datums(app, module, target):
    """The datums HQ's link editor offers for an advanced target form (``get_datums_meta_for_form_generic``, which
    for an advanced form reads ``get_datum_meta_assertions_advanced``): each load that asks for a selection (one
    selected in a mode of its own asks for none), under its id once HQ aligns it to its root
    (``_aligned_load_datums``). None where a load chooses from a lookup table or shows CommCare Supply's product,
    or the root's datums are not followed here."""
    loads, _ = _advanced_lists(target)
    if any(_from_fixture(load) or load.get("show_product_stock") for load in loads):
        return None
    aligned = _aligned_load_datums(app, module, loads)
    if aligned is None:
        return None
    return {
        aligned[id(load)]
        for load in loads
        if not (_auto_selected(load) and load["auto_select"].get("mode"))
    }


def _selection_datums(app, link):
    """The datums HQ's link editor offers for a form link's target (``views/forms.py::_get_form_datums``: the
    target form's datums that require a selection, ``EntriesHelper.get_datums_meta_for_form_generic``), where
    the target is a form in a basic menu with no registry: for a form that requires a case, its menu's
    selections (``_select_chain``), none for one that does not, each renamed as HQ aligns a child menu's
    datums to its root's first form (``EntriesHelper.add_parent_datums``): a datum whose id a root datum holds
    becomes ``<id>_<case type>``, and the next datum takes the id of each root datum that asks for a selection
    where both load one case type. A search the menu offers changes none of them: its query is a datum that
    requires no selection, and the case it selects keeps its session variable
    (``EntriesHelper.add_remote_query_datums``, ``get_datum_meta_module``). None for any other target, whose
    datums need HQ's suite."""
    target = app.forms_by_id.get(link.get("form_id"))
    module = app.module_of(target) if target is not None else None
    if (
        target is not None
        and module is not None
        and module.get("doc_type") == "AdvancedModule"
        and target.get("doc_type") == "AdvancedForm"
        and not (module.get("search_config") or {}).get("data_registry")
    ):
        return _advanced_selection_datums(app, module, target)
    if target is None or module is None or (module.get("doc_type") or "Module") != "Module":
        return None
    if (target.get("doc_type") or "Form") != "Form" or (module.get("search_config") or {}).get("data_registry"):
        return None
    datums = []
    if _requires(target) == "case":
        chain = _select_chain(app, module)
        if chain is None:
            return None
        # Each selection is an update_case datum (``get_datum_meta_module``), which the alignment may rename.
        datums = [{"id": variable, "type": case_type, "selects": True, "aligns": True} for variable, case_type in chain]
    actions = _actions(target)
    opens_case = _active(actions.get("open_case"))
    if opens_case:
        new = f"case_id_new_{module.get('case_type')}_0"
        datums.append({"id": new, "type": module.get("case_type"), "selects": False, "aligns": True})
    for position, subcase in enumerate(_subcases(target)):
        if _active(subcase) and not subcase.get("repeat_context"):
            number = position + 1 if opens_case else position
            new = f"case_id_new_{subcase.get('case_type')}_{number}"
            datums.append({"id": new, "type": subcase.get("case_type"), "selects": False, "aligns": True})
    if module.get("root_module_id"):
        root = app.modules_by_id.get(module.get("root_module_id"))
        parents = _root_selection_datums(app, root) if root is not None else None
        if parents is None:
            return None
        by_id = {datum["id"]: datum for datum in datums}
        remaining = list(datums)
        for parent, parent_type, parent_selects in parents:
            if parent in by_id:
                renamed = by_id[parent]
                renamed["id"] = f"{renamed['id']}_{renamed['type']}"
            if parent_selects and remaining:
                if remaining[0]["type"] == parent_type and remaining[0]["aligns"]:
                    remaining.pop(0)["id"] = parent
    return {datum["id"] for datum in datums if datum["selects"]}


def _blank(app, text):
    """Whether a datum's value is blank on every opening: no text, or one Core reads as an empty literal."""
    if not text or not text.strip():
        return True
    parsed = app.parsed(text)
    return (
        parsed is not None
        and "error" not in parsed
        and parsed["expressions"] == ["XPathStringLiteral"]
        and not parsed["functions"]
        and text.strip() in ("''", '""')
    )


def target_case_id_left_empty(use, manifest):
    """``forms-and-case-writes/form-links-datums-that-leave-the-target-s-case-id-empty``: a form link whose
    datums give none, or a blank one, for a datum its target's case selection needs."""
    at, form = _form(use)
    if form is None:
        return None
    unsure = False
    for link in form.get("form_links") or []:
        link = link or {}
        if not link.get("datums") or not link.get("form_id"):
            continue
        needed = _selection_datums(at.app, link)
        if needed is None:
            unsure = True
            continue
        given = {datum.get("name") for datum in link["datums"] if not _blank(at.app, (datum or {}).get("xpath"))}
        if needed - given:
            return True
    return None if unsure else False


def other_datum_names_or_module_target(use, manifest):
    """``forms-and-case-writes/form-links-datums-with-other-names-or-on-a-module-target``: a form link's datums
    on a module target, or naming a datum the link editor does not offer for its target form
    (``_selection_datums``)."""
    at, form = _form(use)
    if form is None:
        return None
    unsure = False
    for link in form.get("form_links") or []:
        link = link or {}
        if not link.get("datums"):
            continue
        if not link.get("form_id"):
            return True
        offered = _selection_datums(at.app, link)
        if offered is None:
            unsure = True
        elif {(datum or {}).get("name") for datum in link["datums"]} - offered:
            return True
    return None if unsure else False


def _child_matched(app, module, target):
    """Whether HQ's link editor offers a child menu as a link target from a form in ``module`` without
    ``FORM_LINK_ADVANCED_MODE`` (``views/forms.py::_get_linkable_forms_context``, ``is_child_match``): the form's
    menu has a parent, and that parent's case type is the target's parent's. None where either parent is not
    in the app."""
    if not module.get("root_module_id"):
        return False
    parent = app.modules_by_id.get(module.get("root_module_id"))
    target_parent = app.modules_by_id.get(target.get("root_module_id"))
    if parent is None or target_parent is None:
        return None
    return parent.get("case_type") == target_parent.get("case_type")


def other_module_target(use, manifest):
    """``forms-and-case-writes/form-links-target-any-other-module``: a form link to a module other than a
    top-level or child-matched module that does not show its forms in its parent: a display-only-forms
    (``put_in_root``) menu, or a child menu HQ's link editor does not match (``_child_matched``)."""
    at, form = _form(use)
    if form is None:
        return None
    module = at.app.module_of(form) or {}
    unsure = False
    for link in form.get("form_links") or []:
        target = (
            at.app.modules_by_id.get((link or {}).get("module_unique_id")) if not (link or {}).get("form_id") else None
        )
        if target is None:
            continue
        if target.get("put_in_root"):
            return True
        if target.get("root_module_id"):
            matched = _child_matched(at.app, module, target)
            if matched is None:
                unsure = True
            elif not matched:
                return True
    return None if unsure else False


def not_offered(use, manifest):
    """``forms-and-case-writes/any-other-post-form-workflow-outside-the-offered-set-previous``: a
    ``post_form_workflow`` the form settings do not offer: ``previous_screen`` in a multi-select module at
    the top level or under a multi-select root; ``module`` or ``parent_module`` under a multi-select root;
    ``previous_screen`` in an inline-search module on a form that does not require a case."""
    at, form = _form(use)
    if form is None:
        return None
    workflow = form.get("post_form_workflow")
    module = at.app.module_of(form) or {}
    root = at.app.root(module)
    multi = _multi_select(module)
    root_multi = root is not None and _multi_select(root)
    if workflow == "previous_screen":
        if multi and (root is None or root_multi):
            return True
        if _inline_search(module) and _requires(form) == "none":
            return True
    if workflow in ("module", "parent_module") and root_multi:
        return True
    return False


def _multi_select(module):
    return bool(((module.get("case_details") or {}).get("short") or {}).get("multi_select"))


def _offers_search(module):
    """``util.py::module_offers_search``: a search property or default filter."""
    config = module.get("search_config") or {}
    return bool(config.get("properties") or config.get("default_properties"))


def _inline_search(module):
    """``util.py::module_uses_inline_search``."""
    config = module.get("search_config") or {}
    return _offers_search(module) and bool(config.get("inline_search")) and bool(config.get("auto_launch"))


def _offered_workflows(app, module):
    """The post-submit destinations the form settings offer a menu's forms (``views/forms.py::get_form_view_
    context`` ``form_workflows``), beside the home screen, the first menu and a link."""
    offered = set()
    root = app.root(module)
    if root is None or not _multi_select(root):
        if not module.get("put_in_root"):
            offered.add("module")
        if not (_multi_select(module) or _inline_search(module)):
            offered.add("previous_screen")
    if root is not None and not root.get("put_in_root") and not _multi_select(root):
        offered.add("parent_module")
    return offered


def not_offered_under_conditional_link(use, manifest):
    """``forms-and-case-writes/post-form-workflow-fallback-module-parent-module-or-previous``: a fallback of
    ``module``, ``parent_module`` or ``previous_screen`` that the menu's form settings do not offer
    (``_offered_workflows``), under ``form`` with a conditional link."""
    at, form = _form(use)
    if form is None:
        return None
    fallback = form.get("post_form_workflow_fallback")
    if form.get("post_form_workflow") != "form" or fallback not in ("module", "parent_module", "previous_screen"):
        return False
    if not any((link or {}).get("xpath") for link in form.get("form_links") or []):
        return False
    return fallback not in _offered_workflows(at.app, at.app.module_of(form) or {})


# Case search -------------------------------------------------------------------------


def _search(use):
    at = _json(use)
    if at is None:
        return None, None
    return at, at.nearest("CaseSearch")


def _default_entries(at, config):
    entry = at.nearest("DefaultCaseSearchProperty")
    return (
        [entry]
        if entry is not None
        else [each for each in config.get("default_properties") or [] if isinstance(each, dict)]
    )


def _literal(app, text):
    """Whether Core reads an expression as one literal (None where the observation holds no reading of it)."""
    parsed = app.parsed(text)
    if parsed is None or "error" in parsed:
        return None
    return parsed["expressions"] in (["XPathStringLiteral"], ["XPathNumericLiteral"]) and not parsed["functions"]


# The tokens after which Core's lexer reads an operator (``Lexer.LEX_CONTEXT_OP``, ``proof/rules/_xpath.py``): a
# ``/`` after any other begins an absolute path.
_ENDS_A_VALUE = frozenset(
    {"WILDCARD", "NSWILDCARD", "QNAME", "VAR", "NUM", "STR", "RBRACK", "RPAREN", "DOT", "DBL_DOT"}
)


def _reads_an_absolute_path(text):
    """Whether an expression holds a path from the document's root (``/data/...``), read over Core's tokens: a ``/``
    or ``//`` where Core's lexer reads a value; None where the lexer does not read the text."""
    found = xpath_tokens(text or "")
    if found is None:
        return None
    previous = None
    for token in found:
        if token.kind in ("SLASH", "DBL_SLASH") and (previous is None or previous.kind not in _ENDS_A_VALUE):
            return True
        previous = token
    return False


def _reads_a_relative_path(text):
    """Whether an expression holds a path from the context node (a name, ``.``, ``..`` or ``@name`` where Core's
    lexer reads a value and no call follows); None where the lexer does not read the text."""
    found = xpath_tokens(text or "")
    if found is None:
        return None
    for index, token in enumerate(found):
        previous = found[index - 1] if index > 0 else None
        if previous is not None and (previous.kind in _ENDS_A_VALUE or previous.kind in ("SLASH", "DBL_SLASH")):
            continue
        following = found[index + 1] if index + 1 < len(found) else None
        if token.kind in ("DOT", "DBL_DOT", "AT", "WILDCARD", "NSWILDCARD"):
            return True
        if token.kind == "QNAME" and (following is None or following.kind != "LPAREN"):
            return True
    return False


def native_filter_unbound_value(use, manifest):
    """``case-search/native-filter-value-outside-screen-scope``: a default filter keyed by a native search key (any
    key but ``_xpath_query``) whose value reads what its search screen holds no value of. A path from the document's
    root (``/data/name``) names a form's answer, and the search screen is no form (Nova's ``search_filter_value``
    slot holds the session, lookups and the worker alone): in the class. A value of literals and calls that read no
    node, or that reads the session's context and its user alone, is outside it; any other read (a path from the
    context node, ``current()``, a session datum, another instance) is not told (None)."""
    at = _json(use)
    if at is None:
        return None
    entry = at.nearest("DefaultCaseSearchProperty")
    if entry is None:
        return None
    if entry.get("property") == "_xpath_query":
        return False
    value = entry.get("defaultValue")
    if not isinstance(value, str):
        return False
    absolute = _reads_an_absolute_path(value)
    if absolute is None:
        return None
    if absolute:
        return True
    parsed = at.app.parsed(value)
    if parsed is None or "error" in parsed:
        return None
    if "XPathPathExpr" not in parsed["expressions"]:
        return False
    if parsed["roots"] != ["instance"] or _reads_a_relative_path(value) is not False:
        return None
    screen = all(
        path["instance"] == "commcaresession"
        and path["steps"][:1] == ["session"]
        and path["steps"][1:2] in (["context"], ["user"])
        for path in parsed["instancePaths"]
    )
    return False if parsed["instancePaths"] and screen else None


# The keys of HQ's search index Nova reads as a record's own information
# (``lib/commcare/suite/case-search/requestOrder.ts::RECORD_KEYS``), and the names Nova reserves for a case's own facts
# or as CommCare HQ's reserved words (``lib/domain/standardCaseProperties.ts::FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES``:
# the SaveToCase set with the block's own rows and the two location keys).
SERVER_ORDER_RECORD_KEYS = frozenset(
    {"@case_id", "@owner_id", "@case_type", "@status", "name", "case_name", "external_id", "date_opened", "last_modified"}
)
CASE_OPERATION_OWN_ROWS = frozenset({"case_type", "case_name", "owner_id", "location_id", "hq_user_id"})


def _order_key_reserved(key):
    return key not in SERVER_ORDER_RECORD_KEYS and (key in SAVE_TO_CASE_RESERVED_UPDATE_KEYS or key in CASE_OPERATION_OWN_ROWS)


def server_order_reserved_property(use, manifest):
    """``case-search/a-server-order-naming-a-property-nova-reserves``: a literal ``commcare_sort`` default filter, or a
    search's ``custom_sort_properties`` on a search its menu offers (the only one Nova reads them on), one of whose
    keys names a property Nova reserves (``status`` is a saved property; the record's state is ``@status``,
    ``es/case_search.py::sort_by_case_property``). A ``commcare_sort`` that is no one literal is
    ``a-commcare-sort-x-commcare-custom-related-case-property-or-case``'s."""
    at, config = _search(use)
    if config is None:
        return None
    if not use.key.startswith(("schema:CaseSearch.custom_sort_properties", "schema:CaseSearchCustomSortProperty")):
        for entry in _default_entries(at, config):
            if entry.get("property") != "commcare_sort":
                continue
            text = _literal_text(entry.get("defaultValue"))
            if text is not None and any(
                _order_key_reserved(part.lstrip("+-").split(":")[0]) for part in text.split(",")
            ):
                return True
        return False
    if not (config.get("properties") or config.get("default_properties")):
        return False
    row = at.nearest("CaseSearchCustomSortProperty")
    rows = [row] if row is not None else [each for each in config.get("custom_sort_properties") or [] if isinstance(each, dict)]
    return any(isinstance(each.get("property_name"), str) and _order_key_reserved(each["property_name"]) for each in rows)


def request_config_key_runtime_value(use, manifest):
    """``case-search/a-commcare-sort-x-commcare-custom-related-case-property-or-case``: a ``commcare_sort``,
    ``x_commcare_custom_related_case_property`` or ``case_type`` default filter whose value Core does not
    read as one literal."""
    at, config = _search(use)
    if config is None:
        return None
    unsure = False
    for entry in _default_entries(at, config):
        if entry.get("property") not in ("commcare_sort", "x_commcare_custom_related_case_property", "case_type"):
            continue
        literal = _literal(at.app, entry.get("defaultValue"))
        if literal is False:
            return True
        unsure = unsure or literal is None
    return None if unsure else False


def related_case_property_twice(use, manifest):
    """``case-search/an-x-commcare-custom-related-case-property-entry-together-with``: an
    ``x_commcare_custom_related_case_property`` default filter beside ``custom_related_case_property``. A use
    inside a default filter is in the class only where that filter is the one keyed so (``_default_entries``), as
    Nova's reader refuses that filter alone (``search/index.ts::keyFinding``)."""
    at, config = _search(use)
    if config is None:
        return None
    keyed = any(
        each.get("property") == "x_commcare_custom_related_case_property" for each in _default_entries(at, config)
    )
    return keyed and bool(config.get("custom_related_case_property"))


def data_registry_key(use, manifest):
    """``case-search/default-properties-entry-keyed-x-commcare-data-registry``."""
    at, config = _search(use)
    if config is None:
        return None
    return any(entry.get("property") == "x_commcare_data_registry" for entry in _default_entries(at, config))


def registry_named(use, manifest):
    """``case-search/data-registry-data-registry-workflow-additional-registry-cases``: a search whose
    ``data_registry`` holds text, with whatever ``data_registry_workflow`` and ``additional_registry_cases`` stand
    beside it. HQ reads the registry by truth (``util.py::module_offers_registry_search``), so a blank or absent
    registry names none, and the workflow and extra cases beside it are the INERT ``no-registry`` class."""
    at, config = _search(use)
    if config is None:
        return None
    return bool(config.get("data_registry"))


def endpoint_id_key(use, manifest):
    """``case-search/default-properties-entry-keyed-x-commcare-endpoint-id``."""
    at, config = _search(use)
    if config is None:
        return None
    return any(entry.get("property") == "x_commcare_endpoint_id" for entry in _default_entries(at, config))


def holds_no_default_value(entry):
    """Whether a default filter holds no value: its ``defaultValue`` is absent, no string, or blank once
    JavaScript's ``trim`` takes what ends it, as Nova's reader reads it (``search/index.ts``, the row it refuses
    whole). HQ keeps no ``None`` there (``DefaultCaseSearchProperty.defaultValue``, ``exclude_if_none``)."""
    value = entry.get("defaultValue")
    return not isinstance(value, str) or not value.strip("".join(JS_WHITESPACE))


def missing_default_value(use, manifest):
    """``case-search/default-properties-entry-with-no-defaultvalue-…``: a default filter with no
    ``defaultValue`` (HQ stores an empty one as none, ``DefaultCaseSearchProperty.wrap``). The class stands at
    the filter itself (``schema:DefaultCaseSearchProperty``, which the extraction makes a use of only for such a
    filter), where Nova's reader refuses the whole filter: the list that holds it, and its keys, are in no such
    class."""
    at = _json(use)
    if at is None:
        return None
    if at.key is not None or at.scope[-1][0] != "DefaultCaseSearchProperty":
        return False
    return holds_no_default_value(at.owner)


def blacklisted_owner_ids_twice(use, manifest):
    """``case-search/that-entry-together-with-blacklisted-owner-ids-expression``: a
    ``commcare_blacklisted_owner_ids`` default filter beside ``blacklisted_owner_ids_expression``. A use inside a
    default filter is in the class only where that filter is the one keyed so (``_default_entries``), as Nova's
    reader refuses that filter alone (``search/index.ts::keyFinding``)."""
    at, config = _search(use)
    if config is None:
        return None
    keyed = any(each.get("property") == "commcare_blacklisted_owner_ids" for each in _default_entries(at, config))
    return keyed and bool(config.get("blacklisted_owner_ids_expression"))


def shared_by_filter_and_prompt(use, manifest):
    """``case-search/a-default-filter-and-a-search-property-sharing-one-name``: a prompt's ``name`` a default
    filter's ``property`` also names, and that filter's ``property``; a use in a prompt or a filter that shares
    no name is in no such class (``search/prompts.ts``, ``nameShared``)."""
    at, config = _search(use)
    if config is None:
        return None
    prompts = {each.get("name") for each in config.get("properties") or [] if isinstance(each, dict)} - {None, ""}
    filters = {each.get("property") for each in config.get("default_properties") or [] if isinstance(each, dict)}
    filters -= {None, ""}
    prompt = at.nearest("CaseSearchProperty")
    if prompt is not None:
        return prompt.get("name") in filters
    entry = at.nearest("DefaultCaseSearchProperty")
    if entry is not None:
        return entry.get("property") in prompts
    return bool(prompts & filters)


def _required(prompt):
    return bool(((prompt.get("required") or {}).get("test")) if isinstance(prompt.get("required"), dict) else False)


def _validations(prompt):
    return [each for each in prompt.get("validations") or [] if isinstance(each, dict)]


def _prompt_reader(test):
    def reader(use, manifest):
        at = _json(use)
        if at is None:
            return None
        prompt = at.nearest("CaseSearchProperty")
        if prompt is None:
            return None
        return test(prompt)

    return reader


# The input types HQ's Case List page shows over an address appearance (``case_claim.js::_getAppearance`` tests them
# last), which HQ's build also writes over the ``input="address"`` the appearance gives
# (``remote_requests.py::build_query_prompts``): beside one, the prompt is no address field.
INPUTS_OVER_ADDRESS = frozenset({"date", "daterange", "checkbox"})


def _address_field(prompt):
    return prompt.get("appearance") == "address" and prompt.get("input_") not in INPUTS_OVER_ADDRESS


address_with_required_or_validations = _prompt_reader(
    lambda prompt: _address_field(prompt) and (_required(prompt) or bool(_validations(prompt)))
)
address_with_required_or_validations.__doc__ = """``case-search/appearance-address-with-required-or-validations``: an
address field (an address appearance with no ``input_`` HQ's build and Case List page put over it) with a requirement
or a validation."""

hidden_with_required_or_validations = _prompt_reader(
    lambda prompt: bool(prompt.get("hidden")) and (_required(prompt) or bool(_validations(prompt)))
)
hidden_with_required_or_validations.__doc__ = """``case-search/hidden-together-with-required-or-validations``."""

allow_blank_on_a_hidden_prompt = _prompt_reader(
    lambda prompt: bool(prompt.get("hidden")) and bool(prompt.get("allow_blank_value"))
)
allow_blank_on_a_hidden_prompt.__doc__ = """``case-search/allow-blank-value-on-a-hidden-prompt``: ``allow_blank_value`` on a
``hidden`` prompt, whose row Web Apps hides whole (``query.js``, ``d-none``) while it still reads a starting value
that begins with a blank as the box ticked (``query.js::decodeValue``)."""

allow_blank_beside_the_owner = _prompt_reader(
    lambda prompt: not prompt.get("hidden")
    and not prompt.get("exclude")
    and prompt.get("name") == "owner_id"
    and bool(prompt.get("allow_blank_value"))
)
allow_blank_beside_the_owner.__doc__ = """``case-search/allow-blank-value-on-a-prompt-named-owner-id``: ``allow_blank_value``
on a shown ``owner_id`` prompt without ``exclude``, which reaches HQ as the owner filter, and HQ refuses a second
value beside an owner (``case_search/models.py::SearchCriteria._validate_multiple_terms``)."""

later_validations = _prompt_reader(
    lambda prompt: len(_validations(prompt)) > 1 and not prompt.get("hidden") and not _address_field(prompt)
)
later_validations.__doc__ = """``case-search/validations-1``: ``validations[1:]`` on a prompt neither hidden nor an
address (the editor edits only ``[0]``)."""


def _itemset_scheme(prompt):
    instance = ((prompt.get("itemset") or {}).get("instance_id")) if isinstance(prompt.get("itemset"), dict) else None
    return instance.split(":", 1)[0] if instance else None


mobile_ucr_reports = _prompt_reader(
    lambda prompt: prompt.get("input_") in ("select1", "select") and _itemset_scheme(prompt) == "commcare-reports"
)
mobile_ucr_reports.__doc__ = """``case-search/input-select1-select-commcare-reports-itemset-mobile-ucr``."""


def editor_appearance(prompt):
    """The appearance HQ's Case List page shows for a prompt (``case_claim.js::_getAppearance``): the stored
    ``appearance``, or none; a selection's lookup or Mobile UCR choice over it, by whether its itemset's
    ``instance_id`` names ``commcare-reports``; ``address`` where the stored appearance is; and the input type over
    all of them where it is a date, a date range or a checkbox. Nova's reader reads it alike
    (``search/prompts.ts::editorAppearance``)."""
    stored = prompt.get("appearance")
    appearance = stored if isinstance(stored, str) else ""
    input_ = prompt.get("input_")
    if input_ in ("select1", "select"):
        itemset = prompt.get("itemset")
        instance_id = itemset.get("instance_id") if isinstance(itemset, dict) else None
        appearance = (
            "report_fixture"
            if isinstance(instance_id, str) and "commcare-reports" in instance_id
            else "lookup_table_fixture"
        )
    if stored == "address":
        appearance = "address"
    if input_ in ("date", "daterange", "checkbox"):
        appearance = input_
    return appearance


# The appearances HQ's Case List page shows that take no value another screen sends a prompt: every one but a plain
# text field and a lookup or Mobile UCR selection (``views/modules.py::_update_search_properties`` keeps a
# ``receiver_expression`` only for appearance ``fixture`` or none).
RECEIVER_REFUSED_APPEARANCES = frozenset({"barcode_scan", "address", "date", "daterange", "checkbox"})

receiver_on_another_appearance = _prompt_reader(
    lambda prompt: (
        prompt.get("receiver_expression") not in (None, "")
        and editor_appearance(prompt) in RECEIVER_REFUSED_APPEARANCES
    )
)
receiver_on_another_appearance.__doc__ = """``case-search/receiver-expression-on-a-prompt-whose-editor-…``: a
``receiver_expression`` holding text on a prompt whose appearance in HQ's Case List page is neither a plain text
field nor a lookup or Mobile UCR selection (``editor_appearance``); a blank one is no value, and on any other prompt
the expression is ``case-search/receiver-expression``'s."""

# The input types a runtime names (commcare-core ``QueryPrompt.INPUT_TYPE_*``): the six Formplayer supports
# (``QueryScreen.getSupportedPrompts``), of which Android supports three (``QueryRequestActivity``).
RUNTIME_PROMPT_INPUTS = frozenset({"select1", "select", "date", "daterange", "checkbox", "address"})


def input_no_runtime_names(use, manifest):
    """``case-search/input-no-runtime-names``: a prompt's input type no runtime names, read on the stored
    prompt's ``input_`` (an app JSON) or on the suite prompt's ``input`` (Core's ``QueryPromptParser``)."""
    json_at = _json(use)
    if json_at is not None:
        prompt = json_at.nearest("CaseSearchProperty")
        if prompt is None:
            return None
        value = prompt.get("input_")
    else:
        xml_at = _xml(use)
        if xml_at is None or _local(xml_at.element) != "prompt":
            return None
        value = xml_at.element.get("input")
    return value not in (None, "") and value not in RUNTIME_PROMPT_INPUTS


SEARCH_BUTTON_LABEL = {"en": "Search All Cases"}


def other_search_button_label(use, manifest):
    """``case-search/search-button-label-any-other-value``: a ``search_button_label`` other than HQ's
    default ``{en: Search All Cases}`` (``CaseSearch`` model)."""
    at, config = _search(use)
    if config is None:
        return None
    label = config.get("search_button_label")
    return label is not None and label != SEARCH_BUTTON_LABEL


def _instance_ids_read(text):
    """The ids an expression reads with ``instance('<id>')``, through Core's lexer (``Lexer.lex``), in reading order;
    None where the lexer does not read the text."""
    found = xpath_tokens(text or "")
    if found is None:
        return None
    ids = []
    for index, token in enumerate(found[:-3]):
        if (
            token.kind == "QNAME"
            and token.text == "instance"
            and found[index + 1].kind == "LPAREN"
            and found[index + 2].kind == "STR"
            and found[index + 3].kind == "RPAREN"
        ):
            read = found[index + 2].text[1:-1]
            if read not in ids:
                ids.append(read)
    return ids


def search_button_reads_what_the_list_does_not_load(use, manifest):
    """``case-search/search-button-display-condition-reading-what-the-case-list-does-not-load``: a Search action's
    ``relevant`` (the action whose frame pushes ``search_command.<menu>``) in a detail some entry shows as its list
    (``detail-select``), reading an instance one such entry does not declare. HQ declares an entry's instances from
    what its datums, details and frames read and never from an action's ``relevant``
    (``post_process/instances.py::_get_all_xpaths_for_entry``, ``xml_models.py::Detail.get_all_xpaths``), and Core
    evaluates the condition in the entry's scope (``Detail.getCustomActions``,
    ``CommCareSession.getEvaluationContext``), where an undeclared instance throws. Decided on a suite, the build
    that declares the entry's instances. An app JSON's ``search_button_display_condition`` alone does not say what
    HQ's build will declare beside it: on an app HQ made it is None, and an app Nova sends never holds the class,
    since Nova's gate admits only a condition every entry showing the list declares
    (``lib/commcare/suite/case-search/buttonCondition.ts``), so False."""
    json_at = _json(use)
    if json_at is not None:
        if json_at.key != "search_button_display_condition":
            return None
        return None if json_at.app is None or json_at.app.authored else False
    at = _xml(use, "runtime")
    if at is None or at.attribute != "relevant" or _local(at.element) != "action":
        return None
    action = at.element
    pushes = [
        _command_literal(command)
        for command in action.iter()
        if isinstance(command.tag, str) and _local(command) == "command"
    ]
    if not pushes or not all((pushed or "").startswith("search_command.") for pushed in pushes):
        return False
    detail = action.getparent()
    if detail is None or _local(detail) != "detail":
        return None
    read = _instance_ids_read(action.get("relevant"))
    if read is None:
        return None
    shown_in = [
        entry
        for entry in _children(at.document.root)
        if _local(entry) == "entry"
        and any(
            _local(datum) == "datum" and datum.get("detail-select") == detail.get("id")
            for session in _children(entry)
            if _local(session) == "session"
            for datum in _children(session)
        )
    ]
    if not shown_in:
        return None
    for entry in shown_in:
        declared = {child.get("id") for child in _children(entry) if _local(child) == "instance"}
        if any(instance_id not in declared for instance_id in read):
            return True
    return False


def list_first_with_web_apps(use, manifest):
    """``case-search/workflow-legacy-classic-auto-launch-false-in-an-app-with``: ``auto_launch: false`` on a
    module that offers search, in an app with ``cloudcare_enabled``. In a suite, a search action
    (``<action auto_launch>``) or query (``default_search``) whose action Core does not launch, in an app
    that declares Web Apps, which a suite does not say: None there."""
    at = use.at
    if isinstance(at, XmlAt):
        return None
    at = _json(use)
    if at is None:
        return None
    module = at.nearest(*MODULES)
    if module is None or not _offers_search(module):
        return False
    return not (module.get("search_config") or {}).get("auto_launch") and bool(at.app.doc.get("cloudcare_enabled"))


# Case lists and menus -----------------------------------------------------------------


def _column(use):
    """A use's case list column with its detail, its detail's kind (``short``, the case list; ``long``, the
    case detail) and its module: (at, column, detail, kind, module), or Nones."""
    at = _json(use)
    if at is None:
        return None, None, None, None, None
    column = at.nearest("DetailColumn")
    detail = at.nearest("Detail")
    module = at.nearest(*MODULES)
    kind = None
    if detail is not None:
        pair = at.nearest("DetailPair")
        if pair is not None:
            kind = next((name for name in ("short", "long") if pair.get(name) is detail), None)
    return at, column, detail, kind, module


def _columns(detail):
    return [column for column in (detail or {}).get("columns") or [] if isinstance(column, dict)]


def _column_reader(test):
    """A reader of a use's column (``test(at, column, detail, kind, module)``); a use on a detail's
    ``columns`` reads each of its columns."""

    def reader(use, manifest):
        at, column, detail, kind, module = _column(use)
        if detail is None:
            return None
        columns = [column] if column is not None else _columns(detail)
        verdicts = [test(at, each, detail, kind, module or {}) for each in columns]
        if any(verdicts):
            return True
        return None if any(verdict is None for verdict in verdicts) else False

    return reader


def _format(column):
    return column.get("format") or ""


def _keys_of(column):
    return [item.get("key") for item in column.get("enum") or [] if isinstance(item, dict)]


def format_reader(slug):
    reader = _column_reader(lambda at, column, detail, kind, module: _format(column) == slug)
    reader.__doc__ = f"A column whose format is ``{slug}``."
    return reader


def _in_product_details(detail, module):
    """Whether a detail is one of an advanced module's product details (``AdvancedModule.product_details``)."""
    details = module.get("product_details")
    return isinstance(details, dict) and any(details.get(name) is detail for name in ("short", "long"))


product = _column_reader(
    lambda at, column, detail, kind, module: (
        column.get("model") == "product" and not _in_product_details(detail, module)
    )
)
product.__doc__ = """``menus-and-case-lists/model-product``: a case list or case detail column whose ``model`` is
``product``. A column of an advanced module's product details is in no such class: those details are judged whole,
equal to the single ``name`` column ``AdvancedModule.new_module`` writes or differing from it
(``differs_from_the_default``)."""


def _json_equal(a, b):
    """JSON equality as HQ's properties read it: numbers by value, a boolean never a number."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_json_equal(a[key], b[key]) for key in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_json_equal(x, y) for x, y in zip(a, b, strict=True))
    return type(a) is type(b) and a == b


def _at_schema_defaults(manifest, cls, value, aside):
    """Whether every key of a schema object but those ``aside`` holds its class's default (the surface's
    ``schema:<cls>.<key>`` item). A key the class does not declare is the undeclared-key catch-all's, read there."""
    for key, held in value.items():
        if key in aside:
            continue
        item = manifest.item(f"schema:{cls}.{key}")
        if item is None or not item.get("declared") or "default" not in item:
            continue
        if not _json_equal(held, item["default"]):
            return False
    return True


# The one product column ``AdvancedModule.new_module`` writes, beside its ``header`` (``Product`` in the app's
# language).
DEFAULT_PRODUCT_COLUMN = {"field": "name", "model": "product", "format": "plain"}


def differs_from_the_default(use, manifest):
    """``menus-and-case-lists/advancedmodule-product-details-differing-from-the-default``: an advanced module's
    ``product_details`` other than the ones ``AdvancedModule.new_module`` writes: a short detail of one plain
    ``name`` column over the product headed ``Product`` in one language, and a long detail with no column, each
    detail's other settings at ``Detail``'s defaults (its ``display`` the name ``DetailPair.wrap`` gives it). The
    column's ``graph_configuration`` is aside, since HQ's build reads it only of a ``graph`` column
    (``detail_screen.py::Graph``). CommCare Supply builds its product list from them
    (``AdvancedModule.get_details``)."""
    at = _json(use)
    if at is None:
        return None
    module = at.nearest(*MODULES)
    if module is None:
        return None
    details = module.get("product_details")
    if not isinstance(details, dict):
        return True
    for name in ("short", "long"):
        detail = details.get(name)
        if not isinstance(detail, dict) or detail.get("display") not in (None, name):
            return True
        if not _at_schema_defaults(manifest, "Detail", detail, {"columns", "display"}):
            return True
    if details["long"].get("columns"):
        return True
    columns = details["short"].get("columns") or []
    if len(columns) != 1 or not isinstance(columns[0], dict):
        return True
    (column,) = columns
    if any(column.get(key) != value for key, value in DEFAULT_PRODUCT_COLUMN.items()):
        return True
    if list((column.get("header") or {}).values()) != ["Product"]:
        return True
    aside = {*DEFAULT_PRODUCT_COLUMN, "header", "graph_configuration"}
    return not _at_schema_defaults(manifest, "DetailColumn", column, aside)


# Basic and shadow modules refuse the build. Advanced modules bypass the
# check and emit no action. Both source shapes need an endpoint.
clickable_icon_list_empty = _column_reader(
    lambda at, column, detail, kind, module: (
        _format(column) == "clickable-icon" and kind == "short" and not column.get("endpoint_action_id")
    )
)
clickable_icon_list_empty.__doc__ = """``menus-and-case-lists/16p-clickable-icon-with-an-empty-endpoint-action-id-…``:
the column, read on each use of its keys, its icon mapping (``enum``) among them, which HQ's build reads of a
clickable icon (``detail_screen.py::ClickableIcon``) and which the column editor's extras on another format are not."""

clickable_icon_on_detail = _column_reader(
    lambda at, column, detail, kind, module: _format(column) == "clickable-icon" and kind == "long"
)
clickable_icon_on_detail.__doc__ = """``menus-and-case-lists/16pp-clickable-icon-on-the-case-detail-…``: the
column, read on each use of its keys, its icon mapping (``enum``) among them."""


def _unusable_clickable_icon(at, column, detail, kind, module):
    if _format(column) != "clickable-icon" or kind != "short" or not column.get("endpoint_action_id"):
        return False
    endpoint = column["endpoint_action_id"]
    grouping = detail.get("case_tile_group")
    if isinstance(grouping, dict):
        row, header = column.get("grid_y"), grouping.get("header_rows")
        if isinstance(row, int) and isinstance(header, int) and row >= header:
            return True
    targets = [
        (owner, form)
        for owner in at.app.modules
        for form in owner.get("forms") or []
        if isinstance(form, dict) and form.get("session_endpoint_id") == endpoint
    ]
    if not targets:
        return True
    if len(targets) != 1:
        return True
    owner, target = targets[0]
    if target.get("doc_type") == "Form" and target.get("requires") != "case":
        return True
    if owner.get("case_type") != module.get("case_type"):
        # The action's target type can be a related record selected by the grouped header.
        return None
    xform = at.app.xform(target)
    if xform is None:
        return None
    body = next((node for node in xform.root if _local(node) == "body"), None)
    if body is None:
        return True
    for label in body.iter():
        if not isinstance(label.tag, str) or _local(label) != "label":
            continue
        if not re.fullmatch(r"jr:itext\(\s*(['\"])Pragma-Submit-Automatically\1\s*\)", label.get("ref") or ""):
            continue
        if _local(label.getparent()) in ("group", "repeat"):
            continue
        if (not grouping and target.get("doc_type") == "Form"
                and target.get("requires") == "case"
                and not (owner.get("parent_select") or {}).get("active")
                and not (owner.get("case_details") or {}).get("short", {}).get("multi_select")):
            return False
        return None
    return True


clickable_icon_unusable = _column_reader(_unusable_clickable_icon)
clickable_icon_unusable.__doc__ = """A case-list icon missing a case-requiring form with a leaf label that
sets Pragma-Submit-Automatically, which HQ requires before offering the endpoint in its Case List editor."""

# Characters HQ's mapping editor marks in a translatable-enum key (ui-element-key-val-mapping.js::hasBadXML):
# anything outside [A-Za-z0-9_-].
TRANSLATABLE_KEY = re.compile(r"[A-Za-z0-9_-]*", re.ASCII)

translatable_enum_key_grammar = _column_reader(
    lambda at, column, detail, kind, module: (
        _format(column) == "translatable-enum"
        and any(not TRANSLATABLE_KEY.fullmatch(str(key or "")) for key in _keys_of(column))
    )
)
translatable_enum_key_grammar.__doc__ = """``menus-and-case-lists/21p-translatable-enum-key-outside-a-za-z0-9``."""

translatable_enum_over_relation = _column_reader(
    lambda at, column, detail, kind, module: (
        _format(column) == "translatable-enum"
        and not column.get("useXpathExpression")
        and "/" in str(column.get("field") or "")
        and _offers_search(module)
    )
)
translatable_enum_over_relation.__doc__ = (
    """``menus-and-case-lists/translatable-enum-on-a-column-that-is-not-a-calculated-property-…``."""
)

enum_xml_special_key = _column_reader(
    lambda at, column, detail, kind, module: (
        _format(column) == "enum" and any(any(mark in str(key or "") for mark in "&<>\"'") for key in _keys_of(column))
    )
)
enum_xml_special_key.__doc__ = (
    """``menus-and-case-lists/5p-enum-key-containing``: an ``enum`` key holding ``& < > " '``."""
)

MAPPING_FORMATS = frozenset({"enum", "enum-image", "conditional-enum", "translatable-enum"})

mapping_with_shared_key = _column_reader(
    lambda at, column, detail, kind, module: (
        _format(column) in MAPPING_FORMATS and len(_keys_of(column)) != len(set(_keys_of(column)))
    )
)
mapping_with_shared_key.__doc__ = (
    """``menus-and-case-lists/an-enum-enum-image-conditional-enum-or-translatable-enum-column``."""
)

# The time-ago intervals HQ's column editor offers (details/bootstrap5/column.js time_ago_extra, with utils.js
# TIME_AGO).
TIME_AGO_INTERVALS = (365.25, 365.25 / 12, 7.0, 1.0, -1.0, -7.0, -365.25 / 12)

# The escapes Core's ``format-date`` formats (``DateUtils.format``); it raises on any other, and on a pattern that
# ends with ``%``.
CORE_DATE_ESCAPES = frozenset("%YymnBbdeHhMS3AawZ")


def core_formats(pattern):
    """Whether Core's ``format-date`` formats a pattern (``DateUtils.format``): every ``%`` followed by an escape it
    reads."""
    index = 0
    while index < len(pattern):
        if pattern[index] == "%":
            if index + 1 >= len(pattern) or pattern[index + 1] not in CORE_DATE_ESCAPES:
                return False
            index += 2
        else:
            index += 1
    return True


def _unformatted_date(at, column, detail, kind, module):
    pattern = column.get("date_format")
    return _format(column) == "date" and (not isinstance(pattern, str) or not pattern or not core_formats(pattern))


date_with_another_pattern = _column_reader(_unformatted_date)
date_with_another_pattern.__doc__ = """``menus-and-case-lists/2p-date-any-other-date-format``: a date column whose
pattern HQ's build hands Core's ``format-date`` (``detail_screen.py::Date``) and Core does not format
(``core_formats``), or no pattern, which shows no date. A pattern HQ's menu does not offer that Core formats is
the HELD row's: HQ's Case List page keeps it (``ui-element-select.js::Select.val``)."""


def _interval_offered(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return number in TIME_AGO_INTERVALS


time_ago_with_another_interval = _column_reader(
    lambda at, column, detail, kind, module: (
        _format(column) == "time-ago" and not _interval_offered(column.get("time_ago_interval", 365.25))
    )
)
time_ago_with_another_interval.__doc__ = """``menus-and-case-lists/3p-time-ago-other-interval``."""

# Each geo format and the formats it needs beside it in its detail (the rows of formats 11 to 14).
GEO_DEPENDENCIES = {
    "geo-boundary": ("address",),
    "geo-boundary-color": ("address", "geo-boundary"),
    "geo-points": ("address",),
    "geo-points-colors": ("address", "geo-points"),
}

geo_without_dependency = _column_reader(
    lambda at, column, detail, kind, module: (
        _format(column) in GEO_DEPENDENCIES
        and any(
            needed not in {_format(other) for other in _columns(detail)} for needed in GEO_DEPENDENCIES[_format(column)]
        )
    )
)
geo_without_dependency.__doc__ = """``menus-and-case-lists/a-geo-column-without-the-column-it-depends-on``."""

# The formats whose own sort wins over a sort element's calculation (FormattedDetailColumn.sort_node).
OWN_SORT_FORMATS = frozenset(
    {"enum", "enum-image", "conditional-enum", "translatable-enum", "clickable-icon", "date", "time-ago", "distance"}
)
# A calculated column's sort field, as HQ's build reads it (util.py, with const.py's CALCULATED_SORT_FIELD_RX):
# Python's re.match, whose ``$`` also matches before a final newline.
CALCULATED_SORT_FIELD = re.compile(r"^_cc_calculated_(\d+)$")


def _sorts(detail):
    return [sort for sort in (detail or {}).get("sort_elements") or [] if isinstance(sort, dict)]


def _filter_changes_the_build(at, column, detail, kind, module):
    """24′ ``filter`` otherwise: a filter column that is the short detail's first with no sort elements, whose
    field a sort element names with no earlier column of that field, before a column a ``_cc_calculated_N``
    sort field names, or in a custom tile's slots."""
    if _format(column) != "filter":
        return False
    columns = _columns(detail)
    position = next(index for index, each in enumerate(columns) if each is column)
    sorts = _sorts(detail)
    if kind == "short" and position == 0 and not sorts:
        return True
    field = column.get("field")
    if any(sort.get("field") == field for sort in sorts) and not any(
        each.get("field") == field for each in columns[:position]
    ):
        return True
    for sort in sorts:
        matched = CALCULATED_SORT_FIELD.match(str(sort.get("field") or ""))
        if matched and int(matched.group(1)) > position:
            return True
    return detail.get("case_tile_template") == "custom" and column.get("grid_x") is not None


filter_changes_the_build = _column_reader(_filter_changes_the_build)
filter_changes_the_build.__doc__ = """``menus-and-case-lists/24p-filter-otherwise``."""

SINGLE_FORMATS = ("image", "geo-boundary", "geo-boundary-color", "geo-points", "geo-points-colors")


def _repeated_single_format(detail, column, single_formats):
    """Whether a detail holds a second column of one of ``single_formats``; for a use in a column, whether that
    column is of the repeated format, since the class is a fact about those columns and not their neighbours."""
    formats = [_format(one) for one in _columns(detail)]
    repeated = {single for single in single_formats if formats.count(single) > 1}
    return bool(repeated) if column is None else _format(column) in repeated


def several_of_one_format_basic(use, manifest):
    """``menus-and-case-lists/more-than-one-address-column-or-more-than-one-image-or-geo``: in a basic or
    shadow module's detail, a second ``image`` or geo column of one format, which the editor refuses; a
    second ``address`` fails HQ's build (``invalid tile configuration``). The source check also classifies
    the address columns of a retained mutation that has no build verdict."""
    at, column, detail, kind, module = _column(use)
    if detail is None:
        return None
    return (module or {}).get("doc_type") != "AdvancedModule" and _repeated_single_format(
        detail, column, (*SINGLE_FORMATS, "address")
    )


def several_of_one_format_advanced(use, manifest):
    """``menus-and-case-lists/more-than-one-image-or-geo-column-of-the-same-format-in-a-detail``."""
    at, column, detail, kind, module = _column(use)
    if detail is None:
        return None
    return (module or {}).get("doc_type") == "AdvancedModule" and _repeated_single_format(
        detail, column, SINGLE_FORMATS
    )


# HQ's editor's field check (details/utils.js::isValidPropertyName, and sort_rows.js::hasValidPropertyName for a
# calculated column's sort field): JavaScript's RegExp.test, whose ``^...$`` holds of the whole string, a final
# newline included, and whose ``\w`` and ``\d`` are ASCII; so each is matched whole here (``fullmatch``).
_WORD = r"[a-zA-Z][\w_-]*"
PROPERTY_NAME = re.compile(rf"({_WORD}:)*({_WORD}/)*#?{_WORD}", re.ASCII)
EDITOR_CALCULATED_SORT_FIELD = re.compile(r"_cc_calculated_(\d+)", re.ASCII)


def fails_property_name_check(use, manifest):
    """``menus-and-case-lists/field-failing-details-utils-js-isvalidpropertyname-non``: a non-calculated
    column's field, or a sort element's, that the editor's check refuses (a ``_cc_calculated_N`` sort field
    is its own row's)."""
    at = _json(use)
    if at is None:
        return None
    sort = at.nearest("SortElement")
    if sort is not None:
        field = str(sort.get("field") or "")
        return bool(field) and not EDITOR_CALCULATED_SORT_FIELD.fullmatch(field) and not PROPERTY_NAME.fullmatch(field)
    column = at.nearest("DetailColumn")
    if column is None:
        return None
    return not column.get("useXpathExpression") and not PROPERTY_NAME.fullmatch(str(column.get("field") or ""))


def explicit_property_prefix(use, manifest):
    """``menus-and-case-lists/property-x-or-prefix-x-with-a-prefix-hq-registers-no-generator``: a column field
    ``property:<x>`` (a ``detail-field-type:property`` use; another unregistered prefix is its own key)."""
    at, column, detail, kind, module = _column(use)
    if column is None:
        return None
    return str(column.get("field") or "").startswith("property:")


def case_id_element(use, manifest):
    """``menus-and-case-lists/case-id-as-a-property-column-s-field``: a non-calculated column whose field is
    ``case_id``, which HQ reads as a child element no case carries (``detail_screen.py::CASE_PROPERTY_MAP`` maps no
    ``case_id``)."""
    at, column, detail, kind, module = _column(use)
    if column is None:
        return None
    field = str(column.get("field") or "")
    return (not column.get("useXpathExpression") and PROPERTY_NAME.fullmatch(field) is not None
            and ":" not in field and not field.startswith("user/") and field.split("/")[-1] == "case_id")


def _custom_tile(detail):
    return detail.get("case_tile_template") == "custom"


def _case_list_tile(detail, kind):
    """Whether a detail is the case list's custom tile, whose cells the tile's cell classes read. A custom tile on
    the case detail is a class of its own (``menus-and-case-lists/long-detail-custom-tile-case-detail-laid-out-as-a-
    tile``), which takes its cells with it, as Nova's reader refuses it whole (``caseList/tile.ts::readTile``)."""
    return kind == "short" and _custom_tile(detail)


null_on_unplaced_tile = _column_reader(
    lambda at, column, detail, kind, module: (
        _case_list_tile(detail, kind) and (column.get("grid_x") is None or column.get("grid_y") is None)
    )
)
null_on_unplaced_tile.__doc__ = """``menus-and-case-lists/custom-tile-column-with-grid-null-unplaced``."""

null_font_size_on_tile = _column_reader(
    lambda at, column, detail, kind, module: (
        _case_list_tile(detail, kind) and "font_size" in column and column.get("font_size") is None
    )
)
null_font_size_on_tile.__doc__ = """``menus-and-case-lists/custom-tile-font-size-null``."""

null_alignment_on_placed_tile = _column_reader(
    lambda at, column, detail, kind, module: (
        _case_list_tile(detail, kind)
        and column.get("grid_x") is not None
        and column.get("grid_y") is not None
        and column.get("horizontal_align") is None
    )
)
null_alignment_on_placed_tile.__doc__ = (
    """``menus-and-case-lists/horizontal-align-null-on-a-placed-custom-tile-column``."""
)


def _tile_box(column):
    """A column's stored square on a custom tile (``grid_x``, ``grid_y``, ``width``, ``height``), or None where one
    of the four is no number."""
    box = tuple(column.get(key) for key in ("grid_x", "grid_y", "width", "height"))
    return box if all(isinstance(value, int) and not isinstance(value, bool) for value in box) else None


def _boxes_overlap(a, b):
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def overlapping_tile_cells(use, manifest):
    """``menus-and-case-lists/custom-tile-cells-covering-the-same-square``: a placed cell of a menu's custom tile that
    covers a square another placed cell of the same tile covers: on the case list every column but a ``filter`` one
    (HQ's build writes no field for it, ``detail_screen.py::Filter``), on the case detail the columns of one tab
    (``DetailTab.starting_index`` starts each). HQ's build writes both cells as they are, and Nova's reader refuses
    each such cell (``caseList/tile.ts::overlappingCells``). A detail HQ's build never lays out as a menu's tile (one
    that is no custom tile, or no menu's own case list or detail) is out of the class; a use on the detail reads
    each of its columns."""
    at, column, detail, kind, module = _column(use)
    if detail is None:
        return None
    pair = (module or {}).get("case_details")
    if (
        not _custom_tile(detail)
        or kind not in ("short", "long")
        or not isinstance(pair, dict)
        or pair.get(kind) is not detail
    ):
        return False
    columns = _columns(detail)
    starts = sorted(
        tab["starting_index"]
        for tab in (detail.get("tabs") or [])
        if kind == "long"
        and isinstance(tab, dict)
        and isinstance(tab.get("starting_index"), int)
        and not isinstance(tab.get("starting_index"), bool)
    )
    placed = [
        (index, sum(1 for start in starts if start <= index), _tile_box(each))
        for index, each in enumerate(columns)
        if _format(each) != "filter"
    ]
    placed = [(index, group, box) for index, group, box in placed if box is not None]
    covering = {
        index
        for index, group, box in placed
        for other, other_group, other_box in placed
        if other != index and other_group == group and _boxes_overlap(box, other_box)
    }
    targets = [column] if column is not None else columns
    return any(index in covering for index, each in enumerate(columns) if any(each is one for one in targets))


def _added_child_types(app, case_type):
    """The child case types HQ's Case Detail page offers a data tab of ``case_type``'s menus: each type a basic
    form of a menu of that case type adds as a child case it does not close (``Application.get_subcase_types``,
    ``Form.get_subcase_types``)."""
    return {
        subcase.get("case_type")
        for module in app.modules
        if module.get("case_type") == case_type
        for form in module.get("forms") or []
        if isinstance(form, dict) and form.get("doc_type") == "Form"
        for subcase in ((form.get("actions") or {}).get("subcases") or [])
        if isinstance(subcase, dict)
        and subcase.get("case_type")
        and ((subcase.get("close_condition") or {}).get("type") or "never") == "never"
    }


def tab_child_type_no_form_adds(use, manifest):
    """``menus-and-case-lists/detail-tab-child-type-no-form-of-its-menu-s-case-type-adds``: a data tab's
    ``nodeset_case_type`` naming a type no basic form of a menu of the list's case type adds, which HQ's Case
    Detail page clears at its next save. Nova's reader refuses it (``caseList/index.ts::
    refuseTabChildTypesNoFormAdds``)."""
    at = _json(use)
    if at is None:
        return None
    tab = at.nearest("DetailTab")
    module = at.nearest(*MODULES)
    if tab is None or module is None:
        return None
    child = tab.get("nodeset_case_type")
    if tab.get("has_nodeset") is not True or not isinstance(child, str) or not child:
        return False
    return child not in _added_child_types(at.app, module.get("case_type"))


TILE_GRID = 12
# The fewest rows HQ's Case List and Case Detail pages offer a tile (``details/bootstrap5/screen.js``,
# ``caseTileRowMax = max(columns + 1, 7)``, so a bottom edge up to ``max(columns, 6)``).
TILE_MIN_ROWS = 6


def _offered_rows(detail, kind):
    """The rows HQ's page offers one detail's tile: ``max(n, 6)``, n its columns other than ``filter`` ones and, on
    the case detail (``long``), its tabs, which the page splices into its columns before it drops the filters
    (``screen.js``). Written from the page's source, not from Nova's (``caseList/tile.ts::screenTileRows``)."""
    columns = [column for column in (detail.get("columns") or []) if not isinstance(column, dict) or _format(column) != "filter"]
    tabs = detail.get("tabs") if kind == "long" else None
    return max(len(columns) + (len(tabs) if isinstance(tabs, list) else 0), TILE_MIN_ROWS)


def _grid_fit(box, rows):
    """Where a stored cell stands against the grid of its screen of ``rows`` rows (``caseList/tile.ts::gridFit``):
    ``outside`` for a cell starting left of or above the grid, spanning less than one square, or running past the
    twelfth column; ``past`` for one inside those columns whose bottom edge passes the rows HQ's page offers;
    ``fits`` otherwise, a cell past the twelfth row inside those rows among them (the HELD class
    ``menus-and-case-lists/custom-tile-cell-below-the-twelfth-row``, an allowing class no reader reads)."""
    x, y, width, height = box
    if x < 0 or y < 0 or width < 1 or height < 1 or x + width > TILE_GRID:
        return "outside"
    return "past" if y + height > rows else "fits"


def _tile_cell_fit(fit):
    def reader(use, manifest):
        at, column, detail, kind, module = _column(use)
        if detail is None:
            return None
        pair = (module or {}).get("case_details")
        if (
            not _custom_tile(detail)
            or kind not in ("short", "long")
            or not isinstance(pair, dict)
            or pair.get(kind) is not detail
        ):
            return False
        targets = [column] if column is not None else _columns(detail)
        rows = _offered_rows(detail, kind)
        return any(
            _format(each) != "filter" and box is not None and _grid_fit(box, rows) == fit
            for each in targets
            for box in [_tile_box(each)]
        )

    return reader


tile_cell_outside_the_grid = _tile_cell_fit("outside")
tile_cell_outside_the_grid.__doc__ = """``menus-and-case-lists/custom-tile-cell-outside-the-grid``: a placed cell of a
menu's custom tile (its case list's or its case detail's, every column but a ``filter`` one) that starts left of or
above the grid, spans less than one square, or runs past the twelfth column. Nova's reader refuses each such cell
(``caseList/tile.ts::gridFit``). A detail HQ's build never lays out as a menu's tile is out of the class; a use on
the detail reads each of its columns."""

tile_cell_below_the_offered_rows = _tile_cell_fit("past")
tile_cell_below_the_offered_rows.__doc__ = """``menus-and-case-lists/custom-tile-cell-below-the-rows-hq-s-page-
offers``: a placed cell of a menu's custom tile, inside its twelve columns, whose bottom edge passes the rows HQ's
Case List or Case Detail page offers its screen, ``max(n, 6)`` (``_offered_rows``): the page's next save moves it
(as ``tile_cell_outside_the_grid`` reads its tile)."""


def _detail_reader(test):
    def reader(use, manifest):
        at, column, detail, kind, module = _column(use)
        if detail is None:
            return None
        return test(at, detail, kind, module or {})

    return reader


person_simple_on_list = _detail_reader(
    lambda at, detail, kind, module: kind == "short" and detail.get("case_tile_template") == "person_simple"
)
person_simple_on_list.__doc__ = """``menus-and-case-lists/detail-case-tile-template-person-simple``."""

not_custom_on_detail = _detail_reader(
    lambda at, detail, kind, module: kind == "long" and detail.get("case_tile_template") not in (None, "", "custom")
)
not_custom_on_detail.__doc__ = """``menus-and-case-lists/long-detail-non-custom-tile``."""


def _sorted_column(columns, field):
    """The column HQ's build attaches a sort element's field to (``util.py::get_sort_and_sort_only_columns``):
    the first column with that field, else, for a calculated column's sort field (``_cc_calculated_N``,
    ``CALCULATED_SORT_FIELD``), the column at that index; None where neither names one."""
    column = next((column for column in columns if column.get("field") == field), None)
    if column is not None:
        return column
    matched = CALCULATED_SORT_FIELD.match(str(field or ""))
    if matched and int(matched.group(1)) < len(columns):
        return columns[int(matched.group(1))]
    return None


def _case_order_type(tree, properties):
    """The type supplied by a case-row expression, when its operands establish one."""
    kind = tree[0]
    if kind == "number":
        return "number"
    if kind == "text":
        return "text"
    if kind == "path":
        prop = _bare_read(tree, "child")
        if prop == "*" or (
            tree[1] == "instance:casedb"
            and tree[4] == [["child", "casedb", 0], ["child", "case", 0]]
        ):
            return "collection"
        if prop is not None:
            data_type = properties.get(prop)
            return "number" if data_type in ("int", "decimal") else data_type or "scalar"
        if _bare_read(tree, "attribute") in ("case_id", "case_type"):
            return "text"
        if tree[1] == "instance:commcaresession" and _session_context_read(tree) in (
            "username", "userid",
        ):
            return "text"
        return None
    if kind == "negative":
        return "number" if _case_order_type(tree[1], properties) == "number" else None
    if kind == "binary":
        left, right = (_case_order_type(node, properties) for node in tree[2:])
        if left == right == "number" and tree[1] in ("+", "-", "*", "div", "mod"):
            return "number"
        if left == right and left in ("number", "text") and tree[1] in ("=", "!=", "<", "<=", ">", ">="):
            return "boolean"
        return None
    if kind == "call":
        args = [_case_order_type(node, properties) for node in tree[2]]
        if tree[1] == "concat" and len(args) >= 2 and all(arg not in (None, "collection") for arg in args):
            return "text"
        if tree[1] == "if" and len(args) == 3 and args[0] == "boolean" and args[1] == args[2]:
            return args[1]
    return None


def mapping_condition_outside_predicate(use, manifest):
    """``menus-and-case-lists/mapping-condition-outside-predicate``: a mapping key of a column whose format reads
    its keys as conditions (``observe/manifest.py::CONDITION_KEY_FORMATS``) that Core's parse refuses, so it is no
    condition a case meets (``lib/commcare/reader/expressions/findings.ts::parseIssueEntry``). A key with none of an
    expression's characters is a saved value, another class; a key Core parses may still read a value Nova has no
    binding for, which the key alone does not settle, so the class is decided by the parse only where it fails."""
    at, column, _, _, _ = _column(use)
    if at is None or column is None:
        return None
    if column.get("format") not in ("conditional-enum", "enum-image", "clickable-icon"):
        return False
    item = at.nearest("MappingItem")
    if item is None or not isinstance(item.get("key"), str):
        return None
    key = item["key"]
    if not any(character in key for character in "{}()[]=<>.\"'/"):
        return False
    field = column.get("field")
    properties = _case_properties(use)
    dot = None
    if not column.get("useXpathExpression") and isinstance(field, str) and field in properties:
        dot = _CASE_VALUE_TYPES.get(properties[field] or "text")
    return _scoped_verdict(at.app, key, lambda tree: _case_condition_type(tree, properties, dot) == "boolean")


# The value a case property of a declared type gives an expression of the selected case, as Nova's type checker reads
# it (``lib/domain/casePropertyTypes.ts``): a single choice compares as text, a multiple choice is read only by
# ``selected``, and a type this table leaves out (a date, a time, a place) is read by no rule these classes decide.
_CASE_VALUE_TYPES = {
    "text": "text",
    "single_select": "text",
    "multi_select": "choices",
    "int": "number",
    "decimal": "number",
}


def _case_properties(use):
    """The declared properties of the case type a use's case list reads (``_list_case_type``), by name with each one's
    type; empty where the type or the catalog is not known."""
    at = _json(use)
    case_type = _list_case_type(use)
    if at is None or case_type is None:
        return {}
    return (at.app.case_types or {}).get(case_type) or {}


def _case_condition_type(tree, properties, dot=None):
    """The type an expression of the selected case gives (``number``, ``text``, ``choices`` or ``boolean``), where its
    every part is one Nova's type checker types the same way: a literal, a bare read of a declared property of a
    type ``_CASE_VALUE_TYPES`` names (``.``, the column's own property, where ``dot`` gives its type), a comparison of
    two values of one type (an order of two numbers), ``and``/``or``/``not`` over truth values, arithmetic over
    numbers, ``concat`` of texts, ``selected`` of a property and a text, ``true()`` and ``false()``. None for anything else, which these
    classes leave undecided rather than guess."""
    kind = tree[0]
    if kind == "number":
        return "number"
    if kind == "text":
        return "text"
    if kind == "path":
        steps = tree[4]
        if dot is not None and tree[1] == "relative" and not tree[3] and [list(step) for step in steps] == [
            ["self", "node()", 0]
        ]:
            return dot
        prop = _bare_read(tree, "child")
        # A declared property with no type is text, as Nova's checker reads it (``data_type ?? "text"``).
        return None if prop is None or prop not in properties else _CASE_VALUE_TYPES.get(properties[prop] or "text")
    if kind == "negative":
        return "number" if _case_condition_type(tree[1], properties, dot) == "number" else None
    if kind == "binary":
        left, right = (_case_condition_type(node, properties, dot) for node in tree[2:])
        operator = tree[1]
        if operator in ("and", "or"):
            return "boolean" if left == right == "boolean" else None
        if operator in ("=", "!="):
            return "boolean" if left == right and left in ("number", "text") else None
        if operator in ("<", "<=", ">", ">="):
            return "boolean" if left == right == "number" else None
        if operator in ("+", "-", "*", "div", "mod"):
            return "number" if left == right == "number" else None
        return None
    if kind == "call":
        name, arguments = tree[1], tree[2]
        if name in ("true", "false") and not arguments:
            return "boolean"
        if name == "not" and len(arguments) == 1:
            return "boolean" if _case_condition_type(arguments[0], properties, dot) == "boolean" else None
        if name == "selected" and len(arguments) == 2:
            subject = _case_condition_type(arguments[0], properties, dot)
            value = _case_condition_type(arguments[1], properties, dot)
            return "boolean" if subject in ("choices", "text") and value == "text" else None
        # A text holding both quote characters is printed as a concatenation of literals.
        if name == "concat" and len(arguments) >= 2:
            parts = [_case_condition_type(argument, properties, dot) for argument in arguments]
            return "text" if all(part == "text" for part in parts) else None
    return None


def _scoped_verdict(app, text, typed):
    """The verdict of a class of expressions Nova reads in the selected case's scope: in it (True) where Core's
    parse refuses the text, which then holds no expression at all (``lib/commcare/reader/expressions/findings.ts::
    parseIssueEntry``, "syntax"); out of it (False) where its structure is one ``typed`` places in the scope; and
    undecided (None) for every other text, including one the records hold no parse or structure of."""
    parsed = app.parsed(text)
    if parsed is None:
        return None
    if "error" in parsed:
        return True
    tree = app.tree(text)
    if tree is None:
        return None
    return False if typed(tree) else None


def _detail_of(use):
    """A use's detail with its kind (``short``, ``long``) and its menu, where the detail is the menu's own case list
    or case detail (``case_details``): (at, detail, kind, module), or Nones."""
    at = _json(use)
    if at is None:
        return None, None, None, None
    detail, module = at.nearest("Detail"), at.nearest(*MODULES)
    pair = (module or {}).get("case_details")
    kind = next(
        (name for name in ("short", "long") if isinstance(pair, dict) and pair.get(name) is detail and detail is not None),
        None,
    )
    return at, detail, kind, module


def _tabs(detail):
    return [tab for tab in (detail or {}).get("tabs") or [] if isinstance(tab, dict)]


def columns_above_the_first_tab(use, manifest):
    """``menus-and-case-lists/columns-above-the-first-tab-when-tabs-exist``: a detail whose first tab starts after its
    first column (``starting_index`` above 0), which HQ's Case Detail page refuses to save ("All properties must be
    below a tab", ``screen.js::save``) and Nova's reader refuses (``caseList/details.ts``, ``tabsColumnsAbove``). A
    use of the tabs or of any tab's start reads the detail's first tab; a start that is no number is no column
    above a tab."""
    at = _json(use)
    detail = at.nearest("Detail") if at is not None else None
    if detail is None:
        return None
    tabs = _tabs(detail)
    if not tabs:
        return False
    start = tabs[0].get("starting_index")
    return isinstance(start, int) and not isinstance(start, bool) and start > 0


def tab_condition_outside_case_scope(use, manifest):
    """``menus-and-case-lists/tab-display-condition-outside-its-case-scope``: a tab's display condition (``relevant``)
    that is no condition of the selected case: one Core's parse refuses. One whose structure
    ``_case_condition_type`` types as a truth value of the menu's case is out of the class; any other is undecided."""
    at = _json(use)
    tab = at.nearest("DetailTab") if at is not None else None
    if tab is None:
        return None
    text = tab.get("relevant")
    if not isinstance(text, str) or not text.strip():
        return False
    properties = _case_properties(use)
    return _scoped_verdict(at.app, text, lambda tree: _case_condition_type(tree, properties) == "boolean")


def _records_rows_typed(tree, app):
    """Whether a records tab's rows are the cases of one declared type, each predicate beside the type's one a
    condition of that type (``_case_predicate_scope``): ``instance('casedb')/casedb/case[@case_type = 'T'][...]``."""
    if tree[0] != "path":
        return False
    case_type, first, end = _case_predicate_scope(tree)
    if case_type is None or len(tree[4]) != 2:
        return False
    properties = (app.case_types or {}).get(case_type)
    if properties is None:
        return False
    for predicate in tree[3][first:end]:
        if predicate[:2] == ["binary", "="] and any(
            _bare_read(path, "attribute") == "case_type" and literal[0] == "text"
            for path, literal in (predicate[2:], list(reversed(predicate[2:])))
        ):
            continue
        if _case_condition_type(predicate, properties) != "boolean":
            return False
    return True


def tab_without_a_resolvable_row_source(use, manifest):
    """``menus-and-case-lists/detail-tab-without-a-resolvable-row-source``: a tab that lists records but names none it
    can read, as Nova's reader decides (``caseList/details.ts``, ``tabRowsMissing``, ``tabTypeInvalid`` and the
    rows' and filter's slots): rows turned on (``has_nodeset``) with neither rows (``nodeset``) nor a child type in
    the case type grammar (``nodeset_case_type``); a child type outside the grammar on a tab that lists children;
    rows or a child filter Core's parse refuses, and rows that are a literal, a value and no records. Rows that are
    one declared type's cases under conditions
    ``_case_condition_type`` types, and a child filter it types over the child type, are out of the class, as is
    every setting of a tab whose rows are off; a records tab's child type beside a search is the search's, which
    the use alone does not settle."""
    at = _json(use)
    tab = at.nearest("DetailTab") if at is not None else None
    if tab is None:
        return None
    active = tab.get("has_nodeset") is True
    nodes, child, filter_ = tab.get("nodeset"), tab.get("nodeset_case_type"), tab.get("nodeset_filter")
    custom = active and isinstance(nodes, str) and nodes != ""
    valid_child = isinstance(child, str) and MENU_PAGE_CASE_TYPE.fullmatch(child) is not None
    children = active and not custom and valid_child
    key = at.key
    if not active:
        return False
    if key == "has_nodeset":
        return not (custom or children)
    if key == "nodeset_case_type":
        if custom:
            return False if valid_child or not child else None
        return not children
    if key == "nodeset":
        if not custom:
            return False
        verdict = _scoped_verdict(at.app, nodes, lambda tree: _records_rows_typed(tree, at.app))
        tree = at.app.tree(nodes)
        # A literal is a value, never records a tab can list.
        return True if verdict is None and tree is not None and tree[0] in ("text", "number") else verdict
    if key == "nodeset_filter":
        if not children or not isinstance(filter_, str) or not filter_.strip():
            return False
        properties = (at.app.case_types or {}).get(child) or {}
        return _scoped_verdict(at.app, filter_, lambda tree: _case_condition_type(tree, properties) == "boolean")
    return None


def _defines_line(detail):
    """Whether a detail turns on the one-line context above a form that its own persistent tile does not replace
    (``caseList/details.ts``, ``definesLine``)."""
    return detail.get("persist_case_context") is True and not (
        detail.get("case_tile_template") and detail.get("persist_tile_on_forms") is True
    )


def form_context_expression_outside_case_scope(use, manifest):
    """``menus-and-case-lists/form-context-expression-outside-its-case-scope``: the line a case list puts above its
    forms (``persistent_case_context_xml`` of a short detail that turns the line on and whose own tile does not
    persist) that is no value of the selected case: one Core's parse refuses. A value ``_case_condition_type`` types,
    or a bare read of a declared property, is out of the class, as is the key wherever no line reads it."""
    at, detail, kind, module = _detail_of(use)
    if detail is None:
        return None
    text = detail.get("persistent_case_context_xml")
    if kind != "short" or not _defines_line(detail) or not isinstance(text, str) or not text.strip():
        return False
    properties = _case_properties(use)
    return _scoped_verdict(
        at.app,
        text,
        lambda tree: _bare_read(tree, "child") in properties or _case_condition_type(tree, properties) is not None,
    )


def form_context_without_a_compatible_tile(use, manifest):
    """``menus-and-case-lists/form-context-without-a-compatible-case-tile``: a case list whose context above a form
    names another menu (``persistent_case_tile_from_module``) that does not exist, lays out no tile, or lists another
    case type (a menu with neither a tile nor its own suite holds no context, another class), or that pulls a tile
    down (``pull_down_tile``) with no tile of its own that persists and no other menu's, as Nova's reader decides
    (``caseList/details.ts``, ``contextUnavailable``, ``inlineUnavailable``). Either key of a case detail reads
    nothing, another class."""
    at, detail, kind, module = _detail_of(use)
    if detail is None:
        return None
    if kind != "short":
        return False
    source_id = detail.get("persistent_case_tile_from_module")
    external = None
    if isinstance(source_id, str) and source_id:
        source = at.app.modules_by_id.get(source_id)
        pair = (source or {}).get("case_details")
        source_short = pair.get("short") if isinstance(pair, dict) and isinstance(pair.get("short"), dict) else {}
        if source is not None and not source_short.get("case_tile_template") and not source_short.get("custom_xml"):
            external = False  # a menu with no tile: the reader leaves the setting dormant
        elif source is None or not source_short.get("case_tile_template") or source.get("case_type") != module.get(
            "case_type"
        ):
            if at.key == "persistent_case_tile_from_module":
                return True
            external = False
        else:
            external = True
    if at.key == "persistent_case_tile_from_module":
        return False
    if at.key == "pull_down_tile":
        if detail.get("pull_down_tile") is not True:
            return False
        own = detail.get("case_tile_template") in ("custom", "icon_text_grid") and detail.get(
            "persist_tile_on_forms"
        ) is True
        return not (external or own)
    return None


def competing_form_context_values(use, manifest):
    """``menus-and-case-lists/two-different-values-for-the-same-form-context``: a case detail whose one-line context
    above a form differs from its case list's, both turning the line on (``_defines_line``): HQ's build writes one
    shared detail for both, of which Core keeps the last, so the Case List page shows a line the worker does not
    see. Nova's reader refuses the case detail's keys and reads the case list's (``caseList/details.ts``,
    ``competingLine``), so a use on the case list is out of the class."""
    at, detail, kind, module = _detail_of(use)
    if detail is None:
        return None
    if kind != "long":
        return False
    short = module["case_details"].get("short")
    if not isinstance(short, dict) or not _defines_line(short) or not _defines_line(detail):
        return False
    return short.get("persistent_case_context_xml", "case_name") != detail.get("persistent_case_context_xml", "case_name")


def independent_sort_without_scalar(use, manifest):
    """Classify the selected case's scalar independently of Nova's reader.
    An expression with an unresolved binding or function stays undecided."""
    at = _json(use)
    sort = at.nearest("SortElement") if at is not None else None
    if sort is None:
        return None
    text = sort.get("sort_calculation")
    if sort.get("field") != "" or not isinstance(text, str) or not text.strip():
        return False
    tree = at.app.tree(text)
    if tree is None:
        return None
    properties = (at.app.case_types or {}).get(_list_case_type(use)) or {}
    result = _case_order_type(tree, properties)
    return None if result is None else result == "collection"


def calculated_distance_without_property(use, manifest):
    """HQ's invisible temporary column has an empty field for Distance to evaluate."""
    at = _json(use)
    sort = at.nearest("SortElement") if at is not None else None
    if sort is None:
        return None
    calculation = sort.get("sort_calculation")
    return sort.get("type") == "distance" and sort.get("field") == "" and isinstance(calculation, str) and bool(calculation.strip())


def distance_on_translated_calculation(use, manifest):
    """The translated expression's sort node reads a calculated variable its template never defines."""
    at = _json(use)
    detail = at.nearest("Detail") if at is not None else None
    sort = at.nearest("SortElement") if at is not None else None
    if detail is None or sort is None:
        return None
    if sort.get("type") != "distance" or not sort.get("field"):
        return False
    columns = _columns(detail)
    named = _sorted_column(columns, sort["field"])
    if named is None:
        return False
    # A positional reference uses the named column's text to find the first column with that field.
    landing = next((column for column in columns if column.get("field") == named.get("field")), named)
    return bool(landing.get("useXpathExpression")) and _format(landing) == "translatable-enum"


def beside_a_field_on_another_format(use, manifest):
    """``menus-and-case-lists/field-and-a-differing-sort-calculation-on-any-other-column``: a sort element
    with a field and a ``sort_calculation`` that differs from what its column (``_sorted_column``) shows, on a
    column whose format has no sort of its own. A calculated column's sort field whose calculation is that
    column's own expression is the class
    ``menus-and-case-lists/sort-calculation-equal-to-the-referenced-calculated-column`` (HELD), not this one."""
    at = _json(use)
    if at is None:
        return None
    detail = at.nearest("Detail")
    if detail is None:
        return None
    sort = at.nearest("SortElement")
    columns = _columns(detail)
    for each in [sort] if sort is not None else _sorts(detail):
        field, calculation = each.get("field"), each.get("sort_calculation")
        if not field or not calculation or calculation == field:
            continue
        column = _sorted_column(columns, field)
        if column is not None and column.get("field") != field and calculation == column.get("field"):
            continue
        if column is None or _format(column) not in OWN_SORT_FORMATS:
            return True
    return False


def _module_of_detail(use):
    at = _json(use)
    if at is None:
        return None, None
    return at, at.nearest(*MODULES)


def empty_short_detail_another_selects_from(use, manifest):
    """``menus-and-case-lists/short-columns-empty-on-a-module-another-module-s-active-parent``: a module whose
    case list has no columns that another module's active parent selection names, or whose case tile
    another module's ``persistent_case_tile_from_module`` names, or that an advanced form's load lists cases
    from."""
    at, module = _module_of_detail(use)
    if module is None:
        return None
    short = ((module.get("case_details") or {}).get("short")) or {}
    if _columns(short):
        return False
    me = module.get("unique_id")
    for other in at.app.modules:
        if other is module:
            continue
        parent = other.get("parent_select") or {}
        if parent.get("active") and parent.get("module_id") == me:
            return True
        if (((other.get("case_details") or {}).get("short")) or {}).get("persistent_case_tile_from_module") == me:
            return True
        for form in _forms(other):
            for load in (form.get("actions") or {}).get("load_update_cases") or []:
                if isinstance(load, dict) and load.get("details_module") == me:
                    return True
    return False


def _case_list_form_reader(test):
    def reader(use, manifest):
        at, module = _module_of_detail(use)
        if module is None:
            return None
        form_id = (
            ((module.get("case_list_form") or {}).get("form_id"))
            if isinstance(module.get("case_list_form"), dict)
            else None
        )
        if not form_id:
            return False
        return test(at, module, form_id)

    return reader


on_child_whose_parent_registers_same_form = _case_list_form_reader(
    lambda at, module, form_id: (
        bool(module.get("put_in_root"))
        and at.app.root(module) is not None
        and ((at.app.root(module).get("case_list_form") or {}).get("form_id")) == form_id
    )
)
on_child_whose_parent_registers_same_form.__doc__ = (
    """``menus-and-case-lists/case-list-form-on-a-child-put-in-root-module-whose-parent-s-case``."""
)

on_module_whose_forms_do_not_all_require_a_case = _case_list_form_reader(
    lambda at, module, form_id: any(
        _requires(form) != "case" for form in _forms(module) if (form.get("doc_type") or "Form") == "Form"
    )
)
on_module_whose_forms_do_not_all_require_a_case.__doc__ = (
    """``menus-and-case-lists/case-list-form-on-a-module-whose-forms-do-not-all-require-a-case``."""
)

on_display_only_module_with_tile_list = _case_list_form_reader(
    lambda at, module, form_id: (
        bool(module.get("put_in_root"))
        and bool((((module.get("case_details") or {}).get("short")) or {}).get("case_tile_template"))
    )
)
on_display_only_module_with_tile_list.__doc__ = (
    """``menus-and-case-lists/case-list-form-on-a-put-in-root-module-whose-case-list-is-a-tile``."""
)


def default_on_multi_select_host(use, manifest):
    """``menus-and-case-lists/case-list-form-post-form-workflow-default-on-a-multi-select-host``: a registration
    form offered from a case list that selects several cases, whose ``post_form_workflow`` is ``default``: HQ's
    return frame carries the one new case into the selection (``CaseListFormWorkflow._get_stack_frames``)."""
    return _case_list_form_reader(
        lambda at, module, form_id: (
            ((module.get("case_list_form") or {}).get("post_form_workflow") or "default") == "default"
            and _multi_select(module)
        )
    )(use, manifest)


def put_in_root_beside_an_endpoint_inline_search_or_form_return(use, manifest):
    """``menus-and-case-lists/put-in-root-session-endpoint-id-or-inline-search-or-an-end-of``: a module that shows
    its forms in the menu above (``put_in_root``) beside one of what HQ's build refuses there: its own
    ``session_endpoint_id``, inline search (``util.py::module_uses_inline_search``), or a ``form_links`` entry
    anywhere in the app that names it by ``module_unique_id`` with no ``form_id`` (``helpers/validators.py``:
    ``endpoint to display only forms``, ``inline search to display only forms``, ``form link to display only
    forms``). An end-of-form return to it (a form of its own whose ``post_form_workflow`` is ``module``, or a form
    of a child module's whose is ``parent_module``) is the form's own class
    (``forms-and-case-writes/post-form-workflow-hq-s-build-refuses-module-in-a-put-in-root``), at the form."""
    at, module = _module_of_detail(use)
    if module is None:
        return None
    if not module.get("put_in_root"):
        return False
    if module.get("session_endpoint_id") or _inline_search(module):
        return True
    me = module.get("unique_id")
    for other in at.app.modules:
        for form in _forms(other):
            for link in form.get("form_links") or []:
                if isinstance(link, dict) and link.get("module_unique_id") == me and not link.get("form_id"):
                    return True
    return False


def case_list_endpoint_on_a_put_in_root_module(use, manifest):
    """``menus-and-case-lists/case-list-session-endpoint-id-on-a-put-in-root-module``: a module's
    ``case_list_session_endpoint_id`` beside its ``put_in_root``, whose endpoint HQ builds through the menu above
    and never the list. In the app JSON, a module whose ``case_list_session_endpoint_id`` is not blank and whose
    ``put_in_root`` is true. In a suite, the endpoint itself: HQ's navigation frame for a module's endpoint
    (``post_process/endpoints.py::EndpointsHelper._make_session_endpoint``, the stack's last ``<push>``) starts with
    the command ``id_strings.py::menu_id`` names (``workflow.py::WorkflowHelper.get_frame_children``), which for a
    ``put_in_root`` module is no command at all (the first menu) or its parent's menu, and a form's endpoint names
    the form's entry command after it. So a use outside an ``<endpoint>`` is no use of the class; a frame with no
    command is in it, since only a ``put_in_root`` module's endpoint goes through the first menu; a frame whose
    last command is an entry's is a form's endpoint, and one whose last command names a menu no other ``<menu>``
    shares the id of is that menu's own; a menu id several ``<menu>`` elements share holds a ``put_in_root``
    module beside its parent (``suite_xml/sections/menus.py::MenuContributor``), whose endpoints the suite alone
    does not tell apart (None)."""
    at = use.at
    if isinstance(at, XmlAt):
        endpoint = next(
            (node for node in at.element.iterancestors() if isinstance(node.tag, str) and _local(node) == "endpoint"),
            at.element if _local(at.element) == "endpoint" else None,
        )
        if endpoint is None:
            return False
        stacks = [child for child in _children(endpoint) if _local(child) == "stack"]
        pushes = [push for stack in stacks for push in _children(stack) if _local(push) == "push"]
        if not pushes:
            return False
        commands = [child for child in _children(pushes[-1]) if _local(child) == "command"]
        if not commands:
            return True
        named = _literal_text(commands[-1].get("value"))
        if named is None:
            return None
        root = at.document.root
        entries = {
            command.get("id")
            for entry in root.iter()
            if isinstance(entry.tag, str) and _local(entry) == "entry"
            for command in _children(entry)
            if _local(command) == "command"
        }
        if named in entries:
            return False
        menus = [menu for menu in root.iter() if isinstance(menu.tag, str) and _local(menu) == "menu"]
        return None if sum(menu.get("id") == named for menu in menus) > 1 else False
    at = _json(use)
    if at is None:
        return None
    module = at.nearest(*MODULES)
    if module is None:
        return None
    return bool(module.get("case_list_session_endpoint_id")) and bool(module.get("put_in_root"))


def _literal_text(text):
    """The text of an expression that is one string literal, read with Core's lexer (``proof/rules/_xpath.py``);
    None for any other expression."""
    found = xpath_tokens(text or "")
    if not found or len(found) != 1 or found[0].kind != "STR":
        return None
    return found[0].text[1:-1]


def _screen_of(app, module):
    """The module whose screen lists a module's forms, or None for the app's first menu
    (``lib/domain/menuScreens.ts::menuScreenOf``, over HQ's ``put_in_root``): a module that does not show its forms
    above lists them on its own screen; one that does, on its parent's where the parent keeps its screen, and on
    the first menu otherwise."""
    if not module.get("put_in_root"):
        return module
    parent = app.root(module)
    if parent is not None and not parent.get("put_in_root"):
        return parent
    return None


def _form_needs_no_case(app, form, module):
    """Whether a form's entry asks for no case (``models/forms.py``: a basic form's ``requires_case``, an advanced
    form's load that is not auto-selected, a shadow form's source's); a module with no case type loads none."""
    if not module.get("case_type"):
        return True
    if (form.get("doc_type") or "Form") == "ShadowForm":
        source = app.forms_by_id.get(form.get("shadow_parent_form_id"))
        return True if source is None else _form_needs_no_case(app, source, app.module_of(source) or module)
    if form.get("doc_type") == "AdvancedForm":
        loads = (form.get("actions") or {}).get("load_update_cases") or []
        return not any(isinstance(load, dict) and not load.get("auto_select") for load in loads)
    return _requires(form) not in ("case", "referral")


def _first_chosen_type(app, module):
    """The case type a module's entries choose first: its parent selection's, where one is active, else its own."""
    parent = module.get("parent_select") or {}
    if parent.get("active"):
        selected = app.modules_by_id.get(parent.get("module_id"))
        if selected is not None:
            return selected.get("case_type")
    return module.get("case_type")


def _screen_chooses_no_case_first(app, module):
    """Whether the screen that lists a module's forms lets a worker choose a form before any case, by the rule
    Nova's gate holds (``lib/domain/menuScreens.ts::screenCaseFirstBlocker``): the first menu; a screen with a form
    that needs no case; a screen whose menus choose different cases first. Core asks one question of every entry a
    screen lists (``CommCareSession.getDataNeededByAllEntries``), so any of the three lists the forms first."""
    screen = _screen_of(app, module)
    if screen is None:
        return True
    contributors = [other for other in app.modules if _screen_of(app, other) is screen]
    for contributor in contributors:
        if any(_form_needs_no_case(app, form, contributor) for form in _forms(contributor)):
            return True
    return len({_first_chosen_type(app, contributor) for contributor in contributors}) > 1


def _reads_chosen_case(app, text):
    """Whether a display condition reads the case a menu chooses: a hashtag of it, by HQ's own test of the text
    (``xpath.py::_ensure_no_case_references``: ``#case``, ``#parent``, ``#host``), or a read of a session datum
    (Core's parse: a path from ``instance('commcaresession')`` through ``session/data``), which no screen supplies
    before a case is chosen; None where neither is found and Core's parse of the text is not at hand."""
    if any(hashtag in text for hashtag in ("#case", "#parent", "#host")):
        return True
    parsed = app.parsed(text)
    if parsed is None or "error" in parsed:
        return None
    return any(
        path["instance"] == "commcaresession" and path["steps"][:2] == ["session", "data"]
        for path in parsed["instancePaths"]
    )


def form_filter_reads_case_off_a_case_first_screen(use, manifest):
    """``menus-and-case-lists/form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first``: a
    ``form_filter`` that reads the form's case (``_reads_chosen_case``) where the screen that lists the form lets a
    worker choose the form before any case (``_screen_chooses_no_case_first``), so the condition reads a case that
    is not chosen yet. Wider than HQ's own build error, which reads the form's module alone
    (``helpers/validators.py``, ``CaseXPathValidationError``)."""
    at, form = _form(use)
    if form is None:
        return None
    text = form.get("form_filter")
    if not isinstance(text, str) or not text.strip():
        return False
    module = at.app.module_of(form)
    if module is None:
        return None
    if not _screen_chooses_no_case_first(at.app, module):
        return False
    return _reads_chosen_case(at.app, text)


def _root_reader(test):
    """A reader of the module a use's module sits under (``root_module_id``), on a module and a suite menu
    alike where the suite does not settle it (None there)."""

    def reader(use, manifest):
        at, module = _module_of_detail(use)
        if module is None:
            return None
        root = at.app.root(module)
        if root is None:
            return False
        return test(at, module, root)

    return reader


names_a_training_module = _root_reader(lambda at, module, root: bool(root.get("is_training_module")))
names_a_training_module.__doc__ = """``menus-and-case-lists/any-module-under-a-training-menu``."""

names_a_shadow_module = _root_reader(
    lambda at, module, root: (
        root.get("doc_type") == "ShadowModule" and (None if module.get("doc_type") == "ShadowModule" else True)
    )
)
names_a_shadow_module.__doc__ = """``menus-and-case-lists/any-other-module-under-a-shadow-menu``: a module under a
shadow menu; a shadow under one may be one of HQ's child mirrors, which the export alone does not tell (None)."""

grandchild = _root_reader(
    lambda at, module, root: root.get("doc_type") != "ShadowModule" and bool(root.get("root_module_id"))
)
grandchild.__doc__ = """``menus-and-case-lists/child-menu-deeper-than-one-tier-grandchild``."""


def training_module(use, manifest):
    """``menus-and-case-lists/module-with-is-training-module-true-training-menu-root-training``."""
    at, module = _module_of_detail(use)
    return None if module is None else bool(module.get("is_training_module"))


def custom_assertions_non_empty(use, manifest):
    """``menus-and-case-lists/custom-assertions-module-non-empty``."""
    at, module = _module_of_detail(use)
    return None if module is None else bool(module.get("custom_assertions"))


def _parent_select_reader(test, *, missing=False):
    """A reader of an active parent selection's target; ``missing`` is its answer for a ``module_id`` that names no
    menu of the app."""

    def reader(use, manifest):
        at, module = _module_of_detail(use)
        if module is None:
            return None
        parent = module.get("parent_select") or {}
        if not parent.get("active"):
            return False
        target = at.app.modules_by_id.get(parent.get("module_id"))
        if target is None:
            return missing
        return test(at, module, target)

    return reader


# A module_id naming no menu is an invalid candidate, which the entry names beside a multi-select one (and HQ's build
# refuses as ``invalid parent select id``, which the bar reports as well).
names_a_multi_select_module = _parent_select_reader(lambda at, module, target: _multi_select(target), missing=True)
names_a_multi_select_module.__doc__ = """
``menus-and-case-lists/parent-select-module-id-naming-a-multi-select-module-or-an``: an active parent selection
naming a multi-select module, which the editor never offers (an invalid candidate and a cycle are HQ's build's:
``invalid parent select id``, ``parent cycle``)."""


def _survey_parent(at, module, target):
    if target.get("case_type"):
        return False
    if (module.get("case_list") or {}).get("show") or any(_requires(form) == "case" for form in _forms(module)):
        return True
    return None  # the chain of another module's parent selection through this one


names_a_survey_module = _parent_select_reader(_survey_parent)
names_a_survey_module.__doc__ = (
    """``menus-and-case-lists/parent-select-naming-a-survey-module-on-a-child-that-shows-its``."""
)


def _max_select_number(value):
    """A list's ``max_select_value`` as Nova's reader reads it (``caseList/details.ts::readSelection``): a number,
    False for null (HQ's model's ``None``, for which HQ's build writes no ``max-select-value`` and Core takes 100), and
    None for any other value, which HQ's model refuses as it wraps the app (``IntegerProperty``, an
    ``AssertTypeProperty``), so no source HQ serves holds it and the reader leaves it unclaimed."""
    if value is None:
        return False
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def zero_or_below_minus_one(use, manifest):
    """``menus-and-case-lists/detail-max-select-value-of-0-or-below-1-on-a-multi-select-basic``: a
    multi-select basic case list whose ``max_select_value`` is 0 or below -1; in a suite, an instance datum's
    ``max-select-value`` of 0 or below -1."""
    at = use.at
    if isinstance(at, XmlAt) and at.document.kind == "runtime":
        value = at.element.get("max-select-value")
        try:
            number = int(value)
        except (TypeError, ValueError):
            return None
        return number == 0 or number < -1
    at, module = _module_of_detail(use)
    if module is None:
        return None
    short = ((module.get("case_details") or {}).get("short")) or {}
    if (module.get("doc_type") or "Module") != "Module" or not short.get("multi_select"):
        return False
    value = _max_select_number(short.get("max_select_value"))
    if value is None or value is False:
        return value
    return value == 0 or value < -1


def fails_filter_xpath_check(use, manifest):
    """``menus-and-case-lists/detail-filter-failing-etree-xpath-dummy-filter``: in a basic or shadow module
    HQ's build refuses it (``invalid filter xpath``), which the bar reports; in an advanced module, a filter
    Core cannot parse, which the observation reads only where the filter's text is an expression it parsed
    (None otherwise)."""
    at, module = _module_of_detail(use)
    if module is None:
        return None
    if (module.get("doc_type") or "Module") != "AdvancedModule":
        return False
    detail = at.nearest("Detail") or {}
    text = detail.get("filter")
    if not text:
        return False
    parsed = at.app.parsed(text)
    return None if parsed is None else "error" in parsed


# Case search in a suite ----------------------------------------------------------


@cache
def _reserved_request_keys(manifest):
    """The prompt names HQ takes as request configuration rather than a search
    (``case-search/a-prompt-that-reaches-hq-as-its-own-key-named-as-a-config-keys``): each
    ``CONFIG_KEYS_MAPPING`` key and value and ``CASE_SEARCH_TAGS_MAPPING`` key, as the surface's ``csql-key``
    items record them, and ``include_closed``, ``commcare_blacklisted_owner_ids``, ``commcare_project`` and
    ``_xpath_query``."""
    keys = {"include_closed", "commcare_blacklisted_owner_ids", "commcare_project", "_xpath_query"}
    for name in manifest.family("csql-key"):
        item = manifest.item(f"csql-key:{name}") or {}
        roles = set(item.get("roles") or ())
        if roles & {"configuration", "tag"}:
            keys.add(name)
        if item.get("configField"):
            keys.add(item["configField"])
    return frozenset(keys)


def reserved_request_key(use, manifest):
    """A prompt whose name HQ reads as request configuration, a tag, an ignored key, the owner exclusion, the
    project, CSQL or a reverse-index filter (``indices.<identifier>``)."""
    at = use.at
    if isinstance(at, XmlAt) and at.document.kind == "runtime":
        name = at.element.get("key")
    else:
        at = _json(use)
        prompt = at.nearest("CaseSearchProperty") if at is not None else None
        if prompt is None:
            return None
        name = prompt.get("name")
    if not name:
        return False
    return name in _reserved_request_keys(manifest) or str(name).startswith("indices.")


def _instance_in(use):
    """The suite ``<instance>`` a use sits on and the ``<entry>`` that declares it, or (instance, None)."""
    at = _xml(use, "runtime")
    if at is None or _local(at.element) != "instance":
        return None, None
    node = at.element.getparent()
    while node is not None and _local(node) not in ("entry", "remote-request", "detail", "menu"):
        node = node.getparent()
    return at.element, (node if node is not None and _local(node) == "entry" else None)


def _entry_loads_query(entry, storage, before_detail=None):
    """The named storage loaded by the session before it shows a detail or opens the form."""
    session = next((child for child in _children(entry) if _local(child) == "session"), None)
    if session is None:
        return False
    for step in _children(session):
        if before_detail and step.get("detail-select") == before_detail:
            break
        if _local(step) == "query" and step.get("storage-instance") == storage:
            return True
    return False


def _instance_reads(use):
    """The expression a use of an instance's scheme sits on, in a form or an app JSON's slot, where HQ's build
    reads each instance id it holds (``models/forms.py``'s ``add_missing_instances``, and the suite it writes from
    a slot): its document and the ids its paths read from ``instance()``, by Core's parse of it. (None, None) for a
    use on no such expression (a suite's declaration); (document, None) where the records hold no parse of it."""
    document, text = _expression_at(use)
    if document is None or document.kind == "runtime" or text is None:
        return None, None
    parsed = document.parsed(text)
    if parsed is None or "error" in parsed:
        return document, None
    return document, {path["instance"] for path in parsed["instancePaths"]}


def _form_entries(form):
    """Each ``<entry>`` of the suites the check reads beside a form (``Form.entry_suites``) that opens it (its
    ``<form>`` names the form's namespace)."""
    if form.xmlns is None:
        return []
    return [
        entry
        for suite in form.entry_suites
        for entry in _children(suite)
        if _local(entry) == "entry"
        and any(_local(child) == "form" and (child.text or "").strip() == form.xmlns for child in _children(entry))
    ]


def _command_literal(command):
    """The command a stack frame's ``<command>`` names: its ``value``'s one string literal, read through Core's
    lexer, or None where it names its value otherwise."""
    found = xpath_tokens(command.get("value") or "")
    return found[0].text[1:-1] if found is not None and len(found) == 1 and found[0].kind == "STR" else None


def _frame_commands(frame):
    """The command each ``<command>`` of a stack frame names, in order (``_command_literal``)."""
    return [_command_literal(command) for command in _children(frame) if _local(command) == "command"]


def _entries_showing(root, detail_id):
    """Each ``<entry>`` or ``<remote-request>`` of a suite one of whose datums shows the detail ``detail_id`` as its
    list: a ``<datum>``, or the ``<instance-datum>`` of a list that selects several cases
    (``suite_xml/xml_models.py::InstanceDatum``, which ``Entry.all_datums`` reads beside ``<datum>``)."""
    return [
        entry
        for entry in _children(root)
        if _local(entry) in ("entry", "remote-request")
        and any(
            isinstance(datum.tag, str)
            and _local(datum) in ("datum", "instance-datum")
            and datum.get("detail-select") == detail_id
            for datum in entry.iter()
        )
    ]


def _reached_without_a_query(entry, storage):
    """Whether a suite opens an entry's form with no query for the requested storage on the session's frame (True), only after one (False),
    or does not say (None).

    Core opens the form from the frame the session is in when the entry's last step is met. A menu's command
    begins that frame and the entry's own session fills it, and a stack's ``<create>`` begins a frame of its own
    steps (``CommCareSession.processStackOp``, ``createFrame``), so either holds a query only where the entry's
    session or the frame's steps before the command hold one. A ``<push>`` adds its steps to the frame the session
    is in (``performPush``): a case list's action, HQ's Register action after an empty search among them
    (``suite_xml/sections/details.py::get_case_list_form_action``, a ``PushFrame``), pushes onto the frame of the
    entry or search whose datum shows that list, which holds its query where that one's session does; a push
    anywhere else is not read here. A menu held off the menu (``_puts_off_the_menu``) offers its commands to no
    one. Where the suite reaches the entry by none of these, it does not say how the form opens, and the entry's
    own session is read."""
    root = entry.getparent()
    command = _command_id(entry)
    if root is None or command is None:
        return not _entry_loads_query(entry, storage)
    own = _entry_loads_query(entry, storage)
    verdicts = set()
    for menu in _children(root):
        if _local(menu) != "menu" or not any(
            _local(child) == "command" and child.get("id") == command for child in _children(menu)
        ):
            continue
        off = _puts_off_the_menu(menu.get("relevant"))
        if off is None:
            verdicts.add(None)
        elif not off:
            verdicts.add(not own)
    for frame in root.iter():
        if not isinstance(frame.tag, str) or _local(frame) not in ("create", "push"):
            continue
        names = _frame_commands(frame)
        if command not in names:
            if None in names:
                verdicts.add(None)
            continue
        if _local(frame) == "create":
            queried = False
            for step in _children(frame):
                if _local(step) == "command" and _command_literal(step) == command:
                    break
                queried = queried or (_local(step) == "query" and step.get("id") == storage)
            verdicts.add(not (own or queried))
            continue
        detail = next((at for at in frame.iterancestors() if _local(at) == "detail"), None)
        if detail is None:
            verdicts.add(None)
            continue
        showing = _entries_showing(root, detail.get("id"))
        verdicts.update(not (own or _entry_loads_query(shown, storage, detail.get("id"))) for shown in showing)
    if True in verdicts:
        return True
    if None in verdicts:
        return None
    return False if verdicts else not own


def non_inline_search_form(prefix):
    source_prefix = "jr://instance/search-input/" if prefix == "search-input" else "jr://instance/remote/"

    def storage_id(instance_id, source):
        if source and source.startswith(source_prefix):
            return source[len(source_prefix):]
        if instance_scheme(instance_id) == prefix:
            if prefix == "results":
                return instance_id
            return instance_id.partition(":")[2] or None
        return None

    def reader(use, manifest):
        document, read = _instance_reads(use)
        if document is not None:
            if document.kind != "xform":
                return False
            if read is None:
                return None
            sources = dict(document.declared_instances)
            storage = {value for instance_id in read if (value := storage_id(instance_id, sources.get(instance_id)))}
            if not storage:
                return False
            entries = _form_entries(document)
            if not entries:
                return None
            verdicts = {_reached_without_a_query(entry, value) for entry in entries for value in storage}
            return True if True in verdicts else None if None in verdicts else False
        instance, entry = _instance_in(use)
        if instance is None:
            return None
        storage = storage_id(instance.get("id") or "", instance.get("src"))
        if entry is None or storage is None:
            return False
        return _reached_without_a_query(entry, storage)

    reader.__doc__ = (
        f"An ``{prefix}`` instance a form's entry declares, or a form's expression reads, where the suite opens the"
        " form with no query on the session's frame (``_reached_without_a_query``): reached through a search that"
        " is not inline, the search's ``<rewind>`` drops the step that loads it"
        " (``SessionFrame.rewindToMarkAndSet``). A form HQ's Register action opens after an empty inline search"
        " (the no-matches form, in a menu held off the menu) is pushed onto the searching entry's frame, which holds"
        " the query. An app JSON's slot is evaluated outside a form."
    )
    return reader


# The sources a ``locations`` instance takes: HQ's hierarchical fixture, and its flat one; and the flag under which
# HQ's build chooses the hierarchical one (``corehq/toggles/__init__.py::HIERARCHICAL_LOCATION_FIXTURE``).
HIERARCHICAL_LOCATIONS = "jr://fixture/commtrack:locations"
FLAT_LOCATIONS = "jr://fixture/locations"
HIERARCHICAL_LOCATION_FIXTURE = "HIERARCHICAL_LOCATION_FIXTURE"


def _locations_source(source):
    if source == HIERARCHICAL_LOCATIONS:
        return True
    if source == FLAT_LOCATIONS:
        return False
    return None


def hierarchical_locations(use, manifest):
    """``expressions-and-data/commtrack-locations-hierarchical``: a ``locations`` instance a suite declares from
    HQ's hierarchical fixture, ``jr://fixture/commtrack:locations``, which HQ chooses only under
    ``HIERARCHICAL_LOCATION_FIXTURE`` with the flat fixture off
    (``suite_xml/post_process/instances.py::location_fixture_instances``), or a form's expression reading an
    instance its form declares from it. The flat ``jr://fixture/locations`` is not, and another source is not this
    class's to say (None). An app JSON slot's read takes the source HQ's build chooses as it writes the suite: the
    flat one in a project space without ``HIERARCHICAL_LOCATION_FIXTURE``, by the configurations the app was sent
    under (``App.configurations``), and with the flag on, the one its location settings choose, which no export
    carries (None)."""
    document, read = _instance_reads(use)
    if document is not None and document.kind == "app":
        if read is None or not any(instance_id.split(":", 1)[0] == "locations" for instance_id in read):
            return None if read is None else False
        configurations = document.configurations
        if configurations is None or any(HIERARCHICAL_LOCATION_FIXTURE in each.flags for each in configurations):
            return None
        return False
    if document is not None:
        if read is None:
            return None
        declarations = dict(document.declared_instances)
        if isinstance(document, Form) and read - set(declarations):
            declarations = {**document.working_instances, **declarations}
        verdicts = {
            _locations_source(source) for instance_id, source in declarations.items() if instance_id in read
            and source in (FLAT_LOCATIONS, HIERARCHICAL_LOCATIONS)
        }
        if True in verdicts:
            return True
        return False if verdicts == {False} else None
    instance, _ = _instance_in(use)
    if instance is None:
        return None
    return _locations_source(instance.get("src"))


def legacy_after_query(use, manifest):
    """``expressions-and-data/legacy-search-input-read-after-the-query-in-the-results-detail``: the legacy
    bare ``search-input`` instance declared by a form's entry or a detail, read after the query; in an app JSON, a
    case list column's or filter's read of it, or a form link's, which HQ's build writes into a detail and an
    entry's stack. A form's own read is the form's class, and a display condition's is a menu's."""
    document, read = _instance_reads(use)
    if document is not None:
        if document.kind != "app":
            return False
        if read is None:
            return None
        at = use.at
        return "search-input" in read and at.nearest("Detail", "FormLink", "FormDatum") is not None
    at = _xml(use, "runtime")
    if at is None or _local(at.element) != "instance":
        return None
    if at.element.get("id") != "search-input":
        return False
    node = at.element.getparent()
    while node is not None and _local(node) not in ("entry", "detail", "remote-request"):
        node = node.getparent()
    return node is not None and _local(node) in ("entry", "detail")


def runtime_query_structure(use, manifest):
    """``case-search/property-names-operators-or-function-names-computed-at-runtime``: an ``_xpath_query``
    whose CSQL holds a value only the run time knows where a property or function name stands: HQ's CSQL
    parser reads the hole Core's reading leaves there (``proof.observe.manifest.CSQL_HOLE``) as a
    comparison's property or a call's name. A hole spliced in unquoted anywhere but on a comparison's value
    side may stand for either, which the reading does not tell (None)."""
    at = _json(use)
    if at is None:
        return None
    entry = at.nearest("DefaultCaseSearchProperty")
    if entry is None or entry.get("property") != "_xpath_query":
        return False
    readings = at.app.readings
    strings = readings.strings.get(entry.get("defaultValue")) if readings is not None else None
    if strings is None or "error" in strings:
        return None
    unsure = False
    for string in strings["strings"]:
        reading = readings.csql.get(string) or ()
        comparisons = [item for item in reading if item[0] == "cmp"]
        if any(item[2] == "hole" for item in comparisons) or any(
            item[0] == "fn" and item[1] in CSQL_HOLES for item in reading
        ):
            return True
        steps = sum(1 for item in reading if item[0] == "step" and item[1] in CSQL_HOLES)
        unsure = unsure or steps > sum(1 for item in comparisons if item[3] == "hole")
    return None if unsure else False


def _comparisons(use):
    at = use.at
    if not isinstance(at, CsqlAt):
        return None
    return [item for item in at.reading if item[0] == "cmp"]


def _typed_value(side, manifest):
    """Whether HQ's comparison reads a value side as a number, date or datetime (True), as other text (False),
    or as a value only the run time knows, which the export does not settle (None): a call to one of HQ's
    value functions that gives a date, datetime or number is typed (``XPATH_VALUE_FUNCTIONS``), and so is the
    device's today(), which the run time always writes as a date (``hole-date``)."""
    if side in ("number", "date", "datetime", "hole-date"):
        return True
    if side in ("text", "invalid-date"):
        return False
    if side.startswith("function:"):
        name = side.split(":", 1)[1]
        item = manifest.item(f"csql-fn:{name}") or {}
        return True if item.get("kind") == "value" and name != "unwrap-list" else None
    return None


@cache
def _datetime_metadata(manifest):
    return {
        name
        for name in manifest.family("csql-metadata")
        if (manifest.item(f"csql-metadata:{name}") or {}).get("isDatetime")
    }


def untyped_right_side(use, manifest):
    """``case-search/p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of``: a property compared by
    ``>``, ``>=``, ``<`` or ``<=`` with a value HQ reads as neither a number, a date nor a datetime
    (``comparison.py::case_property_range_query``); a date-time metadata property is the next row's. Read
    on the operator's use, over the comparisons of its string that use it."""
    comparisons = _comparisons(use)
    if comparisons is None:
        return None
    op = use.key.split(":", 1)[1]
    metadata = _datetime_metadata(manifest)
    verdicts = [
        _typed_value(right, manifest)
        for cmp, operator, left, right in comparisons
        if operator == op and left.startswith("step:") and left.split(":", 1)[1] not in metadata
    ]
    if any(verdict is False for verdict in verdicts):
        return True
    return None if any(verdict is None for verdict in verdicts) else False


# HQ's value functions that give a date or datetime (xpath_functions/value_functions.py, XPATH_VALUE_FUNCTIONS).
DATE_FUNCTIONS = frozenset(
    f"function:{name}" for name in ("date", "date-add", "datetime", "datetime-add", "now", "today")
)


def non_date_value(use, manifest):
    """``case-search/date-opened-closed-on-or-last-modified-compared-with-any``: a date-time metadata property
    (``date_opened``, ``closed_on``, ``last_modified``) compared with a value HQ reads as neither a date nor a
    datetime (``comparison.py::_create_system_datetime_query``); read on the metadata's use."""
    comparisons = _comparisons(use)
    if comparisons is None:
        return None
    name = use.key.split(":", 1)[1]
    verdicts = []
    for _, _, left, right in comparisons:
        if left != f"step:{name}":
            continue
        typed = _typed_value(right, manifest)
        verdicts.append(None if typed is None else right in ("date", "datetime") or right in DATE_FUNCTIONS)
    if any(verdict is False for verdict in verdicts):
        return True
    return None if any(verdict is None for verdict in verdicts) else False


# More case list, form and media readers ---------------------------------------------------


def sort_type_index(use, manifest):
    """``menus-and-case-lists/type-index-cache-and-index-order-2``: a sort element of ``type: index``."""
    at = _json(use)
    if at is None:
        return None
    sort = at.nearest("SortElement")
    return None if sort is None else sort.get("type") == "index"


def fixture_value(use, manifest):
    """``forms-and-case-writes/form-filter-using-fixture-value``: a form filter reading ``$fixture_value``,
    as HQ's own reader finds it: by the text, which ``xpath.py::interpolate_xpath`` replaces wherever it
    stands."""
    at, form = _form(use)
    if form is None:
        return None
    return "$fixture_value" in (form.get("form_filter") or "")


def android_verified_path_without_entry(use, manifest):
    """``expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install``: a media reference
    with no file on a slot Android's install verification checks, in an app that turns that verification on
    (``profile.properties.cc-content-valid`` = ``no``, "Validate Multimedia",
    ``commcare-profile-settings.yml``). With the verification off no reference is in the class. With it on,
    whether a reference has its file is decided from the media the export carries beside the app, Nova's local
    archive (``proof.observe.manifest.media_facts``, read as ``_media`` reads it): a reference whose file the
    archive holds at its path is not in the class, and one whose file it lacks is; without the observation's
    readings the export does not say."""
    at = _json(use)
    if at is None:
        return None
    properties = ((at.app.doc.get("profile") or {}).get("properties")) or {}
    if properties.get("cc-content-valid") != "no":
        return False
    readings = at.app.readings
    if readings is None:
        return None
    item = at.nearest("HQMediaMapItem")
    references = at.app.doc.get("multimedia_map") or {}
    paths = [path for path, value in references.items() if item is None or value is item]
    return any(not path.startswith(MEDIA_PREFIX) or path[len(MEDIA_PREFIX) :] not in readings.media for path in paths)


def media_reference_drawn_without_entry(use, manifest):
    """``expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws``: a media reference
    with no ``multimedia_map`` entry on a slot a runtime draws. Web Apps draws a question's label or help
    audio or video (``form_entry/multimedia.html`` and ``help_multimedia.html``: ``visible: caption_audio``,
    ``caption_video``, ``help_audio``, ``help_video``), so such a reference in an app with Web Apps
    (``cloudcare_enabled``) is in the class. Web Apps also draws a broken picture for a case list image
    column's picture with no entry: the cell's ``<img>`` has no address and, for its alternative text, what
    HQ's build writes for the value (``case_list/item.html``), a no-break space where the app gives none
    (``commcare_translations.py::dumps``), from CommCare 2.54 (``feature_support.py::supports_alt_text``), so
    such a column in an app with Web Apps at a version that writes it is in the class, and one whose
    ``build_spec`` names no version this reads is not said. Android draws every medium of a question's label or
    help, of a choice, and a case list image column's picture (``MediaLayout.showMissingMediaView``,
    ``setupStandardAudio``, ``EntityView.setupImageLayout``), and whether an app declares Android is no part of
    its export, so such a reference on Android's slots alone is not said. A reference every slot of which no
    runtime draws (a hint, a validation message, a menu's or a form's icon) stands with the INERT row, and an
    app whose every reference has its entry holds none in the class. A form's itext is placed by what its
    questions name it with (``Form.itext_references``), which the observation's readings hold."""
    at = _json(use)
    if at is None:
        return None
    mapped = set(at.app.doc.get("multimedia_map") or {})
    web_apps = bool(at.app.doc.get("cloudcare_enabled"))
    unsaid = False
    for form in at.app.forms.values():
        kinds, unplaced = form.itext_references
        for translation in form.translations:
            for text in _children(translation):
                if _local(text) != "text":
                    continue
                for value in _children(text):
                    medium = value.get("form")
                    if _local(value) != "value" or medium not in ("image", "audio", "video", "video-inline"):
                        continue
                    path = (value.text or "").strip()
                    if not path or path in mapped:
                        continue
                    held = kinds.get(text.get("id"))
                    if held is None:
                        unsaid = unsaid or unplaced
                        continue
                    if web_apps and medium in ("audio", "video") and held & {"label", "help"}:
                        return True
                    if held & {"label", "help", "choice"}:
                        unsaid = True
    spec = at.app.doc.get("build_spec")
    version = _version(spec.get("version")) if isinstance(spec, dict) and spec.get("version") else None
    for module in at.app.modules:
        details = module.get("case_details") or {}
        for screen in ("short", "long"):
            for column in (details.get(screen) or {}).get("columns") or []:
                if not isinstance(column, dict) or column.get("format") != "enum-image":
                    continue
                if any(path not in mapped for path in _media_paths(column.get("enum"))):
                    if web_apps and version is not None and version >= ALT_TEXT_FROM:
                        return True
                    unsaid = True
    return None if unsaid else False


# The CommCare version from which HQ's build writes an image column's alternative text
# (feature_support.py::supports_alt_text).
ALT_TEXT_FROM = (2, 54)


def _media_paths(value):
    """Every string under ``value`` that names a file under ``jr://file/``."""
    if isinstance(value, str):
        return [value] if value.startswith(MEDIA_PREFIX) else []
    if isinstance(value, dict):
        return [path for item in value.values() for path in _media_paths(item)]
    if isinstance(value, list):
        return [path for item in value for path in _media_paths(item)]
    return []


# Media ----------------------------------------------------------------------------

MEDIA_PREFIX = "jr://file/"


# What ``_media`` gives for an item of the app HQ made whose path HQ holds no file at: a format class takes no
# such item.
NO_FILE = object()


def _media(use):
    """What the file a ``media-class`` use's multimedia map item names is (``proof.observe.manifest.
    media_facts``): in the app HQ made, the file HQ holds at the item's path (``Readings.authored_media``), or
    ``NO_FILE`` where HQ holds none there (a starter app's template maps a path its own media list leaves out, and
    HQ's media view answers 404 for it, ``hqmedia/views.py::ViewMultimediaFile``); and in an app Nova sends, the
    file Nova's local archive carries at the reference's path. None where the readings do not say."""
    at = _json(use)
    if at is None:
        return None
    item = at.nearest("HQMediaMapItem")
    readings = at.app.readings
    if item is None or readings is None:
        return None
    references = at.app.doc.get("multimedia_map") or {}
    path = next((key for key, value in references.items() if value is item), None)
    if path is None:
        return None
    if at.app.authored:
        return readings.authored_media.get(path, NO_FILE)
    if not path.startswith(MEDIA_PREFIX):
        return None
    return readings.media.get(path[len(MEDIA_PREFIX) :])


def _video_tracks(iso):
    return [track for track in iso["tracks"] if track["handler"] == "vide"]


def tiff_heif(use, manifest):
    """``expressions-and-data/image-tiff-heif``: an image HQ classifies as TIFF or HEIF."""
    facts = _media(use)
    if facts is None or facts is NO_FILE:
        return None if facts is None else False
    return facts["mime"] in ("image/tiff", "image/heif", "image/heic", "image/heif-sequence", "image/heic-sequence")


def svg_image(use, manifest):
    """``expressions-and-data/image-svg``: an image HQ classifies as SVG, which it cannot store."""
    facts = _media(use)
    if facts is None or facts is NO_FILE:
        return None if facts is None else False
    return facts["mime"] == "image/svg+xml"


# The WAV format code of integer PCM (WAVE_FORMAT_PCM).
WAVE_FORMAT_PCM = 1


def other_wav(use, manifest):
    """``expressions-and-data/audio-wav-that-is-not-8-or-16-bit-pcm``: a WAV whose ``fmt`` chunk holds another
    codec, or PCM of another sample size, which Android does not play."""
    facts = _media(use)
    if facts is None or facts is NO_FILE:
        return None if facts is None else False
    wav = facts.get("wav")
    if "wav" not in facts:
        return False
    return wav is None or wav["format"] != WAVE_FORMAT_PCM or wav["bits"] not in (8, 16)


def audio_3gp(use, manifest):
    """``expressions-and-data/audio-3gp``: a 3GP file with no video track (``ftyp`` brand ``3g…``), which HQ
    classifies as video."""
    facts = _media(use)
    if facts is None or facts is NO_FILE:
        return None if facts is None else False
    iso = facts.get("iso")
    return iso is not None and str(iso["brand"]).startswith("3g") and not _video_tracks(iso)


def audio_m4a_other_brand(use, manifest):
    """``expressions-and-data/audio-m4a-with-another-brand-isom-mp41-mp42-dash``: an MPEG-4 file with no video
    track whose brand is ``isom``, ``mp41``, ``mp42`` or ``dash``, which HQ classifies as video."""
    facts = _media(use)
    if facts is None or facts is NO_FILE:
        return None if facts is None else False
    iso = facts.get("iso")
    return iso is not None and iso["brand"] in ("isom", "mp41", "mp42", "dash") and not _video_tracks(iso)


def av1_mov_avi_theora_h263(use, manifest):
    """``expressions-and-data/video-av1-mov-avi-ogg-theora-h-263-3gp``: an AV1 video track, a QuickTime file
    (``ftyp`` brand ``qt``), an AVI (as HQ classifies it), Theora in Ogg, or an H.263 track."""
    facts = _media(use)
    if facts is None or facts is NO_FILE:
        return None if facts is None else False
    iso = facts.get("iso")
    if iso is not None:
        codecs = {codec for track in _video_tracks(iso) for codec in track["codecs"]}
        return iso["brand"] == "qt  " or bool(codecs & {"av01", "s263", "h263"})
    if facts.get("ogg") is not None:
        return facts["ogg"]["theora"]
    return facts["mime"] in ("video/x-msvideo", "video/avi")


# Data nodes as Vellum's parser reads them ------------------------------------------


# Vellum's Question ID rule (util.js::isValidElementName, a JavaScript test whose ``\w`` is ASCII), which
# baseSpecs.js's ``nodeID`` check reads with ``meta`` in any case refused beside it.
VELLUM_ELEMENT_NAME = re.compile(r"(?!XML)[a-zA-Z][A-Za-z0-9_-]*")
# The characters JavaScript's ``.`` does not match (its LineTerminators).
JS_LINE_TERMINATORS = frozenset("\n\r\u2028\u2029")
# JavaScript's ``\s`` (the ECMAScript WhiteSpace and LineTerminator characters), which Vellum's choice value test
# reads (mugs/types/select.js: ``/\s/.test(mug.p.nodeID)``).
JS_WHITESPACE = frozenset("\t\n\v\f\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff") | frozenset(
    map(chr, range(0x2000, 0x200B))
)


def _data_node(use):
    """The main-instance element below the data root an instance-content use sits on, with its form; (form, None)
    for a use on any other element; (None, None) outside an XForm."""
    form, element = _form_element(use)
    if form is None:
        return None, None
    if element is form.data_root or not _under(element, form.data_root):
        return form, None
    return form, element


def _under(element, ancestor):
    while element is not None:
        if element is ancestor:
            return True
        element = element.getparent()
    return False


def _path_of(form, element):
    """A main-instance element's path, by the local names from the data root down (two siblings of one name share
    it, which ``Form.paths`` keeps for the first alone)."""
    steps = []
    while element is not None and element is not form.data_root:
        steps.append(_local(element))
        element = element.getparent()
    return "/" + "/".join([_local(form.data_root), *reversed(steps)])


def _node_name(element):
    """An element's DOM ``nodeName``, which Vellum's parser takes as its question's id (``parser.js``:
    ``el.nodeName``): its prefix and local name."""
    return f"{element.prefix}:{_local(element)}" if element.prefix else _local(element)


# The names Vellum's parser finds by bare element name at any depth, so a form holding one never opens
# (``parser.js``, and jQuery's ``parseXML``, which takes any ``parsererror`` element for its own parse failure);
# ``lib/domain/questionId.ts::FORM_SOURCE_READER_NAMES``.
NEVER_OPENED = frozenset({"instance", "bind", "parsererror"})


def _question_node(use):
    """The data node a question id use sits on, with its form: a node Vellum's parser makes a question of
    (``Form.vellum_nodes``); ``(form, None)`` for any other element, ``(None, None)`` outside an XForm."""
    form, element = _data_node(use)
    if form is None:
        return None, None
    if element is None or element not in form.vellum_nodes:
        return form, None
    return form, element


def invalid_question_id(use, manifest):
    """``questions/question-id-failing-the-grammar-or-meta-in-any-case``: a data node Vellum's parser makes a
    question of (``Form.vellum_nodes``) whose name fails Vellum's Question ID rule or is ``meta`` in any case
    (``baseSpecs.js``'s ``nodeID`` validation, ``util.js::isValidElementName``), or is ``instance``, ``bind`` or
    ``parsererror``, which HQ's form builder cannot open a form holding (``NEVER_OPENED``), as Nova's reader reads
    each question's data node (``lib/commcare/reader/xform/join.ts``'s question id rule over
    ``questionId.ts::questionIdProblem``)."""
    form, element = _question_node(use)
    if form is None:
        return None
    if element is None:
        return False
    name = _node_name(element)
    return VELLUM_ELEMENT_NAME.fullmatch(name) is None or name.lower() == "meta" or name in NEVER_OPENED


def _hq_primary_case(form):
    """Whether HQ appends its own primary case block (XForm._create_casexml).
    A project's registry support is an external fact, so a potential registry
    load cannot establish an HQ build collision from the form alone."""
    if form.app_form is None:
        return None
    app, stored = form.app_form
    if (stored.get("doc_type") or "Form") != "Form":
        return False
    actions = _actions(stored)
    requires = _requires(stored)
    opens = requires != "case" and _active(actions.get("open_case"))
    if opens:
        return True
    module = app.module_of(stored) or {}
    if requires == "none" or _multi_select(module):
        return False
    search = module.get("search_config") or {}
    if _offers_search(module) and search.get("data_registry") and search.get("data_registry_workflow") == "load_case":
        return None
    return (any(_active(actions.get(name)) for name in ("update_case", "close_case", "usercase_update"))
            or any((actions.get(name) or {}).get("preload") for name in ("case_preload", "usercase_preload", "load_from_form"))
            or any(_active(subcase) for subcase in _subcases(stored)))


def _hq_case_collision(form, node):
    return (node.getparent() is form.data_root and _node_name(node) == "case"
            and etree.QName(node).namespace in (etree.QName(form.data_root).namespace, CASE))


def submitted_case_answer(use, manifest):
    form, node = _data_node(use)
    if form is None:
        return None
    if node is None or _local(node).lower() != "case":
        return False
    if etree.QName(node).namespace == CASE and _local(node) == "case":
        return False
    if _hq_case_collision(form, node) and _hq_primary_case(form) is True:
        return False
    return not any(ancestor.tag == "{%s}case" % CASE for ancestor in node.iterancestors())


def ordinary_stock_answer(use, manifest):
    form, node = _data_node(use)
    if form is None:
        return None
    stock = "http://commcarehq.org/ledger/v1"
    if node is None or etree.QName(node).namespace != stock:
        return False
    return (_local(node) not in ("balance", "transfer") and node.get("{%s}role" % VELLUM) not in
            ("Balance", "Transfer", "Dispense", "Receive")
            and not any(etree.QName(a).namespace == stock or a.tag == "{%s}case" % CASE for a in node.iterancestors() if a is not form.data_root))


def unsupported_question_lock(use, manifest):
    at = use.at
    if at is None or not hasattr(at, "attribute") or at.attribute is None:
        return None
    if at.attribute != "{http://commcarehq.org/xforms/vellum}lock":
        return False
    if at.element.get(at.attribute) != "all":
        return True
    form, node = _data_node(use)
    if form is None or node is None:
        return False
    path = _path_of(form, node)
    bind = form.bind(path)
    return bool(form.question_controls(path)) and (bind is None or bind.get(at.attribute) != "all")


def namespace_the_designer_cannot_keep(use, manifest):
    """``questions/submitted-namespace-the-form-designer-cannot-keep``: a question's data node that declares its own
    namespace, unprefixed and other than its parent's, where Vellum keeps none: an explicit empty namespace (which
    Vellum's ``parseDataTree`` loses), or one on a question with a control or children (Vellum keeps an ``xmlns``
    only for a data-only value), as Nova's reader refuses it (``lib/commcare/reader/xform/join.ts::ownNamespace``,
    ``claimNode``). A node that inherits its parent's namespace is outside the class: every question of a form
    does."""
    form, node = _question_node(use)
    if form is None:
        return None
    if node is None or not use.key.endswith("@xmlns") or node.prefix is not None:
        return False
    parent = node.getparent()
    namespace = etree.QName(node).namespace
    if parent is None or namespace == etree.QName(parent).namespace:
        return False
    return namespace in (None, "") or bool(form.question_controls(_path_of(form, node))) or len(node) > 0


def sibling_with_one_name(use, manifest):
    """``questions/two-sibling-data-nodes-with-one-name``: a data node of the main instance beside another of the
    same name, so both answers share one submission path. A repeat's rows share their path by design (a body
    ``<repeat>``'s nodeset, or a ``jr:template``), and are outside the class."""
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None:
        return False
    same = [sibling for sibling in _children(element.getparent()) if sibling.tag == element.tag]
    if len(same) < 2:
        return False
    if _path_of(form, element) in form.repeat_paths:
        return False
    return not any(sibling.get(f"{{{JAVAROSA}}}template") is not None for sibling in same)


def nova_scaffolding_part(use, manifest):
    """The part of a REFUSED class a data node's use is: a node Nova generates, by its name with its minted part
    ``*`` (``compare.names.nova_name``: ``nova_operations``, ``nova_guard_*``, and the ``__nova_operations`` and
    ``__nova_guard_*`` the retained controls hold), which Nova emits whatever a person authors, apart from a node
    a person named; None for the latter, and where the use is on no data node. A person's node named like a
    generated family is read as that family."""
    _, element = _data_node(use)
    if element is None:
        return None
    return nova_name(_node_name(element))


def hidden_value_with_children(use, manifest):
    """``questions/hidden-value-with-children``: a data node Vellum's parser keeps a Hidden Value (its
    ``DataBindOnly`` mug: no data-node role it supports and no body control naming it, ``parser.js``) that holds
    element children, which that mug cannot hold (``validChildTypes`` is empty). HQ's question reader lists only
    leaves as hidden values (``xform.py::XForm._get_leaf_data_nodes``), so the class is read on the data node."""
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None or form.vellum_nodes.get(element, "") is not None or not _children(element):
        return False
    return not form.question_controls(_path_of(form, element))


def _relative_read(tree, context):
    """The node a relative location path with no predicate names from ``context``, its structure as HQ's XPath
    grammar reads it (the observation's ``trees``), or None for any other expression."""
    if not isinstance(tree, list) or tree[:2] != ["path", "relative"] or tree[3]:
        return None
    return _resolved(context, tree[4])


def _call_of(tree, name, arity):
    """A call's arguments, where ``tree`` is a call of ``name`` with ``arity`` arguments, else None."""
    if isinstance(tree, list) and tree[:2] == ["call", name] and len(tree[2]) == arity:
        return tree[2]
    return None


def _row_id_choice(tree, place, count, ids, context, *, whole):
    """Whether ``tree`` is ``if(<place> < <count>, selected-at(<ids>, <place>), '')``, the choice of a row's id a
    count placement writes: its count and ids read from ``context`` as the nodes ``count`` and ``ids``, the count as
    it stands or, where it is not ``whole``, through ``int()``, and its place one expression twice, which ``place``
    tells is the row's."""
    branches = _call_of(tree, "if", 3)
    if branches is None or branches[2] != ["text", ""]:
        return False
    test, chosen = branches[0], _call_of(branches[1], "selected-at", 2)
    if chosen is None or not isinstance(test, list) or test[:2] != ["binary", "<"] or chosen[1] != test[2]:
        return False
    bound = test[3] if whole else (_call_of(test[3], "int", 1) or [None])[0]
    return place(test[2]) and _relative_read(bound, context) == count and _relative_read(chosen[0], context) == ids


def _count_placement_row_id(form, element, path, bind, defaults):
    """Whether a Hidden Value with a calculate and a default is the id of a row of a query repeat's count placement,
    which the count repeat's own entry holds (``questions/count-repeat-whose-count-and-row-ids-come-from-one-query-a``,
    ``lib/commcare/xform/countPlacementRow.ts``): a child of a repeat's row (an element holding ``jr:template``, the
    nodeset of a body ``<repeat>`` whose ``jr:count`` names a node beside the row, its count), whose calculate is
    ``if(../<index> < ../../<count>, selected-at(../../<ids>, ../<index>), '')`` over another node of the row and a
    node beside the row, and whose one default, at ``jr-insert``, is ``if(position(..) < int(../../<count>),
    selected-at(../../<ids>, position(..)), '')``. The default and the calculate give a row one id, so no runtime
    reads a default its calculate does not give, as Nova's reader reads the row
    (``reader/xform/generated.ts::readQueryPlacement``). Each expression is read by its structure as HQ's XPath
    grammar reads it (the observation's ``trees``): None where the records hold none of one this decides by."""
    row = element.getparent()
    wrapper = row.getparent() if row is not None else None
    if wrapper is None or row is form.data_root or row.get(f"{{{JAVAROSA}}}template") is None:
        return False
    row_path, wrapper_path = form.paths.get(row), form.paths.get(wrapper)
    counted = [
        control
        for control in form.controls.get(row_path or "", [])
        if _local(control) == "repeat" and (control.get(f"{{{JAVAROSA}}}count") or "").strip()
    ]
    if row_path is None or wrapper_path is None or len(counted) != 1 or len(defaults) != 1:
        return False
    if (defaults[0].get("event") or "").split() != ["jr-insert"]:
        return False
    count_reads = _tree_reads(form, counted[0].get(f"{{{JAVAROSA}}}count"), row_path)
    if count_reads is None:
        return None
    count = count_reads[0] if len(count_reads) == 1 else None
    if count is None or count.rpartition("/")[0] != wrapper_path:
        return False
    calculate, default = form.tree(bind.get("calculate")), form.tree(defaults[0].get("value"))
    if calculate is None or default is None:
        return None
    branches = _call_of(calculate, "if", 3)
    chosen = _call_of(branches[1], "selected-at", 2) if branches is not None else None
    ids = _relative_read(chosen[0], path) if chosen is not None else None
    if ids is None or ids in (count, row_path) or ids.rpartition("/")[0] != wrapper_path:
        return False

    def row_place(tree):
        place = _relative_read(tree, path)
        return place is not None and place != path and place.rpartition("/")[0] == row_path

    def row_position(tree):
        held = _call_of(tree, "position", 1)
        return held is not None and _relative_read(held[0], path) == row_path

    return _row_id_choice(calculate, row_place, count, ids, path, whole=True) and _row_id_choice(
        default, row_position, count, ids, path, whole=False
    )


NESTING_CONTROLS = frozenset({"group", "repeat"})


def question_with_children(use, manifest):
    """``questions/a-question-other-than-a-group-or-repeat-whose-data-node-has``: a data node with element children
    that a body question control other than a group or repeat names (an input, a select, a label, an upload),
    whose mug takes no child (``mugs.js::isNestableGroup``; a select's Choice and Itemset children are
    control-only)."""
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None or not _children(element):
        return False
    return any(_local(control) not in NESTING_CONTROLS for control in form.question_controls(_path_of(form, element)))


def default_data_value(use, manifest):
    """``questions/default-data-value-datavalue-instance-text``: a data node Vellum's parser makes a question of
    that holds text in the form's instance, which it reads as the question's ``dataValue`` (``parser.js``:
    ``$el.children().length ? null : $el.text()``)."""
    form, element = _data_node(use)
    if form is None:
        return None
    return _instance_text_value(form, element) and not _attachment_answer(form, element)


def _instance_text_value(form, element):
    # Core's XFormParser.getXMLDocument drops text Java String.trim() makes empty. A no-break space survives.
    return (
        element is not None and element in form.vellum_nodes and not _children(element)
        and any(ord(char) > 0x20 for text in element.itertext() for char in text)
    )


def _attachment_answer(form, element):
    return any(
        _local(control) == "upload" and control.get("mediatype") in UPLOAD_MEDIATYPES
        for control in form.question_controls(_path_of(form, element))
    )


def hand_written_case_block(use, manifest):
    """``questions/hand-written-case-block-without-vellum-role-…``: a ``<case>`` block (HQ's case namespace) in a
    form's main instance whose parent is no SaveToCase node (``vellum:role="SaveToCase"``), a root ``/data/case``
    included. The blocks HQ's build writes into a form it builds are the build's, which a local archive carries
    and the source never does."""
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None or element.tag != f"{{{CASE}}}case":
        return False
    return element.getparent().get(f"{{{VELLUM}}}role") != "SaveToCase"


def attachment_in_save_to_case(use, manifest):
    """``questions/attachment-inside-a-savetocase-block``: an ``<attachment>`` element inside a SaveToCase node,
    which Vellum's SaveToCase never writes (it writes create, update, close and index, ``saveToCase.js``)."""
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None or _local(element) != "attachment":
        return False
    held = form.holder(element)
    return held is not None and held[0] == "save-to-case" and held[1] is not element


# The names a SaveToCase block's ``update`` row may hold that Nova reserves for a case's own facts or as a word in
# ``case-reserved-words.json`` (``lib/domain/standardCaseProperties.ts::FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES``,
# less the block's own rows ``case_type``, ``case_name`` and ``owner_id``); ``proof/ci/__tests__/manifestReaders.test.ts``
# holds it to that set.
SAVE_TO_CASE_RESERVED_UPDATE_KEYS = frozenset(
    {
        "actions",
        "case_id",
        "case_type_id",
        "closed",
        "closed_by",
        "closed_on",
        "commtrack",
        "computed_",
        "computed_modified_on_",
        "create",
        "date",
        "date_modified",
        "date_opened",
        "doc_type",
        "domain",
        "index",
        "indices",
        "initial_processing_complete",
        "last_modified",
        "modified_by",
        "modified_on",
        "name",
        "opened_by",
        "opened_on",
        "parent",
        "referrals",
        "server_modified_on",
        "server_opened_on",
        "status",
        "type",
        "user_id",
        "userid",
        "version",
        "xform_id",
        "xform_ids",
    }
)


def reserved_save_to_case_key(use, manifest):
    """``questions/savetocase-update-key-nova-reserves-for-a-case-s-own-facts``: a row of a SaveToCase node's own
    ``case/update`` whose name is one Nova reserves (``SAVE_TO_CASE_RESERVED_UPDATE_KEYS``), which HQ's form builder
    writes (``saveToCase.js::validatePropertyNameChars`` checks no reserved word) and HQ's build checks no key of."""
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None or _local(element) not in SAVE_TO_CASE_RESERVED_UPDATE_KEYS:
        return False
    update = element.getparent()
    case = update.getparent() if update is not None else None
    if update is None or update.tag != f"{{{CASE}}}update" or case is None or case.tag != f"{{{CASE}}}case":
        return False
    held = form.holder(element)
    return (
        held is not None
        and held[0] == "save-to-case"
        and case.getparent() is held[1]
        and held[1].get(f"{{{VELLUM}}}case_type") != "commcare-user"  # the worker's record's class
    )


# The keys of the worker's own case CommCare HQ's user-case sync writes from the worker's profile
# (``callcenter/sync_usercase.py::_get_user_case_fields``; ``lib/domain/usercase.ts::USERCASE_BUILT_IN_KEYS``).
USERCASE_BUILT_IN_KEYS = frozenset(
    {
        "case_name",
        "username",
        "email",
        "first_name",
        "last_name",
        "hq_user_id",
        "language",
        "phone_number",
        "last_device_id_used",
        "commcare_profile",
        "commcare_location_id",
        "commcare_location_ids",
        "commcare_primary_case_sharing_id",
        "commcare_project",
    }
)
# The names HQ's user data refuses for a field (``custom_data_fields/models.py::SYSTEM_FIELDS``;
# ``lib/domain/users.ts::USER_DATA_SYSTEM_FIELDS``) and the prefixes it refuses (``USER_DATA_RESERVED_PREFIXES``).
USER_DATA_SYSTEM_FIELDS = frozenset(
    {"commtrack-supply-point", "name", "type", "owner_id", "external_id", "hq_user_id", "user_type"}
)
USER_DATA_RESERVED_PREFIXES = frozenset({"commcare", "xml"})
# ``case-reserved-words.json`` with ``owner_id`` (``lib/commcare/constants.ts::RESERVED_CASE_PROPERTIES``), which HQ's
# user data also refuses (``CustomDataFieldsForm.verify_no_reserved_words``).
RESERVED_CASE_PROPERTIES = frozenset(
    {
        "actions",
        "case_id",
        "case_name",
        "case_type",
        "case_type_id",
        "closed",
        "closed_by",
        "closed_on",
        "commtrack",
        "create",
        "computed_",
        "computed_modified_on_",
        "date",
        "date_modified",
        "date_opened",
        "doc_type",
        "domain",
        "index",
        "indices",
        "initial_processing_complete",
        "last_modified",
        "modified_by",
        "modified_on",
        "opened_by",
        "opened_on",
        "owner_id",
        "parent",
        "referrals",
        "server_modified_on",
        "server_opened_on",
        "status",
        "type",
        "user_id",
        "userid",
        "version",
        "xform_id",
        "xform_ids",
    }
)
# The reserved words HQ's build refuses as a preloaded property's last step (``case-reserved-words.json``, and the two
# hyphenated spellings ``lib/commcare/constants.ts::HQ_CASE_RESERVED_WORDS`` adds), ``owner_id`` aside, which HQ reads
# as the case's ``@owner_id``.
HQ_CASE_RESERVED_WORDS = (RESERVED_CASE_PROPERTIES - {"owner_id"}) | {"date-opened", "external-id"}
# The children of every case Core's case database holds that Nova reads by the same element
# (``preloads.ts::CASE_CHILD_ELEMENTS``): the reserved words HQ's grammar admits only with a trailing newline.
CASE_CHILD_ELEMENTS = frozenset({"case_name", "date_opened", "last_modified"})
# A session-user field's name, which a worker-record read prints as an element
# (``lib/domain/externalUserProperty.ts::SESSION_USER_FIELD_PATTERN``).
SESSION_USER_FIELD = re.compile(r"[a-zA-Z_][-a-zA-Z0-9_]*")
# A worker property's slug (``lib/domain/users.ts::USER_PROPERTY_SLUG_PATTERN``, at most 127 characters), matched whole.
WORKER_PROPERTY_SLUG = re.compile(r"[a-zA-Z_][-a-zA-Z0-9_]{0,126}")
# HQ's property grammar on an action's key (``helpers/validators.py::validate_property``;
# ``basicActions.ts::HQ_PROPERTY``).
HQ_PROPERTY = re.compile(r"[a-zA-Z][\w-]*\n?")


def _no_worker_property(key):
    """Whether the worker's record takes no write to ``key`` (``lib/commcare/reader/worldEntities.ts::
    holdsWorkerRecordWrite``): a key HQ's user-case sync writes over, or a name no worker property takes. The two
    ``hq_user_id`` HQ's sync writes over, and ``location_id``, a worker property's slug, the record holds in its
    location column (``update-keys-location-id-hq-user-id``)."""
    lowered = key.lower()
    return (
        key in USERCASE_BUILT_IN_KEYS
        or WORKER_PROPERTY_SLUG.fullmatch(key) is None
        or lowered in USER_DATA_SYSTEM_FIELDS
        or lowered in RESERVED_CASE_PROPERTIES
        or any(lowered.startswith(prefix) for prefix in USER_DATA_RESERVED_PREFIXES)
    )


def _hq_build_refuses_key(key):
    """Whether HQ's build refuses an action's key: outside its grammar, or a word of ``case-reserved-words.json``
    (``update-key-failing-hq-s-grammar-or-in-case-reserved-words-json``, the bar's). ``name`` and ``owner_id`` it
    writes as the case's name and owner."""
    if key in ("name", "owner_id"):
        return False
    reserved = key in RESERVED_CASE_PROPERTIES or key in ("date-opened", "external-id")
    return reserved or HQ_PROPERTY.fullmatch(key) is None


def worker_record_key(use, manifest):
    """``forms-and-case-writes/a-write-of-the-worker-s-record-to-a-key-no-worker-property-takes``: a key of an active
    ``usercase_update``'s ``update``, or of a load auto-selected by ``usercase``'s ``case_properties``, that HQ's
    build writes and no worker property takes (``_no_worker_property``), and a row of a ``commcare-user`` SaveToCase
    node's own ``case/update`` whose name no worker property takes, its ``case_type`` row included (HQ's build
    checks no block's keys)."""
    at = _json(use)
    if at is not None:
        form = at.nearest(*FORMS)
        if form is None:
            return None
        action = at.nearest("UpdateCaseAction", "LoadUpdateAction")
        if action is None:
            return False
        if action is _actions(form).get("usercase_update"):
            keys = action.get("update") if _active(action) else None
        elif _auto_selected(action) and action["auto_select"].get("mode") == "usercase":
            keys = action.get("case_properties")
        else:
            return False
        return any(
            "/" not in key and not _hq_build_refuses_key(key) and _no_worker_property(key) for key in (keys or {})
        )
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None:
        return False
    update = element.getparent()
    case = update.getparent() if update is not None else None
    if update is None or update.tag != f"{{{CASE}}}update" or case is None or case.tag != f"{{{CASE}}}case":
        return False
    held = form.holder(element)
    if held is None or held[0] != "save-to-case" or case.getparent() is not held[1]:
        return False
    if held[1].get(f"{{{VELLUM}}}case_type") != "commcare-user":
        return False
    name = _local(element)
    return name == "case_type" or _no_worker_property(name)


def authored_meta_block(use, manifest):
    """``questions/authored-data-meta-block``: a child of the data root named ``meta`` in any case, in a source form
    (HQ's build replaces it with its own, ``xform.py::XForm._add_meta_2``)."""
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None or element.getparent() is not form.data_root:
        return False
    return _local(element).lower() == "meta"


def usercase_root_question(use, manifest):
    """``questions/a-root-question-commcare-usercase-in-a-form-with-usercase``: a child of the data root named
    ``commcare_usercase`` in a basic form whose usercase update is active with a property to write, beside which
    HQ's build appends its own ``commcare_usercase`` (``xform.py::XForm._add_usercase``, run by
    ``Form.add_stuff_to_xform`` alone, over ``active_actions``). Read on a form the app JSON carries, whose form
    object says it; a form outside an app JSON does not say: None."""
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None or element.getparent() is not form.data_root or _local(element) != "commcare_usercase":
        return False
    if form.app_form is None:
        return None
    _, form_json = form.app_form
    if (form_json.get("doc_type") or "Form") != "Form":
        return False
    action = _actions(form_json).get("usercase_update")
    return isinstance(action, dict) and _active(action) and bool(action.get("update"))


def _instance_element(use):
    form, element = _form_element(use)
    if form is None:
        return None, None
    if _local(element) != "instance" or element.getparent() is not form.model:
        return form, None
    return form, element


def inline_instance(use, manifest):
    """``expressions-and-data/inline-instance-content-inside-instance-no-src``: a secondary instance of the model
    (one after its main instance, with an ``id``) that names no ``src``, so its content is written inline."""
    form, element = _instance_element(use)
    if form is None:
        return None
    if element is None or element is form.model.find(f"{{{XFORMS}}}instance"):
        return False
    return element.get("src") is None


def unnamed_instances(use, manifest):
    """``expressions-and-data/more-than-one-instance-without-an-id``: an ``<instance>`` without an ``id`` after the
    form's first such instance, which Vellum refuses to open (``parser.js::_getInstances``, which finds every element
    named ``instance`` in the document, takes the first whose ``id`` is empty as the main instance and throws on a
    later one). The first is the form's main instance, which is not in the class where a later one is the model's
    own; where every later one is an element inside an instance's content (a data node named ``instance``), which
    is no use of the model's ``<instance>``, the class stands at the main instance, the one use the form makes of
    it."""
    form, element = _instance_element(use)
    if form is None:
        return None
    if element is None or element.get("id"):
        return False
    unnamed = [other for other in form.named_instance_elements if not other.get("id")]
    if len(unnamed) < 2:
        return False
    if element is not unnamed[0]:
        return True
    return not any(other.getparent() is form.model for other in unnamed[1:])


def supply_point_datum(use, manifest):
    """``expressions-and-data/session-data-supply-point-id-anywhere-except-…``: an expression reading the session's
    ``data/supply_point_id``, anywhere but in an advanced form one of whose computed datums has that id
    (``_supply_point_read``)."""
    reads, computed = _supply_point_read(use, manifest)
    return reads if not reads else (None if computed is None else not computed)


def _supply_point_read(use, manifest):
    """Whether an expression reads the session's ``data/supply_point_id``, and where it does, whether it stands in an
    advanced form one of whose computed datums has that id (``AdvancedForm.arbitrary_datums``); None where this does
    not say. Read from Core's parse of the expression (its instance paths through the session's instance,
    ``instance-source:session``). A suite does not say which form its expressions belong to: None there. An app JSON
    slot does: a form's display condition and its links are the form's, and a menu's display condition and its case
    list's filter and columns are no form's."""
    document, text, sessions = _session_reads(use, manifest)
    if document is None:
        return None, None
    parsed = document.parsed(text)
    if parsed is None or "error" in parsed:
        return None, None
    if not any(
        path["instance"] in sessions and path["steps"][:3] == ["session", "data", "supply_point_id"]
        for path in parsed["instancePaths"]
    ):
        return False, None
    if isinstance(use.at, JsonAt):
        form_json = use.at.nearest(*FORMS)
        if form_json is None:
            return True, False
    elif document.kind != "xform" or document.app_form is None:
        return True, None
    else:
        _, form_json = document.app_form
    datums = form_json.get("arbitrary_datums") or []
    return True, (
        form_json.get("doc_type") == "AdvancedForm"
        and any(isinstance(datum, dict) and datum.get("datum_id") == "supply_point_id" for datum in datums)
    )


# The session data paths with an item of their own, or a class of their own under ``session/data/*``.
_OWN_SESSION_DATA = frozenset({"stringquery", "fingerprintquery", "supply_point_id"})


def _session_ids(holder):
    """The ids a ``<session>``'s children write into the session's data, in order: a datum's or an instance
    datum's ``id``, a query's ``storage-instance`` (``SessionDatumParser``), each with its element."""
    session = next((child for child in _children(holder) if _local(child) == "session"), None)
    found = []
    for child in _children(session) if session is not None else ():
        datum_id = child.get("storage-instance") if _local(child) == "query" else child.get("id")
        if datum_id:
            found.append((datum_id, child))
    return found


def _entries_under(root, menu_id):
    """Each ``<entry>`` or ``<remote-request>`` a command of a menu with ``menu_id`` names: the entries Core
    asks the common datums of once that menu is chosen (``CommCareSession.getEntriesForCommand``)."""
    commands = {
        command.get("id")
        for menu in _children(root)
        if _local(menu) == "menu" and menu.get("id") == menu_id
        for command in _children(menu)
        if _local(command) == "command"
    }
    return [
        holder
        for holder in _children(root)
        if _local(holder) in ("entry", "remote-request")
        and any(_local(child) == "command" and child.get("id") in commands for child in _children(holder))
    ]


def _common_prefix(lists):
    """The longest run of ids every list starts with: the datums Core collects before a menu's items show
    (``CommCareSession.getDataNeededByAllEntries``, one datum at a time while every entry needs the same)."""
    if not lists:
        return []
    prefix = []
    for ids in zip(*lists, strict=False):
        if any(datum_id != ids[0] for datum_id in ids):
            break
        prefix.append(ids[0])
    return prefix


def _suite_supplied(document, element, sessions=frozenset()):
    """The session data ids set where a suite element's expressions run, or None where the suite does not say:
    inside an entry or a remote request, the ids its session writes (in a datum, only those before it), and inside
    a remote request also the ids the frame holds wherever its command is launched (``_launch_frames``); inside an
    entry's stack operation whose ``if`` holds a session value equal to a literal (``return_to = 'm1'``), also the
    ids every launch of the entry that sets that value holds (``_conditioned_supplied``); inside a menu, the ids
    every entry of the menu it shows in shares first (a menu's own condition shows it in its ``root``'s list, a
    command's in its own menu's); inside a detail, the ids written before each datum that shows it (through the
    datum, for a detail that stays on screen while the form runs), every such datum agreeing."""
    root = document.root
    chain = [element, *element.iterancestors()]
    holder = next((at for at in chain if _local(at) in ("entry", "remote-request")), None)
    if holder is not None:
        ids = _session_ids(holder)
        if _local(holder) == "remote-request":
            launched = _agreed(frame for frame, _ in _launch_frames(root, _command_id(holder))) or []
        else:
            launched = _conditioned_supplied(document, holder, chain, sessions)
        datum = next((at for at in chain if at.getparent() is not None and _local(at.getparent()) == "session"), None)
        if datum is None:
            return [*launched, *(datum_id for datum_id, _ in ids)]
        before = ids[: next(i for i, (_, at) in enumerate(ids) if at is datum)]
        return [*launched, *(datum_id for datum_id, _ in before)]
    menu = next((at for at in chain if _local(at) == "menu"), None)
    if menu is not None:
        shown_in = menu.get("id") if element is not menu else (menu.get("root") or "root")
        return _menu_supplied(root, shown_in)
    details = [at for at in chain if _local(at) == "detail"]
    if not details:
        return None
    return _detail_supplied(root, details[-1].get("id"))


def _menu_supplied(root, menu_id):
    """The ids every entry of a menu shares first, which Core collects before the menu's items show; none for the
    root menu, and None where no entry names a command of the menu."""
    if menu_id == "root":
        return []
    lists = [[datum_id for datum_id, _ in _session_ids(holder)] for holder in _entries_under(root, menu_id)]
    return _common_prefix(lists) if lists else None


def _command_id(holder):
    """The id of an entry's or a remote request's ``<command>``, or None."""
    return next((child.get("id") for child in _children(holder) if _local(child) == "command"), None)


def _literal_value(element, text):
    """Whether an element's ``value`` is the string literal ``text`` (HQ's and Nova's builds write a command's id
    and a fixed datum value as a quoted literal)."""
    value = (element.get("value") or "").strip()
    return value in (f"'{text}'", f'"{text}"')


def _agreed(frames):
    """The ids every frame holds, or None where there is none."""
    supplied = None
    for frame in frames:
        if frame is not None:
            supplied = set(frame) if supplied is None else supplied & set(frame)
    return None if supplied is None else list(supplied)


def _stack_frames(stack, command_id, start):
    """Each frame a stack's operations hold where one names ``command_id``, with that operation: a ``<create>``
    begins a frame of its own and a ``<push>`` adds to the current one (Core's ``StackOperation``), starting from
    ``start``, the ids the frame holds where the stack runs; the operation that names the command adds every
    datum it sets."""
    frame = list(start)
    for operation in _children(stack):
        kind = _local(operation)
        if kind == "create":
            frame = []
        elif kind != "push":
            continue
        steps = _children(operation)
        datums = [step.get("id") for step in steps if _local(step) == "datum" and step.get("id")]
        if any(_local(step) == "command" and _literal_value(step, command_id) for step in steps):
            yield [*frame, *datums], operation
        frame.extend(datums)


def _launch_frames(root, command_id):
    """Each frame the session holds where an entry's or a remote request's command is launched, with the stack
    operation that launches it (None from a menu): from a menu, the ids its entries share first; from a detail's
    action, the ids where the detail shows, then the action's stack; from an endpoint's or an entry's stack, the
    stack's own frame (an entry's starting from the ids its session wrote)."""
    if command_id is None:
        return
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        kind = _local(element)
        if kind == "menu":
            if any(_local(child) == "command" and child.get("id") == command_id for child in _children(element)):
                yield _menu_supplied(root, element.get("id")), None
        elif kind == "stack":
            parent = element.getparent()
            owner = next((at for at in element.iterancestors() if _local(at) in ("detail", "endpoint", "entry")), None)
            if owner is None:
                continue
            if _local(owner) == "detail" and parent is not None and _local(parent) == "action":
                start = _detail_supplied(root, owner.get("id"))
                if start is None:
                    continue
            elif _local(owner) == "entry":
                start = [datum_id for datum_id, _ in _session_ids(owner)]
            else:
                start = []
            yield from _stack_frames(element, command_id, start)


def _conditioned_supplied(document, holder, chain, sessions):
    """The ids an entry's stack operation holds beyond the entry's own where its ``if`` holds session values equal
    to literals (CommCare HQ's case list registration frames, ``return_to = 'm1'``, ``workflow.py``): the ids every
    launch of the entry that sets each such value holds, Core evaluating the operation's children only where its
    ``if`` holds. Empty where the operation has no such condition or no launch sets it."""
    operation = next(
        (at for at in chain if at.getparent() is not None and _local(at.getparent()) == "stack" and at.get("if")),
        None,
    )
    if operation is None or not hasattr(document, "tree"):
        return []
    tree = document.tree(operation.get("if"))
    if tree is None or _holds_other(tree):
        return []
    wanted = _literal_equalities(tree, sessions)
    if not wanted:
        return []
    frames = []
    for frame, launch in _launch_frames(document.root, _command_id(holder)):
        sets = {}
        for step in _children(launch) if launch is not None else ():
            if _local(step) == "datum" and step.get("id") in wanted:
                sets[step.get("id")] = step
        if all(key in sets and _literal_value(sets[key], text) for key, text in wanted.items()):
            frames.append(frame)
    return _agreed(frames) or []


def _literal_equalities(tree, sessions):
    """The session data ids an ``and`` chain holds equal to a string literal, each with its text."""
    if tree[0] != "binary":
        return {}
    if tree[1] == "and":
        return {**_literal_equalities(tree[2], sessions), **_literal_equalities(tree[3], sessions)}
    if tree[1] != "=":
        return {}
    for side, other in ((tree[2], tree[3]), (tree[3], tree[2])):
        read = _session_data_id(side, sessions)
        if read is not None and other[0] == "text":
            return {read: other[1]}
    return {}


def _list_filter_detail(at):
    """The short detail a menu's case list filter is (``m<i>_case_short``), where an app JSON use sits on that
    filter; None for any other slot."""
    if at.key != "filter" or at.scope[-1][0] != "Detail":
        return None
    module = at.nearest(*MODULES)
    pair = (module or {}).get("case_details")
    if not isinstance(pair, dict) or pair.get("short") is not at.owner:
        return None
    m = next((index for index, held in enumerate(at.app.modules) if held is module), None)
    return None if m is None else f"m{m}_case_short"


def _nodeset_session_data(text, sessions):
    """Each id a datum's ``nodeset`` reads of the session's data, ``instance('<session>')/session/data/<id>``, read
    through Core's lexer; None where the lexer does not read the text."""
    found = xpath_tokens(text or "")
    if found is None:
        return None
    kinds = [token.kind for token in found]
    shape = ["QNAME", "LPAREN", "STR", "RPAREN", "SLASH", "QNAME", "SLASH", "QNAME", "SLASH", "QNAME"]
    read = set()
    for index in range(len(found) - len(shape) + 1):
        if kinds[index : index + len(shape)] != shape:
            continue
        names = [found[index + offset].text for offset in (0, 5, 7)]
        if names == ["instance", "session", "data"] and found[index + 2].text[1:-1] in sessions:
            read.add(found[index + 9].text)
    return read


def _filter_unsupplied(at, read, guarded, sessions):
    """``datum_not_supplied`` for a menu's case list filter. HQ's build writes the filter into the ``nodeset`` of
    each datum that selects from the list (``suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath``), and
    where it aligns a child menu's datums with its parent's it renames each session read there to the id the
    parent gives the same case (``add_parent_datums``, ``_update_refs``), so the filter's reads are judged as the
    built ``nodeset`` holds them: True where it reads an id written after the datum that one of the filter's own
    unguarded reads names, False where every id it reads is written before, and None where it reads one the filter
    does not (HQ's own index test) or no suite the check reads holds such a datum."""
    detail_id = _list_filter_detail(at)
    verdicts = set()
    for suite in _app_suites(at.app):
        for holder in _children(suite.root):
            if _local(holder) not in ("entry", "remote-request"):
                continue
            ids = _session_ids(holder)
            for position, (_, datum) in enumerate(ids):
                if datum.get("detail-select") != detail_id:
                    continue
                nodeset = _nodeset_session_data(datum.get("nodeset"), sessions)
                if nodeset is None:
                    verdicts.add(None)
                    continue
                written = {datum_id for datum_id, _ in ids[:position]}
                for unsupplied in nodeset - written:
                    verdicts.add(True if unsupplied in read else False if unsupplied in guarded else None)
                verdicts.add(False)
    if True in verdicts:
        return True
    return None if None in verdicts or not verdicts else False


def _detail_supplied(root, detail_id):
    """The ids written before each datum that shows a detail (through the datum, for a detail that stays on
    screen while the form runs), every such datum agreeing; None where no datum shows it."""
    supplied = None
    for holder in _children(root):
        if _local(holder) not in ("entry", "remote-request"):
            continue
        ids = _session_ids(holder)
        for position, (_, datum) in enumerate(ids):
            shows = (datum.get("detail-select"), datum.get("detail-confirm"), datum.get("detail-persistent"))
            if detail_id not in shows:
                continue
            through = position + 1 if datum.get("detail-persistent") == detail_id else position
            here = {datum_id for datum_id, _ in ids[:through]}
            supplied = here if supplied is None else supplied & here
    return None if supplied is None else list(supplied)


def _form_supplied(form):
    """The session data ids every entry that opens a form writes: the entries of the suites the check reads beside
    it (``Form.entry_suites``) whose ``<form>`` names the form's namespace, or None where it reads none."""
    if form.xmlns is None:
        return None
    lists = [
        {datum_id for datum_id, _ in _session_ids(entry)}
        for suite in form.entry_suites
        for entry in _children(suite)
        if _local(entry) == "entry"
        and any(_local(child) == "form" and (child.text or "").strip() == form.xmlns for child in _children(entry))
    ]
    if not lists:
        return None
    return set.intersection(*lists)


def datum_not_supplied(use, manifest):
    """``expressions-and-data/session-data-datum-the-entry-does-not-supply``: an expression reading the session's
    ``data/<id>`` where nothing writes that id when it runs, so a scalar read of the missing leaf can stop the form
    (``lib/commcare/CLAUDE.md``, the binding-resolution oracle). Read from Core's parse of the expression (its
    instance paths through the session's instance, ``instance-source:session``), less the ids with an item or a
    class of their own (``stringquery``, ``fingerprintquery``, ``supply_point_id``). What is written there is the
    suite's: in a suite, the session where the element runs (``_suite_supplied``); in a form, the ids every entry
    that opens it writes, from the suites the check reads beside the form (a local archive's own, and for an app
    JSON's form each build HQ made of its upload, or the local archive Nova built of the same export where HQ
    built none), and None where it reads none. A read Core never unpacks is no read here: the path a ``count()``
    counts (Core counts an absent leaf as none), and a read on the right of an ``and`` whose left holds
    ``count(<the read>) = 1``, ``>= 1`` or ``> 0``, which Core does not evaluate where the leaf is absent (the
    ``return_to`` guard of CommCare HQ's case list registration frames, ``workflow.py``), read over the
    expression's structure as HQ's XPath grammar reads it where the records hold it."""
    document, text, sessions = _session_reads(use, manifest)
    if document is None:
        return None
    parsed = document.parsed(text)
    if parsed is None or "error" in parsed:
        return None
    read = {
        path["steps"][2]
        for path in parsed["instancePaths"]
        if path["instance"] in sessions
        and len(path["steps"]) > 2
        and path["steps"][:2] == ["session", "data"]
        and path["steps"][2] not in _OWN_SESSION_DATA
    }
    tree = document.tree(text) if read and hasattr(document, "tree") else None
    unguarded = set(read)
    if tree is not None and not _holds_other(tree):
        read &= _unpacked_session_data(tree, sessions, frozenset())
    if not read:
        return False
    if isinstance(use.at, JsonAt) and _list_filter_detail(use.at) is not None:
        return _filter_unsupplied(use.at, read, unguarded - read, sessions)
    if isinstance(use.at, JsonAt):
        supplied = _slot_supplied(use.at, sessions)
    elif document.kind == "xform":
        supplied = _form_supplied(document)
    else:
        supplied = _suite_supplied(document, use.at.element, sessions)
    if supplied is None:
        return None
    return not read <= set(supplied)


def _session_reads(use, manifest):
    """The document a use's expression sits in, its text, and the instance ids it reads the session through: those
    an XML document declares from the session's source, or, in an app JSON slot, those HQ's build declares so in
    the suite it writes (``preset_source``); (None, None, None) where the use sits on no expression."""
    at = use.at
    if isinstance(at, JsonAt):
        text = at.value if isinstance(at.value, str) else None
        parsed = at.app.parsed(text)
        if text is None or parsed is None or "error" in parsed:
            return (None, None, None) if text is None else (at.app, text, set())
        sessions = set()
        for path in parsed["instancePaths"]:
            src = preset_source(manifest, path["instance"])
            if src is not None and instance_source(manifest, src) == "instance-source:session":
                sessions.add(path["instance"])
        return at.app, text, sessions
    at = _xml(use)
    if at is None or at.attribute is None:
        return None, None, None
    document = at.document
    sessions = {
        instance_id
        for instance_id, src in document.declared_instances
        if instance_source(manifest, src) == "instance-source:session"
    }
    return document, at.element.get(at.attribute), sessions


def _app_suites(app):
    """The suites the check reads beside an app JSON's forms (``Form.entry_suites``: HQ's builds of its upload, or
    the local archive Nova built of the same export), each once, read with the app's readings."""
    seen, suites = set(), []
    for form in app.forms.values():
        for root in form.entry_suites:
            if id(root) not in seen:
                seen.add(id(root))
                suite = Runtime(root, "suite.xml")
                suite.readings = app.readings
                suites.append(suite)
    return suites


def _slot_elements(root, owner, key, m, f, forms):
    """The suite elements HQ's build writes an app JSON display condition or form link into (``_slot_supplied``)."""
    elements = [element for element in root.iter() if isinstance(element.tag, str)]
    if owner in ("FormLink", "FormDatum"):
        return [element for element in elements if _local(element) == "entry" and _command_id(element) == f"m{m}-f{f}"]
    if owner in FORMS:
        commands = {f"m{m}-f{f}"} if key == "form_filter" else set()
    else:
        own = [element for element in elements if _local(element) == "menu" and element.get("id") == f"m{m}"]
        if own:
            return own
        commands = {f"m{m}-f{index}" for index in range(forms)}
    return [
        element
        for element in elements
        if _local(element) == "command"
        and element.get("id") in commands
        and element.getparent() is not None
        and _local(element.getparent()) == "menu"
    ]


def _slot_supplied(at, sessions):
    """The session data ids set where an app JSON slot's expression runs: where the suites the check reads beside
    the app hold the element HQ's build writes the slot into (``id_strings.py``), the ids set there
    (``_suite_supplied``), every suite agreeing; None where none holds it. A menu's display condition is its
    ``<menu id="m<i>">``'s, else (a menu shown in the one above) each of its forms' commands'; a form's display
    condition is its command's, ``m<i>-f<j>``; a form link's condition and carried values run in the stack of the
    form's own entry; a case list's filter and calculated columns are its detail's, ``m<i>_case_short`` or
    ``m<i>_case_long``."""
    module = at.nearest(*MODULES, "ReportModule")
    if module is None:
        return None
    m = next((index for index, held in enumerate(at.app.modules) if held is module), None)
    form = at.nearest(*FORMS)
    f = next((index for index, held in enumerate(_forms(module)) if held is form), None)
    owner = at.scope[-1][0]
    detail = at.nearest("Detail")
    detail_id = None
    if detail is not None:
        pair = module.get("case_details") or {}
        detail_id = next(
            (f"m{m}_case_{kind}" for kind in ("short", "long") if isinstance(pair, dict) and pair.get(kind) is detail),
            None,
        )
        if detail_id is None:
            return None
    agreed = None
    for suite in _app_suites(at.app):
        if detail_id is not None:
            supplied = _detail_supplied(suite.root, detail_id)
        else:
            elements = _slot_elements(suite.root, owner, at.key, m, f, len(_forms(module)))
            supplied = _agreed(_suite_supplied(suite, element, sessions) for element in elements)
        if supplied is not None:
            agreed = set(supplied) if agreed is None else agreed & set(supplied)
    return None if agreed is None else list(agreed)


def _holds_other(tree):
    """Whether an expression's structure holds a part HQ's grammar gives no structure of (``["other", ...]``)."""
    kind = tree[0]
    if kind == "other":
        return True
    if kind == "path":
        return any(_holds_other(predicate) for predicate in tree[3])
    if kind == "call":
        return any(_holds_other(argument) for argument in tree[2])
    if kind == "binary":
        return _holds_other(tree[2]) or _holds_other(tree[3])
    if kind == "negative":
        return _holds_other(tree[1])
    return False


def _session_data_id(path, sessions):
    """The id a location path reads of the session's ``data/<id>`` with no predicate on it, or None."""
    if path[0] != "path" or not path[1].startswith("instance:") or path[1][len("instance:") :] not in sessions:
        return None
    steps = path[4]
    if len(steps) != 3 or [step[1] for step in steps[:2]] != ["session", "data"]:
        return None
    if any(step[0] != "child" or step[2] for step in steps):
        return None
    return steps[2][1]


def _present_by_guard(tree, sessions):
    """The session data ids a condition, where true, holds present: ``count(<the read>) = 1``, ``>= 1`` or
    ``> 0``, and each conjunct's of an ``and``."""
    if tree[0] != "binary":
        return frozenset()
    if tree[1] == "and":
        return _present_by_guard(tree[2], sessions) | _present_by_guard(tree[3], sessions)
    left, right = tree[2], tree[3]
    counted = (
        _session_data_id(left[2][0], sessions)
        if left[0] == "call" and left[1] == "count" and len(left[2]) == 1
        else None
    )
    if counted is None or right[0] != "number":
        return frozenset()
    holds = (tree[1] in ("=", ">=") and float(right[1]) == 1) or (tree[1] == ">" and float(right[1]) == 0)
    return frozenset({counted}) if holds else frozenset()


def _unpacked_session_data(tree, sessions, present):
    """The session data ids an expression's structure reads by value, less those ``present`` holds: every
    ``data/<id>`` path but the one a ``count()`` counts (its predicates are read), and on the right of an ``and``
    less the ids its left holds present where true (``_present_by_guard``)."""
    kind = tree[0]
    if kind == "path":
        found = set()
        for predicate in tree[3]:
            found |= _unpacked_session_data(predicate, sessions, present)
        read = _session_data_id(tree, sessions)
        if read is None and tree[1].startswith("instance:") and tree[1][len("instance:") :] in sessions:
            steps = tree[4]
            if len(steps) > 2 and [step[1] for step in steps[:2]] == ["session", "data"]:
                read = steps[2][1]
        if read is not None and read not in present:
            found.add(read)
        return found
    if kind == "call":
        found = set()
        for argument in tree[2]:
            if tree[1] == "count" and argument[0] == "path":
                for predicate in argument[3]:
                    found |= _unpacked_session_data(predicate, sessions, present)
            else:
                found |= _unpacked_session_data(argument, sessions, present)
        return found
    if kind == "binary":
        left = _unpacked_session_data(tree[2], sessions, present)
        if tree[1] == "and":
            present = present | _present_by_guard(tree[2], sessions)
        return left | _unpacked_session_data(tree[3], sessions, present)
    if kind == "negative":
        return _unpacked_session_data(tree[1], sessions, present)
    return set()


def var_in_form(use, manifest):
    """``expressions-and-data/var-in-a-form-expression``: a variable reference (``$name``) in an XForm's
    expression, where no variable is defined (form contexts define none, so it reads blank). A suite's are the
    variables HQ's build declares there, outside the class, and so are an app JSON slot's, which HQ's build writes
    into the suite (a menu's or a command's condition, a detail, a stack operation)."""
    if isinstance(use.at, JsonAt):
        return False
    at = _xml(use)
    if at is None:
        return None
    return at.document.kind == "xform"


def _expression_at(use):
    """The document a use's expression sits in and the expression's text: an XML attribute's value, or an app
    JSON slot's; (document, None) where the use sits on no text, (None, None) where it sits on no document."""
    at = use.at
    if isinstance(at, XmlAt):
        return at.document, at.element.get(at.attribute) if at.attribute is not None else None
    if isinstance(at, JsonAt):
        return at.app, at.value if isinstance(at.value, str) else None
    return None, None


def case_named_by_its_slug(use, manifest):
    """``expressions-and-data/case-module-slug-unrelated-parent-select-case``: a ``#case`` that names the case of
    a menu by its slug (``#case:<module-slug>/…``, what "Other" parent selection writes,
    ``app_schemas/session_schema.py::get_session_schema``). In a slot HQ's build interpolates, its text replacement
    of ``#case`` (``xpath.py::interpolate_xpath``) leaves the ``:<slug>`` after the case's path, so the slot's text
    says which it is; the bare shorthand is the case its own menu chose, outside the class. A ``#case`` read
    anywhere else is not read here."""
    at = use.at
    if not isinstance(at, JsonAt) or not isinstance(at.value, str):
        return None
    return "#case:" in at.value


def here_in_form(use, manifest):
    """``expressions-and-data/here-in-a-form``: ``here()`` in an XForm's expression, which no function handler of a
    form's evaluation context answers ("cannot handle function 'here'"). A suite's and an app JSON's expressions (a
    case list's columns, sorts and filters, a menu's or form's display condition, a form link) are evaluated
    outside a form."""
    document, _ = _expression_at(use)
    if document is None:
        return None
    return document.kind == "xform"


def window_width_in_form_logic(use, manifest):
    """``expressions-and-data/session-context-window-width-in-form-logic``: a read of the session's
    ``context/window_width`` in an XForm's expression. HQ's Web Apps client sends the width only with a
    menu request (``formplayer/menus/api.js``), never with a form request
    (``form_entry/web_form_session.js``), and Formplayer runs every calculate again on each form
    request, which throws on a ``FormDef`` it deserializes afresh from the session's stored
    definition after a miss of ``FormDefinitionService.getFormDefWithCache``, since ``XPathPathExpr``
    does not serialize ``templatePathChecked``; Android never sets it. A suite's and an app JSON's
    expressions (case lists, details, display conditions, search values) are evaluated on a menu
    request, outside the class."""
    document, _ = _expression_at(use)
    if document is None:
        return None
    return document.kind == "xform"


def choice_name_on_lookup(use, manifest):
    """``expressions-and-data/jr-choice-name-on-a-lookup-itemset-select``: a ``jr:choice-name(value, 'path')`` call in
    an XForm's expression whose question (its second argument's value, which Core's handler reads as a reference,
    ``FormDef``'s ``jr:choice-name`` handler, ``findQuestionByRef``) is a select whose choices an ``<itemset>``
    gives, which the handler cannot list. Read over the call's structure as HQ's XPath grammar reads it; a call whose
    question is no string is not placed here. A suite's or an app JSON's call is evaluated outside a form, where the
    handler is not."""
    document, text = _expression_at(use)
    if document is None or text is None:
        return None
    if document.kind != "xform":
        return False
    tree = document.tree(text)
    if tree is None:
        return None
    unsure = False
    for arguments in _calls(tree, "jr:choice-name"):
        if len(arguments) != 2:
            continue  # Core's handler takes two
        if arguments[1][0] != "text":
            unsure = True
            continue
        for control in document.question_controls(arguments[1][1]):
            if _local(control) in SELECTS and control.find(f"{{{XFORMS}}}itemset") is not None:
                return True
    return None if unsure else False


def other_bind_id(use, manifest):
    """``questions/any-other-bind-id-named-by-a-control-s-bind``: a control's ``bind`` naming a bind (Core reads the
    control's node as that bind's nodeset, whatever ``ref`` or ``nodeset`` it also holds: ``_core_control_path``)
    whose id does not read as that node's path the way the form builder reads a ``bind``: from the data root where a
    question stands there, else from its parent control's node (``parser.js::getPathFromControlElement``,
    ``processPath``). Nova holds a control's ``bind`` only in that spelling, as its reader does
    (``xform/body.ts``, ``bindIdPath``). Read on the control's ``bind`` and on the bind's ``id`` alike, a bind no
    control names being outside the class; an id that names no bind is the bar's (Core refuses the form)."""
    form, element = _form_element(use)
    if form is None:
        return None
    if _local(element) == "bind" and element.getparent() is form.model:
        bind_id = element.get("id")
        controls = [control for control in form.body_elements if bind_id and control.get("bind") == bind_id]
    else:
        controls = [element] if element.get("bind") is not None and element in form.body_elements else []
    verdicts = {_bind_read_otherwise(form, control) for control in controls}
    if True in verdicts:
        return True
    return None if None in verdicts else False


def _bind_read_otherwise(form, control):
    """Whether a control's ``bind`` id reads as another node than the one Core binds it to (``other_bind_id``):
    True, False, or None where the bind's nodeset names no node here."""
    bind = form.binds_by_id.get(control.get("bind"))
    if bind is None:
        return False
    target = form.node(bind.get("nodeset"))
    if target is None:
        return None
    bind_id = control.get("bind")
    root = f"/{_local(form.data_root)}"
    read = form.node(bind_id if bind_id.startswith("/") else f"{root}/{bind_id}")
    if read is None:
        parent = control.getparent()
        while parent is not None and parent is not form.body and not form.control_path(parent):
            parent = parent.getparent()
        base = form.control_path(parent) if parent is not None and parent is not form.body else root
        read = form.node(f"{base}/{bind_id}")
    return read is not target


def referenced_unrecognized_source(use, manifest):
    """``expressions-and-data/declared-and-referenced-instance-with-an-unrecognized-src``: an instance whose ``src``
    no branch of ``CommCareInstanceInitializer.generateRoot`` takes (``instance_source``: ``(none)``), so it loads
    as ``ConcreteInstanceRoot.NULL``, that an expression of its document reads (Core's parse of an attribute value
    holds a path from ``instance('<its id>')``), where every read throws. An expression whose parse the records do
    not hold, or that calls ``instance()`` other than as a path's root (whose argument the parse does not list),
    leaves it open."""
    at = _xml(use)
    if at is None:
        return None
    element, document = at.element, at.document
    if _local(element) != "instance" or element.get("src") is None:
        return False
    if instance_source(manifest, element.get("src")) != "instance-source:(none)" or not element.get("id"):
        return False
    return _reads_declared_instance(document, element.get("id"))


def ledger_read(use, manifest):
    """HQ's ledger scheme, or a read of a declaration Core initializes as the ledger database. Its source
    may have a different spelling, including a lookup tag containing ledgerdb (generateRoot checks the
    ledger before fixtures). An unread declaration is inert."""
    if use.key == "instance-scheme:ledgerdb":
        return True
    at = _xml(use)
    if at is None or not at.element.get("id"):
        return None
    return _reads_declared_instance(at.document, at.element.get("id"))


def _reads_declared_instance(document, instance_id):
    """Whether Core's parsed expressions read this id, or None where the record cannot settle a read."""
    if document.readings is None:
        return None
    unsure = False
    for other in document.root.iter():
        if not isinstance(other.tag, str):
            continue
        for value in other.attrib.values():
            if not value.strip():
                continue
            parsed = document.parsed(value)
            if parsed is None:
                unsure = True
                continue
            if "error" in parsed:
                continue
            if any(path["instance"] == instance_id for path in parsed["instancePaths"]):
                return True
            unsure = unsure or "instance" in parsed["functions"]
    return None if unsure else False


def _big_image(kind):
    """``questions/label-big-image``, ``questions/choice-big-image``: a text's ``big-image`` value where a question's
    reference names that text as a label (``kind``: ``label``) or as a choice's label (``choice``), each reference
    read as Vellum's ``getITextID`` reads it (``Form.itext_references``)."""

    def reader(use, manifest):
        form, value = _itext_value(use)
        if form is None:
            return None
        if value is None or value.get("form") != "big-image":
            return False
        kinds, unplaced = form.itext_references
        if kind in kinds.get(value.getparent().get("id"), ()):
            return True
        return None if unplaced else False

    return reader


def parent_after_named_step(use, manifest):
    """``expressions-and-data/after-a-named-step-data-a-b``: a location path with a parent step where Core's
    ``XPathPathExpr.getReference`` allows none: in a path from the document's root or from ``instance()``, or after
    a step by name (a child by name or ``*``, an attribute by name), so the reference cannot be built (Core's parse
    of a bind refuses it; an output or setvalue fails as it runs). Read over the expression's structure as HQ's
    XPath parser reads it (the observation's ``trees``); a path Core refuses at an earlier step (another axis or
    node test, a filter, a root other than ``instance()`` and ``current()``) is refused for that, outside the
    class."""
    document, text = _expression_at(use)
    if document is None or text is None:
        return None
    tree = document.tree(text)
    if tree is None:
        return None
    return any(_parent_after_name(path) for path in _paths(tree))


def _parent_after_name(path):
    """Whether a location path holds a parent step where ``getReference`` allows none (``parent_after_named_step``)."""
    root = path[1]
    if root in ("relative", "call:current"):
        allowed = True
    elif root == "absolute" or root.startswith("instance:"):
        allowed = False
    else:
        return False
    for axis, test, _ in path[4]:
        if axis in ("parent", "self"):
            if test != "node()":
                return False
            if axis == "parent" and not allowed:
                return True
        elif axis == "child" and not test.endswith(")") and (test == "*" or not test.endswith(":*")):
            allowed = False
        elif axis == "attribute" and test != "*" and not test.endswith((")", ":*")):
            allowed = False
        else:
            return False
    return False


# The calls Core builds whose value is a number, a date or a truth value whatever their arguments
# (``ASTNodeFunctionCall.buildFuncExpr``'s table, each class's ``evalBody`` giving a Double, a Date or a Boolean), and
# ``uuid``, whose hexadecimal text holds no ``:``; ``if`` and ``coalesce`` give one of their arguments' values.
NON_TIME_CALLS = frozenset(
    {
        "count",
        "sum",
        "number",
        "int",
        "double",
        "round",
        "floor",
        "ceiling",
        "abs",
        "pow",
        "log",
        "log10",
        "exp",
        "sqrt",
        "sin",
        "cos",
        "tan",
        "asin",
        "acos",
        "atan",
        "atan2",
        "pi",
        "min",
        "max",
        "random",
        "string-length",
        "position",
        "count-selected",
        "index-of",
        "distance",
        "true",
        "false",
        "not",
        "boolean",
        "boolean-from-string",
        "selected",
        "is-selected",
        "regex",
        "contains",
        "starts-with",
        "ends-with",
        "checklist",
        "weighted-checklist",
        "is-point-inside-polygon",
        "today",
        "now",
        "date",
        "uuid",
    }
)


# The case's system dates, which a suite's case list expression reads by name off the case node, never a time of
# day: Core's casedb holds ``date_opened`` and ``last_modified`` as ``DateData``
# (``CaseChildElement``'s case node), and ``closed_on``, HQ's third system datetime
# (``corehq/apps/case_search/const.py::INDEXED_METADATA_BY_KEY``), is no child Core builds there, so it reads blank.
SYSTEM_DATE_NAMES = frozenset({"date_opened", "closed_on", "last_modified"})


def time_operand(use, manifest):
    """``expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string``: a relational
    comparison (``<``, ``<=``, ``>``, ``>=``: Core's ``XPathCmpExpr``) with a time on either side, which Core
    compares as a number, a string holding ``:`` being NaN (``FunctionUtils.toNumeric``). Each side is read over the
    expression's structure as HQ's XPath grammar reads it (``_time_kind``); a side whose value this does not read (a
    case property whose type or case context is unknown, a lookup table's field, a value only the run time knows)
    leaves it open. A case list's filter and calculated columns in an app JSON are read on each row, a case of its
    menu's type (``_list_case_type``)."""
    document, text = _expression_at(use)
    if document is None or text is None:
        return None
    tree = document.tree(text)
    if tree is None:
        return None
    context = _context_path(use)
    verdicts = set()
    for node, case_type, in_predicate in _relational(tree, _list_case_type(use)):
        verdicts |= {
            _time_kind(manifest, document, side, context, frozenset(), case_type, in_predicate) for side in node[2:]
        }
    if True in verdicts:
        return True
    return None if None in verdicts else False


def _list_case_type(use):
    """The case type an app JSON case list's filter or calculated column reads its relative paths on: the case
    list's menu's, each row of the list being a case of it (HQ's build writes the filter into the datum's
    ``nodeset`` predicate over ``casedb/case[@case_type=…]`` and a column into its detail's ``xpath``); None for
    any other use."""
    at = use.at
    if not isinstance(at, JsonAt) or at.nearest("Detail") is None:
        return None
    module = at.nearest(*MODULES)
    pair = (module or {}).get("case_details")
    detail = at.nearest("Detail")
    if not isinstance(pair, dict) or not any(pair.get(kind) is detail for kind in ("short", "long")):
        return None
    case_type = module.get("case_type")
    return case_type if isinstance(case_type, str) and case_type else None


def _relational(tree, case_type=None, in_predicate=False):
    """Each relational comparison, and the case type a sibling predicate names where it is evaluated.

    A nested path establishes its own predicate context; an outer case's type never types a child node or a
    different instance's properties. Nor can a predicate-relative read borrow a form bind's context:
    Core's ``EvaluationContext.expandReference`` rescopes it to the candidate node. The observation records
    the instance argument before the step predicates.
    """
    kind = tree[0]
    if kind == "binary":
        if tree[1] in ("<", "<=", ">", ">="):
            yield tree, case_type, in_predicate
        yield from _relational(tree[2], case_type, in_predicate)
        yield from _relational(tree[3], case_type, in_predicate)
    elif kind == "negative":
        yield from _relational(tree[1], case_type, in_predicate)
    elif kind == "call":
        for argument in tree[2]:
            yield from _relational(argument, case_type, in_predicate)
    elif kind == "path":
        scoped, first, end = _case_predicate_scope(tree)
        for index, predicate in enumerate(tree[3]):
            yield from _relational(predicate, scoped if first <= index < end else None, True)


def _case_predicate_scope(tree):
    """The type and predicate span of ``instance('casedb')/casedb/case[@case_type = '<type>'][...]``.

    Read only this named case step and a direct equality among its siblings. A filter on a whole path has a
    different predicate order in the observation's tree, and is left open, as are types named under and/or.
    """
    steps, predicates = tree[4], tree[3]
    if (
        tree[1] != "instance:casedb"
        or len(steps) < 2
        or list(steps[0]) != ["child", "casedb", 0]
        or list(steps[1][:2]) != ["child", "case"]
        or any(axis == "filter" for axis, _, _ in steps)
        or not predicates
        or list(predicates[0]) != ["text", "casedb"]
        or len(predicates) != 1 + sum(count for _, _, count in steps)
    ):
        return None, 0, 0
    first, end = 1, 1 + steps[1][2]
    names = set()
    for predicate in predicates[first:end]:
        if predicate[:2] != ["binary", "="]:
            continue
        for path, literal in (predicate[2:], reversed(predicate[2:])):
            if _bare_read(path, "attribute") == "case_type" and literal[0] == "text":
                names.add(literal[1])
    return next(iter(names)) if len(names) == 1 else None, first, end


def _context_path(use):
    """The path of the node a bind's expression is evaluated at (its nodeset's node), or None."""
    at = use.at
    if not isinstance(at, XmlAt) or at.document.kind != "xform" or _local(at.element) != "bind":
        return None
    form = at.document
    return _node_path(form, form.node(at.element.get("nodeset")))


# A string literal's text that spells an ISO date and time, as Nova's typed-literal rule reads one
# (``lib/domain/expression/ruleSets.ts::literalShape``, ``ISO_DATETIME_SHAPE``): a literal's value, never XPath.
ISO_DATETIME_LITERAL = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?", re.ASCII
)


def _time_kind(manifest, document, tree, context, seen, case_type=None, in_predicate=False):
    """Whether a value is a time as a comparison reads it: True for a string holding ``:`` that is no ISO date and
    time (``ISO_DATETIME_LITERAL``, which Nova's reader types as a moment and compares as one) or a form node whose
    bind type is ``xsd:time`` (or whose calculate gives a time), False for a number, a date, a date and time, a
    truth value or another answer, None where this does not read it. A case predicate reads the same
    ``CaseChildElement`` properties in a form and a suite; its explicit case type and the document's catalog place
    a custom property's value."""
    kind = tree[0]
    if kind == "number":
        return False
    if kind == "text":
        return ":" in tree[1] and ISO_DATETIME_LITERAL.fullmatch(tree[1]) is None
    if kind == "negative":
        return False
    if kind == "binary":
        return None if tree[1] == "|" else False  # arithmetic is a number, a comparison or and/or a truth value
    if kind == "call":
        name, arguments = tree[1], tree[2]
        if name in NON_TIME_CALLS:
            return False
        branches = (
            arguments[1:]
            if name == "if" and len(arguments) == 3
            else arguments
            if name == "coalesce"
            # Core's cond gives the value after the first condition that holds, else its last argument
            # (``XPathCondFunc.evalBody``).
            else [*arguments[1:-1:2], arguments[-1]]
            if name == "cond" and len(arguments) >= 3 and len(arguments) % 2 == 1
            else None
        )
        if not branches:
            return None
        kinds = {_time_kind(manifest, document, branch, context, seen, case_type, in_predicate) for branch in branches}
        return True if True in kinds else None if None in kinds else False
    if kind == "path" and tree[1] == "instance:commcaresession":
        # Core writes the session's drift as a whole number (``SessionInstanceBuilder.addMetadata``,
        # ``String.valueOf`` of a long) and its window width as the client gives it, the window's width in pixels
        # (Web Apps' ``menus/api.js``, ``String(window.innerWidth)``); no other session value is read here.
        return False if _session_context_read(tree) in ("drift", "window_width") else None
    if kind == "path" and document.kind == "xform" and tree[1] == "instance:casedb":
        read = _own_case_property(tree)
        if read is None:
            return None
        return _property_time_kind(document, _datum_case_type(document, read[0]), read[1])
    if kind == "path" and (document.kind == "runtime" or case_type is not None):
        if _system_date_read(tree):
            return False
        property_name = _bare_read(tree, "child")
        data_type = ((document.case_types or {}).get(case_type) or {}).get(property_name)
        if data_type == "time":
            return True  # Core reads a custom property's stored text; ':' makes FunctionUtils.toNumeric return NaN
        if data_type in ("date", "datetime", "int", "decimal"):
            # A date and time is no time of day: Nova compares two as moments (the instant-comparison rewrite,
            # which a first publish declares), whatever Core makes of the stored text.
            return False
        if document.kind == "runtime" or property_name is not None:
            return None
    if kind == "path" and document.kind == "xform":
        if tree[1] == "relative" and in_predicate:
            return None  # this reader places only the explicitly typed case step's predicate-relative reads
        if tree[1] == "absolute":
            path = _resolved("/", tree[4])
        elif tree[1] in ("relative", "call:current") and context is not None:
            path = _resolved(context, tree[4])
        else:
            return None
        return None if path is None else _time_node(manifest, document, path, seen)
    return None


def _property_time_kind(document, case_type, property_name):
    """Whether a case property of a type holds a time (``_time_kind``): by the document's catalog, None where it
    does not type the property."""
    data_type = ((document.case_types or {}).get(case_type) or {}).get(property_name) if case_type else None
    if data_type == "time":
        return True
    if data_type in ("date", "datetime", "int", "decimal"):
        return False
    return None


def _session_context_read(tree):
    """The child of the session's ``context`` a path reads, ``instance('commcaresession')/session/context/<name>``
    with no predicate, or None."""
    steps, predicates = tree[4], tree[3]
    if len(steps) != 3 or list(predicates) != [["text", "commcaresession"]]:
        return None
    if any(axis != "child" or count for axis, _, count in steps):
        return None
    if [step[1] for step in steps[:2]] != ["session", "context"]:
        return None
    return steps[2][1]


def _session_data_read(tree):
    """The id a path reads of the session's data, ``instance('commcaresession')/session/data/<id>`` with no
    predicate, or None."""
    if tree[0] != "path" or tree[1] != "instance:commcaresession":
        return None
    steps, predicates = tree[4], tree[3]
    if len(steps) != 3 or list(predicates) != [["text", "commcaresession"]]:
        return None
    if any(axis != "child" or count for axis, _, count in steps):
        return None
    if [step[1] for step in steps[:2]] != ["session", "data"]:
        return None
    return steps[2][1]


def _own_case_property(tree):
    """``instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/<id>]/<property>``, the
    read of a case a session datum names that HQ's form builder writes for ``#case/<property>``: (the datum's id,
    the property), or None for any other path."""
    steps, predicates = tree[4], tree[3]
    if (
        len(steps) != 3
        or list(steps[0]) != ["child", "casedb", 0]
        or list(steps[1]) != ["child", "case", 1]
        or steps[2][0] != "child"
        or steps[2][2]
        or len(predicates) != 2
        or list(predicates[0]) != ["text", "casedb"]
    ):
        return None
    predicate = predicates[1]
    if predicate[:2] != ["binary", "="]:
        return None
    for path, datum in (predicate[2:], reversed(predicate[2:])):
        if _bare_read(path, "attribute") == "case_id" and _session_data_read(datum) is not None:
            return _session_data_read(datum), steps[2][1]
    return None


def _datum_case_type(form, datum_id):
    """The case type the session datum ``datum_id`` selects in every entry that opens a form (``_form_entries``):
    the type its ``nodeset`` names first, ``instance('casedb')/casedb/case[@case_type='<type>']…``, read through
    Core's lexer; None where an entry selects it otherwise, or the entries disagree or hold none."""
    types = set()
    for entry in _form_entries(form):
        datums = [
            datum
            for datum in entry.iter()
            if isinstance(datum.tag, str) and _local(datum) == "datum" and datum.get("id") == datum_id
        ]
        if len(datums) != 1:
            return None
        found = xpath_tokens(datums[0].get("nodeset") or "")
        shape = [token.kind for token in found or ()][:14]
        expected = ["QNAME", "LPAREN", "STR", "RPAREN", "SLASH", "QNAME", "SLASH", "QNAME"]
        expected += ["LBRACK", "AT", "QNAME", "EQ", "STR", "RBRACK"]
        if (
            shape != expected
            or [found[index].text for index in (0, 5, 7, 10)] != ["instance", "casedb", "case", "case_type"]
            or found[2].text[1:-1] != "casedb"
        ):
            return None
        types.add(found[12].text[1:-1])
    return next(iter(types)) if len(types) == 1 else None


def _system_date_read(tree):
    """Whether a path is a bare read, by name, of one of the case's system dates (``SYSTEM_DATE_NAMES``)."""
    return _bare_read(tree, "child") in SYSTEM_DATE_NAMES


def _bare_read(tree, axis):
    """The name of a single relative child or attribute read, without a predicate, or None."""
    if tree[0] != "path" or tree[1] != "relative" or tree[3] or len(tree[4]) != 1:
        return None
    step_axis, test, predicates = tree[4][0]
    return test if step_axis == axis and not predicates else None


def _time_node(manifest, form, path, seen):
    """Whether a form node holds a time (``_time_kind``): its bind's type as Core reads it (``_core_datatypes``),
    and an untyped or text node's calculate."""
    if form.node(path) is None:
        return None
    bind = form.bind(path)
    if bind is None:
        return False  # an answer with no bind is text, no time answer
    datatypes = _core_datatypes(manifest, bind.get("type") or "string")
    if datatypes != ("DATATYPE_TEXT",):
        return "DATATYPE_TIME" in datatypes  # Core casts a value to its node's type
    if not (bind.get("calculate") or "").strip():
        return False
    tree = form.tree(bind.get("calculate"))
    if tree is None or path in seen:
        return None
    return _time_kind(manifest, form, tree, path, seen | {path})


# Choices, repeats and model iterations ------------------------------------------------


def _choice_value(item):
    """A choice's value as Vellum's parser reads it (``parser.js``: ``$cEl.children('value').text()``)."""
    return "".join("".join(value.itertext()) for value in _children(item) if _local(value) == "value")


def choice_value_refused_by_vellum(use, manifest):
    """``questions/choice-value-with-whitespace-empty-or-duplicated``: a choice's value that is empty, holds
    whitespace as JavaScript reads it, or equals another choice's of the same question (``mugs/types/select.js``:
    the Choice ``nodeID`` validation; ``presence: 'required'``)."""
    form, element = _form_element(use)
    if form is None:
        return None
    item = element.getparent()
    if _local(element) != "value" or item is None or _local(item) != "item":
        return False
    select = item.getparent()
    if select is None or _local(select) not in SELECTS:
        return False
    value = _choice_value(item)
    if not value or any(character in JS_WHITESPACE for character in value):
        return True
    return any(
        _choice_value(other) == value for other in _children(select) if _local(other) == "item" and other is not item
    )


# HQ's pattern for an instance read (``suite_xml/post_process/instances.py::instance_re``), over literal text,
# with the name widened to any run that holds no quote mark: the reading Nova refuses a choice's value and a form's
# name by (``lib/domain/hqInstanceRead.ts::instanceScanRead``). Python's ``\s`` over text is ``str.isspace``, HQ's
# own.
INSTANCE_READ = re.compile(r"""instance\(\s*['"][^'"]+['"]\s*\)""")


CONNECT_NAMESPACE = "http://commcareconnect.com/data/v1/learn"
CONNECT_ROLES = {
    "ConnectLearnModule": "module",
    "ConnectAssessment": "assessment",
    "ConnectDeliverUnit": "deliver",
    "ConnectTask": "task",
    "ConnectWorkAreaUpdate": "work_area_update",
}


def _connect_part(use):
    """Locate the particular datum read, retaining its role-bearing wrapper and the receiver's own element."""
    form, element = _form_element(use)
    if form is None or element not in form.paths:
        return None
    wrapper = element
    while wrapper is not form.data_root:
        role = wrapper.get(f"{{{VELLUM}}}role")
        if role in CONNECT_ROLES:
            own = wrapper.find(f"{{{CONNECT_NAMESPACE}}}{CONNECT_ROLES[role]}")
            return form, element, wrapper, role, own
        wrapper = wrapper.getparent()
    return None


def connect_id_changes(use, manifest):
    part = _connect_part(use)
    return bool(part and part[1] is part[4] and part[4].get("id") is not None and part[4].get("id") != _local(part[2]))


def connect_id_over_width(use, manifest):
    part = _connect_part(use)
    if not part or part[1] is not part[2] or part[4] is None:
        return False
    width = {"ConnectLearnModule": 50, "ConnectTask": 50, "ConnectDeliverUnit": 100}.get(part[3])
    return width is not None and len(part[4].get("id", "")) > width


def _connect_leaf(use, roles, names):
    part = _connect_part(use)
    if part and part[3] in roles and part[1].getparent() is part[4] and _local(part[1]) in names:
        return part[0], part[1]
    return None, None


def connect_inline_calculation(use, manifest):
    form, leaf = _connect_leaf(
        use, {"ConnectAssessment", "ConnectDeliverUnit"}, {"user_score", "entity_id", "entity_name", "work_area_id"}
    )
    return leaf is not None and (leaf.text or "") != ""


def connect_missing_score(use, manifest):
    form, leaf = _connect_leaf(use, {"ConnectAssessment"}, {"user_score"})
    if leaf is None or leaf.text:
        return False
    bind = form.bind(form.paths[leaf])
    return bind is None or not (bind.get("calculate") or "").strip()


def connect_estimate_outside_column(use, manifest):
    form, leaf = _connect_leaf(use, {"ConnectLearnModule"}, {"time_estimate", "name", "description"})
    if leaf is None:
        return False
    text = leaf.text or ""
    # Connect's module sync reads an empty element as None (`app_xml.py::get_element_text`) into
    # a column that is never null (`LearnModule.name`, `.description`).
    if _local(leaf) != "time_estimate":
        return text == ""
    # Vellum keeps the string, and the receiver writes a PostgreSQL nonnegative integer.
    significant = text.lstrip("0") or "0"
    return (
        not (text.isascii() and text.isdecimal())
        or len(significant) > 10
        or (len(significant) == 10 and significant > "2147483647")
    )


def connect_text_instance(use, manifest):
    form, leaf = _connect_leaf(
        use, {"ConnectLearnModule", "ConnectTask", "ConnectDeliverUnit"}, {"name", "description"}
    )
    return leaf is not None and INSTANCE_READ.search(leaf.text or "") is not None


def _connect_work_area(use):
    part = _connect_part(use)
    if not part or part[1] is not part[2] or part[3] != "ConnectWorkAreaUpdate":
        return None
    wrapper, own = part[2], part[4]
    if own is None or len(_children(wrapper)) != 1 or own.get("id") != _local(wrapper):
        return False
    fields = ["work_area_id", "status", "reason", "additional_details", "photo_evidence"]
    return [child.tag for child in _children(own)] == [f"{{{CONNECT_NAMESPACE}}}{key}" for key in fields] and all(
        not _children(child) for child in _children(own)
    )


def connect_photo_not_forwarded(use, manifest):
    return _connect_work_area(use) is True


def connect_work_area_changed_by_editor(use, manifest):
    return _connect_work_area(use) is False


def _bind_text(form, node, key):
    bind = form.bind(form.paths.get(node))
    return (bind.get(key) or "").strip() if bind is not None else ""


def _token_texts(expression):
    found = xpath_tokens(expression)
    return tuple(token.text for token in found) if found is not None else ()


def _connect_count_limit(form, count):
    # Nova materializes a literal count in a typed calculate which jr:count
    # names. A worker answer, a variable expression or a mutable setvalue
    # doesn't prove a fixed maximum for a submitted repeat.
    tokens = xpath_tokens(count) or ()
    if len(tokens) > 1 and tokens[0].kind == "SLASH":
        path = "".join(t.text for t in tokens)
        node = form.node(path)
        if node is None or isinstance(node, tuple) or form.question_controls(path):
            return 2
        bind = form.bind(path)
        if bind is None or (bind.get("type") or "").split(":")[-1] != "int":
            return 2
        if any(_held_ref(action) == path for action in form.model.iter(f"{{{XFORMS}}}setvalue")):
            return 2
        tokens = xpath_tokens(_bind_text(form, node, "calculate")) or ()
    if len(tokens) == 1 and tokens[0].kind == "NUM" and tokens[0].text.isdecimal():
        return min(2, int(tokens[0].text)) if len(tokens[0].text) < 10 else 2
    return 2


def _connect_limits(form, wrapper):
    counts = dict(form.counted_repeats)
    path = form.paths[wrapper]
    # The model iteration's named wrapper and its body's item repeat describe
    # the very same rows. Nested physical repeats still count independently.
    iterations = {form.paths[n] + "/item" for n in form.model_repeats}
    repeats = tuple(sorted((p for p in form.repeat_paths if p not in iterations and path.startswith(p + "/")), key=len))
    limits = [_connect_count_limit(form, counts.get(repeat, "")) for repeat in repeats]
    return repeats, 0 if 0 in limits else 2 if 2 in limits else 1


def _connect_top_level(tokens):
    depth = 0
    for index, token in enumerate(tokens):
        if token.kind in ("RPAREN", "RBRACK"):
            depth -= 1
        if depth == 0:
            yield index, token
        if token.kind in ("LPAREN", "LBRACK"):
            depth += 1


def _connect_ungroup(tokens):
    while tokens and tokens[0].kind == "LPAREN" and tokens[-1].kind == "RPAREN":
        if [i for i, _ in _connect_top_level(tokens)] != [0, len(tokens) - 1]:
            break
        tokens = tokens[1:-1]
    return tokens


def _connect_conjuncts(tokens):
    tokens = _connect_ungroup(tokens)
    top = list(_connect_top_level(tokens))
    if any(t.kind == "OR" for _, t in top):
        return (tokens,)
    positions = [i for i, t in top if t.kind == "AND"]
    if not positions:
        return (tokens,)
    clauses = []
    for start, end in zip([-1, *positions], [*positions, len(tokens)], strict=True):
        clauses.extend(_connect_conjuncts(tokens[start + 1 : end]))
    return clauses


def _connect_guard_fact(form, tokens):
    negated = bool(tokens and tokens[0].text == "not" and tokens[1:2] and tokens[1].kind == "LPAREN")
    if negated:
        inner = _connect_ungroup(tokens[1:])
        if inner == tokens[1:]:
            return None
        tokens = inner
    operators = [(i, t) for i, t in _connect_top_level(tokens) if t.kind in {"EQ", "NEQ"}]
    if len(operators) != 1:
        return None
    split, operator = operators[0]
    if negated and operator.kind != "EQ":
        return None
    left, right = _connect_ungroup(tokens[:split]), _connect_ungroup(tokens[split + 1 :])
    if len(left) == 1 and left[0].kind == "STR":
        left, right = right, left
    if len(right) != 1 or right[0].kind != "STR" or not left or len(left) % 2:
        return None
    if any(t.kind != ("SLASH" if i % 2 == 0 else "QNAME") for i, t in enumerate(left)):
        return None
    path = "".join(t.text for t in left)
    if form.in_repeat(path) or not any(_local(q) in {"input", "select1"} for q in form.question_controls(path)):
        return None
    bind = form.bind(path)
    if bind is not None and (bind.get("type") or "string").split(":")[-1] not in {"string", "select1"}:
        return None
    return path, right[0].text[1:-1], (operator.kind == "EQ") != negated


def _connect_guards(form, wrapper):
    """Only a scalar answer shared by the whole form rules out a pair of placements."""
    guards = []
    for node in (wrapper, *wrapper.iterancestors()):
        if node not in form.paths:
            break
        expr = _bind_text(form, node, "relevant")
        if not expr:
            continue
        for clause in _connect_conjuncts(xpath_tokens(expr) or ()):
            if tuple(t.text for t in clause) == ("false", "(", ")"):
                return None
            guard = _connect_guard_fact(form, clause)
            if guard is not None:
                guards.append(guard)
    return guards


def _connect_exclusive(guards):
    for i, (path, value, equal) in enumerate(guards):
        for other, v, eq in guards[i + 1 :]:
            if path == other and ((equal and eq and value != v) or (equal != eq and value == v)):
                return True
    return False


def _connect_entity(form, wrapper):
    leaf = wrapper.find(f"{{{CONNECT_NAMESPACE}}}deliver/{{{CONNECT_NAMESPACE}}}entity_id")
    if leaf is None:
        return None, None
    text = _bind_text(form, leaf, "calculate")
    parsed = xpath_tokens(text) or ()
    if not text:
        return leaf.text or "", leaf
    if len(parsed) == 1 and parsed[0].kind == "STR":
        return parsed[0].text[1:-1], leaf
    return None, leaf


def _connect_query_is_injective(form, value):
    """The worker's joined list is injective only where spaces cannot split an ID."""
    tokens = xpath_tokens(value) or ()
    if len(tokens) >= 6 and tuple(t.text for t in tokens[:2]) == ("join", "(") and tokens[2].kind == "STR":
        if tokens[2].text[1:-1] != " " or tokens[3].text != "," or tokens[-1].text != ")":
            return False
        tokens = _connect_ungroup(tokens[4:-1])
    if len(tokens) == 1 and tokens[0].kind == "STR":
        ids = tokens[0].text[1:-1].split(" ")
        return all(ids) and len(ids) == len(set(ids))
    tree = form.tree(value)
    joined = _call_of(tree, "join", 2)
    if joined is not None and joined[0] == ["text", " "]:
        tree = joined[1]
    if not isinstance(tree, list) or tree[:2] != ["path", "instance:casedb"]:
        return False
    case_type, start, end = _case_predicate_scope(tree)
    if case_type is None or len(tree[4]) != 3 or list(tree[4][-1]) != ["attribute", "case_id", 0]:
        return False
    for predicate in tree[3][start:end]:
        negated = _call_of(predicate, "not", 1)
        args = _call_of(negated[0], "contains", 2) if negated else None
        if args and _bare_read(args[0], "attribute") == "case_id" and args[1] == ["text", " "]:
            return True
    return False


def _model_setvalues(form):
    """The setvalues the model holds as its own children, whatever their event, in document order: what a
    Connect activity's row and recipient rules read of the values a form sets."""
    return [] if form.model is None else list(form.model.iterfind(f"{{{XFORMS}}}setvalue"))


def _connect_initial_value(form, path, event):
    writes = [action for action in _model_setvalues(form) if _held_ref(action) == path]
    if len(writes) == 1 and (writes[0].get("event") or "").split() == [event]:
        return writes[0].get("value") or ""
    return ""


def _connect_iteration_unique(form, container, row, attribute, repeats):
    outer = [p for p in repeats if p != form.paths[container]]
    counts = dict(form.counted_repeats)
    if any(_connect_count_limit(form, counts.get(p, "")) > 1 for p in outer) or _bind_text(form, row, "relevant"):
        return False
    base, item = form.paths[container], form.paths[row]
    current = form.bind(base + "/@current_index")
    if current is None or _token_texts(current.get("calculate") or "") != _token_texts(f"count({item})"):
        return False
    if _token_texts(_connect_initial_value(form, item + "/@index", "jr-insert")) != _token_texts(
        f"int({base}/@current_index)"
    ):
        return False
    if attribute == "index":
        return True
    if attribute != "id" or _token_texts(_connect_initial_value(form, item + "/@id", "jr-insert")) != _token_texts(
        f"selected-at({base}/@ids, ../@index)"
    ):
        return False
    return _connect_query_is_injective(
        form, _connect_initial_value(form, base + "/@ids", "jr-insert" if outer else "xforms-ready")
    )


def _connect_count_placement_unique(form, row, member, repeats):
    """A count-placement row stores its index at insertion. Its ID selects
    the same index from a space-separated query result. Inspect the row guard,
    the count's source and both writers of the ID before relying on either."""
    row_path = form.paths[row]
    wrapper = row.getparent()
    if wrapper not in form.paths or row_path not in repeats or _local(row) != "item":
        return False
    counts = dict(form.counted_repeats)
    if any(_connect_count_limit(form, counts.get(path, "")) > 1 for path in repeats if path != row_path):
        return False
    controls = [c for c in form.controls.get(row_path, ()) if _local(c) == "repeat"]
    if len(controls) != 1 or _token_texts(controls[0].get(f"{{{JAVAROSA}}}noAddRemove") or "") != ("true", "(", ")"):
        return False
    count_path = counts.get(row_path)
    count_node = form.node(count_path) if count_path else None
    if count_node is None or isinstance(count_node, tuple) or count_node.getparent() is not wrapper:
        return False
    count_bind = form.bind(count_path)
    if count_bind is None or (count_bind.get("type") or "").split(":")[-1] != "int":
        return False
    if _token_texts(_bind_text(form, row, "relevant")) != _token_texts(f"position() < ../{_local(count_node)}"):
        return False
    ids = _token_texts(count_bind.get("calculate") or "")
    if len(ids) != 6 or ids[:4] != ("count-selected", "(", "..", "/") or ids[-1] != ")":
        return False
    ids_node = form.node(form.paths[wrapper] + "/" + ids[4])
    if ids_node is None or isinstance(ids_node, tuple) or form.question_controls(form.paths[ids_node]):
        return False
    members = [node for node in row if isinstance(node.tag, str) and _local(node) == member]
    if len(members) != 1:
        return False
    node = members[0]
    path = form.paths[node]
    if form.question_controls(path) or (node.text or "").strip():
        return False
    bind = form.bind(path)
    if bind is None:
        return False

    def is_stored_index(node):
        bind = form.bind(form.paths[node])
        return (
            bind is not None
            and (bind.get("type") or "").split(":")[-1] == "int"
            and not bind.get("calculate")
            and not form.question_controls(form.paths[node])
            and _token_texts(_connect_initial_value(form, form.paths[node], "jr-insert"))
            == _token_texts("position(..)")
        )

    if is_stored_index(node):
        return True
    defaults = [action for action in _model_setvalues(form) if _held_ref(action) == path]
    if not _count_placement_row_id(form, node, path, bind, defaults):
        return False
    branches = _call_of(form.tree(bind.get("calculate")), "if", 3)
    selected = _call_of(branches[1], "selected-at", 2)
    actual_ids = _relative_read(selected[0], path)
    index_path = _relative_read(selected[1], path)
    index = form.node(index_path) if index_path else None
    return (
        actual_ids == form.paths[ids_node]
        and index is not None
        and not isinstance(index, tuple)
        and is_stored_index(index)
        and _connect_query_is_injective(form, _bind_text(form, ids_node, "calculate"))
    )


def _connect_recipient_unique(form, wrapper, repeats):
    """Read the native all-row constraint and bind from their wire addresses.
    Vellum's model iteration index is unique in the repeat that supplied it.
    A second varying outer repeat restarts those indices."""
    _, leaf = _connect_entity(form, wrapper)
    if leaf is None or not repeats:
        return False
    tokens = _token_texts(_bind_text(form, leaf, "calculate"))
    target = leaf
    while tokens[:2] == ("..", "/"):
        if target is None:
            return False
        target = target.getparent()
        tokens = tokens[2:]
    if target is None or target not in form.paths:
        return False
    parent = target.getparent()
    if len(tokens) == 2 and tokens[0] == "@" and parent in form.model_repeats and _local(target) == "item":
        return _connect_iteration_unique(form, parent, target, tokens[1], repeats)
    if len(tokens) == 1 and _connect_count_placement_unique(form, target, tokens[0], repeats):
        return True
    if len(repeats) != 1:
        return False
    repeat = form.node(repeats[0])
    if target is not repeat or len(tokens) != 1 or repeat.getparent() is not form.data_root:
        return False
    path = f"{repeats[0]}/{tokens[0]}"
    node = form.node(path)
    if node is None or node.text or _bind_text(form, repeat, "relevant") or _bind_text(form, node, "relevant"):
        return False
    bind = form.bind(path)
    if bind is None or (bind.get("type") or "string").split(":")[-1] != "string" or bind.get("calculate"):
        return False
    if any(_held_ref(action) == path for action in _model_setvalues(form)):
        return False
    if not any(_local(q) == "input" for q in form.question_controls(path)):
        return False
    if _token_texts(_bind_text(form, node, "required")) != ("true", "(", ")"):
        return False
    values = f"{repeats[0]}[true()]/{tokens[0]}"
    constraint = xpath_tokens(_bind_text(form, node, "constraint")) or ()

    # Normalize quote choice at the token level. Every nonempty separator
    # works, but both sides must use the same string and the same all-row path.
    def normalized(tokens):
        return tuple((t.kind, t.text[1:-1] if t.kind == "STR" else t.text) for t in tokens)

    for clause in _connect_conjuncts(constraint):
        literals = [t for t in clause if t.kind == "STR"]
        if len(literals) != 2 or not literals[0].text[1:-1] or literals[0].text[1:-1] != literals[1].text[1:-1]:
            continue
        separator = literals[0].text
        left = f"string-length(join({separator}, {values}))"
        right = f"string-length(join({separator}, distinct-values({values})))"
        alternatives = [normalized(xpath_tokens(f"{l} = {r}")) for l, r in ((left, right), (right, left))]
        if normalized(clause) in alternatives:
            return True
    return False


def connect_colliding_activities(kinds):
    """Classify the particular reached wrapper against the other occurrences in this submitted form."""

    def applies(use, manifest):
        part = _connect_part(use)
        if not part or part[1] is not part[2] or part[3] not in kinds or part[4] is None:
            return False
        form, node, wrapper, role, own = part
        repeats, limit = _connect_limits(form, wrapper)
        guards = _connect_guards(form, wrapper)
        if not limit or guards is None or _connect_exclusive(guards):
            return False
        for candidate in form.paths:
            other_role = candidate.get(f"{{{VELLUM}}}role")
            if other_role not in kinds or (len(kinds) > 1 and other_role == role):
                continue
            other = candidate.find(f"{{{CONNECT_NAMESPACE}}}{CONNECT_ROLES[other_role]}")
            if other is None:
                continue
            if candidate is wrapper:
                if limit == 1 or (role == "ConnectDeliverUnit" and _connect_recipient_unique(form, wrapper, repeats)):
                    continue
            _, other_limit = _connect_limits(form, candidate)
            other_guards = _connect_guards(form, candidate)
            if not other_limit or other_guards is None or _connect_exclusive(guards + other_guards):
                continue
            if len(kinds) == 1 and role != "ConnectAssessment" and own.get("id") != other.get("id"):
                continue
            if len(kinds) == 1 and role == "ConnectDeliverUnit" and candidate is not wrapper:
                first, _ = _connect_entity(form, wrapper)
                second, _ = _connect_entity(form, candidate)
                if first is not None and second is not None and first != second:
                    continue
            return True
        return False

    return applies


def form_name_read_as_an_instance(use, manifest):
    """``forms-and-case-writes/form-name-read-as-an-instance``: a form whose name in the app's default language
    (``Application.default_language``: the first of ``langs``, ``en`` where there is none) holds text CommCare HQ's
    build reads as an instance. That name is the text of the form's ``<h:title>`` and its data root's ``name``,
    which HQ's form builder writes from it on every save (``views/formdesigner.py::_get_vellum_core_context``,
    ``formName``), and ``XForm.add_missing_instances`` reads both in the whole rendered form (``xform.py``). A
    name in another language reaches only the app's strings, which that scan does not read. A name that holds no
    text in the default language does not say what the source's title holds: not settled here."""
    at = _json(use)
    if at is None or at.key != "name":
        return None
    names = at.value
    if not isinstance(names, dict):
        return None
    langs = at.app.doc.get("langs") or []
    name = names.get(langs[0] if langs else "en")
    if not isinstance(name, str):
        return None
    return INSTANCE_READ.search(name) is not None


def choice_value_read_as_an_instance(use, manifest):
    """``questions/choice-value-read-as-an-instance``: a choice's value holding text CommCare HQ's build reads as an
    instance, which ``XForm.add_missing_instances`` reads in the whole rendered form, a choice's ``<value>`` text
    among the rest (``xform.py``)."""
    form, element = _form_element(use)
    if form is None:
        return None
    item = element.getparent()
    if _local(element) != "value" or item is None or _local(item) != "item":
        return False
    select = item.getparent()
    if select is None or _local(select) not in SELECTS:
        return False
    return INSTANCE_READ.search(_choice_value(item)) is not None


def no_add_remove_without_count(use, manifest):
    """``questions/jr-noaddremove-without-jr-count``: a ``<repeat>`` with ``jr:noAddRemove`` and no ``jr:count``,
    which Vellum filters out (``mugs/types/group.js``, Repeat's ``controlChildFilter`` writes it only beside a
    count)."""
    form, element = _form_element(use)
    if form is None:
        return None
    if _local(element) != "repeat" or element.get(f"{{{JAVAROSA}}}noAddRemove") is None:
        return False
    return not (element.get(f"{{{JAVAROSA}}}count") or "").strip()


def user_repeat_in_field_list(use, manifest):
    """``questions/user-controlled-repeat-inside-a-question-list-…``: a ``<repeat>`` without a ``jr:count`` inside a
    group whose appearance is ``field-list`` in any case (Android reads such a group as the screen's host, comparing
    the whole appearance ignoring case, ``FormEntryController.isHostWithAppearance``, and cannot add rows there;
    Vellum asks a Repeat Count of a repeat in a Question List)."""
    form, element = _form_element(use)
    if form is None:
        return None
    if _local(element) != "repeat" or (element.get(f"{{{JAVAROSA}}}count") or "").strip():
        return False
    node = element.getparent()
    while node is not None and node is not form.body:
        if _local(node) == "group" and (node.get("appearance") or "").lower() == "field-list":
            return True
        node = node.getparent()
    return False


def _resolved(context, steps):
    """The path a location path's steps name from a node's path (``context``, as ``Form.paths`` writes one, or
    ``/`` for the document's root), each step as HQ's XPath grammar reads it (the observation's ``trees``): None
    where a step is other than the parent, the node itself, or a child or an attribute by name without a
    predicate (another axis, a node test, a predicate, a filter)."""
    names = [name for name in context.split("/") if name]
    for axis, test, predicates in steps:
        if predicates:
            return None
        if (axis, test) == ("parent", "node()"):
            if not names:
                return None
            names.pop()
        elif (axis, test) == ("self", "node()"):
            continue
        elif axis in ("child", "attribute") and test != "*" and not test.endswith(")"):
            names.append(f"@{test}" if axis == "attribute" else test)
        else:
            return None
    return "/" + "/".join(names)


def _node_path(form, node):
    """A main-instance node's path as ``Form.paths`` writes it (an attribute's as its element's and ``/@name``), or
    None."""
    if isinstance(node, tuple):
        held = form.paths.get(node[0])
        return None if held is None else f"{held}/@{node[1]}"
    return form.paths.get(node) if node is not None else None


def _tree_reads(form, text, context=None):
    """The main-instance paths an expression reads, by its structure as HQ's XPath grammar reads it (the
    observation's ``trees``): each path from the document's root, and each path from ``current()`` or relative
    path outside a predicate read from ``context`` (the path of the node the expression is evaluated at,
    ``_resolved``), with None in place of one whose steps this does not follow; None where the records hold no
    structure of the expression or it reads the form's nodes in a way this does not place."""
    tree = form.tree(text)
    if tree is None:
        return None
    found = []

    def walk(node, where):
        kind = node[0]
        if kind == "path":
            root, steps = node[1], node[4]
            if root == "absolute":
                found.append(_resolved("/", steps))
            elif (root == "relative" and where == "form") or root == "call:current":
                if context is None:
                    return False
                resolved = _resolved(context, steps)
                if resolved is None:
                    return False
                found.append(resolved)
            elif root == "relative" and where == "predicate":
                return False
            inner = "instance" if root.startswith("instance:") else "predicate"
            return all(walk(predicate, inner) for predicate in node[3])
        if kind == "binary":
            return walk(node[2], where) and walk(node[3], where)
        if kind == "negative":
            return walk(node[1], where)
        if kind == "call":
            return node[1] != "current" and all(walk(argument, where) for argument in node[2])
        return True

    return found if walk(tree, "form") else None


def _under_path(path, held):
    return path == held or path.startswith(f"{held}/")


def _reads_rows(form, text, rows, seen, context=None):
    """Whether an expression reads a node of the repeat whose rows are at ``rows`` (a node's path), directly,
    through a calculate it reads, or through another counted repeat whose rows it reads (that repeat's count):
    True, False, or None where a part it reads is not placed."""
    if text in seen:
        return False
    paths = _tree_reads(form, text, context)
    if paths is None:
        return None
    unsure = False
    seen = seen | {text}
    for path in paths:
        if path is None:
            unsure = True
            continue
        if _under_path(path, rows):
            return True
        if form.node(path) is None:
            unsure = True
            continue
        through = []
        bind = form.bind(path)
        if bind is not None and (bind.get("calculate") or "").strip():
            through.append((bind.get("calculate"), path))  # a calculate is evaluated at its bind's node
        for other, count in form.counted_repeats:
            held = _node_path(form, form.node(other))
            if held is None:
                unsure = True
            elif held != rows and _under_path(path, held):
                through.append((count, None))
        for expression, at in through:
            reads = _reads_rows(form, expression, rows, seen, at)
            if reads:
                return True
            unsure = unsure or reads is None
    return None if unsure else False


def count_reading_its_rows(use, manifest):
    """``questions/a-count-that-depends-on-the-rows-it-creates-…``: a ``jr:count`` that reads the rows its own
    repeat creates, directly, through the calculates it reads or through another counted repeat's rows, so Core
    keeps adding rows as entry moves on. Read over the count's and the calculates' structure as HQ's XPath grammar
    reads them (the observation's ``trees``, which hold each count and each calculate)."""
    form, element = _form_element(use)
    if form is None:
        return None
    if _local(element) != "repeat":
        return False
    count = element.get(f"{{{JAVAROSA}}}count")
    if count is None or not count.strip():
        return False
    rows = _node_path(form, form.node(element.get("nodeset")))
    if rows is None:
        return None
    return _reads_rows(form, count, rows, frozenset())


def _model_iteration(use):
    """The model iteration's container whose ``vellum:role`` a use sits on, with its form; (form, None) for
    another role's."""
    form, element = _form_element(use)
    if form is None:
        return None, None
    if element.get(f"{{{VELLUM}}}role") != "Repeat" or element not in form.paths:
        return form, None
    return form, element


def model_iteration_nested(use, manifest):
    """``questions/model-iteration-repeat-nested-in-another-repeat-of-any-kind``: a model iteration's container
    inside another repeat (a body ``<repeat>``'s rows, or another model iteration's)."""
    form, container = _model_iteration(use)
    if form is None:
        return None
    if container is None:
        return False
    def fixed_query(element):
        target = f"{form.paths[element]}/@ids"
        for assignment in form.model.iterfind(f"{{{XFORMS}}}setvalue"):
            if _held_ref(assignment) == target:
                args = _call_of(form.tree(assignment.get("value")), "join", 2)
                if args and args[1][0] == "text":
                    return args[1][1]
        return None

    def count_selected(text):
        # Core splits U+0020 runs, preserves a leading empty selection
        # and discards trailing empties. A tab is part of one selection.
        trimmed = text.rstrip(" ")
        return len(re.split(" +", trimmed)) if trimmed else 0

    own = fixed_query(container)
    if own is not None and count_selected(own) == 0:
        return False
    parent = container.getparent()
    while parent is not None and parent is not form.data_root:
        path = form.paths[parent]
        for control in form.controls.get(path, ()):
            if _local(control) != "repeat":
                continue
            # Model iteration's row count is its parent's captured query.
            wrapper = parent.getparent()
            if wrapper in form.model_repeats:
                members = fixed_query(wrapper)
                if members is not None and count_selected(members) <= 1:
                    continue
                return True
            # A count in Nova's wire names the scalar question or generated
            # hidden count. A literal calculation of zero or one cannot
            # create a second address. A worker-entered count can.
            count = control.get(f"{{{JAVAROSA}}}count")
            bind = form.bind(count) if count else None
            calculated = form.tree(bind.get("calculate")) if bind is not None and bind.get("calculate") else None
            if calculated is None or calculated[0] != "number" or calculated[1] not in (0,1):
                return True
        parent = parent.getparent()
    return False


def _load_setvalues(form):
    """The model's load-time setvalues in the order Core runs them (``xforms-ready``, in document order: README,
    "Load-time values"). What one sets is read through ``_held_ref``, as Nova's reader reads a form's load
    (``xform/loadOrder.ts::effectiveLoadOrder``): one Core reads otherwise than Nova writes sets no node here, its
    form being refused under the form-level setvalue's entry."""
    return [
        setvalue
        for setvalue in form.model.iterfind(f"{{{XFORMS}}}setvalue")
        if "xforms-ready" in (setvalue.get("event") or "").split()
    ]


def _iteration_ids(form, container):
    """The setvalue that snapshots the wrapper IDs, at ready or at its containing row's insertion."""
    target = f"{form.paths[container]}/@ids"
    return next((s for s in form.model.iterfind(f"{{{XFORMS}}}setvalue") if _held_ref(s) == target), None)


def _insertion_scope(form, path):
    """The nearest body repeat row that owns this concrete action."""
    return max(
        (
            row for row in form.repeat_paths
            if path and (path == row or path.startswith(row + "/"))
            and any(_local(control) == "repeat" for control in form.controls.get(row, ()))
        ),
        key=len, default=None,
    )


def _before_capture(form, assignment):
    event = assignment.get("event")
    scope = _insertion_scope(form, _held_ref(assignment))
    earlier = []
    for action in form.model.iterfind(f"{{{XFORMS}}}setvalue"):
        if action is assignment:
            break
        if action.get("event") == event and _insertion_scope(form, _held_ref(action)) == scope:
            earlier.append(action)
    return earlier


def _relevance(form, element):
    """The ``relevant`` of the bind Core applies to an element's path, or None."""
    bind = form.bind(form.paths.get(element))
    relevant = bind.get("relevant") if bind is not None else None
    return relevant.strip() if relevant and relevant.strip() else None


def model_iteration_under_late_relevance(use, manifest):
    """``questions/model-iteration-repeat-under-an-ancestor-that-core-s-load-can…``: a model iteration under an
    ancestor that Core's load can leave not relevant where its setvalues run, on an opening where the ancestor can
    become relevant later (README, "Load-time values": a node is relevant until its condition first runs, which an
    earlier load-time setvalue setting a node it reads makes it do; one written exactly ``false()`` is never
    relevant, so the repeat never shows). Each ancestor's condition is read over its structure as HQ's XPath grammar
    reads it (the observation's ``trees``, ``_hidden_at``)."""
    form, container = _model_iteration(use)
    if form is None:
        return None
    if container is None:
        return False
    ancestors = []
    node = container.getparent()
    while node is not None and node is not form.data_root:
        relevant = _relevance(form, node)
        if relevant == "false()":
            return False
        if relevant is not None:
            ancestors.append(node)
        node = node.getparent()
    if not ancestors:
        return False
    ids = _iteration_ids(form, container)
    if ids is None:
        return None
    earlier = _before_capture(form, ids)
    if not earlier:
        return False
    # A worker-dependent condition is an input; only proven suppression belongs to this refusal.
    return any(_hidden_at(form, ancestor, earlier) is True for ancestor in ancestors)


def _hidden_at(form, element, earlier):
    """Whether Core's load leaves an element with a relevance condition not relevant after the load-time setvalues
    ``earlier``, on an opening where it can become relevant later: True, False, or None where the records do not
    settle it. Its condition has run there where one of them set a node it reads (a calculated node it reads, or one
    under a condition, is not followed: None); its value there is read where every node it reads holds
    a value the load settles (``_condition_at``); and it can become relevant later where it reads an answer a
    question takes."""
    condition = form.bind(form.paths[element]).get("relevant")
    reads = _tree_reads(form, condition, form.paths[element])
    if reads is None or None in reads:
        return None
    nodes = [form.node(path) for path in reads]
    if None in nodes or any(_computed(form, path) for path in reads):
        return None  # a calculated node, or one under a condition, is not followed
    set_here = {form.node(_held_ref(setvalue)) for setvalue in earlier} - {None}
    if not any(node in set_here for node in nodes):
        return False  # its condition has not run where the iteration's setvalues run: relevant there
    value = _condition_at(form, form.tree(condition), form.paths[element], earlier)
    if value is None:
        return None
    if value:
        return False
    return any(form.question_controls(path) for path in reads)


def _condition_at(form, tree, context, earlier):
    """A condition's truth after the load-time setvalues ``earlier``, where it compares nodes those set to literals
    (``=``, ``!=``, ``and``, ``or``, ``not()``, ``true()``, ``false()``): True, False, or None for anything else."""
    if tree is None:
        return None
    kind = tree[0]
    if kind == "call" and tree[1] in ("true", "false") and not tree[2]:
        return tree[1] == "true"
    if kind == "call" and tree[1] == "not" and len(tree[2]) == 1:
        value = _condition_at(form, tree[2][0], context, earlier)
        return None if value is None else not value
    if kind != "binary":
        return None
    if tree[1] in ("and", "or"):
        sides = [_condition_at(form, side, context, earlier) for side in tree[2:]]
        if tree[1] == "and":
            return False if False in sides else None if None in sides else True
        return True if True in sides else None if None in sides else False
    if tree[1] not in ("=", "!=", ">", ">=", "<", "<="):
        return None
    values = [_value_at(form, side, context, earlier) for side in tree[2:]]
    if None in values:
        return None
    (left, left_number), (right, right_number) = values
    if tree[1] in (">", ">=", "<", "<="):
        try:
            l, r = float(left), float(right)
        except ValueError:
            return False
        return {">": l > r, ">=": l >= r, "<": l < r, "<=": l <= r}[tree[1]]
    if left_number or right_number:  # XPath compares as numbers where either side is one
        try:
            same = float(left) == float(right)
        except ValueError:
            same = False
    else:
        same = left == right
    return same if tree[1] == "=" else not same


def _value_at(form, tree, context, earlier):
    """A literal's text, or a node's value after the load-time setvalues ``earlier`` where the last of them to set
    it set a literal (``(text, whether it is a number)``); None otherwise."""
    if tree[0] == "text":
        return tree[1], False
    if tree[0] == "number":
        return str(tree[1]), True
    if tree[0] != "path":
        return None
    path = _resolved(context, tree[4]) if tree[1] in ("relative", "call:current") else None
    path = _resolved("/", tree[4]) if tree[1] == "absolute" else path
    node = form.node(path) if path is not None else None
    if node is None:
        return None
    for setvalue in reversed(earlier):
        if form.node(_held_ref(setvalue)) is node:
            value = form.tree(setvalue.get("value"))
            return _value_at(form, value, context, []) if value is not None and value[0] in ("text", "number") else None
    return None


def _blank_at_load(form, path, setvalue):
    """Whether a main-instance node an expression of a load-time setvalue reads is blank there on every opening
    (README, "Load-time values"): True, False, or None where the records do not settle it."""
    node = form.node(path)
    if node is None:
        return None
    element = _target_element(node)
    if _insertion_scope(form, path) != _insertion_scope(form, _held_ref(setvalue)):
        return False  # another page or an earlier row may already hold the worker's answer
    earlier = _before_capture(form, setvalue)
    if any(form.node(_held_ref(other)) == node for other in earlier):
        return False  # an earlier load-time setvalue gave it its value there
    holder = element
    conditions = False
    while holder is not None and holder is not form.data_root:
        relevant = _relevance(form, holder)
        if relevant == "false()":
            return True  # applied before the load: never relevant there
        conditions = conditions or relevant is not None
        holder = holder.getparent()
    if conditions and earlier:
        return None  # an earlier setvalue may have run a condition that hides it
    bind = form.bind(path)
    if bind is not None and (bind.get("calculate") or "").strip():
        return True if not earlier else None  # a calculate first runs after the load, unless an earlier one feeds it
    if isinstance(node, tuple):
        return not node[0].get(node[1])
    if _children(element):
        return True  # Core keeps no value on an element with children (XFormParser.loadInstanceData)
    return not "".join(element.itertext())  # instance text is its value at load; else entered, or set later


def model_iteration_reading_blank_answer(use, manifest):
    """``questions/model-iteration-repeat-whose-query-reads-a-form-answer-that-is…``: a model iteration whose query
    (its ``@ids`` load-time setvalue, ``modeliteration.js``) reads a form answer that is blank where that setvalue
    runs, on every opening: one entered in the form, one only a later setvalue (a later default, or HQ's build's
    appended values) sets, a calculated value no earlier setvalue feeds, or one under a condition written
    ``false()``. Read over the query's structure as HQ's XPath grammar reads it (the observation's ``trees``, which
    hold every load-time setvalue's value)."""
    form, container = _model_iteration(use)
    if form is None:
        return None
    if container is None:
        return False
    ids = _iteration_ids(form, container)
    if ids is None:
        return None
    args = _call_of(form.tree(ids.get("value")), "join", 2)
    if args is None:
        return None
    query = args[1]
    if query[0] != "path":
        return False
    if query[1] in ("absolute", "relative", "call:current") and not query[3]:
        context = "/" if query[1] == "absolute" else _node_path(form, form.node(_held_ref(ids)))
        path = _resolved(context, query[4])
        return bool(path) and _blank_at_load(form, path, ids) is True
    if query[1] != "instance:casedb" or not query[3] or list(query[3][0]) != ["text", "casedb"]:
        return False
    steps = query[4]
    if len(steps) != 3 or list(steps[0]) != ["child", "casedb", 0] or list(steps[1][:2]) != ["child", "case"] or list(steps[2]) != ["attribute", "case_id", 0]:
        return False
    for condition in query[3][1:]:
        if condition[:2] != ["binary", "="]:
            continue
        for key, read in (condition[2:], reversed(condition[2:])):
            if _bare_read(key, "attribute") != "case_id" or read[:2] != ["path", "absolute"] or read[3]:
                continue
            path = _resolved("/", read[4])
            if path and _blank_at_load(form, path, ids) is True:
                return True
    return False


def _itemset_read(use):
    """The actual form or Search itemset slot, parsed as a row-relative XPath by the proof parser."""
    from proof.checks.xpath_tree import tree

    if isinstance(use.at, JsonAt):
        item = use.at.nearest("Itemset")
        if item is None or use.at.key not in ("label", "value", "sort"):
            return None
        value = item.get(use.at.key)
    elif isinstance(use.at, XmlAt):
        element = use.at.element
        parent = element.getparent()
        if parent is None or _local(parent) != "itemset" or _local(element) not in ("label", "value", "sort"):
            return None
        value = element.get("ref")
    else:
        return None
    return tree(value) if isinstance(value, str) else None


# What ends a name step for every XPath reader of an itemset reference: whitespace, quotes and XPath's operator
# and delimiter characters. ``:`` is left out with them, as it may start a QName's local part.
_STEP_BREAKS = frozenset(" \t\r\n'\"/[]()@=<>!|*+,:$")


def _one_non_ascii_step(element):
    """For an itemset ``ref`` the proof's parser leaves unread because it holds a non-ASCII character (it reads ASCII
    alone, ``proof.rules._xpath``): whether it is no single child or ``@`` attribute step, the shape Vellum's
    ``itemset.js::validateRefWidget`` compares as a string with the table's fields and attributes. A text that is one
    such step is decided editable (False); whether Core reads its characters as a name is the business of
    ``expressions-and-data/tag-or-field-name-core-s-xpath-lexer-does-not-read-as-a-name-any``. Any other text
    stays undecided (None)."""
    if element is None or _local(element) not in ("label", "value", "sort"):
        return None
    ref = element.get("ref")
    if not isinstance(ref, str) or ref.isascii():
        return None
    name = ref[1:] if ref.startswith("@") else ref
    if not name or set(name) & _STEP_BREAKS:
        return None
    return False


def form_itemset_ref_uneditable(use, manifest):
    from proof.rules import _xpath

    form, element = _form_element(use)
    if form is None:
        return None
    read = _itemset_read(use)
    if read is None:
        return _one_non_ascii_step(element)
    if read[:2] == ("call", "jr:itext"):
        return False
    if read[:3] != ("path", None, None):
        return True
    steps = [step for step in read[3] if step[1] != "self"]
    if len(steps) != 1 or steps[0][1] not in ("child", "attribute"):
        return True
    # A literal opening bracket interrupts Vellum's predicate stripping.
    return any(tok.kind == "STR" and "[" in tok.text for tok in _xpath.tokens(element.get("ref")))


def itemset_label_itext(use, manifest):
    """``questions/itemset-label-jr-itext-field``: an itemset label whose ``ref`` calls ``jr:itext``, which Vellum's
    lookup table widget does not find among a table's fields (``itemset.js::validateRefWidget``). Read from Core's
    parse of the reference."""
    form, element = _form_element(use)
    if form is None:
        return None
    itemset = element.getparent()
    if _local(element) != "label" or itemset is None or _local(itemset) != "itemset" or element.get("ref") is None:
        return False
    parsed = form.parsed(element.get("ref"))
    if parsed is None or "error" in parsed:
        return None
    return "jr:itext" in parsed["functions"]


# The case types Vellum's SaveToCase refuses to create, close or link (``commcare-user``) or to name at all.
USER_CASE_TYPE, RESERVED_SAVE_TO_CASE_TYPE = "commcare-user", "user-owner-mapping-case"


def _quoted(text):
    """The text between a pair of quotes around the whole of a value, as Vellum's SaveToCase reads a create's case
    type (``saveToCase.js``: ``/^(['"])(.*)\\1$/``), or None."""
    if len(text) >= 2 and text[0] in "'\"" and text[-1] == text[0] and not set(text) & JS_LINE_TERMINATORS:
        return text[1:-1]
    return None


def reserved_save_to_case_type(use, manifest):
    """``questions/savetocase-create-close-or-link-of-commcare-user-or-type-user``: a SaveToCase node whose case type
    is ``user-owner-mapping-case``, or ``commcare-user`` where it creates, closes or links that case (its case holds
    a ``create``, ``close`` or ``index``), which Vellum marks as an error (``saveToCase.js``'s ``case_type``
    validation). The case type is the one Vellum reads: a create's quoted ``case_type`` calculate where one is
    written, else ``vellum:case_type``; a create whose ``case_type`` is an expression is no case type it checks."""
    form, element = _form_element(use)
    if form is None:
        return None
    if element.get(f"{{{VELLUM}}}role") != "SaveToCase" or element not in form.paths:
        return False
    case = element.find(f"{{{CASE}}}case")
    case_type = element.get(f"{{{VELLUM}}}case_type") or ""
    bind = form.bind(f"{form.paths[element]}/case/create/case_type")
    calculate = bind.get("calculate") if bind is not None else None
    if calculate:
        quoted = _quoted(calculate)
        if not quoted:
            return False  # an expression: the case type Vellum shows in its expression field, which it does not check
        case_type = quoted
    if case_type == RESERVED_SAVE_TO_CASE_TYPE:
        return True
    if case_type != USER_CASE_TYPE or case is None:
        return False
    return any(case.find(f".//{{{CASE}}}{action}") is not None for action in ("create", "close", "index"))


# Binds -------------------------------------------------------------------------------


def _bind(use):
    """The bind a use sits on (its element or one of its attributes), with its form and the node its nodeset names
    (None where it names none)."""
    form, element = _form_element(use)
    if form is None or _local(element) != "bind" or element.getparent() is not form.model:
        return form, None, None
    if not (element.get("nodeset") or "").strip():
        return form, None, None
    return form, element, form.node(element.get("nodeset"))


def relevance_on_save_to_case(use, manifest):
    """``questions/relevance-bound-on-the-savetocase-node-itself``: a bind ``relevant`` on a SaveToCase node, which
    Vellum discards (``saveToCase.js``: its ``getBindList`` writes the node's own binds)."""
    form, bind, node = _bind(use)
    if bind is None:
        return None if form is None else False
    return node is not None and not isinstance(node, tuple) and node.get(f"{{{VELLUM}}}role") == "SaveToCase"


def constraint_in_save_to_case(use, manifest):
    """``questions/constraint-on-savetocase-case-leaves``: a bind ``constraint`` on a node inside a SaveToCase node's
    case block, which Vellum drops (its SaveToCase writes no constraint)."""
    form, bind, node = _bind(use)
    if bind is None or node is None:
        return None if form is None else False
    element = _target_element(node)
    held = form.holder(element)
    return held is not None and held[0] == "save-to-case" and (held[1] is not element or isinstance(node, tuple))


def live_create_id(use, manifest):
    """``questions/create-case-id-live-calculate-outside-a-repeat``: a bind ``calculate`` on the ``@case_id`` of a
    SaveToCase node that creates its case outside any repeat, which Vellum rewrites to a load-time setvalue
    (``saveToCase.js::getSetValues``)."""
    form, bind, node = _bind(use)
    if bind is None:
        return None if form is None else False
    if not isinstance(node, tuple) or node[1] != "case_id":
        return False
    case = node[0]
    holder = case.getparent()
    if case.tag != f"{{{CASE}}}case" or holder is None or holder.get(f"{{{VELLUM}}}role") != "SaveToCase":
        return False
    return _creates(holder) and not form.in_repeat(form.paths[holder])


def write_and_close(use, manifest):
    """A Close Condition on a SaveToCase block that also changes the case."""
    form, bind, close = _bind(use)
    if form is None:
        return None
    if bind is None or close is None or isinstance(close, tuple) or close.tag != f"{{{CASE}}}close":
        return False
    case = close.getparent()
    holder = case.getparent()
    return (
        holder.get(f"{{{VELLUM}}}role") == "SaveToCase"
        and any(case.find(f"{{{CASE}}}{facet}") is not None for facet in ("create", "update", "index"))
    )


def exact_create_id(use, manifest):
    """The create's authored ready action or repeat-row bind supplies a case ID."""
    form, setvalue = _setvalue(use)
    if form is not None and setvalue is not None:
        target = _target(form, setvalue)
        holder = _save_to_case_create_id(form, setvalue, target)
        if holder is None or form.in_repeat(form.paths[holder]) or setvalue.get("event") != "xforms-ready":
            return False
        value = (setvalue.get("value") or "").strip()
        if value in ("", "''", '""', "uuid()"):
            return False
        if form.node(value) is not None:
            return any(
                step.get("ref") == value and step.get("event") == "xforms-ready"
                and (step.get("value") or "").strip() not in ("", "''", '""')
                for step in setvalue.itersiblings(preceding=True)
                if step.tag == f"{{{XFORMS}}}setvalue"
            )
        return True
    form, bind, target = _bind(use)
    if form is None:
        return None
    if bind is None or not isinstance(target, tuple) or target[1] != "case_id":
        return False
    holder = target[0].getparent()
    if holder is None or holder.get(f"{{{VELLUM}}}role") != "SaveToCase" or not _creates(holder):
        return False
    value = (bind.get("calculate") or "").strip()
    if "nova-case-v1:" in value:
        return None  # The derived-key envelope has a separate judgment.
    return form.in_repeat(form.paths[holder]) and bool(value) and value != "uuid()"


def conditioned_create_owner(use, manifest):
    """Fresh create has its own relevance on the owner leaf."""
    form, bind, node = _bind(use)
    if form is None:
        return None
    if bind is None or node is None or isinstance(node, tuple) or not bind.get("relevant"):
        return False
    create = node.getparent()
    if node.tag != f"{{{CASE}}}owner_id" or create is None or create.tag != f"{{{CASE}}}create":
        return False
    case = create.getparent()
    holder = case.getparent() if case is not None else None
    if holder is None or holder.get(f"{{{VELLUM}}}role") != "SaveToCase":
        return False
    id_path = f"{form.paths[holder]}/case/@case_id"
    id_bind = form.bind(id_path)
    if id_bind is not None:
        return (id_bind.get("calculate") or "").strip() == "uuid()"
    return any(
        setvalue.get("ref") == id_path and (setvalue.get("value") or "").strip() == "uuid()"
        for setvalue in form.model.findall(f"{{{XFORMS}}}setvalue")
    )


def _savetocase_index_at(use):
    form, element = _data_node(use)
    if form is None or element is None:
        return form, None, None
    holder = form.holder(element)
    if holder is None or holder[0] != "save-to-case":
        return form, None, None
    case = holder[1].find(f"{{{CASE}}}case")
    if case is None:
        return form, None, None
    return form, case, case.find(f"{{{CASE}}}index")


def index_name_adds_action(use, manifest):
    form, case, index = _savetocase_index_at(use)
    if form is None:
        return None
    return index is not None and any(
        index.find(f"{{{CASE}}}{action}") is not None and case.find(f"{{{CASE}}}{action}") is None
        for action in ("create", "close")
    )


def index_period_loses_bind(use, manifest):
    form, _, index = _savetocase_index_at(use)
    if form is None:
        return None
    return index is not None and any("." in _local(link) for link in index)


# The body controls a question shows (XFormParser's question handlers; a group or repeat is no question Vellum
# offers a Calculate Condition on).
SHOWN_CONTROLS = frozenset({"input", "secret", "select", "select1", "trigger", "upload", "range"})


def calculate_on_shown_question(use, manifest):
    """``questions/bind-calculate-on-a-visible-question``: a bind ``calculate`` on a node a body question control
    names, a Calculate Condition Vellum shows only where it is already present (``visible_if_present``)."""
    form, bind, node = _bind(use)
    if bind is None:
        return None if form is None else False
    return any(_local(control) in SHOWN_CONTROLS for control in form.controls.get(bind.get("nodeset").strip(), ()))


def attribute_bind_no_plugin_owns(use, manifest):
    """``questions/bind-on-an-attribute-path-not-owned-by-a-plugin-…``: a bind on an attribute of the main instance
    outside a SaveToCase node and a model iteration, which Vellum discards ("Bind Node … will be discarded",
    ``parser.js::parseBindElement``: no question holds the path). A nodeset naming no node is not placed here."""
    form, bind, node = _bind(use)
    if bind is None:
        return None if form is None else False
    if node is None:
        return None
    if not isinstance(node, tuple):
        return False
    owner = node[0]
    held = form.holder(owner)
    if held is not None and held[0] == "save-to-case":
        return False
    parent = owner.getparent()
    return not (owner in form.model_repeats or (_local(owner) == "item" and parent in form.model_repeats))


def validation_on_hidden_value(use, manifest):
    """Vellum's DataBindOnly has no constraintAttr. Only a bodyless authored leaf is that question."""
    form, bind, node = _bind(use)
    if form is None:
        return None
    if bind is None or node is None or isinstance(node, tuple) or use.at.attribute != "constraint":
        return False
    return (
        node in form.vellum_nodes
        and form.vellum_nodes[node] is None
        and not _children(node)
        and not form.question_controls(bind.get("nodeset"))
    )


def bind_on_data_root(use, manifest):
    """``questions/bind-whose-path-names-the-data-root-itself-data-data-or-a``: a bind whose nodeset names the data
    root itself, which Core applies to the root (``XFormParser.getAbsRef`` resolves a relative path from it), so its
    ``relevant`` hides the whole form: ``/data``, or the spellings ``/data/.``, ``.`` and ``./.``, which name the
    root and no node here. Any other nodeset that names no node here is not settled by the export alone."""
    form, bind, node = _bind(use)
    if bind is None:
        return None if form is None else False
    if node is not None:
        return node is form.data_root
    root = form.paths.get(form.data_root)
    return True if bind.get("nodeset").strip() in {f"{root}/.", ".", "./."} else None


def second_default(use, manifest):
    """``questions/a-second-default-setvalue-on-one-question``: a setvalue Vellum reads as a question's Default
    Value after another one on the same question, of which its parser keeps only one (``parser.js::parseSetValue``,
    each one replacing the question's ``defaultValue``)."""
    form, setvalue = _setvalue(use)
    if form is None:
        return None
    if setvalue is None:
        return False  # an event on another element of the form, no setvalue
    target = _target(form, setvalue)
    if target is None:
        return _unplaced_target(form, setvalue)
    if not _default_value(form, setvalue, target):
        return False
    for other in form.model.iterfind(f"{{{XFORMS}}}setvalue"):
        if other is setvalue:
            return False
        held = _target(form, other)
        if held is not None and held == target and _default_value(form, other, held):
            return True
    return False


def order_a_save_changes(use, manifest):
    """``questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes``: a setvalue Vellum reads as a
    question's Default Value that stands, among the defaults of its event, in another order than its question stands
    in the data tree, beside a default it reads or that reads it: a save writes each question's default in data-tree
    order (``writer.js::createSetValues``), which changes what the reading default finds when the form loads
    (``ActionController.java::triggerActionsFromEvent`` runs one event's actions in the model's order). None where a
    value of such a pair reads the form's nodes in a way ``_tree_reads`` does not place."""
    form, setvalue = _setvalue(use)
    if form is None:
        return None
    if setvalue is None:
        return False  # an event on another element of the form, no setvalue
    target = _target(form, setvalue)
    if target is None:
        return _unplaced_target(form, setvalue)
    if not _default_value(form, setvalue, target):
        return False
    tree_order = {element: index for index, element in enumerate(form.data_root.iter())}
    model = list(form.model.iterfind(f"{{{XFORMS}}}setvalue"))
    mine = _target_element(target)
    my_path = form.paths.get(mine)
    my_reads = _tree_reads(form, setvalue.get("value") or "", my_path)
    unsure = False
    for other in model:
        if other is setvalue or other.get("event") != setvalue.get("event"):
            continue
        held = _target(form, other)
        if held is None or not _default_value(form, other, held):
            continue
        theirs = _target_element(held)
        if (model.index(other) < model.index(setvalue)) == (tree_order.get(theirs, 0) < tree_order.get(mine, 0)):
            continue
        their_path = form.paths.get(theirs)
        their_reads = _tree_reads(form, other.get("value") or "", their_path)
        if my_reads is None or their_reads is None:
            unsure = True
            continue
        if their_path in my_reads or my_path in their_reads:
            return True
    return None if unsure else False


def data_root_ui_version(use, manifest):
    """``questions/data-root-uiversion-other-than-1-or-absent``: the main instance's data root without a
    ``uiVersion`` of ``1`` (none, or another), which a Vellum save writes as ``1`` (``parser.js``, ``writer.js``)."""
    form, element = _form_element(use)
    if form is None:
        return None
    if element is not form.data_root:
        return False
    return element.get("uiVersion") != "1"


def _resolve_hashtags(form, tree):
    """A required condition's structure with each hashtag replaced by the structure of the XPath Vellum reads it
    as (``_hashtag_path``), or None where one is not placed."""
    kind = tree[0]
    if kind == "hashtag":
        return _hashtag_path(form, tree[1])
    if kind == "binary":
        sides = [_resolve_hashtags(form, side) for side in tree[2:]]
        return None if None in sides else ["binary", tree[1], *sides]
    if kind == "negative":
        operand = _resolve_hashtags(form, tree[1])
        return None if operand is None else ["negative", operand]
    if kind == "call":
        arguments = [_resolve_hashtags(form, argument) for argument in tree[2]]
        return None if None in arguments else ["call", tree[1], arguments]
    if kind == "path":
        predicates = [_resolve_hashtags(form, predicate) for predicate in tree[3]]
        return None if None in predicates else ["path", tree[1], tree[2], predicates, tree[4]]
    return tree


def _hashtag_path(form, hashtag):
    """The structure of the XPath Vellum reads a hashtag as (``xpath.js::hashtagToXPath``: the form's hashtag map,
    else its prefix's transform), a location path; None where it reads it as none, or as no path (Vellum then
    writes the hashtag itself, or text this does not compare). The map holds each question's own
    (``Form.mug_hashtags``), over the head's ``vellum:hashtags``; a transform appends the hashtag's last segment to
    its prefix's XPath (``vellum:hashtagTransforms``; Vellum splits a hashtag at its last ``/``)."""
    path = form.mug_hashtags.get(hashtag)
    if path is not None:
        steps = [["child", name, 0] for name in path.split("/") if name]
        return ["path", "absolute", path, [], steps]
    mapped, prefixes = form.vellum_hashtags
    text = mapped.get(hashtag)
    if not (isinstance(text, str) and text):
        prefix, _, segment = hashtag.rpartition("/")
        value = prefixes.get(f"{prefix}/")
        text = value + segment if isinstance(value, str) and segment else None
    tree = form.tree(text)
    return tree if tree is not None and tree[0] == "path" else None


def required_condition_differing(use, manifest):
    """``questions/requiredcondition-differing-from-a-present-non-false-required``: a bind whose ``required`` is
    present and not ``false()`` and whose Vellum ``requiredCondition`` reads otherwise, so a Vellum save rewrites
    ``required`` to it (``parser.js::parseBindElement`` reads the condition first; ``defaultOptions.js::getBindList``
    writes ``required`` from it, ``util.js::writeHashtags`` as the XPath its hashtags stand for). The condition is
    read as Vellum reads it, its hashtags standing for the XPath ``_hashtag_path`` gives (the observation's
    ``conditions``: HQ's XPath grammar with Vellum's hashtag production), and compared with ``required`` by
    structure (``_shape``): the same structure is the same condition, however each is spelled."""
    form, bind, _ = _bind(use)
    if bind is None:
        return None if form is None else False
    # The condition Vellum reads: its ``vellum:`` spelling, else the bare one the form builder also writes
    # (``parser.js::parseVellumAttrs``), which the observation reads no hashtags of, so that one is not settled.
    condition = bind.get(f"{{{VELLUM}}}requiredCondition") or bind.get("requiredCondition")
    required = bind.get("required")
    # parser.js::parseBoolAttributeValue: Vellum reads a required that is false() (lowercased, its white space
    # removed) or empty as not required, and writes it as false() whatever the condition.
    if condition is None or required is None or "".join(required.lower().split()) in ("", "false()"):
        return False
    if form.readings is None:
        return None
    held, expected = form.readings.conditions.get(condition), form.tree(required)
    if held is None or expected is None:
        return None
    resolved = _resolve_hashtags(form, held)
    if resolved is None:
        return None
    return _shape(resolved) != _shape(expected)


def message_without_condition(use, manifest):
    """``questions/validation-message-without-a-validation-condition``: a bind with a ``jr:constraintMsg`` and no
    ``constraint``, which Vellum marks as an error (``javaRosa/plugin.js::validateConstraintMsgAttr`` for a message
    with content, the ``constraintMsgItext`` validation for one it did not name itself; ``baseSpecs.js`` for a
    literal one). A message naming a text (``_itext_id``, over its structure as HQ's XPath grammar reads it) that
    holds no content in any language passes Vellum's checks where its id is the one Vellum makes for it, which
    this does not read: not settled here."""
    form, bind, _ = _bind(use)
    if bind is None:
        return None if form is None else False
    message = bind.get(f"{{{JAVAROSA}}}constraintMsg")
    if message is None or (bind.get("constraint") or "").strip():
        return False
    parsed = form.parsed(message)
    if parsed is None:
        return None
    if "error" not in parsed and "jr:itext" in parsed["functions"]:
        tree = form.tree(message)
        if tree is None:
            return None
        text_id = _itext_id(tree)
        if text_id is not None and text_id in form.itext_ids and form.itext_blank(text_id):
            return None
    return True


def literal_validation_message(use, manifest):
    """``questions/literal-jr-constraintmsg-text-no-itext``: a ``jr:constraintMsg`` that is not a ``jr:itext()``
    call on a string, which Vellum keeps only as its hidden ``constraintMsgAttr`` (``javaRosa/plugin.js``:
    ``getITextID`` takes the id of a ``jr:itext`` call alone). Read from Core's parse of the message."""
    form, bind, _ = _bind(use)
    if bind is None:
        return None if form is None else False
    message = bind.get(f"{{{JAVAROSA}}}constraintMsg")
    if message is None:
        return False
    parsed = form.parsed(message)
    if parsed is None:
        return None
    if "error" in parsed:
        return True
    if bind in form.protected_constraint_messages:
        return False
    return not (parsed["functions"] == ["jr:itext"] and parsed["expressions"] == ["XPathStringLiteral"])


def authored_readonly(use, manifest):
    """``questions/bind-readonly``: every readonly except a protected message's exact technical carrier.

    Core's ``processStandardBindAttributes`` accepts readonly; Vellum retains it only in raw bind
    attributes (``parser.js::parseBindElement``, ``writer.js::getBindList``). Nova derives this one
    carrier, whereas an authored readonly remains outside Nova's vocabulary.
    """
    form, bind, node = _bind(use)
    if bind is None:
        return None if form is None else True
    if form.readings is None:
        if (
            node is not None
            and not isinstance(node, tuple)
            and _local(node).startswith("nova_constraint_message_")
            and bind.get("readonly") == "true()"
            and bind.get("relevant") == "false()"
            and bind.get("type") == "xsd:string"
        ):
            return None  # a possible technical carrier still needs its owning message's recorded parse
        return True
    return not any(carrier is bind for carrier, _ in form.protected_constraint_messages.values())


# Itext -------------------------------------------------------------------------------


def _itext_value(use):
    """The itext ``<value>`` a use sits on (the element, or its ``form``), with its form; (form, None) otherwise."""
    form, element = _form_element(use)
    if form is None:
        return None, None
    text = element.getparent()
    translation = text.getparent() if text is not None else None
    if translation is None or (_local(element), _local(text), _local(translation)) != ("value", "text", "translation"):
        return form, None
    return form, element


def _inner(element):
    """An element's content as written: its text and its children with their tails."""
    return (element.text or "") + "".join(etree.tostring(child, encoding=str) for child in element)


# The texts no runtime reads a ``markdown`` value of: a hint (``FormEntryPrompt.getHintText``) and a validation
# message, by the body's ``<alert>`` or the bind's ``jr:constraintMsg`` (``FormEntryPrompt.getConstraintText``),
# each asking for no form. Their copies are ``questions/hint-markdown-form``'s and
# ``questions/validation-message-markdown-form``'s, INERT whether they equal the text or differ from it.
UNREAD_MARKDOWN_KINDS = frozenset({"hint", "alert", "message"})


def markdown_differing(use, manifest):
    """``questions/markdown-form-differing-from-the-default-text``: a ``markdown`` value whose content differs from
    its text's default value in the same language, on a label, a choice or a help text, which a Vellum save
    replaces with it (``javaRosa/plugin.js::loadXML`` loads the markdown value as the default text, and the writer
    writes both from it). A text holding no default value has none to differ from: not settled here. A text every
    question reference names as a hint or a validation message is the INERT entries' (``UNREAD_MARKDOWN_KINDS``)."""
    form, value = _itext_value(use)
    if form is None:
        return None
    if value is None or value.get("form") != "markdown":
        return False
    plain = [other for other in _children(value.getparent()) if _local(other) == "value" and other.get("form") is None]
    if not plain:
        return None
    if _inner(plain[0]) == _inner(value):
        return False
    kinds, unplaced = form.itext_references
    held = kinds.get(value.getparent().get("id"))
    if held is not None and held <= UNREAD_MARKDOWN_KINDS:
        return False
    if held is None and unplaced:
        return None
    return True


def markdown_in_some_languages(use, manifest):
    """``questions/a-label-with-a-markdown-form-in-some-languages-only-…``: a ``markdown`` value for a text whose
    entry in another language holds no ``markdown`` value or no value of its own, where the languages show two texts:
    the default translation holds no ``markdown`` value of the text, an entry holds one beside no value of its own
    and other than the default's value, or an entry without one holds a value other than the default's ``markdown``
    value and not a blank the form builder fills from the default's text. Core lays the default language's keys under
    each language's own (``Localizer.getLocaleData``, the form's ``new Localizer(true, true)``), so a language without
    the copy shows the default's copy and its own value where a runtime reads the text without its form (Android's
    hierarchy, ``getLongText``), and a language without the value the default's value; only where these differ do
    the languages show two texts; the rest of the class is
    ``questions/a-markdown-form-in-some-languages-only-each-other-language-holding-the-default-s``, HELD.

    The translations read are the reader's (``lib/commcare/reader/xform/itext.ts``): where an app JSON carries the
    form, those of its ``langs``, a removed language's left to ``translation-for-a-language-not-in-langs``, and the
    default is the first language's where the form holds it, else the first held, as HQ's build marks it
    (``xform.py::XForm.exclude_languages``, ``set_default_language(langs[0])``); a form outside an app JSON says only
    its own translations, and its default is ``FormFile.default_translation``."""
    form, value = _itext_value(use)
    if form is None:
        return None
    if value is None or value.get("form") != "markdown":
        return False
    text_id = value.getparent().get("id")
    translations = list(form.translations)
    default_translation = form.default_translation
    if form.app_form is not None:
        app, _ = form.app_form
        langs = [lang for lang in app.doc.get("langs") or [] if isinstance(lang, str)]
        if langs:
            if value.getparent().getparent().get("lang") not in langs:
                return False
            translations = [translation for translation in translations if translation.get("lang") in langs]
            first = [translation for translation in translations if translation.get("lang") == langs[0]]
            default_translation = (first or translations or [None])[0]

    def values_of(translation):
        """The text's default and ``markdown`` values in one translation, or None where it holds no entry."""
        for entry in _children(translation) if translation is not None else ():
            if _local(entry) == "text" and entry.get("id") == text_id:
                values = [held for held in _children(entry) if _local(held) == "value"]
                plain = next((held for held in values if held.get("form") is None), None)
                copy = next((held for held in values if held.get("form") == "markdown"), None)
                return plain, copy
        return None

    def blank(element):
        return not (element.text or "").strip() and not _children(element)

    entries = [
        held for held in (values_of(other) for other in translations) if held is not None and held != (None, None)
    ]
    if all(plain is not None and copy is not None for plain, copy in entries):
        return False
    default = values_of(default_translation)
    if default is None or default[0] is None or default[1] is None:
        return True
    default_plain, default_copy = default
    for plain, copy in entries:
        if plain is None and _inner(copy) != _inner(default_plain):
            return True
        if (
            plain is not None
            and copy is None
            and _inner(plain) != _inner(default_copy)
            and not (blank(plain) and not blank(default_plain))
        ):
            return True
    return False


def blank_in_the_first_language(use, manifest):
    """``questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text``: an empty ``<value>``
    in the app's first language, Vellum's default (``views/formdesigner.py``: ``'langs': app.langs``;
    ``javaRosa/plugin.js``: ``Itext.setDefaultLanguage(langs[0])``), where another app language's value of the same
    text and form holds content, so a Vellum save fills it from that language
    (``javaRosa/itext.js::getValueOrDefault``). A blank value in any other language is the HELD entry's, read as no
    translation. Read on a form the app JSON carries, whose ``langs`` say it; a form outside an app JSON does not
    say: None."""
    form, value = _itext_value(use)
    if form is None:
        return None
    if value is None or value.text or _children(value):
        return False
    if form.app_form is None:
        return None
    app, _ = form.app_form
    langs = [lang for lang in app.doc.get("langs") or [] if isinstance(lang, str)]
    if not langs:
        return None
    text = value.getparent()
    translation = text.getparent()
    if translation.get("lang") != langs[0]:
        return False
    for other in form.translations:
        if other is translation or other.get("lang") not in langs:
            continue
        for entry in _children(other):
            if _local(entry) == "text" and entry.get("id") == text.get("id"):
                for held in _children(entry):
                    if (
                        _local(held) == "value"
                        and held.get("form") == value.get("form")
                        and (held.text or _children(held))
                    ):
                        return True
    return False


def markdown_with_formatting_off(use, manifest):
    """``questions/a-markdown-form-in-a-form-whose-text-formatting-is-off``: a ``markdown`` value of a label, a
    choice or a help text in a form whose ``vellum:ignore`` holds ``markdown`` (``parser.js``, split on spaces),
    which the form builder's next save drops: it writes the copy only where the form's ``noMarkdown`` is off
    (``javaRosa/plugin.js::contributeToModelXML``). A text every question reference names as a hint or a validation
    message is the INERT entries' (``UNREAD_MARKDOWN_KINDS``)."""
    form, value = _itext_value(use)
    if form is None:
        return None
    if value is None or value.get("form") != "markdown":
        return False
    if "markdown" not in (form.root.get(f"{{{VELLUM}}}ignore") or "").split(" "):
        return False
    kinds, unplaced = form.itext_references
    held = kinds.get(value.getparent().get("id"))
    if held is not None and held <= UNREAD_MARKDOWN_KINDS:
        return False
    if held is None and unplaced:
        return None
    return True


def _itext_text(use):
    """The itext ``<text>`` whose ``id`` a use sits on, with its form; (form, None) otherwise."""
    form, element = _form_element(use)
    if form is None:
        return None, None
    translation = element.getparent()
    if _local(element) != "text" or translation is None or _local(translation) != "translation":
        return form, None
    return form, element


def itext_read_only_in_expressions(use, manifest):
    """``questions/itext-entry-referenced-only-from-jr-itext-in-an-expression``: a text id no question references
    (``Form.question_itext``: its controls' label, hint, help, alert and repeat caption, its choices' labels and its
    binds' validation messages, each as Vellum's ``getITextID`` reads it) that an expression's ``jr:itext()`` reads,
    which Vellum drops (an itext item is written only where a question holds it,
    ``javaRosa/util.js::getItextItemsFromMugs``). The ids an expression reads are its ``jr:itext`` calls' string
    arguments, over its structure as HQ's XPath grammar reads it (``Form.itext_reads``)."""
    form, text = _itext_text(use)
    if form is None:
        return None
    if text is None:
        return False
    text_id = text.get("id")
    held, unplaced = form.question_itext
    if text_id in held:
        return False
    if unplaced:
        return None
    reads = form.itext_reads
    if reads is None:
        return None
    ids, unsure = reads
    if text_id in ids:
        return True
    return None if unsure else False


# The itext ids a runtime reads as a form's pragmas (commcare-core FormMetaIndicatorUtil.FORM_DESCRIPTOR;
# formplayer FormSession.getPragma's keys).
PRAGMA_IDS = frozenset(
    {
        "Pragma-Form-Descriptor",
        "Pragma-Skip-Full-Form-Validation",
        "Pragma-Submit-Automatically",
        "Pragma-Suppress-Autosync",
        "Pragma-Volatility-Key",
        "Pragma-Volatility-Entity-Title",
        "Pragma-Volatility-Window",
    }
)


def unreferenced_pragma(use, manifest):
    """``questions/itext-pragma-entries-…``: a text whose id is a pragma key and that no question references
    (``Form.question_itext``), which Vellum drops as unreferenced itext."""
    form, text = _itext_text(use)
    if form is None:
        return None
    if text is None or text.get("id") not in PRAGMA_IDS:
        return False
    held, unplaced = form.question_itext
    if text.get("id") in held:
        return False
    return None if unplaced else True


# Appearances (the controls' ``appearance`` attributes) -----------------------------------------


def _control_appearance(use):
    form, element = _form_element(use)
    if form is None:
        return None, None, None
    value = element.get("appearance")
    if value is None or form.body is None or element not in form.body_elements:
        return form, None, None
    return form, element, value


def appearance_whitespace_read_otherwise(use, manifest):
    """``questions/an-appearance-holding-such-whitespace-that-some-runtime-reads…``: an appearance whose whitespace
    some runtime's read of that element takes otherwise than its single-spaced form: a read the surface records
    acts on the one and not the other (``AppearanceRule``, ``element_facts``; Android's whole-string match of
    ``minimal`` with a trailing space, Web Apps' tokens split on a space)."""
    form, element, value = _control_appearance(use)
    if element is None:
        return None if form is None else False
    spaced = " ".join(value.split())
    if spaced == value:
        return False
    facts = element_facts(manifest, form, element)
    return any(
        appearance_matches(value, rule) != appearance_matches(spaced, rule)
        for rule in appearance_rules(manifest)
        if rule.reads(facts)
    )


def appearance_words(manifest, document, element, value, readers=None):
    """What the runtimes read of one element's appearance: the reads whose rule acts on it there (each item's key),
    and each of its whitespace-separated words no such read takes, in order (a word is read where a read's rule acts
    on it alone, or, for a read of the second word, where it is that word and the read acts on the value)."""
    facts = element_facts(manifest, document, element)
    rules = [
        rule for rule in appearance_rules(manifest) if (readers is None or rule.reader in readers) and rule.reads(facts)
    ]
    matched = {rule.key for rule in rules if appearance_matches(value, rule)}
    words = value.split(" ")
    unread = []
    for index, word in enumerate(value.split()):
        read = any(
            appearance_matches(word, rule)
            or (
                rule.match == 'word 1 split on " "'
                and index == 1
                and len(words) > 1
                and appearance_matches(value, rule)
            )
            for rule in rules
            if rule.key in matched
        )
        if not read:
            unread.append(word)
    return matched, unread


def appearance_token_no_runtime_reads(use, manifest):
    """``questions/any-other-multi-token-string-holding-a-token-no-runtime-reads-on``: an appearance of several words
    one of which no runtime's read of that element takes in its place (``appearance_words``), other than a label's
    appearance starting ``floating-`` (its own row), where dropping those words changes a runtime's reading. Where it
    may not, the value may be the HELD-NEW class beside it
    (``questions/a-multi-token-string-holding-tokens-no-runtime-reads-on-that``, ``minimal hint-as-placeholder foo``
    on a select), which turns on the class of what is left (``xform/appearances.ts::droppingKeepsReading``), and the
    use is not settled."""
    form, element, value = _control_appearance(use)
    if element is None:
        return None if form is None else False
    if len(value.split()) < 2:
        return False
    if _local(element) == "trigger" and value.startswith("floating-"):
        return False
    unread = appearance_words(manifest, form, element, value)[1]
    if not unread:
        return False
    if _dropping_changes_reading(manifest, form, element, value, unread):
        return True
    rest = " ".join(word for word in value.split() if word not in unread)
    return False if _rest_read_as_written(manifest, form, element, rest) else None


def unread_words_dropped(manifest, document, element, value):
    """Whether an element's appearance is in the HELD class beside ``appearance_token_no_runtime_reads``'s
    (``questions/a-multi-token-string-holding-tokens-no-runtime-reads-on-that``): several words, some no runtime's
    read takes, whose dropping leaves every runtime's reading the same. Its unread words are that class's, as Nova's
    reader drops them (``xform/appearances.ts::droppingKeepsReading``), so none is a use of its own."""
    if not isinstance(document, Form) or element not in document.body_elements or len(value.split()) < 2:
        return False
    if _local(element) == "trigger" and value.startswith("floating-"):
        return False
    unread = appearance_words(manifest, document, element, value)[1]
    if not unread or _dropping_changes_reading(manifest, document, element, value, unread):
        return False
    return _rest_read_as_written(manifest, document, element, " ".join(w for w in value.split() if w not in unread))


def _rest_read_as_written(manifest, document, element, rest):
    """Whether what is left of an appearance once its unread words are dropped is a value the runtimes read as it is
    written, no refused class taking it (``xform/appearances.ts::droppingKeepsReading``: the rest's own class is no
    refusal): every word a read takes alone by its exact token, no single word holding a value Android matches inside
    it, and no per-row token the per-row refusals take. True, or None where the rest needs a reading this check does
    not make (a case variant, an ``intent:`` id, one word holding a value Android matches inside it)."""
    facts = element_facts(manifest, document, element)
    rules = [rule for rule in appearance_rules(manifest) if rule.reads(facts)]
    words = rest.split(" ")
    if rest != rest.lower() or rest.startswith("intent:"):
        return None
    # A single word holding a value Android matches inside it is a reading of its own
    # (``android_inside_match_other``); in a string of several words Android reads only the values the rows name.
    if len(words) == 1 and any(
        rule.reader == "android" and rule.match in INSIDE_MATCHES and appearance_matches(rest, rule) for rule in rules
    ):
        return None
    control = _row_control(document, element)
    if _per_row_without_leading_digits(rest, control) or _per_row_holding_read(
        manifest, document, element, rest, control
    ):
        return None
    read = all(
        any(rule.match not in INSIDE_MATCHES and appearance_matches(word, rule) for rule in rules) for word in words
    )
    return True if read else None


# Web Apps' per-row patterns (``const.js::PER_ROW_PATTERN``, ``PER_ROW_REPEAT_PATTERN``), as ``form_ui.js`` tests
# each space-separated token of a question's or group's appearance.
PER_ROW = re.compile(r"\d+-per-row(\s|$)")
PER_ROW_REPEAT = re.compile(r"\d+-per-row-repeat(\s|$)")
# The controls whose ``receive-`` and ``broadcast-`` words Web Apps reads (``entries.js::getEntry``,
# ``buildBroadcastTopics``, ``enableReceiver``), by the control their element is.
RECEIVE_CONTROLS = frozenset({"select1", "text", "barcode"})
BROADCAST_CONTROLS = frozenset({"text", "image", "audio", "video", "document"})
UPLOAD_ROW_CONTROLS = {"image/*": "image", "audio/*": "audio", "video/*": "video", "application/*,text/*": "document"}


def _row_control(document, element):
    """The control an appearance sits on as the per-row and channel rows name it: a Vellum repeat, a group wrapping a
    repeat as a direct child (``repeat-wrapper``), another group, a text input (an input typed ``xsd:string`` or
    untyped), a barcode input, an upload by its media type, or the element's own name."""
    local = _local(element)
    if local == "group":
        return "repeat-wrapper" if any(_local(child) == "repeat" for child in _children(element)) else "group"
    if local == "input":
        bind = document.control_bind(element) if isinstance(document, Form) else None
        kind = (bind.get("type") if bind is not None else None) or ""
        kind = kind.removeprefix("xsd:")
        return {"": "text", "string": "text", "barcode": "barcode"}.get(kind, "input-other")
    if local == "upload":
        return UPLOAD_ROW_CONTROLS.get(element.get("mediatype"), "upload-other")
    return local


def _per_row_token(value, wrapper):
    """The first token Web Apps' per-row pattern matches; on a group wrapping a repeat, the first its per-row-repeat
    pattern matches whose text before its first ``-`` ends in a digit."""
    for token in value.split(" "):
        if wrapper:
            if PER_ROW_REPEAT.search(token) and re.search(r"\d$", token[: token.index("-")]):
                return token
        elif PER_ROW.search(token):
            return token
    return None


def _per_row_without_leading_digits(value, control):
    if control == "repeat":
        return False
    token = _per_row_token(value, control == "repeat-wrapper")
    if token is None:
        return False
    return re.match(r"\+?\d", token[: token.index("-")]) is None


def _android_inside(manifest, facts, value):
    return {
        rule.token
        for rule in appearance_rules(manifest)
        if rule.reader == "android"
        and rule.match in INSIDE_MATCHES
        and rule.reads(facts)
        and appearance_matches(value, rule)
    }


def _per_row_holding_read(manifest, document, element, value, control):
    if control == "repeat":
        return False
    wrapper = control == "repeat-wrapper"
    token = _per_row_token(value, wrapper)
    if token is None:
        return False
    digits = re.match(r"\+?(\d+)", token[: token.index("-")])
    if digits is None:
        return False
    held = digits.group(1) + ("-per-row-repeat" if wrapper else "-per-row")
    if token == held:
        return False
    if control in RECEIVE_CONTROLS and "receive" in token:
        return True
    if control in BROADCAST_CONTROLS and "broadcast" in token:
        return True
    facts = element_facts(manifest, document, element)
    return bool(_android_inside(manifest, facts, token) - _android_inside(manifest, facts, held))


def per_row_without_leading_digits(use, manifest):
    """``questions/a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does``: the per-row token
    (``_per_row_token``: on a question or a group, the first token ``const.js::PER_ROW_PATTERN`` matches; on a group
    wrapping a repeat, the first ``PER_ROW_REPEAT_PATTERN`` matches whose text before its first ``-`` ends in a
    digit) whose text before its first ``-`` does not start, after at most one ``+``, with a digit
    (``x2-per-row``): ``form_ui.js`` reads the row count with ``parseInt`` of that text, which is no number. A
    Vellum repeat's own appearance is no runtime's (Core moves the wrapper's label to it, never an appearance)."""
    form, element, value = _control_appearance(use)
    if element is None:
        return None if form is None else False
    return _per_row_without_leading_digits(value, _row_control(form, element))


def per_row_holding_another_read_value(use, manifest):
    """``questions/a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-starts``: a per-row token with
    leading digits that itself holds another value a runtime reads there: ``receive`` on a control whose receiver
    Web Apps reads, ``broadcast`` on one whose sender it reads, or a value Android matches inside the string that
    ``<k>-per-row`` (``<k>-per-row-repeat`` on a group wrapping a repeat) does not hold, so writing the count alone
    would drop that read. A token already spelled ``<k>-per-row``, and a ``receive-``, ``broadcast-`` or Android
    word of its own beside it, stay their own rows'."""
    form, element, value = _control_appearance(use)
    if element is None:
        return None if form is None else False
    return _per_row_holding_read(manifest, form, element, value, _row_control(form, element))


def _dropping_changes_reading(manifest, document, element, value, unread):
    """Whether dropping an appearance's unread words changes a runtime's reading of it, as the reader decides it
    (``xform/appearances.ts::droppingKeepsReading``): nothing is left, a read of the whole value takes what is left,
    a dropped word holds a value Android matches inside the string, or the second word, which Web Apps reads by its
    position, moves."""
    rest = [word for word in value.split() if word not in unread]
    if not rest:
        return True
    rest_text = " ".join(rest)
    facts = element_facts(manifest, document, element)
    rules = [rule for rule in appearance_rules(manifest) if rule.reads(facts)]
    if any(rule.match == "whole" and appearance_matches(rest_text, rule) for rule in rules):
        return True
    if any(
        rule.reader == "android" and rule.match in ("contains", "index") and appearance_matches(word, rule)
        for word in unread
        for rule in rules
    ):
        return True

    def second(text):
        words = text.split(" ")
        return words[1] if len(words) > 1 else None

    return any(rule.match == 'word 1 split on " "' for rule in rules) and second(value) != second(rest_text)


def case_variant_read_differently(use, manifest):
    """``questions/a-case-variant-of-numeric-short-or-ethiopian-as-the-whole``: a whole appearance an Android read
    takes ignoring case (``WidgetFactory.buildBasicWidget``: ``equalsIgnoreCase("numeric")`` on a text input or
    secret, ``toLowerCase().equals("ethiopian")`` on a date; ``StringWidget.shouldSupportIMEAction``:
    ``equalsIgnoreCase`` of ``short``) spelled otherwise than the lowercase value, such as ``Numeric``. Web Apps
    compares each space-separated token exactly (``form_ui.js::getMatchingStyles``), so it ignores the variant
    Android reads as the value. The use's key names the read (``appearance:android/<value>``); its rule, as the
    surface records it, must compare the whole appearance of this element and act on it, and the use is in the
    class where the appearance is not the value itself. A read recorded otherwise than as a whole match is not
    placed here: None."""
    form, element, value = _control_appearance(use)
    if element is None:
        return None if form is None else False
    facts = element_facts(manifest, form, element)
    reads = [
        rule
        for rule in appearance_rules(manifest)
        if rule.key == use.key and rule.reads(facts) and appearance_matches(value, rule)
    ]
    if not reads:
        return False
    if any(rule.match != "whole" for rule in reads):
        return None
    return any(value != rule.token for rule in reads)


# Data Parent ------------------------------------------------------------------------


def _nearest_repeat(form, path):
    """The repeat (a path ``Form.repeat_paths`` holds) a node's path sits strictly under, the innermost, or None."""
    held = [repeat for repeat in form.repeat_paths if path.startswith(f"{repeat}/")]
    return max(held, key=len) if held else None


def data_parent_crossing_a_repeat(use, manifest):
    """``questions/data-parent-crossing-a-repeat``: a body control whose data node sits under another repeat than
    the control itself (Vellum: "Data parent of question in repeat group must be (in) the same repeat group",
    ``baseSpecs.js``'s ``dataParent`` validation). Read on the control's ``ref`` as an absolute path; a ``ref`` written
    otherwise is not placed here."""
    form, element = _form_element(use)
    if form is None:
        return None
    if form.body is None or element not in form.body_elements or element.get("ref") is None:
        return False
    path = element.get("ref").strip()
    if not path.startswith("/"):
        return None
    control_repeat = None
    node = element.getparent()
    while node is not None and node is not form.body:
        if _local(node) == "repeat" and node.get("nodeset"):
            control_repeat = node.get("nodeset").strip()
            break
        node = node.getparent()
    return _nearest_repeat(form, path) != control_repeat


def _placed_control(use):
    """A body control's form, element, its data path (``ref``, or a repeat's ``nodeset``) and the path of the group
    or repeat it stands in on screen as Vellum's parser takes its parent (the nearest enclosing ``group`` with a
    ``ref`` or ``repeat`` with a ``nodeset``; the data root at the body's top); ``(form, None, None, None)`` for a
    use on anything else, and None for the path where the control's is not absolute."""
    form, element = _form_element(use)
    if form is None or form.body is None or element not in form.body_elements:
        return form, None, None, None
    attribute = "nodeset" if _local(element) == "repeat" else "ref"
    if element.get(attribute) is None or form.data_root is None:
        return form, None, None, None
    path = element.get(attribute).strip()
    screen = f"/{_local(form.data_root)}"
    node = element.getparent()
    if (
        attribute == "nodeset"
        and _local(node) == "group"
        and (node.get("appearance") or "").lower() != "field-list"
        and [child for child in _children(node) if _local(child) in QUESTION_CONTROLS] == [element]
    ):
        # A repeat's wrapping group gives it a label, not a screen parent.
        # A model iteration's native nodeset is its inner item. Its authored
        # Data Parent belongs to the enclosing model-iteration data node.
        container = path.removesuffix("/item")
        if container != path and any(form.paths[repeat] == container for repeat in form.model_repeats):
            path = container
        node = node.getparent()
    while node is not None and node is not form.body:
        if _local(node) == "repeat" and node.get("nodeset"):
            screen = node.get("nodeset").strip()
            break
        if _local(node) == "group" and node.get("ref"):
            screen = node.get("ref").strip()
            break
        node = node.getparent()
    return form, element, (path if path.startswith("/") else None), screen


def data_parent_at_the_form_root(use, manifest):
    """``questions/data-parent-at-the-form-root-under-a-grouped-control``: a body control inside a group whose data
    node is a child of the data root. Vellum's parser names that data parent ``#form``
    (``parser.js::parseControlElement``), and its Data Parent check reports "Must be valid path" on every open. A
    control inside a repeat is the crossing class's."""
    form, element, path, screen = _placed_control(use)
    if element is None:
        return None if form is None else False
    if path is None:
        return None
    if data_parent_crossing_a_repeat(use, manifest):
        return False
    root = f"/{_local(form.data_root)}"
    return screen != root and path.rsplit("/", 1)[0] == root


def data_parent_on_a_group_or_repeat(use, manifest):
    """``questions/data-parent-on-a-group-or-repeat``: a group's or repeat's control whose data node stands under
    another group than the one the control stands in, at a place other than the data root. Vellum's save writes a
    group's own answers only under the group's place in its data tree, before it places the group itself
    (``form.js::dataTree``), so the group's answers are lost. The data root and a crossed repeat are their own
    classes'."""
    form, element, path, screen = _placed_control(use)
    if element is None or _local(element) not in ("group", "repeat"):
        return None if form is None else False
    if path is None:
        return None
    if data_parent_crossing_a_repeat(use, manifest):
        return False
    parent = path.rsplit("/", 1)[0]
    return parent != screen and parent != f"/{_local(form.data_root)}"


# The keys a class does not declare that the inventory's rows name, by class (``menus-and-case-lists/
# module-display-separately``, ``module-referral-label-case-label`` (HQ's agriculture template app carries both on
# every menu), ``display-style-on-an-advanced-or-shadow-module``,
# ``legacy-detail-custom-variables-key``, ``detail-print-template``, ``ui-bookkeeping-keys-…``;
# ``forms-and-case-writes/no-vellum-removed-field-dynamic-key``, ``put-in-root-on-a-form-dynamic-key``,
# ``update-multi-name-update-multi``); the rows' own items spell them, which a test holds the map to.
ROW_UNDECLARED_KEYS = {
    "Module": frozenset({"display_separately", "referral_label", "case_label"}),
    "AdvancedModule": frozenset({"display_style"}),
    "ShadowModule": frozenset({"display_style"}),
    "Detail": frozenset({"custom_variables", "print_template"}),
    "DetailColumn": frozenset(
        {
            "hasAutocomplete",
            "calc_xpath",
            "isTab",
            "hasNodeset",
            "nodeset",
            "relevant",
            "nodesetCaseType",
            "nodesetFilter",
        }
    ),
    # The Case Detail page writes ``isTab`` on every tab it saves (``details/bootstrap5/column.js::serialize``).
    "DetailTab": frozenset({"isTab"}),
    "Form": frozenset({"no_vellum", "put_in_root"}),
    "AdvancedForm": frozenset({"no_vellum", "put_in_root"}),
    # No row names a key a basic form's actions do not declare: the catch-all refuses every one.
    "FormActions": frozenset(),
    "UpdateCaseAction": frozenset({"update_multi", "name_update_multi"}),
    "OpenCaseAction": frozenset({"update_multi", "name_update_multi"}),
}
UNDECLARED = ".<undeclared>"


def undeclared_key_no_row_names(use, manifest):
    """``menus-and-case-lists/any-other-undeclared-key``, ``forms-and-case-writes/any-other-undeclared-key``: a key an
    object's class does not declare (``schema:<Class>.<undeclared>``, which jsonobject keeps) other than the ones the
    inventory's rows name for that class (``ROW_UNDECLARED_KEYS``)."""
    at = _json(use)
    if at is None or at.key is None or not use.key.endswith(UNDECLARED):
        return None
    if _in_reference_details(at):
        return False  # ``menus-and-case-lists/module-ref-details`` holds every key of a detail HQ's build never writes
    names = ROW_UNDECLARED_KEYS.get(use.key[len("schema:") : -len(UNDECLARED)])
    return None if names is None else at.key not in names


def _in_reference_details(at):
    """Whether a use sits in a menu's ``ref_details``, which HQ's build never writes (``Module.get_details`` turns the
    ``ref_*`` details off), so the inventory's row for the key holds the whole value by where it sits."""
    module = at.nearest(*MODULES)
    pair = (module or {}).get("ref_details")
    return isinstance(pair, dict) and any(value is pair for _, value in at.scope)


# HELD-NEW classes beside an allowing class of their key ----------------------------
#
# Where an entry HELD-NEW splits one value of a key an allowing entry also names, by that value's grammar or bound,
# the line between what Nova holds and what it does not hold yet is one predicate over the value. Each reader here
# draws it as Nova's reader of HQ's apps does (the module that claims the entry, named in each docstring), from the
# use's own value and the objects or elements that hold it, never from another part of the app. A use it does not
# read (one of a suite, where the key is also a parser's) it leaves unjudged (None), and the use is then held as it
# was (``manifest_usage.standing``).


# HQ's property grammar with parents (``helpers/validators.py::validate_property``, which
# ``IndexedFormBaseValidator.check_case_properties`` runs on every written key; ``basicActions.ts::HQ_PROPERTY_PATH``),
# matched whole: Python's ``re.match`` of a pattern ending in ``$`` takes one newline before the end, which the
# optional ``\n`` spells here.
HQ_PROPERTY_PATH = re.compile(r"[a-zA-Z][\w-]*(/[a-zA-Z][\w-]*)*\n?")
# The index steps an update key may take before its property (``case_config_ui.js::caseProperty.validate``).
UPDATE_INDEX_STEPS = frozenset({"parent", "host"})
# Nova's case property grammar (``lib/domain/casePropertyName.ts::authoredCasePropertyNameSchema``): its pattern,
# matched whole, its length and the three spellings it refuses for Nova's canonical standard names.
AUTHORED_CASE_PROPERTY_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_-]*")
MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH = 255
NOT_CANONICAL_STANDARD_NAMES = frozenset({"name", "date-opened", "external-id"})
# ``case-reserved-words.json`` and HQ's own hyphenated spellings, which HQ's validator refuses as a written key
# (``lib/commcare/constants.ts::HQ_CASE_RESERVED_WORDS``).
HQ_CASE_RESERVED_WORDS = (RESERVED_CASE_PROPERTIES - {"owner_id"}) | {"date-opened", "external-id"}
# The code point ranges of a name character of Core's XPath grammar, as Nova's reader reads a written key
# (``basicActions.ts::CORE_NAME_RANGES``).
CORE_NAME_RANGES = (
    (0x2D, 0x2E),
    (0x30, 0x39),
    (0x41, 0x5A),
    (0x5F, 0x5F),
    (0x61, 0x7A),
    (0xB7, 0xB7),
    (0xC0, 0xD6),
    (0xD8, 0xF6),
    (0xF8, 0x37D),
    (0x37F, 0x1FFF),
    (0x200C, 0x200D),
    (0x203F, 0x2040),
    (0x2070, 0x218F),
    (0x2C00, 0x2FEF),
    (0x3001, 0xD7FF),
    (0xF900, 0xFDCF),
    (0xFDF0, 0xFFFD),
)


def _authored_property_name(name):
    """Whether Nova's case property grammar takes a name (``authoredCasePropertyNameSchema``)."""
    return (
        0 < len(name) <= MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH
        and AUTHORED_CASE_PROPERTY_NAME.fullmatch(name) is not None
        and name not in NOT_CANONICAL_STANDARD_NAMES
    )


def _core_name_character(character):
    code = ord(character)
    return any(low <= code <= high for low, high in CORE_NAME_RANGES)


def _non_ascii_core_name(name):
    """Whether a written property name is in the ``non-ascii`` class of Nova's reader
    (``basicActions.ts::propertyNameClass``): outside Nova's grammar, inside HQ's (``HQ_PROPERTY``) and none of its
    reserved words, and every character one of Core's name characters, which leaves one past ASCII. A name a
    character of which Core does not read as a name's is HQ's build's to refuse (the bar's), and none of this."""
    if AUTHORED_CASE_PROPERTY_NAME.fullmatch(name) and name not in RESERVED_CASE_PROPERTIES:
        return False  # Nova's grammar, or only past its length
    if HQ_PROPERTY.fullmatch(name) is None or name in HQ_CASE_RESERVED_WORDS or name in RESERVED_CASE_PROPERTIES:
        return False
    return all(_core_name_character(character) for character in name)


def _held(value, key):
    """``value[key]`` where ``value`` is an object, else None."""
    return value.get(key) if isinstance(value, dict) else None


def _writes_own_update(update_case):
    """Whether HQ's build writes a basic form's ``update_case`` map: the action is active (``_active``); under the
    condition ``never`` the map is the inert class Nova's reader reads it as
    (``forms-and-case-writes/update-case-update-map-under-condition-never``), which no key of it is a write of."""
    return _active(update_case)


def _written_maps(at):
    """The property maps a use of an action's keys holds, each ``(slot, map)``: ``own`` (a basic form's
    ``update_case``), ``worker`` (its ``usercase_update``), ``child`` (a child case's ``case_properties``), ``load``
    and ``open`` (an advanced load's or open action's ``case_properties``). A use of a form's ``actions`` holds every
    one of its actions' maps, a use of ``update_case`` that action's, a use of a map that map. None for any other
    use."""
    owner, cls, value = at.owner, at.scope[-1][0], at.value
    if at.key == "update" and cls == "UpdateCaseAction":
        actions = at.scope[-2][1] if len(at.scope) > 1 else None
        if _held(actions, "usercase_update") is owner:
            return [("worker", value)]
        return [("own", value if _writes_own_update(owner) else None)]
    if at.key == "case_properties" and cls == "OpenSubCaseAction":
        return [("child", value)]
    if at.key == "case_properties" and cls == "LoadUpdateAction":
        return [("load", value)]
    if at.key == "case_properties" and cls == "AdvancedOpenCaseAction":
        return [("open", value)]
    if at.key == "update_case" and cls == "FormActions":
        return [("own", _held(value, "update") if _writes_own_update(value) else None)]
    if at.key == "actions" and cls in FORMS:
        own = _held(value, "update_case")
        maps = [
            ("own", _held(own, "update") if _writes_own_update(own) else None),
            ("worker", _held(_held(value, "usercase_update"), "update")),
        ]
        for slot, name in (("child", "subcases"), ("load", "load_update_cases"), ("open", "open_cases")):
            listed = _held(value, name)
            maps += [(slot, _held(action, "case_properties")) for action in listed or () if isinstance(listed, list)]
        return maps
    return None


def _written_properties(at):
    """The property each key of a use's maps writes (``_written_maps``), where Nova's reader reads the key as a
    write of that property: a key with an index step on a child case, the worker's record or an open action is
    refused before its property is read (``basicActions.ts``: ``illegalChildKey``, ``usercaseSlash``;
    ``advancedActions.ts``: the open action's ``slash``), as is one outside HQ's grammar with parents (a child
    case's key excepted, which is read as a location key first) or through an index step other than ``parent`` or
    ``host``. None for a use that holds no map."""
    maps = _written_maps(at)
    if maps is None:
        return None
    found = []
    for slot, held in maps:
        for key in held if isinstance(held, dict) else ():
            if not isinstance(key, str):
                continue
            if slot in ("child", "worker", "open") and "/" in key:
                continue
            if slot != "child" and HQ_PROPERTY_PATH.fullmatch(key) is None:
                continue
            *steps, written = key.split("/")
            if any(step not in UPDATE_INDEX_STEPS for step in steps):
                continue
            found.append(written)
    return found


def non_ascii_core_name_key(use, manifest):
    """``forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character``: an action's key whose written
    property is Nova's reader's ``non-ascii`` class (``_non_ascii_core_name``): every character after the ASCII
    letter HQ's grammar starts it with one of Core's name characters, at least one past ASCII. ``name`` and
    ``owner_id`` are a case's own facts, and ``category`` and ``state`` a row of their own, neither of which this
    class holds; none is past ASCII."""
    at = _json(use)
    if at is None:
        return None
    written = _written_properties(at)
    return None if written is None else any(_non_ascii_core_name(name) for name in written)


# The keys a prompt reaches CommCare HQ under as a request setting of its own (``case_search/models.py``:
# ``CONFIG_KEYS_MAPPING``, the tag key, the owner exclusion key and the query key;
# ``lib/commcare/reader/search/prompts.ts::RESERVED_REQUEST_KEYS``), whose prompt is another class's.
PROMPT_REQUEST_KEYS = frozenset(
    {
        "case_type",
        "x_commcare_data_registry",
        "x_commcare_custom_related_case_property",
        "x_commcare_include_all_related_cases",
        "commcare_sort",
        "x_commcare_endpoint_id",
        "x_commcare_tag_module_name",
        "commcare_blacklisted_owner_ids",
        "_xpath_query",
    }
)
# A Search field's name (``lib/domain/modules.ts::SEARCH_INPUT_NAME_PATTERN``), matched whole.
SEARCH_INPUT_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")
# The case attributes a prompt can be named for, and the case's name, which HQ's search matches by its own rule: a
# prompt without ``exclude`` named for one is another class's (``prompts.ts::ATTRIBUTE_PROMPT_NAMES``).
ATTRIBUTE_PROMPT_NAMES = frozenset({"case_id", "owner_id", "status", "name"})


def _prompt_slot(use, key):
    """The prompt a use of its ``key`` sits on, or None."""
    at = _json(use)
    if at is None or at.key != key or at.scope[-1][0] != "CaseSearchProperty":
        return None
    return at.owner


def prompt_key_outside_nova_s_name_grammar(use, manifest):
    """``case-search/prompt-key-outside-nova-s-name-grammar``: a prompt's ``name`` outside a Search field's grammar
    (``SEARCH_INPUT_NAME``), or, on a prompt that is neither hidden nor ``exclude``, a case property Nova's grammar
    does not name (``_x``, ``date-opened``, ``external-id``), as Nova's reader reads it
    (``prompts.ts``, ``nameOutside``). A name HQ reads as a request setting of its own, and a case attribute's name
    on a prompt without ``exclude``, are other classes'."""
    prompt = _prompt_slot(use, "name")
    if prompt is None:
        return None
    name = prompt.get("name")
    if not isinstance(name, str):
        return None
    if name in PROMPT_REQUEST_KEYS:
        return False
    if SEARCH_INPUT_NAME.fullmatch(name) is None:
        return True
    if prompt.get("hidden") is True or prompt.get("exclude") is True or name in ATTRIBUTE_PROMPT_NAMES:
        return False
    return not _authored_property_name(name)


def _offered_search_config(use):
    """A use's ``CaseSearch`` object and whether its menu offers that search: ``util.py::module_offers_search``,
    a search property or a default filter, read from the object itself; (None, None) outside one."""
    at = _json(use)
    config = None if at is None else at.nearest("CaseSearch")
    if config is None:
        return None, None
    return config, bool(config.get("properties") or config.get("default_properties"))


def endpoint_on_an_offered_search(use, manifest):
    """``case-search/case-search-endpoint-id``: ``case_search_endpoint_id`` on a search the menu offers, the one
    place HQ's build reads it (``util.py::module_uses_case_search_endpoint``, beside ``CASE_SEARCH_ENDPOINTS``),
    and each default filter of such a search, which HQ's build sends the endpoint as a parameter of its key
    (``remote_requests.py``, ``_remote_request_query_datums``). On a menu that offers none the id is part of the
    search configuration HQ stores and builds nothing of, the round trip's class, and a default filter of a
    search with no id is its own key's."""
    config, offered = _offered_search_config(use)
    if config is None:
        return None
    if use.key == "schema:CaseSearch.case_search_endpoint_id":
        return offered
    return offered and bool(config.get("case_search_endpoint_id"))


def max_select_value_above_100(use, manifest):
    """``menus-and-case-lists/detail-max-select-value-above-100``: a ``max_select_value`` above 100 on the case list
    of a basic menu with a case type whose list selects several cases (``lib/commcare/reader/caseList/details.ts::
    readSelection``). A value 0, below -1 or no number is another class's."""
    at = _json(use)
    if at is None or at.key != "max_select_value" or at.scope[-1][0] != "Detail":
        return None
    detail, pair, module = at.owner, at.nearest("DetailPair"), at.nearest(*MODULES)
    if pair is None or pair.get("short") is not detail or module is None:
        return False
    if module.get("doc_type") == "AdvancedModule" or not module.get("case_type"):
        return False
    if detail.get("multi_select") is not True:
        return False
    value = _max_select_number(detail.get("max_select_value"))
    if value is None or value is False:
        return value
    return value > 100


# The characters Core trims from the end of a line it reads of an app strings file: every one up to U+0020.
CORE_LINE_END_TRIMMED = "".join(chr(code) for code in range(0x21))


# Nova's XML name for a link's and a tile grouping's identifier (``lib/domain/expression/types.ts::
# XML_ELEMENT_NAME_PATTERN``), matched whole; it holds no ``-``.
XML_ELEMENT_NAME = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*")


def _index_identifier(index):
    """An advanced open action's index's identifier as HQ's build names it: its ``reference_id``, ``parent`` where
    that is blank."""
    reference = index.get("reference_id")
    return reference if isinstance(reference, str) and reference != "" else "parent"


def index_identifier_outside_an_xml_name(use, manifest):
    """``forms-and-case-writes/index-identifier-outside-an-xml-element-name``: an advanced open action's index whose
    identifier (``_index_identifier``) is no XML name Nova writes (``XML_ELEMENT_NAME``;
    ``advancedActions.ts``, ``openIndexName``). A load's index is another class's."""
    at = _json(use)
    if at is None:
        return None
    if at.key == "case_indices" and at.scope[-1][0] == "AdvancedOpenCaseAction":
        indices = [index for index in at.value or [] if isinstance(index, dict)] if isinstance(at.value, list) else []
    elif at.scope[-1][0] == "CaseIndex":
        if len(at.scope) < 2 or at.scope[-2][0] != "AdvancedOpenCaseAction":
            return False
        indices = [at.owner]
    else:
        return None
    return any(XML_ELEMENT_NAME.fullmatch(_index_identifier(index)) is None for index in indices)


def tile_group_identifier_outside_an_xml_name(use, manifest):
    """``menus-and-case-lists/case-tile-group-identifier-outside-an-xml-element-name``: a case list's tile grouping
    whose ``index_identifier`` holds text that is no XML name Nova writes (``XML_ELEMENT_NAME``), on the case list of
    a menu with a case type whose tile is custom (``lib/commcare/reader/caseList/tile.ts``,
    ``groupIdentifierOutside``). A grouping with no identifier groups nothing."""
    at = _json(use)
    if at is None:
        return None
    if at.key == "case_tile_group" and at.scope[-1][0] == "Detail":
        group = at.value
    elif at.scope[-1][0] == "CaseTileGroupConfig":
        group = at.owner
    else:
        return None
    detail, pair, module = at.nearest("Detail"), at.nearest("DetailPair"), at.nearest(*MODULES)
    if detail is None or pair is None or pair.get("short") is not detail or module is None:
        return False
    if not module.get("case_type") or detail.get("case_tile_template") != "custom" or not isinstance(group, dict):
        return False
    identifier = group.get("index_identifier")
    return isinstance(identifier, str) and identifier != "" and XML_ELEMENT_NAME.fullmatch(identifier) is None


def column_hash_property(use, manifest):
    """``menus-and-case-lists/column-reading-an-unknown-hash-property``: a property column's ``field`` (HQ's
    ``PROPERTY_NAME``, with no prefix and not the worker's ``user/``) whose last word starts with ``#`` and is not
    ``#owner_name``. HQ's page takes it (``details/utils.js::isValidPropertyName``); its build rewrites
    ``#owner_name`` alone (``PropertyXpathGenerator.xpath``) and writes any other word into the step, which Core's
    lexer refuses (``Lexer.matchNCName``), so the column breaks on both workers. A name past 255 characters is a
    read (``column-reading-a-property-name-over-255-characters``), and a calculated column's field is an
    expression."""
    at = _json(use)
    if at is None or at.key != "field" or at.scope[-1][0] != "DetailColumn":
        return None
    field = at.value
    if at.owner.get("useXpathExpression") or not isinstance(field, str):
        return False
    if ":" in field or field.startswith("user/") or PROPERTY_NAME.fullmatch(field) is None:
        return False
    last = field.split("/")[-1]
    return last.startswith("#") and last != "#owner_name"


def invalid_profile_languages(use, manifest):
    """A selected profile needs a first language and an ordered subset of the app's own codes."""
    at = _json(use)
    if at is None:
        return None
    app_languages = at.app.doc.get("langs") or []
    def invalid(profile):
        languages = profile.get("langs") or []
        return not languages or any(code not in app_languages for code in languages) or len(set(languages)) != len(languages)
    profile = at.nearest("BuildProfile")
    if profile is not None:
        return invalid(profile)
    if at.key == "build_profiles" and isinstance(at.value, dict):
        return any(invalid(profile) for profile in at.value.values())
    return None


def unaddressable_answer_root(use, manifest):
    form, root = _form_element(use)
    if form is None:
        return None
    if root is not form.data_root:
        return False
    name = _local(root)
    def letter(ch):
        return ord(ch) <= 0xffff and (ch.isupper() or ch.islower() or ch == "_")
    return bool(root.prefix or not letter(name[0]) or
                any(not (letter(ch) or ord(ch) <= 0xffff and ch.isdecimal() or ch in ".-") for ch in name[1:]))


def designer_reserved_answer_root(use, manifest):
    form, root = _form_element(use)
    if form is None:
        return None
    return root is form.data_root and not root.prefix and _local(root) in {"instance", "bind", "parsererror"}


# The registry ---------------------------------------------------------------------


# Each value class the check reads, by the id of the entry that names it: a reader of a use (and the
# manifest), giving whether the use falls in that class (True), not (False), or None where the export does not
# say. The entry is REFUSED, or HELD-NEW beside an allowing class of its key (the last group). A REFUSED entry
# refused only because HQ's build refuses its state needs none (the bar reports it,
# ``proof.checks.manifest_usage.Entry.refused_by_hq_build``).
# The REFUSED classes whose uses are two symptoms the check names apart: each class's part reader by its entry's
# id (``manifest_usage.unclassified`` writes a use's part after its class). Nova's scaffolding nodes are one
# defect's (13) and the ids a person authors another's (15), so each holds its own register entry.
VARIANTS = {
    "questions/question-id-failing-the-grammar-or-meta-in-any-case": nova_scaffolding_part,
    "questions/hidden-value-with-children": nova_scaffolding_part,
}


# Menus listing another menu's forms, and the first menu's shared case ------------------------------------------


def _shadow_of(use):
    """The ShadowModule a use sits in, with its location, or (at, None) for a use in another module."""
    at, module = _module_of_detail(use)
    if module is None or module.get("doc_type") != "ShadowModule":
        return at, None
    return at, module


def unavailable_source_form(use, manifest):
    """``menus-and-case-lists/shared-form-menu-with-an-unavailable-source-form``: a version-2 ShadowModule whose
    ``source_module_id`` names no module or another ShadowModule (the menu settings page offers neither,
    ``views/modules.py::_get_shadow_module_view_context``), or whose ``excluded_form_ids`` or
    ``form_session_endpoints`` name a form its source does not hold, a form twice in its endpoints. HQ's source
    download can mint a form's id anew while those two lists keep the id the application resource holds, so on an
    app made in CommCare HQ an id that names no source form is undecided here (None): Nova's reader resolves it
    through the aligned resource (``reader/menus/sharedForms.ts::realForms``)."""
    at, shadow = _shadow_of(use)
    if at is None:
        return None
    if shadow is None:
        return False
    source = at.app.modules_by_id.get(shadow.get("source_module_id"))
    if source is None or source.get("doc_type") == "ShadowModule":
        return True
    forms = {form.get("unique_id") for form in _forms(source)}
    excluded = shadow.get("excluded_form_ids") or []
    endpoints = shadow.get("form_session_endpoints") or []
    if not isinstance(excluded, list) or not isinstance(endpoints, list):
        return True
    named = [form_id for form_id in excluded]
    seen = set()
    for row in endpoints:
        if not isinstance(row, dict) or not isinstance(row.get("form_id"), str):
            return True
        if row["form_id"] in seen:
            return True
        seen.add(row["form_id"])
        named.append(row["form_id"])
    if all(isinstance(form_id, str) and form_id in forms for form_id in named):
        return False
    return None if at.app.authored else True


def incomplete_shared_submenus(use, manifest):
    """``menus-and-case-lists/shared-form-menus-with-incomplete-submenus``: a ShadowModule under a parent other
    than its source's (a top-level shadow of a top-level source, or one under its source's parent; one under
    another ShadowModule is HQ's child mirror), or one without exactly one child ShadowModule naming each
    non-shadow child of its source, which HQ's ``views/utils.py::handle_shadow_child_modules`` always makes."""
    at, shadow = _shadow_of(use)
    if at is None:
        return None
    if shadow is None:
        return False
    source = at.app.modules_by_id.get(shadow.get("source_module_id"))
    if source is None or source.get("doc_type") == "ShadowModule":
        return False  # the unavailable source's own class
    own_parent = shadow.get("root_module_id") or None
    parent = at.app.modules_by_id.get(own_parent) if own_parent else None
    if (
        (parent is None or parent.get("doc_type") != "ShadowModule")
        and (own_parent is None or parent is not None)
        and own_parent != (source.get("root_module_id") or None)
    ):
        return True
    children = [module for module in at.app.modules if module.get("root_module_id") == source.get("unique_id")]
    listed = [module for module in at.app.modules if module.get("root_module_id") == shadow.get("unique_id")]
    for child in children:
        if child.get("doc_type") == "ShadowModule":
            continue
        mirrors = [
            menu
            for menu in listed
            if menu.get("doc_type") == "ShadowModule" and menu.get("source_module_id") == child.get("unique_id")
        ]
        if len(mirrors) != 1:
            return True
    return False


def _creation_datum_ids(module, form):
    """The ids of the new-case datums HQ's build gives a form, each once
    (``suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta``): a basic form's open action
    ``case_id_new_<menu type>_0`` and each subcase outside a repeat ``case_id_new_<type>_<index>``, its index
    counting the open action (``Form.session_var_for_action``); an advanced form's open actions outside a repeat
    ``case_id_new_<type>_<tag>`` (``AdvancedOpenCaseAction.case_session_var``). None for a shadow form, whose
    actions are its source's."""
    if form.get("doc_type") == "ShadowForm":
        return None
    actions = _actions(form)
    if form.get("doc_type") == "AdvancedForm":
        _, opens = _advanced_lists(form)
        return [
            f"case_id_new_{action.get('case_type')}_{action.get('case_tag')}"
            for action in opens
            if not action.get("repeat_context")
        ]
    found = []
    opens = _active(actions.get("open_case"))
    if opens:
        found.append(f"case_id_new_{module.get('case_type')}_0")
    for index, subcase in enumerate(_subcases(form)):
        if _active(subcase) and not subcase.get("repeat_context"):
            found.append(f"case_id_new_{subcase.get('case_type')}_{index + (1 if opens else 0)}")
    return found


def function_datum_without_one_creation(use, manifest):
    """``forms-and-case-writes/function-datum-endpoints-with-an-unavailable-supplier``: a form's
    ``function_datum_endpoints`` naming an id no new-case datum of the form has (``_creation_datum_ids``). HQ's build
    adds only the names it finds on the navigation frame (``post_process/endpoints.py``, ``child.id in
    form.function_datum_endpoints``), so a name given twice is one argument; Nova holds each name as the case
    creation that supplies it, twice where it is given twice, and its deep link exposes that creation once
    (``entryPointProjection.ts::exposedEntryCaseCreations``). A shadow form's are undecided here (None)."""
    at = _json(use)
    if at is None:
        return None
    form = at.nearest(*FORMS)
    if form is None:
        return None
    names = form.get("function_datum_endpoints") or []
    if not names:
        return False
    module = at.app.module_of(form)
    created = None if module is None else _creation_datum_ids(module, form)
    if created is None:
        return None
    return any(name not in created for name in names)


def _first_menu_modules(app):
    """The menus whose forms list on the app's first menu: a top-level ``put_in_root`` menu, and a
    ``put_in_root`` child of one (``menus.py::MenuContributor``)."""
    found = []
    for module in app.modules:
        if not module.get("put_in_root"):
            continue
        root = app.root(module)
        if root is None and not module.get("root_module_id"):
            found.append(module)
        elif root is not None and root.get("put_in_root") and not root.get("root_module_id"):
            found.append(module)
    return found


def _first_menu_case(app):
    """The case type every form on the first menu opens a chosen case of, as ``case_id`` with one record, or
    None where they share none; ``...`` where the export alone does not say (an advanced or shadow menu, or a
    parent selection, whose datums HQ names otherwise)."""
    menus = _first_menu_modules(app)
    forms = [(module, form) for module in menus for form in _forms(module)]
    if not forms:
        return None
    if any(module.get("doc_type") != "Module" or (module.get("parent_select") or {}).get("active") for module in menus):
        return ...
    if any(_requires(form) != "case" for _, form in forms):
        return None
    types = {module.get("case_type") for module, _ in forms}
    if len(types) != 1 or any(_multi_select(module) for module, _ in forms):
        return None
    return types.pop()


def _reads_case_id_otherwise(app, case_type):
    """Whether a command of the app reads ``case_id`` as another case type or as several records: a basic or
    shadow menu's form that requires a case, or its case list shown as a menu item."""
    for module in app.modules:
        kind = module.get("doc_type")
        if kind == "AdvancedModule":
            continue
        source = app.modules_by_id.get(module.get("source_module_id")) if kind == "ShadowModule" else module
        if source is None:
            continue
        reads = (module.get("case_list") or {}).get("show") or any(_requires(form) == "case" for form in _forms(source))
        if reads and (source.get("case_type") != case_type or _multi_select(module)):
            return True
    return False


def _under_the_first_menu(app, module):
    """Whether a menu's frame opens through the first menu: it lists there, or sits under a menu that does."""
    menus = _first_menu_modules(app)
    if any(module is menu for menu in menus):
        return True
    root = app.root(module)
    return root is not None and any(root is menu for menu in menus)


def first_menu_case_read_otherwise(use, manifest):
    """``forms-and-case-writes/first-menu-selection-used-for-different-records``: a deep link or a form link whose
    frame opens through the first menu while every form there opens one chosen case
    (``workflow.py::WorkflowHelper.get_frame_children``, ``_root_module_datums``), where another command reads that
    datum, ``case_id``, as another case type or as several records: Android keeps the first menu's case for it
    (``CommCareSession.syncState``). An app whose first-menu datums HQ names otherwise is undecided (None)."""
    at = _json(use)
    if at is None:
        return None
    app = at.app
    shared = _first_menu_case(app)
    if shared is None:
        return False
    if shared is ...:
        return None
    owner = at.owner
    if at.key in ("form_links", "form_id") or at.nearest("FormLink") is not None:
        link = at.nearest("FormLink")
        links = [link] if link is not None else [
            each for each in (at.nearest(*FORMS) or {}).get("form_links") or [] if isinstance(each, dict)
        ]
        targets = []
        for each in links:
            if each.get("form_id"):
                form = app.forms_by_id.get(each["form_id"])
                targets.append(None if form is None else app.module_of(form))
            else:
                targets.append(app.modules_by_id.get(each.get("module_unique_id")))
    else:
        if not (owner.get(at.key) if at.key is not None else None):
            return False
        targets = [at.nearest(*MODULES)]
    if not any(target is not None and _under_the_first_menu(app, target) for target in targets):
        return False
    return _reads_case_id_otherwise(app, shared)


def first_menu_registration_return_otherwise(use, manifest):
    """``menus-and-case-lists/first-menu-registration-return-without-a-compatible-case``: a case list's
    registration form on a menu under a first-menu menu whose forms open one chosen case, which returns to the
    list or its new case (``post_form_workflow`` other than ``default``), where that return frame carries the
    first menu's ``case_id`` ahead of the host's command (``workflow.py::CaseListFormWorkflow``): the new case is
    of another type than the first menu's, so the form does not supply it, or another command reads ``case_id``
    otherwise (``first_menu_case_read_otherwise``). Undecided where the first menu's datums are (None)."""
    at, module = _module_of_detail(use)
    if module is None:
        return None
    listed = module.get("case_list_form") or {}
    if not listed.get("form_id") or (listed.get("post_form_workflow") or "default") == "default":
        return False
    root = at.app.root(module)
    if root is None or not any(root is menu for menu in _first_menu_modules(at.app)):
        return False
    shared = _first_menu_case(at.app)
    if shared is None:
        return False
    if shared is ...:
        return None
    return module.get("case_type") != shared or _reads_case_id_otherwise(at.app, shared)



# Menu and form badges, and the navigation conditions beside them -------------------------------------------------


def _first_badge(use):
    """The CustomIcon a use sits in, where it is the first of a menu's or a form's ``custom_icons``, the one HQ's
    build reads (``models/mixins.py::NavMenuItemMediaMixin.custom_icon``, read by ``suite_xml/sections/menus.py``
    and ``entries.py``), with the app; ``(at, None)`` for a later icon, one a case list or its registration
    action holds (which no build reads), or a use in no icon."""
    at = _json(use)
    if at is None:
        return None, None
    classes = [cls for cls, _ in at.scope]
    if "CustomIcon" not in classes:
        return at, None
    index = len(classes) - 1 - classes[::-1].index("CustomIcon")
    icon = at.scope[index][1]
    holder_cls, holder = at.scope[index - 1] if index > 0 else (None, None)
    if holder_cls not in (*MODULES, *FORMS) or not isinstance(holder, dict):
        return at, None
    icons = holder.get("custom_icons")
    if not isinstance(icons, list) or not icons or icons[0] is not icon:
        return at, None
    return at, icon


def badge_form_other_than_badge(use, manifest):
    """``menus-and-case-lists/custom-icon-form-other-than-badge``: a menu's or a form's first custom icon whose
    ``form`` names a display form other than ``badge``. HQ's editor saves only badges
    (``views/utils.py::handle_custom_icon_edits`` keeps ``CustomIcon.form``, which is always ``badge``)."""
    at, icon = _first_badge(use)
    if at is None:
        return None
    if icon is None:
        return False
    return icon.get("form", "badge") != "badge"


def badge_without_text(use, manifest):
    """``menus-and-case-lists/badge-missing-localized-text``: a menu's or a form's first badge with no calculation
    (``not custom_icon.xpath``, ``menus.py``, ``entries.py``), whose text holds nothing in every language of the
    app once a missing language takes the default language's (``mixins.py::custom_icon_form_and_text_by_language``):
    HQ's build names the badge's locale id and writes no text for it (``app_strings.py``)."""
    at, icon = _first_badge(use)
    if at is None:
        return None
    if icon is None or icon.get("form", "badge") != "badge" or icon.get("xpath"):
        return False
    texts = icon.get("text") or {}
    if not isinstance(texts, dict):
        return None
    langs = [code for code in at.app.doc.get("langs") or [] if isinstance(code, str)] or ["en"]
    shown = [texts.get(lang, texts.get(langs[0])) for lang in langs]
    return not any(isinstance(text, str) and text for text in shown)


def badge_calculation_untyped(use, manifest):
    """``menus-and-case-lists/badge-calculation-outside-typed-values``: a first badge's calculation Nova's reader
    cannot bind to a typed value on the worker's menu. Nova prints every calculation it sends from a typed value
    (``lib/commcare/menuBadge.ts``), so an app Nova sends holds none; on an app made in CommCare HQ only Nova's
    reader settles it (None), and on one the corpus holds it read it (``App.read``)."""
    at, icon = _first_badge(use)
    if at is None:
        return None
    if icon is None or icon.get("form", "badge") != "badge" or not icon.get("xpath"):
        return False
    return None if at.app.authored and not at.app.read else False


def mirror_form_links_on_survey_listing(use, manifest):
    """``menus-and-case-lists/mirror-form-deep-links-on-a-menu-listing-survey-forms``: a menu listing another menu's
    forms (``ShadowModule``) holding deep links to single forms (``form_session_endpoints``) where the menu it lists
    tracks no cases (``case_type`` empty, HQ's ``is_surveys``). HQ's menu settings page sends those links with every
    save but renders the ``session_endpoint_id`` field its save reads only in the Advanced panel, which
    ``views/modules.py::get_module_view_context`` hides on such a menu, so ``edit_module_attr`` raises. None where the
    listed menu is no menu of the app."""
    at = _json(use)
    if at is None or at.key != "form_session_endpoints":
        return None
    links = at.value
    if not isinstance(links, list) or not links:
        return False
    source = at.app.modules_by_id.get(at.owner.get("source_module_id"))
    if source is None:
        return None
    return not source.get("case_type")


def shadow_version_one(use, manifest):
    """``menus-and-case-lists/shadowmodule-version-1-or-key-absent-model-default-1``: a menu listing another menu's
    forms (``ShadowModule``) whose ``shadow_module_version`` is 1, the retiring version HQ's model defaults to
    (``models/modules.py::ShadowModule.shadow_module_version``), whose behaviour HQ keys on ``== 1``; Nova writes
    version 2. Version 1 and an absent key are HQ's default and no use, so every use is outside the class."""
    at = _json(use)
    if at is None or at.key != "shadow_module_version":
        return None
    return at.value == 1


def shadow_endpoint_id_padded(use, manifest):
    """``menus-and-case-lists/a-shadow-menu-s-own-or-mirror-form-endpoint-id-with-surrounding``: a listing menu's own
    deep link id, or one of its forms' (``ShadowFormEndpoint``), with whitespace around it: HQ's shadow save checks
    the stripped id and stores it as typed (``views/modules.py::set_shadow_module_and_form_session_endpoint``). In a
    suite an endpoint's ``id`` says nothing of the menu it came from, so a padded one there is left open (None)."""
    at = _json(use)
    if at is not None:
        value = at.value
        return isinstance(value, str) and value != value.strip()
    at = _xml(use)
    if at is None or at.attribute is None:
        return None
    value = at.element.get(at.attribute) or ""
    return None if value != value.strip() else False


def navigation_condition_untyped(use, manifest):
    """``menus-and-case-lists/navigation-condition-outside-typed-worker-context``: a menu's or a form's display
    condition Nova's reader cannot bind to a typed condition on the worker's route. Nova prints every condition it
    sends from a typed one (``lib/commcare/suite/displayConditions.ts``), so an app Nova sends holds none; on an app
    made in CommCare HQ only Nova's reader settles it (None), and on one the corpus holds it read it
    (``App.read``)."""
    at = _json(use)
    if at is None:
        return None
    if at.key not in ("module_filter", "form_filter") or not at.value:
        return False
    return None if at.app.authored and not at.app.read else False

VALUE_CLASSES = {
    "application-and-settings/menu-layout-outside-editor-choices": menu_layout_outside_choices,
    "menus-and-case-lists/module-layout-outside-editor-choices": menu_layout_outside_choices,
    # Questions
    "questions/connect-deliveries-share-receiver-key": connect_colliding_activities({'ConnectDeliverUnit'}),
    "questions/connect-repeats-module-completion-key": connect_colliding_activities({'ConnectLearnModule'}),
    "questions/several-connect-assessment-blocks-in-one-form-or-one-inside-a": connect_colliding_activities({'ConnectAssessment'}),
    "questions/connect-deliver-unit-and-task-in-one-form": connect_colliding_activities({'ConnectDeliverUnit', 'ConnectTask'}),
    "questions/connect-unit-id-changed-by-form-editor": connect_id_changes,
    "questions/a-connect-learn-module-or-task-id-longer-than-50-characters-or": connect_id_over_width,
    "questions/connect-value-that-the-editor-clears": connect_inline_calculation,
    "questions/connect-assessment-without-score": connect_missing_score,
    "questions/connect-estimate-outside-receiver-range": connect_estimate_outside_column,
    "questions/connect-block-text-read-as-an-instance": connect_text_instance,
    "questions/connect-work-area-update-photo-not-forwarded": connect_photo_not_forwarded,
    "questions/connect-work-area-update": connect_work_area_changed_by_editor,
    "questions/other-h-head-children-whose-local-name-or-a-descendant-s-core-or": head_child,
    "questions/authored-orx-pollsensor": authored_pollsensor,
    "questions/type-on-a-savetocase-property-leaf-a-create-update-or-index": savetocase_leaf_type,
    "questions/a-select-whose-bind-type-is-neither-a-choice-type-nor-a-string": non_choice_type_on_select,
    "questions/secret-with-a-numeric-bind-type": numeric_type_on_secret,
    "questions/input-whose-bind-type-vellum-does-not-write-xsd-decimal-xsd": type_vellum_does_not_write,
    "questions/an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring": _untyped_numeric("input"),
    "questions/a-secret-whose-bind-has-no-type-with-numeric-or-numbers-ignoring": _untyped_numeric("secret"),
    "questions/long-xsd-long": long_input,
    "questions/media-form-missing-in-default-language": media_missing_in_default,
    "questions/long-qrcode-or-tts-form-missing-in-default-language": label_text_missing_in_default,
    "questions/video-inline-form-on-a-text-other-than-a-question-label": inline_video_off_question_label,
    "questions/video-inline-as-the-only-content-of-a-help-text": inline_video_on_empty_help,
    "questions/long-form-on-a-hint-help-text-validation-message-or-choice": _long_form_on(
        {"hint", "help", "alert", "message", "choice"}
    ),
    "questions/long-form-on-a-repeat-action-caption": _long_form_on({"caption"}),
    "questions/long-form-on-a-group-or-repeat-label": _long_form_on({"container-label"}),
    "questions/empty-media-form-beside-a-translated-file": media_blank_beside_file,
    "questions/intent-id-naming-an-odkx-intent-that-no-callout-question-writes": orphan_android_action,
    "questions/intent-id-on-any-input-naming-no-odkx-intent-in-the-form": missing_android_action,
    "questions/android-app-callout-that-cannot-be-recreated": unreproducible_android_question,
    "questions/print-callout-class-org-commcare-dalvik-action-print-extra-cc": print_callout,
    "questions/input-readonly-true-control-attribute": readonly_input,
    "questions/jr-imagedimensionscaledmax-that-is-not-an-integer-or-is-greater": invalid_image_dimension,
    "questions/upload-with-any-other-mediatype-or-none": other_upload_mediatype,
    "questions/a-default-value-s-setvalue-whose-event-does-not-match-where-the": default_event_mismatching_placement,
    "questions/setvalue-event-xforms-value-changed-authored-xforms-revalidate": form_level_setvalue,

    "questions/savetocase-case-id-expression-on-a-create": exact_create_id,
    "questions/a-savetocase-block-that-creates-or-updates-and-also-closes-under": write_and_close,
    "questions/savetocase-owner-id-condition": conditioned_create_owner,
    "questions/savetocase-link-name-changes-actions-on-save": index_name_adds_action,
    "questions/savetocase-link-bind-lost-on-save": index_period_loses_bind,
    "questions/savetocase-create-at-the-form-root-whose-authored-case-id-xpath": savetocase_blank_create_id,
    "questions/default-other-than-blank-on-a-capture-question": default_other_than_blank_on_a_capture_question,
    "questions/actions-nested-inside-controls": action_nested_in_control,
    "questions/unknown-namespace-model-children-named-itext-instance-bind": foreign_namespace_model_child,
    "questions/jr-count-naming-a-node-in-a-secondary-instance-or-no-node": count_outside_form_data,
    "questions/jr-count-naming-a-decimal-question": count_from_decimal_question,
    "questions/jr-count-naming-any-other-question-kind-text-barcode-multi": count_from_other_question,
    "questions/jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer": count_from_non_integer_hidden_value,
    "questions/any-other-single-string-no-row-names-that-holds-a-value-android": android_inside_match_other,
    "questions/question-id-failing-the-grammar-or-meta-in-any-case": invalid_question_id,
    "questions/two-sibling-data-nodes-with-one-name": sibling_with_one_name,
    "questions/hidden-value-with-children": hidden_value_with_children,
    "questions/validation-on-a-hidden-value": validation_on_hidden_value,
    "questions/a-question-other-than-a-group-or-repeat-whose-data-node-has": question_with_children,
    "questions/default-data-value-datavalue-instance-text": default_data_value,
    "questions/hand-written-case-block-without-vellum-role-incl-a-root-data": hand_written_case_block,
    "questions/attachment-inside-a-savetocase-block": attachment_in_save_to_case,
    "questions/savetocase-update-key-nova-reserves-for-a-case-s-own-facts": reserved_save_to_case_key,
    "questions/authored-data-meta-block": authored_meta_block,
    "questions/a-root-question-commcare-usercase-in-a-form-with-usercase": usercase_root_question,
    "questions/choice-value-with-whitespace-empty-or-duplicated": choice_value_refused_by_vellum,
    "questions/choice-value-read-as-an-instance": choice_value_read_as_an_instance,
    "questions/jr-noaddremove-without-jr-count": no_add_remove_without_count,
    "questions/user-controlled-repeat-inside-a-question-list-a-group-whose": user_repeat_in_field_list,
    "questions/a-count-that-depends-on-the-rows-it-creates-through-calculations": count_reading_its_rows,
    "questions/model-iteration-repeat-nested-in-another-repeat-of-any-kind": model_iteration_nested,
    "questions/model-iteration-repeat-under-an-ancestor-that-core-s-load-can": model_iteration_under_late_relevance,
    "questions/model-iteration-repeat-whose-query-reads-a-form-answer-that-is": model_iteration_reading_blank_answer,
    "questions/relevance-bound-on-the-savetocase-node-itself": relevance_on_save_to_case,
    "questions/constraint-on-savetocase-case-leaves": constraint_in_save_to_case,
    "questions/create-case-id-live-calculate-outside-a-repeat": live_create_id,
    "questions/savetocase-create-close-or-link-of-commcare-user-or-type-user": reserved_save_to_case_type,
    "questions/bind-calculate-on-a-visible-question": calculate_on_shown_question,
    "questions/bind-on-an-attribute-path-not-owned-by-a-plugin-savetocase-model": attribute_bind_no_plugin_owns,
    "questions/bind-whose-path-names-the-data-root-itself-data-data-or-a": bind_on_data_root,
    "questions/a-second-default-setvalue-on-one-question": second_default,
    "questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes": order_a_save_changes,
    "questions/data-root-uiversion-other-than-1-or-absent": data_root_ui_version,
    "questions/requiredcondition-differing-from-a-present-non-false-required": required_condition_differing,
    "questions/validation-message-without-a-validation-condition": message_without_condition,
    "questions/literal-jr-constraintmsg-text-no-itext": literal_validation_message,
    "questions/bind-readonly": authored_readonly,
    "questions/lookup-choice-reference-the-form-editor-cannot-keep": form_itemset_ref_uneditable,
    "questions/itemset-label-jr-itext-field": itemset_label_itext,
    "questions/markdown-form-differing-from-the-default-text": markdown_differing,
    "questions/a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk": markdown_in_some_languages,
    "questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text": blank_in_the_first_language,
    "questions/a-markdown-form-in-a-form-whose-text-formatting-is-off": markdown_with_formatting_off,
    "questions/itext-entry-referenced-only-from-jr-itext-in-an-expression": itext_read_only_in_expressions,
    "questions/itext-pragma-entries-pragma-form-descriptor-pragma-skip-full": unreferenced_pragma,
    "questions/an-appearance-holding-such-whitespace-that-some-runtime-reads": appearance_whitespace_read_otherwise,
    "questions/any-other-multi-token-string-holding-a-token-no-runtime-reads-on": appearance_token_no_runtime_reads,
    "questions/a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does": per_row_without_leading_digits,
    "questions/a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-starts": (
        per_row_holding_another_read_value
    ),
    "questions/a-case-variant-of-numeric-short-or-ethiopian-as-the-whole": case_variant_read_differently,
    "questions/data-parent-crossing-a-repeat": data_parent_crossing_a_repeat,
    "questions/data-parent-at-the-form-root-under-a-grouped-control": data_parent_at_the_form_root,
    "questions/data-parent-on-a-group-or-repeat": data_parent_on_a_group_or_repeat,
    "questions/any-other-bind-id-named-by-a-control-s-bind": other_bind_id,
    "questions/label-big-image": _big_image("label"),
    "questions/choice-big-image": _big_image("choice"),
    # Application and settings
    "application-and-settings/34p-hq-build-spec-below-nova-s-floor": below_floor,
    "application-and-settings/50pp-hq-location-fixture-restore-only-hierarchical-fixture": only_hierarchical_fixture,
    "application-and-settings/a-non-empty-langs-code-outside-that-grammar-or-repeated": invalid_or_repeated_code,
    "application-and-settings/translations-key-that-is-no-locale-record-under-its-own-name": (
        translation_key_not_its_own
    ),
    "application-and-settings/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare": path_not_from_uploader,
    "application-and-settings/profile-custom-properties-any-other-entry-incl-formplayer-keys": custom_property_other,
    "application-and-settings/repeated-android-app-dependency": repeated_android_app,
    "application-and-settings/profile-properties-or-features-dependencies-value-outside-its": setting_outside_choices,
    "application-and-settings/profile-features-sense-true-or-profile-properties-cc-entry-mode": (
        sense_or_review_entry_mode
    ),
    # Forms and case writes
    "forms-and-case-writes/form-name-read-as-an-instance": form_name_read_as_an_instance,
    "forms-and-case-writes/form-type-other-than-the-form-s-own-kind": form_type_of_another_kind,
    "forms-and-case-writes/form-requires-referral": referral,
    "forms-and-case-writes/form-requires-none-with-child-cases-but-no-open": child_cases_without_open,
    "forms-and-case-writes/subcases-condition-never": subcase_never,
    "forms-and-case-writes/subcases-reference-id-any-other-value": custom_index_name,
    "forms-and-case-writes/subcases-relationship-extension": extension,
    "forms-and-case-writes/subcases-repeat-context-other-than-the-name-question-s-innermost": (
        not_name_question_repeat
    ),
    "forms-and-case-writes/a-load-or-open-action-s-case-tag-containing-which-the-advanced": tag_with_slash,
    "forms-and-case-writes/case-tag-blank-on-a-non-auto-select-action": blank_tag,
    "forms-and-case-writes/case-tag-of-a-non-auto-select-action-failing-actions-js": tag_failing_editor_check,
    "forms-and-case-writes/case-actions-using-the-same-tag": case_actions_using_the_same_tag,
    "forms-and-case-writes/worker-record-selection-with-another-case-type": worker_mode_with_another_type,
    "forms-and-case-writes/automatic-choice-with-an-unknown-mode": unknown_auto_mode,
    "forms-and-case-writes/automatic-table-choice-without-its-table-or-column": table_choice_without_its_source,
    "forms-and-case-writes/opening-values-sharing-a-physical-session-name": opening_values_sharing_a_session_name,
    "forms-and-case-writes/automatic-connection-to-a-load-renamed-by-its-parent": automatic_connection_renamed_by_parent,
    "forms-and-case-writes/loadupdateaction-preload-or-case-properties-property-with-on-a": (
        slash_property_on_indexed_load
    ),
    "forms-and-case-writes/loadupdateaction-case-index-on-an-auto-selected-load-or-on-the": (
        index_on_auto_select_or_first_load
    ),
    "forms-and-case-writes/loadupdateaction-case-index-tag-naming-a-load-other-than-the-one": (
        tag_names_other_than_previous_load
    ),
    "forms-and-case-writes/advancedopencaseaction-case-properties-key-with-parent-p": open_action_slash_key,
    "forms-and-case-writes/a-write-of-the-worker-s-record-to-a-key-no-worker-property-takes": worker_record_key,
    "forms-and-case-writes/two-or-more-open-actions-whose-repeat-context-is-one-repeat": shared_block_in_repeat,
    "forms-and-case-writes/advancedopencaseaction-repeat-context-other-than-the-name": (
        open_action_not_name_question_repeat
    ),
    "forms-and-case-writes/advancedopencaseaction-case-indices-naming-its-own-or-a-later": (
        tag_names_own_or_later_open_action
    ),
    "forms-and-case-writes/an-advanced-open-action-s-index-to-a-load-whose-datum-hq-renames": load_with_renamed_datum,
    "forms-and-case-writes/an-auto-select-load-with-a-blank-mode-or-a-blank-case-type": (
        auto_select_blank_mode_or_case_type
    ),
    "forms-and-case-writes/auto-select-mode-case-naming-itself-a-later-load-or-an-open": (
        auto_select_case_not_an_earlier_load
    ),
    "forms-and-case-writes/show-product-stock-true-or-a-non-empty-product-program": commtrack_on,
    "forms-and-case-writes/extra-actions-load-update-cases-show-product-stock-true-or-a-non": shadow_commtrack_on,
    "forms-and-case-writes/advancedform-schedule-with-enabled-true-visits-transition": schedule_enabled,
    "forms-and-case-writes/a-parent-load-tag-not-repeated-in-extra-actions-where-the-parent": (
        shadow_parent_tag_not_repeated
    ),
    "forms-and-case-writes/shadow-parent-form-id-naming-a-basic-form-or-another-shadowform": basic_or_shadow_parent,
    "forms-and-case-writes/caseindex-relationship-question-inside-a-repeat": relationship_question_in_repeat,
    "forms-and-case-writes/caseindex-relationship-question-relationship-question-the-index-naming-an": (
        question_relationship_to_open_action
    ),
    "forms-and-case-writes/caseindex-relationship-question-on-an-index-to-a-load-that": (
        question_relationship_after_open_action_index
    ),
    "forms-and-case-writes/an-advanced-open-action-indexed-to-an-open-action-that-has-a-neither": (
        outside_parent_repeat
    ),
    "forms-and-case-writes/update-case-condition-never-on-a-follow-up-with-no-other-active": (
        update_never_followup_alone
    ),
    "forms-and-case-writes/update-key-with-any-other-index-segment-or-user-where-the": unrecognized_index_key,
    "forms-and-case-writes/an-update-key-with-an-index-segment-on-a-form-that-opens-its": index_key_on_opened_case,
    "forms-and-case-writes/any-other-usercase-preload": usercase_preload_other,
    "forms-and-case-writes/a-source-only-record-load-with-no-equivalent-editable-initial-value": source_only_record_load,
    "forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-in-a-multi-select-module": (
        multi_select_top_level
    ),
    "forms-and-case-writes/case-references-data-save-differing-from-that-computation": save_differing_from_vellum,
    "forms-and-case-writes/a-basic-form-s-own-case-s-close-or-open-condition-on-another": (
        own_case_condition_not_offered_or_quoted
    ),
    "forms-and-case-writes/a-subcase-or-advanced-action-condition-on-a-question-the-picker": (
        subcase_or_advanced_condition_not_offered
    ),
    "forms-and-case-writes/an-open-close-child-case-or-advanced-action-condition-with": answer_with_apostrophe,
    "forms-and-case-writes/a-case-write-name-or-preload-on-a-question-the-picker-does-not": (
        question_not_offered_by_picker
    ),
    "forms-and-case-writes/update-from-an-upload-question-attachment-mode": upload_question,
    "forms-and-case-writes/subcase-of-the-module-s-own-case-type-in-a-project-space-with": (
        own_case_type_where_same_type_unindexed
    ),
    "forms-and-case-writes/subcases-on-such-a-form-in-an-app-that-shares-cases-where-a": (
        multi_select_case_sharing_without_owner
    ),
    "forms-and-case-writes/form-links-datums-that-leave-the-target-s-case-id-empty": target_case_id_left_empty,
    "forms-and-case-writes/form-links-datums-with-other-names-or-on-a-module-target": (
        other_datum_names_or_module_target
    ),
    "forms-and-case-writes/form-links-target-any-other-module": other_module_target,
    "forms-and-case-writes/any-other-post-form-workflow-outside-the-offered-set-previous": not_offered,
    "forms-and-case-writes/post-form-workflow-fallback-module-parent-module-or-previous": (
        not_offered_under_conditional_link
    ),
    "forms-and-case-writes/session-endpoint-id-not-a-slug-fixed-point-or-duplicated": not_a_slug_or_duplicated,
    "forms-and-case-writes/any-other-undeclared-key": undeclared_key_no_row_names,
    # Case search
    "case-search/a-server-order-naming-a-property-nova-reserves": server_order_reserved_property,
    "case-search/a-commcare-sort-x-commcare-custom-related-case-property-or-case": request_config_key_runtime_value,
    "case-search/an-x-commcare-custom-related-case-property-entry-together-with": related_case_property_twice,
    "case-search/default-properties-entry-keyed-x-commcare-data-registry": data_registry_key,
    "case-search/data-registry-data-registry-workflow-additional-registry-cases": registry_named,
    "case-search/default-properties-entry-keyed-x-commcare-endpoint-id": endpoint_id_key,
    "case-search/default-properties-entry-with-no-defaultvalue-hq-stores-an-empty": missing_default_value,
    "case-search/native-filter-value-outside-screen-scope": native_filter_unbound_value,
    "case-search/search-button-display-condition-reading-what-the-case-list-does-not-load": (
        search_button_reads_what_the_list_does_not_load
    ),
    "case-search/that-entry-together-with-blacklisted-owner-ids-expression": blacklisted_owner_ids_twice,
    "case-search/a-default-filter-and-a-search-property-sharing-one-name": shared_by_filter_and_prompt,
    "case-search/appearance-address-with-required-or-validations": address_with_required_or_validations,
    "case-search/hidden-together-with-required-or-validations": hidden_with_required_or_validations,
    "case-search/allow-blank-value-on-a-hidden-prompt": allow_blank_on_a_hidden_prompt,
    "case-search/allow-blank-value-on-a-prompt-named-owner-id": allow_blank_beside_the_owner,
    "case-search/validations-1": later_validations,
    "case-search/input-select1-select-commcare-reports-itemset-mobile-ucr": mobile_ucr_reports,
    "case-search/input-no-runtime-names": input_no_runtime_names,
    "case-search/receiver-expression-on-a-prompt-whose-editor-appearance-is": receiver_on_another_appearance,
    "case-search/search-button-label-any-other-value": other_search_button_label,
    "case-search/workflow-legacy-classic-auto-launch-false-in-an-app-with": list_first_with_web_apps,
    "case-search/a-prompt-that-reaches-hq-as-its-own-key-named-as-a-config-keys": reserved_request_key,
    "case-search/property-names-operators-or-function-names-computed-at-runtime": runtime_query_structure,
    # Menus and case lists
    "menus-and-case-lists/menu-order-that-separates-a-child-from-its-parent": child_menu_separated_from_its_parent,
    "menus-and-case-lists/module-unique-id-missing": missing_module_id,
    "menus-and-case-lists/case-type-commcare-user-or-user-owner-mapping-case-on-a-basic": (
        reserved_word_on_a_basic_module
    ),
    "menus-and-case-lists/case-type-outside-the-menu-page-s-grammar": case_type_outside_the_menu_page,
    "menus-and-case-lists/module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed": not_a_slugify_fixed_point,
    "menus-and-case-lists/two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form": (
        shared_with_another_endpoint
    ),
    "menus-and-case-lists/module-task-list-show-true": task_list_shown,
    "menus-and-case-lists/auto-select-case-true-on-a-basic-module-an-advanced-form-s-load": (
        auto_select_on_a_load_target
    ),
    "menus-and-case-lists/shadowmodule-case-list-show-true": shown_on_a_shadow_module,
    "menus-and-case-lists/module-filter-false-on-a-menu-something-opens": filter_off_the_menu_on_a_destination,
    "menus-and-case-lists/15-address-popup": format_reader("address-popup"),
    "menus-and-case-lists/17-picture": format_reader("picture"),
    "menus-and-case-lists/18-audio": format_reader("audio"),
    "menus-and-case-lists/22-graph": format_reader("graph"),
    "menus-and-case-lists/23-image-cc-case-image": format_reader("image"),
    "menus-and-case-lists/model-product": product,
    "menus-and-case-lists/advancedmodule-product-details-differing-from-the-default": differs_from_the_default,
    "menus-and-case-lists/16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case": clickable_icon_list_empty,
    "menus-and-case-lists/16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint": clickable_icon_on_detail,
    "menus-and-case-lists/clickable-icon-with-an-unusable-form-endpoint": clickable_icon_unusable,
    "menus-and-case-lists/21p-translatable-enum-key-outside-a-za-z0-9": translatable_enum_key_grammar,
    "menus-and-case-lists/translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-offers": (
        translatable_enum_over_relation
    ),
    "menus-and-case-lists/5p-enum-key-containing": enum_xml_special_key,
    "menus-and-case-lists/an-enum-enum-image-conditional-enum-or-translatable-enum-column": mapping_with_shared_key,
    "menus-and-case-lists/2p-date-any-other-date-format": date_with_another_pattern,
    "menus-and-case-lists/3p-time-ago-other-interval": time_ago_with_another_interval,
    "menus-and-case-lists/a-geo-column-without-the-column-it-depends-on": geo_without_dependency,
    "menus-and-case-lists/24p-filter-otherwise": filter_changes_the_build,
    "menus-and-case-lists/more-than-one-address-column-or-more-than-one-image-or-geo": several_of_one_format_basic,
    "menus-and-case-lists/more-than-one-image-or-geo-column-of-the-same-format-in-a-detail": (
        several_of_one_format_advanced
    ),
    "menus-and-case-lists/field-failing-details-utils-js-isvalidpropertyname-non": fails_property_name_check,
    "menus-and-case-lists/property-x-or-prefix-x-with-a-prefix-hq-registers-no-generator": explicit_property_prefix,
    "menus-and-case-lists/case-id-as-a-property-column-s-field": case_id_element,
    "menus-and-case-lists/custom-tile-column-with-grid-null-unplaced": null_on_unplaced_tile,
    "menus-and-case-lists/custom-tile-font-size-null": null_font_size_on_tile,
    "menus-and-case-lists/custom-tile-cells-covering-the-same-square": overlapping_tile_cells,
    "menus-and-case-lists/custom-tile-cell-outside-the-grid": tile_cell_outside_the_grid,
    "menus-and-case-lists/detail-tab-child-type-no-form-of-its-menu-s-case-type-adds": tab_child_type_no_form_adds,
    "menus-and-case-lists/custom-tile-cell-below-the-rows-hq-s-page-offers": tile_cell_below_the_offered_rows,
    "menus-and-case-lists/horizontal-align-null-on-a-placed-custom-tile-column": null_alignment_on_placed_tile,
    "menus-and-case-lists/detail-case-tile-template-person-simple": person_simple_on_list,
    "menus-and-case-lists/long-detail-non-custom-tile": not_custom_on_detail,
    "menus-and-case-lists/field-and-a-differing-sort-calculation-on-any-other-column": (
        beside_a_field_on_another_format
    ),
    "menus-and-case-lists/short-columns-empty-on-a-module-another-module-s-active-parent": (
        empty_short_detail_another_selects_from
    ),
    "menus-and-case-lists/case-list-form-on-a-child-put-in-root-module-whose-parent-s-case": (
        on_child_whose_parent_registers_same_form
    ),
    "menus-and-case-lists/case-list-form-on-a-module-whose-forms-do-not-all-require-a-case": (
        on_module_whose_forms_do_not_all_require_a_case
    ),
    "menus-and-case-lists/case-list-form-on-a-put-in-root-module-whose-case-list-is-a-tile": (
        on_display_only_module_with_tile_list
    ),
    "menus-and-case-lists/case-list-form-post-form-workflow-default-on-a-multi-select-host": (
        default_on_multi_select_host
    ),
    "menus-and-case-lists/put-in-root-session-endpoint-id-or-inline-search-or-an-end-of": (
        put_in_root_beside_an_endpoint_inline_search_or_form_return
    ),
    "menus-and-case-lists/case-list-session-endpoint-id-on-a-put-in-root-module": (
        case_list_endpoint_on_a_put_in_root_module
    ),
    "menus-and-case-lists/form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first": (
        form_filter_reads_case_off_a_case_first_screen
    ),
    "menus-and-case-lists/any-module-under-a-training-menu": names_a_training_module,
    "menus-and-case-lists/any-other-module-under-a-shadow-menu": names_a_shadow_module,
    "menus-and-case-lists/child-menu-deeper-than-one-tier-grandchild": grandchild,
    "menus-and-case-lists/module-with-is-training-module-true-training-menu-root-training": training_module,
    "menus-and-case-lists/custom-assertions-module-non-empty": custom_assertions_non_empty,
    "menus-and-case-lists/parent-select-module-id-naming-a-multi-select-module-or-an": names_a_multi_select_module,
    "menus-and-case-lists/parent-select-naming-a-survey-module-on-a-child-that-shows-its": names_a_survey_module,
    "menus-and-case-lists/detail-max-select-value-of-0-or-below-1-on-a-multi-select-basic": zero_or_below_minus_one,
    "menus-and-case-lists/detail-filter-failing-etree-xpath-dummy-filter": fails_filter_xpath_check,
    "menus-and-case-lists/any-other-undeclared-key": undeclared_key_no_row_names,
    "menus-and-case-lists/shared-form-menu-with-an-unavailable-source-form": unavailable_source_form,
    "menus-and-case-lists/shared-form-menus-with-incomplete-submenus": incomplete_shared_submenus,
    "menus-and-case-lists/first-menu-registration-return-without-a-compatible-case": (
        first_menu_registration_return_otherwise
    ),
    "forms-and-case-writes/function-datum-endpoints-with-an-unavailable-supplier": function_datum_without_one_creation,
    "forms-and-case-writes/first-menu-selection-used-for-different-records": first_menu_case_read_otherwise,
    "menus-and-case-lists/custom-icon-form-other-than-badge": badge_form_other_than_badge,
    "menus-and-case-lists/badge-missing-localized-text": badge_without_text,
    "menus-and-case-lists/badge-calculation-outside-typed-values": badge_calculation_untyped,
    "menus-and-case-lists/navigation-condition-outside-typed-worker-context": navigation_condition_untyped,
    "menus-and-case-lists/shadowmodule-version-1-or-key-absent-model-default-1": shadow_version_one,
    "menus-and-case-lists/mirror-form-deep-links-on-a-menu-listing-survey-forms": mirror_form_links_on_survey_listing,
    "menus-and-case-lists/a-shadow-menu-s-own-or-mirror-form-endpoint-id-with-surrounding": shadow_endpoint_id_padded,
    # Expressions and data
    "expressions-and-data/inline-instance-content-inside-instance-no-src": inline_instance,
    "expressions-and-data/more-than-one-instance-without-an-id": unnamed_instances,
    "expressions-and-data/session-data-supply-point-id-anywhere-except-in-an-advanced-form": supply_point_datum,
    "expressions-and-data/session-data-datum-the-entry-does-not-supply": datum_not_supplied,
    "expressions-and-data/var-in-a-form-expression": var_in_form,
    "expressions-and-data/here-in-a-form": here_in_form,
    "expressions-and-data/case-module-slug-unrelated-parent-select-case": case_named_by_its_slug,
    "expressions-and-data/session-context-window-width-in-form-logic": window_width_in_form_logic,
    "expressions-and-data/jr-choice-name-on-a-lookup-itemset-select": choice_name_on_lookup,
    "expressions-and-data/declared-and-referenced-instance-with-an-unrecognized-src": referenced_unrecognized_source,
    "expressions-and-data/ledgerdb-vellum-id-ledger": ledger_read,
    "expressions-and-data/after-a-named-step-data-a-b": parent_after_named_step,
    "expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string": time_operand,
    "expressions-and-data/results-read-in-form-expressions-reached-through-a-search-that": (
        non_inline_search_form("results")
    ),
    "expressions-and-data/search-input-read-in-form-expressions-reached-through-a-search": (
        non_inline_search_form("search-input")
    ),
    "expressions-and-data/legacy-search-input-read-after-the-query-in-the-results-detail": legacy_after_query,
    "expressions-and-data/commtrack-locations-hierarchical": hierarchical_locations,
    "case-search/instance-name-containing-casedb-ledgerdb-fixture-or-session": _scope_reader(
        ("CaseSearch",), lambda at, config: any(part in (config.get("instance_name") or "") for part in ("casedb", "ledgerdb", "fixture", "session"))
    ),
    "case-search/results-name-outside-the-search-editor": _scope_reader(
        ("CaseSearch",), lambda at, config: bool(config.get("instance_name")) and not re.fullmatch(r"[A-Za-z]\w*", config["instance_name"])
    ),
    "case-search/p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of": untyped_right_side,
    "case-search/date-opened-closed-on-or-last-modified-compared-with-any": non_date_value,
    "expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install": (
        android_verified_path_without_entry
    ),
    "expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws": (
        media_reference_drawn_without_entry
    ),
    "menus-and-case-lists/mapping-condition-outside-predicate": mapping_condition_outside_predicate,
    "menus-and-case-lists/columns-above-the-first-tab-when-tabs-exist": columns_above_the_first_tab,
    "menus-and-case-lists/tab-display-condition-outside-its-case-scope": tab_condition_outside_case_scope,
    "menus-and-case-lists/detail-tab-without-a-resolvable-row-source": tab_without_a_resolvable_row_source,
    "menus-and-case-lists/form-context-expression-outside-its-case-scope": form_context_expression_outside_case_scope,
    "menus-and-case-lists/form-context-without-a-compatible-case-tile": form_context_without_a_compatible_tile,
    "menus-and-case-lists/two-different-values-for-the-same-form-context": competing_form_context_values,
    "menus-and-case-lists/sort-calculation-without-a-typed-value": independent_sort_without_scalar,
    "menus-and-case-lists/distance-sort-without-a-location-field": calculated_distance_without_property,
    "menus-and-case-lists/distance-on-a-translated-calculated-field": distance_on_translated_calculation,
    "menus-and-case-lists/type-index-cache-and-index-order-2": sort_type_index,
    "expressions-and-data/image-tiff-heif": tiff_heif,
    "expressions-and-data/image-svg": svg_image,
    "expressions-and-data/audio-wav-that-is-not-8-or-16-bit-pcm": other_wav,
    "expressions-and-data/audio-3gp": audio_3gp,
    "expressions-and-data/audio-m4a-with-another-brand-isom-mp41-mp42-dash": audio_m4a_other_brand,
    "expressions-and-data/video-av1-mov-avi-ogg-theora-h-263-3gp": av1_mov_avi_theora_h263,
    "forms-and-case-writes/form-filter-using-fixture-value": fixture_value,
    # HELD-NEW classes beside an allowing class of their key, each decided by the use's own value
    "forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character": non_ascii_core_name_key,
    "forms-and-case-writes/index-identifier-outside-an-xml-element-name": index_identifier_outside_an_xml_name,
    "case-search/prompt-key-outside-nova-s-name-grammar": prompt_key_outside_nova_s_name_grammar,
    "case-search/case-search-endpoint-id": endpoint_on_an_offered_search,
    "questions/data-root-name-that-workers-cannot-address": unaddressable_answer_root,
    "questions/answer-root-that-the-form-designer-reads-as-its-own-element": designer_reserved_answer_root,
    "menus-and-case-lists/detail-max-select-value-above-100": max_select_value_above_100,
    "menus-and-case-lists/case-tile-group-identifier-outside-an-xml-element-name": (
        tile_group_identifier_outside_an_xml_name
    ),
    "menus-and-case-lists/column-reading-an-unknown-hash-property": column_hash_property,
    "questions/submitted-node-consumed-as-case": submitted_case_answer,
    "questions/question-lock-the-designer-cannot-represent": unsupported_question_lock,
    "questions/ordinary-answer-in-stock-namespace": ordinary_stock_answer,
    "questions/submitted-namespace-the-form-designer-cannot-keep": namespace_the_designer_cannot_keep,
    "application-and-settings/build-profiles-invalid-language-subset": invalid_profile_languages,
}
