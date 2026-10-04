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
values (``manifest_usage.standing``).

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
import re
import unicodedata
from dataclasses import dataclass
from functools import cache, cached_property

from lxml import etree

from proof.checks.compare.names import NOVA_PREFIX, nova_name
from proof.observe.manifest import CSQL_HOLE

XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"
JAVAROSA = "http://openrosa.org/javarosa"
VELLUM = "http://commcarehq.org/xforms/vellum"
OPENDATAKIT = "http://opendatakit.org/xforms"
OPENROSA = "http://openrosa.org/jr/xforms"
CASE = "http://commcarehq.org/case/transaction/v2"

# The controls Core's XFormParser hands a bind's node to (its control handlers), by local name.
SELECTS = frozenset({"select", "select1"})


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
        """The body's elements that name a node, by the text of the path they name (``ref``, or a repeat's
        ``nodeset``, or a ``bind`` id's nodeset)."""
        found = {}
        body = self.root.find(f"{{{XHTML}}}body")
        for element in body.iter() if body is not None else ():
            if not isinstance(element.tag, str):
                continue
            path = element.get("ref") or element.get("nodeset")
            if path is None and element.get("bind") in self.binds_by_id:
                path = self.binds_by_id[element.get("bind")].get("nodeset")
            if path:
                found.setdefault(path.strip(), []).append(element)
        return found

    def bind(self, path):
        """The bind Core applies to a path's node: the last of the binds naming it (``XFormParser.parseBind``
        applies each in turn)."""
        binds = self.binds.get((path or "").strip())
        return binds[-1] if binds else None

    def control_path(self, control):
        path = control.get("ref") or control.get("nodeset")
        if path is None and control.get("bind") in self.binds_by_id:
            path = self.binds_by_id[control.get("bind")].get("nodeset")
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
        return _declared_instances(self.root)

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
        its controls' ``label``, ``hint``, ``help`` and ``alert``, its choices' labels (``choice``) and its repeat
        captions (``caption``; ``javaRosa/plugin.js::populateControlMug``, ``parseRepeatItexts``), and its binds'
        validation messages (``message``, ``getITextID``), in document order."""
        found = []
        for element in self.body.iter() if self.body is not None else ():
            if not isinstance(element.tag, str):
                continue
            parent = element.getparent()
            local = _local(element)
            if local in ("label", "hint", "help", "alert") and _local(parent) in QUESTION_CONTROLS | {"item"}:
                found.append((element.get("ref"), "choice" if (local, _local(parent)) == ("label", "item") else local))
            elif element.tag in (f"{{{JAVAROSA}}}addCaption", f"{{{JAVAROSA}}}addEmptyCaption"):
                found.append((element.get("ref"), "caption"))
        for binds in self.binds.values():
            found += [(bind.get(f"{{{JAVAROSA}}}constraintMsg"), "message") for bind in binds]
        return tuple((value, kind) for value, kind in found if value is not None)

    def tree(self, text):
        """HQ's XPath grammar's structure of an expression (the observation's ``trees``), or None where the records
        hold none."""
        if self.readings is None or text is None:
            return None
        return self.readings.trees.get(text)

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
                kinds.setdefault(text_id, set()).add(kind)
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


def _itext_id(tree):
    """The text id Vellum's ``getITextID`` reads in an expression (``javaRosa/plugin.js``: an expression that is a
    ``jr:itext`` call names its first argument's value), from its structure: the call's first argument where that
    is a string, else None (it names none)."""
    if tree[0] == "call" and tree[1] == "jr:itext" and tree[2] and tree[2][0][0] == "text":
        return tree[2][0][1]
    return None


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
    """An app JSON as the value classes read it: the document and each form's XForm (``Form``)."""

    kind = "app"

    def __init__(self, doc, artifact):
        self.doc = doc
        self.artifact = artifact
        self.forms = {}  # a form's unique_id -> Form
        self.readings = None

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

    @cached_property
    def case_types(self):
        return {module.get("case_type") for module in self.modules if module.get("case_type")}

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


def print_callout(use, manifest):
    """``questions/print-callout-…``: an input Vellum reads as an Android callout (bind type ``intent``)
    whose ``<odkx:intent>`` (by the question's node name, ``intentManager.js::syncMugWithIntent``) has the
    print action's class, which Vellum turns into its Print question."""
    form, element = _form_element(use)
    if form is None:
        return None
    if _local(element) != "input":
        return False
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


# Setvalues ----------------------------------------------------------------------


def _setvalue(use):
    """The setvalue element a use sits on (``jr-action:setvalue``, or its ``@event``), with its form."""
    form, element = _form_element(use)
    if form is None or _local(element) != "setvalue":
        return None, None
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


def _target(form, setvalue):
    """A setvalue's target node (an element, or ``(element, attribute)``), or None."""
    return form.node(setvalue.get("ref"))


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
    (``jr-insert``)."""
    for container in form.model_repeats:
        path = form.paths[container]
        parent = container.getparent()
        nested = parent is not None and parent in form.paths and form.in_repeat(form.paths[parent])
        top = "jr-insert" if nested else "xforms-ready"
        if (setvalue.get("event"), (setvalue.get("ref") or "").strip()) in {
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


def default_event_mismatching_placement(use, manifest):
    """``questions/a-default-value-s-setvalue-whose-event-does-not-match-…``: a setvalue Vellum reads as a
    Default Value whose event does not match where the question sits, which a save rewrites
    (``defaultOptions.getSetValues``: ``jr-insert`` in a repeat, ``xforms-ready`` outside one, by
    ``isInRepeat``)."""
    form, setvalue = _setvalue(use)
    if form is None:
        return None
    target = _target(form, setvalue)
    if target is None:
        return None if _model_level(form, setvalue) else False
    if not _default_value(form, setvalue, target):
        return False
    inside = form.in_repeat(form.paths[target])
    return (setvalue.get("event") == "jr-insert") != inside


def form_level_setvalue(use, manifest):
    """``questions/setvalue-event-xforms-value-changed-authored-xforms-revalidate``: a setvalue Vellum keeps
    only as a form-level setvalue: one its parser reads (``head > model > setvalue``) that is no question's
    Default Value (``parser.js::parseSetValue``) and that no plugin takes as its own (a model iteration's,
    ``modeliteration.js``; a SaveToCase create's Case ID, ``saveToCase.js``). What HQ's build writes is no
    authored setvalue."""
    form, setvalue = _setvalue(use)
    if form is None:
        return None
    if not _model_level(form, setvalue):
        return False  # an action nested in a control is that row's
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
    target = _target(form, setvalue)
    if target is None:
        return None if _model_level(form, setvalue) else False
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


# Nova's types of the values an XPath expression's parts give (lib/domain/predicate/typeChecker.ts: a number
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


def path_not_from_uploader(use, manifest):
    """``application-and-settings/logo-refs-slot-path-other-than-the-uploader-s-…``: a logo slot whose path
    is not the one HQ's uploader writes (``ProcessLogoFileUploadView.form_path``:
    ``jr://file/commcare/logo/data/<slot><ext>``)."""
    at = _json(use)
    if at is None:
        return None
    for slot, ref in (at.app.doc.get("logo_refs") or {}).items():
        path = ref.get("path") if isinstance(ref, dict) else None
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


# Forms and case writes -----------------------------------------------------------------


def _form(use):
    at = _json(use)
    if at is None:
        return None, None
    return at, at.nearest(*FORMS)


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
    if not _in_actions(at, form, "update_case"):
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
    return any("/" in str(key) for key in (_actions(form).get("update_case") or {}).get("update") or {})


def usercase_preload_other(use, manifest):
    """``forms-and-case-writes/any-other-usercase-preload``: a ``usercase_preload`` on a form whose active
    ``usercase_update`` writes nothing (the row above holds one beside an update that writes at least one
    property, where moving each load to a default leaves the load's values the same, which the export does
    not settle: None)."""
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
    return None


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


def load_changes_values(use, manifest):
    """``forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held``: a basic
    ``case_preload`` into a question outside any repeat whose held spelling (a default value at the
    question's place in data-tree order, which replaces the question's own default) would change a node's
    value or relevance once the form has loaded, on some opening (README, "Load-time values"). HQ runs the
    load after every other load-time setvalue (``XForm.add_case_preloads``); the held spelling runs it at the
    question's place, as Vellum writes each default (``writer.js::createSetValues``). So only a load-time
    setvalue after that place can see the difference: one that reads the question (or a node holding it) sees
    the case's value there instead of blank, on every opening whose case holds one; one that reads only other
    nodes sees what it saw unless such a node is calculated or conditioned, which this does not follow
    (None); one before the place, or one reading no node of the form, sees the same in both."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "case_preload"):
        return False
    preload = (_actions(form).get("case_preload") or {}).get("preload") or {}
    if not preload or _requires(form) == "none":
        return False
    xform = at.app.xform(form)
    if xform is None or xform.model is None:
        return None
    order = {path: position for position, path in enumerate(xform.nodes)}
    questions = [path for path in preload if not xform.in_repeat(path) and path in order]
    if not questions:
        return None if any(path not in order for path in preload) else False
    unsure = False
    for setvalue in xform.model.iterfind(f"{{{XFORMS}}}setvalue"):
        if "xforms-ready" not in (setvalue.get("event") or "").split():
            continue
        target = (setvalue.get("ref") or "").strip()
        tree = xform.readings.trees.get(setvalue.get("value")) if xform.readings is not None else None
        if tree is None or target not in order:
            return None
        later = [question for question in questions if order[target] > order[question] and target != question]
        if not later or not _reads_form(tree, "form"):
            continue
        reads = _form_reads(tree)
        if reads is None:
            unsure = True
            continue
        for question in later:
            if any(question == read or question.startswith(f"{read}/") for read in reads):
                return True
        if any(_computed(xform, read) for read in reads):
            unsure = True
    return None if unsure else False


def _form_reads(tree):
    """Every path from the form's root an expression reads, or None where it reads the form's nodes another
    way (from the context node, or ``current()``)."""
    found = []

    def walk(node, context):
        kind = node[0]
        if kind == "path":
            root = node[1]
            if root == "absolute":
                found.append(node[2])
            elif root == "call:current" or (root == "relative" and context == "form"):
                return False
            inner = "instance" if root.startswith("instance:") else context
            return all(walk(predicate, inner) for predicate in node[3])
        if kind == "binary":
            return walk(node[2], context) and walk(node[3], context)
        if kind == "negative":
            return walk(node[1], context)
        if kind == "call":
            return node[1] != "current" and all(walk(argument, context) for argument in node[2])
        return True

    return found if walk(tree, "form") else None


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


def save_differing_from_vellum(use, manifest):
    """``forms-and-case-writes/case-references-data-save-differing-from-that-computation``:
    ``case_references_data.save`` other than what Vellum computes from the form's SaveToCase blocks
    (``saveToCase.js::getCaseSaveData``). A form with no SaveToCase block computes none, so a non-empty save
    there differs; one with blocks needs Vellum's computation (None)."""
    at, form = _form(use)
    if form is None:
        return None
    save = ((form.get("case_references_data") or {}).get("save")) or {}
    xform = at.app.xform(form)
    if xform is None:
        return None
    if not xform.save_to_case:
        return bool(save)
    return None


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
    case's condition or close condition on a question the picker does not offer."""
    at, form = _form(use)
    if form is None:
        return None
    if not _in_actions(at, form, "subcases"):
        return False
    xform = at.app.xform(form)
    subcase = at.nearest("OpenSubCaseAction")
    for each in [subcase] if subcase is not None else _subcases(form):
        for slot in ("condition", "close_condition"):
            condition = each.get(slot) or {}
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
    (``case_config_ui.js``: "Inside the wrong repeat!"). Read on the write or preload a use sits on, else on
    every one of the form's."""
    at, form = _form(use)
    if form is None:
        return None
    if (form.get("doc_type") or "Form") != "Form":
        return None
    xform = at.app.xform(form)
    if xform is None:
        return None
    subcase = at.nearest("OpenSubCaseAction")
    written = at.nearest("ConditionalCaseUpdate")
    preload = at.nearest("PreloadAction")
    if subcase is not None:
        return _child_write_not_offered(xform, subcase, written)
    if written is not None:
        return _own_write_not_offered(xform, written.get("question_path"))
    if preload is not None:
        return any(_own_write_not_offered(xform, path) for path in preload.get("preload") or {})
    actions = _actions(form)
    own = [
        update.get("question_path") if isinstance(update, dict) else None
        for name in ("update_case", "usercase_update")
        for update in ((actions.get(name) or {}).get("update") or {}).values()
    ]
    open_name = (actions.get("open_case") or {}).get("name_update") or {}
    own.append(open_name.get("question_path") if isinstance(open_name, dict) else None)
    own += list((actions.get("case_preload") or {}).get("preload") or {})
    return any(_own_write_not_offered(xform, path) for path in filter(None, own)) or any(
        _child_write_not_offered(xform, each, None) for each in _subcases(form)
    )


def _own_write_not_offered(xform, path):
    return bool(path) and (xform.in_repeat(path) or _is_label(xform, path))


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
    if not _in_actions(at, form, "update_case"):
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
    the module's own case type, refused where the project space has DONT_INDEX_SAME_CASETYPE on, which the
    export does not carry: a child of another type is not in the class, one of the same type is None."""
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
    return None if same else False


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


def _selection_datums(app, link):
    """The datums HQ's link editor offers for a form link's target (``views/forms.py::_get_form_datums``: the
    target form's datums that require a selection, ``EntriesHelper.get_datums_meta_for_form_generic``), where
    the target is a form in a basic menu that selects one case with no parent selection or registry:
    ``case_id`` for a form that requires a case, none for one that does not. A search the menu
    offers changes none of them: its query is a datum that requires no selection, and the case it selects
    keeps its session variable (``EntriesHelper.add_remote_query_datums``, ``get_datum_meta_module``). None for
    any other target, whose datums need HQ's suite."""
    target = app.forms_by_id.get(link.get("form_id"))
    module = app.module_of(target) if target is not None else None
    if target is None or module is None or (module.get("doc_type") or "Module") != "Module":
        return None
    if (target.get("doc_type") or "Form") != "Form" or _multi_select(module):
        return None
    if (module.get("parent_select") or {}).get("active") or (module.get("search_config") or {}).get("data_registry"):
        return None
    return {"case_id"} if _requires(target) == "case" else set()


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
    ``x_commcare_custom_related_case_property`` default filter beside ``custom_related_case_property``."""
    at, config = _search(use)
    if config is None:
        return None
    keyed = any(
        each.get("property") == "x_commcare_custom_related_case_property"
        for each in config.get("default_properties") or []
        if isinstance(each, dict)
    )
    return keyed and bool(config.get("custom_related_case_property"))


def data_registry_key(use, manifest):
    """``case-search/default-properties-entry-keyed-x-commcare-data-registry``."""
    at, config = _search(use)
    if config is None:
        return None
    return any(entry.get("property") == "x_commcare_data_registry" for entry in _default_entries(at, config))


def endpoint_id_key(use, manifest):
    """``case-search/default-properties-entry-keyed-x-commcare-endpoint-id``."""
    at, config = _search(use)
    if config is None:
        return None
    return any(entry.get("property") == "x_commcare_endpoint_id" for entry in _default_entries(at, config))


def missing_default_value(use, manifest):
    """``case-search/default-properties-entry-with-no-defaultvalue-…``: a default filter with no
    ``defaultValue`` (HQ stores an empty one as none, ``DefaultCaseSearchProperty.wrap``)."""
    at, config = _search(use)
    if config is None:
        return None
    return any(not entry.get("defaultValue") for entry in _default_entries(at, config))


def blacklisted_owner_ids_twice(use, manifest):
    """``case-search/that-entry-together-with-blacklisted-owner-ids-expression``: a
    ``commcare_blacklisted_owner_ids`` default filter beside ``blacklisted_owner_ids_expression``."""
    at, config = _search(use)
    if config is None:
        return None
    keyed = any(
        each.get("property") == "commcare_blacklisted_owner_ids"
        for each in config.get("default_properties") or []
        if isinstance(each, dict)
    )
    return keyed and bool(config.get("blacklisted_owner_ids_expression"))


def shared_by_filter_and_prompt(use, manifest):
    """``case-search/a-default-filter-and-a-search-property-sharing-one-name``."""
    at, config = _search(use)
    if config is None:
        return None
    prompts = {each.get("name") for each in config.get("properties") or [] if isinstance(each, dict)}
    filters = {each.get("property") for each in config.get("default_properties") or [] if isinstance(each, dict)}
    return bool((prompts & filters) - {None, ""})


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


address_with_required_or_validations = _prompt_reader(
    lambda prompt: prompt.get("appearance") == "address" and (_required(prompt) or bool(_validations(prompt)))
)
address_with_required_or_validations.__doc__ = """``case-search/appearance-address-with-required-or-validations``."""

hidden_with_required_or_validations = _prompt_reader(
    lambda prompt: bool(prompt.get("hidden")) and (_required(prompt) or bool(_validations(prompt)))
)
hidden_with_required_or_validations.__doc__ = """``case-search/hidden-together-with-required-or-validations``."""

later_validations = _prompt_reader(
    lambda prompt: len(_validations(prompt)) > 1 and not prompt.get("hidden") and prompt.get("appearance") != "address"
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


SEARCH_BUTTON_LABEL = {"en": "Search All Cases"}


def other_search_button_label(use, manifest):
    """``case-search/search-button-label-any-other-value``: a ``search_button_label`` other than HQ's
    default ``{en: Search All Cases}`` (``CaseSearch`` model)."""
    at, config = _search(use)
    if config is None:
        return None
    label = config.get("search_button_label")
    return label is not None and label != SEARCH_BUTTON_LABEL


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


product = _column_reader(lambda at, column, detail, kind, module: column.get("model") == "product")
product.__doc__ = """``menus-and-case-lists/model-product``: a column whose ``model`` is ``product``."""


def _clickable_icon_list_empty(at, column, detail, kind, module):
    if _format(column) != "clickable-icon" or kind != "short" or column.get("endpoint_action_id"):
        return False
    # In a basic or shadow module HQ's build refuses it (``invalid clickable icon configuration``), which the
    # bar reports; an advanced module skips that check and builds no action.
    return module.get("doc_type") == "AdvancedModule"


clickable_icon_list_empty = _column_reader(_clickable_icon_list_empty)
clickable_icon_list_empty.__doc__ = (
    """``menus-and-case-lists/16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case``."""
)

clickable_icon_on_detail = _column_reader(
    lambda at, column, detail, kind, module: _format(column) == "clickable-icon" and kind == "long"
)
clickable_icon_on_detail.__doc__ = (
    """``menus-and-case-lists/16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint``."""
)

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
    return any(abs(number - offered) < 1e-9 for offered in TIME_AGO_INTERVALS)


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


def _repeated_single_format(detail):
    formats = [_format(column) for column in _columns(detail)]
    return any(formats.count(single) > 1 for single in SINGLE_FORMATS)


def several_of_one_format_basic(use, manifest):
    """``menus-and-case-lists/more-than-one-address-column-or-more-than-one-image-or-geo``: in a basic or
    shadow module's detail, a second ``image`` or geo column of one format, which the editor refuses; a
    second ``address`` fails HQ's build (``invalid tile configuration``), which the bar reports."""
    at, column, detail, kind, module = _column(use)
    if detail is None:
        return None
    return (module or {}).get("doc_type") != "AdvancedModule" and _repeated_single_format(detail)


def several_of_one_format_advanced(use, manifest):
    """``menus-and-case-lists/more-than-one-image-or-geo-column-of-the-same-format-in-a-detail``."""
    at, column, detail, kind, module = _column(use)
    if detail is None:
        return None
    return (module or {}).get("doc_type") == "AdvancedModule" and _repeated_single_format(detail)


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


def _custom_tile(detail):
    return detail.get("case_tile_template") == "custom"


null_on_unplaced_tile = _column_reader(
    lambda at, column, detail, kind, module: (
        _custom_tile(detail) and (column.get("grid_x") is None or column.get("grid_y") is None)
    )
)
null_on_unplaced_tile.__doc__ = """``menus-and-case-lists/custom-tile-column-with-grid-null-unplaced``."""

null_font_size_on_tile = _column_reader(
    lambda at, column, detail, kind, module: (
        _custom_tile(detail) and "font_size" in column and column.get("font_size") is None
    )
)
null_font_size_on_tile.__doc__ = """``menus-and-case-lists/custom-tile-font-size-null``."""

null_alignment_on_placed_tile = _column_reader(
    lambda at, column, detail, kind, module: (
        _custom_tile(detail)
        and column.get("grid_x") is not None
        and column.get("grid_y") is not None
        and column.get("horizontal_align") is None
    )
)
null_alignment_on_placed_tile.__doc__ = (
    """``menus-and-case-lists/horizontal-align-null-on-a-placed-custom-tile-column``."""
)


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


def _parent_select_reader(test):
    def reader(use, manifest):
        at, module = _module_of_detail(use)
        if module is None:
            return None
        parent = module.get("parent_select") or {}
        if not parent.get("active"):
            return False
        target = at.app.modules_by_id.get(parent.get("module_id"))
        if target is None:
            return False  # an invalid candidate is HQ's build's (``invalid parent select id``), which the bar reports
        return test(at, module, target)

    return reader


names_a_multi_select_module = _parent_select_reader(lambda at, module, target: _multi_select(target))
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
    value = short.get("max_select_value")
    return isinstance(value, int) and not isinstance(value, bool) and (value == 0 or value < -1)


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


def _entry_searches_inline(entry):
    session = next((child for child in _children(entry) if _local(child) == "session"), None)
    return session is not None and any(
        _local(child) == "query" for child in session.iter() if isinstance(child.tag, str)
    )


def non_inline_search_form(prefix):
    def reader(use, manifest):
        instance, entry = _instance_in(use)
        if instance is None:
            return None
        if entry is None or not (instance.get("id") or "").startswith(prefix):
            return False
        return not _entry_searches_inline(entry)

    reader.__doc__ = (
        f"An ``{prefix}`` instance a form's entry declares, reached through a search that is not inline (the"
        " entry's session holds no query): the search's ``<rewind>`` drops the step that loads it"
        " (``SessionFrame.rewindToMarkAndSet``)."
    )
    return reader


def legacy_after_query(use, manifest):
    """``expressions-and-data/legacy-search-input-read-after-the-query-in-the-results-detail``: the legacy
    bare ``search-input`` instance declared by a form's entry or a detail, read after the query."""
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
            item[0] == "fn" and item[1] == CSQL_HOLE for item in reading
        ):
            return True
        steps = sum(1 for item in reading if item[0] == "step" and item[1] == CSQL_HOLE)
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
    value functions that gives a date, datetime or number is typed (``XPATH_VALUE_FUNCTIONS``)."""
    if side in ("number", "date", "datetime"):
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
    ``commcare-profile-settings.yml``). Whether a reference has its file is the media's, which the export does
    not carry: with the verification off no reference is in the class, and with it on the export does not
    say."""
    at = _json(use)
    if at is None:
        return None
    properties = ((at.app.doc.get("profile") or {}).get("properties")) or {}
    return None if properties.get("cc-content-valid") == "no" else False


# Media ----------------------------------------------------------------------------

MEDIA_PREFIX = "jr://file/"


def _media(use):
    """What the file a ``media-class`` use's multimedia map item names is (``proof.observe.manifest.
    media_facts``), as Nova's local archive carries it at the reference's path: None where no archive holds
    it."""
    at = _json(use)
    if at is None:
        return None
    item = at.nearest("HQMediaMapItem")
    readings = at.app.readings
    if item is None or readings is None:
        return None
    references = at.app.doc.get("multimedia_map") or {}
    path = next((key for key, value in references.items() if value is item), None)
    if path is None or not path.startswith(MEDIA_PREFIX):
        return None
    return readings.media.get(path[len(MEDIA_PREFIX) :])


def _video_tracks(iso):
    return [track for track in iso["tracks"] if track["handler"] == "vide"]


def tiff_heif(use, manifest):
    """``expressions-and-data/image-tiff-heif``: an image HQ classifies as TIFF or HEIF."""
    facts = _media(use)
    if facts is None:
        return None
    return facts["mime"] in ("image/tiff", "image/heif", "image/heic", "image/heif-sequence", "image/heic-sequence")


# The WAV format code of integer PCM (WAVE_FORMAT_PCM).
WAVE_FORMAT_PCM = 1


def other_wav(use, manifest):
    """``expressions-and-data/audio-wav-that-is-not-8-or-16-bit-pcm``: a WAV whose ``fmt`` chunk holds another
    codec, or PCM of another sample size, which Android does not play."""
    facts = _media(use)
    if facts is None:
        return None
    wav = facts.get("wav")
    if "wav" not in facts:
        return False
    return wav is None or wav["format"] != WAVE_FORMAT_PCM or wav["bits"] not in (8, 16)


def audio_3gp(use, manifest):
    """``expressions-and-data/audio-3gp``: a 3GP file with no video track (``ftyp`` brand ``3g…``), which HQ
    classifies as video."""
    facts = _media(use)
    if facts is None:
        return None
    iso = facts.get("iso")
    return iso is not None and str(iso["brand"]).startswith("3g") and not _video_tracks(iso)


def audio_m4a_other_brand(use, manifest):
    """``expressions-and-data/audio-m4a-with-another-brand-isom-mp41-mp42-dash``: an MPEG-4 file with no video
    track whose brand is ``isom``, ``mp41``, ``mp42`` or ``dash``, which HQ classifies as video."""
    facts = _media(use)
    if facts is None:
        return None
    iso = facts.get("iso")
    return iso is not None and iso["brand"] in ("isom", "mp41", "mp42", "dash") and not _video_tracks(iso)


def av1_mov_avi_theora_h263(use, manifest):
    """``expressions-and-data/video-av1-mov-avi-ogg-theora-h-263-3gp``: an AV1 video track, a QuickTime file
    (``ftyp`` brand ``qt``), an AVI (as HQ classifies it), Theora in Ogg, or an H.263 track."""
    facts = _media(use)
    if facts is None:
        return None
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


def invalid_question_id(use, manifest):
    """``questions/question-id-failing-the-grammar-or-meta-in-any-case``: a data node Vellum's parser makes a
    question of (``Form.vellum_nodes``) whose name fails Vellum's Question ID rule or is ``meta`` in any case
    (``baseSpecs.js``'s ``nodeID`` validation, ``util.js::isValidElementName``)."""
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None or element not in form.vellum_nodes:
        return False
    name = _node_name(element)
    return VELLUM_ELEMENT_NAME.fullmatch(name) is None or name.lower() == "meta"


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
    """The part of a REFUSED class a data node's use is: Nova's own scaffolding node, by its name with its
    minted part ``*`` (``compare.names.nova_name``: ``__nova_operations``, ``__nova_guard_*``), which Nova emits
    whatever a person authors, apart from a node a person named; None for the latter, and where the use is on
    no data node."""
    _, element = _data_node(use)
    if element is None:
        return None
    name = _node_name(element)
    return nova_name(name) if name.startswith(NOVA_PREFIX) else None


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


def default_data_value(use, manifest):
    """``questions/default-data-value-datavalue-instance-text``: a data node Vellum's parser makes a question of
    that holds text in the form's instance, which it reads as the question's ``dataValue`` (``parser.js``:
    ``$el.children().length ? null : $el.text()``)."""
    form, element = _data_node(use)
    if form is None:
        return None
    if element is None or element not in form.vellum_nodes or _children(element):
        return False
    return bool("".join(element.itertext()))


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
    """``expressions-and-data/more-than-one-instance-without-an-id``: an ``<instance>`` without an ``id`` in a form
    holding another, which Vellum refuses to open (``parser.js::_getInstances``, which finds every element named
    ``instance`` in the document and throws on a second whose ``id`` is empty)."""
    form, element = _instance_element(use)
    if form is None:
        return None
    if element is None or element.get("id"):
        return False
    return sum(1 for other in form.named_instance_elements if not other.get("id")) > 1


def supply_point_datum(use, manifest):
    """``expressions-and-data/session-data-supply-point-id-anywhere-except-…``: an expression reading the session's
    ``data/supply_point_id``, anywhere but in an advanced form one of whose computed datums has that id
    (``AdvancedForm.arbitrary_datums``). Read from Core's parse of the expression (its instance paths through the
    session's instance, ``instance-source:session``). A suite does not say which form its expressions belong to:
    None there."""
    at = _xml(use)
    if at is None or at.attribute is None:
        return None
    document = at.document
    parsed = document.parsed(at.element.get(at.attribute))
    if parsed is None or "error" in parsed:
        return None
    sessions = {
        instance_id
        for instance_id, src in document.declared_instances
        if instance_source(manifest, src) == "instance-source:session"
    }
    if not any(
        path["instance"] in sessions and path["steps"][:3] == ["session", "data", "supply_point_id"]
        for path in parsed["instancePaths"]
    ):
        return False
    if document.kind != "xform":
        return None
    if document.app_form is None:
        return None
    _, form_json = document.app_form
    datums = form_json.get("arbitrary_datums") or []
    return not (
        form_json.get("doc_type") == "AdvancedForm"
        and any(isinstance(datum, dict) and datum.get("datum_id") == "supply_point_id" for datum in datums)
    )


def var_in_form(use, manifest):
    """``expressions-and-data/var-in-a-form-expression``: a variable reference (``$name``) in an XForm's
    expression, where no variable is defined (form contexts define none, so it reads blank). A suite's are the
    variables HQ's build declares there, outside the class."""
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


def here_in_form(use, manifest):
    """``expressions-and-data/here-in-a-form``: ``here()`` in an XForm's expression, which no function handler of a
    form's evaluation context answers ("cannot handle function 'here'"). A suite's and an app JSON's expressions (a
    case list's columns, sorts and filters, a menu's or form's display condition, a form link) are evaluated
    outside a form."""
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
    control's node as that bind's nodeset) whose id Vellum does not read as that node's path. Vellum reads ``bind``
    only on a control with no ``ref`` or ``nodeset``, as a path from the data root where a question stands there,
    else from its parent control's node (``parser.js::getPathFromControlElement``, ``processPath``). Read on the
    control's ``bind`` and on the bind's ``id`` alike, a bind no control names being outside the class; an id that
    names no bind is the bar's (Core refuses the form)."""
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
    """Whether Vellum reads a control's ``bind`` as another node than Core does (``other_bind_id``): True, False,
    or None where the bind's nodeset names no node here."""
    if control.get("ref") is not None or control.get("nodeset") is not None:
        return False  # Vellum reads the control's ref (or nodeset), Core the same node through the bind
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
            if any(path["instance"] == element.get("id") for path in parsed["instancePaths"]):
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


def time_operand(use, manifest):
    """``expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string``: a relational
    comparison (``<``, ``<=``, ``>``, ``>=``: Core's ``XPathCmpExpr``) with a time on either side, which Core
    compares as a number, a string holding ``:`` being NaN (``FunctionUtils.toNumeric``). Each side is read over the
    expression's structure as HQ's XPath grammar reads it (``_time_kind``); a side whose value this does not read (a
    case property, a lookup table's field, a value only the run time knows) leaves it open."""
    document, text = _expression_at(use)
    if document is None or text is None:
        return None
    tree = document.tree(text)
    if tree is None:
        return None
    context = _context_path(use)
    verdicts = set()
    for node in _relational(tree):
        verdicts |= {_time_kind(manifest, document, side, context, frozenset()) for side in node[2:]}
    if True in verdicts:
        return True
    return None if None in verdicts else False


def _relational(tree):
    """Each relational comparison an expression's structure holds, at any depth."""
    kind = tree[0]
    if kind == "binary":
        if tree[1] in ("<", "<=", ">", ">="):
            yield tree
        yield from _relational(tree[2])
        yield from _relational(tree[3])
    elif kind == "negative":
        yield from _relational(tree[1])
    elif kind == "call":
        for argument in tree[2]:
            yield from _relational(argument)
    elif kind == "path":
        for predicate in tree[3]:
            yield from _relational(predicate)


def _context_path(use):
    """The path of the node a bind's expression is evaluated at (its nodeset's node), or None."""
    at = use.at
    if not isinstance(at, XmlAt) or at.document.kind != "xform" or _local(at.element) != "bind":
        return None
    form = at.document
    return _node_path(form, form.node(at.element.get("nodeset")))


def _time_kind(manifest, document, tree, context, seen):
    """Whether a value is a time as a comparison reads it: True for a string holding ``:`` or a form node whose bind
    type is ``xsd:time`` (or whose calculate gives a time), False for a number, a date, a truth value or another
    answer, None where this does not read it."""
    kind = tree[0]
    if kind == "number":
        return False
    if kind == "text":
        return ":" in tree[1]
    if kind == "negative":
        return False
    if kind == "binary":
        return None if tree[1] == "|" else False  # arithmetic is a number, a comparison or and/or a truth value
    if kind == "call":
        name, arguments = tree[1], tree[2]
        if name in NON_TIME_CALLS:
            return False
        branches = arguments[1:] if name == "if" and len(arguments) == 3 else arguments if name == "coalesce" else None
        if not branches:
            return None
        kinds = {_time_kind(manifest, document, branch, context, seen) for branch in branches}
        return True if True in kinds else None if None in kinds else False
    if kind == "path" and document.kind == "xform":
        if tree[1] == "absolute":
            path = _resolved("/", tree[4])
        elif tree[1] in ("relative", "call:current") and context is not None:
            path = _resolved(context, tree[4])
        else:
            return None
        return None if path is None else _time_node(manifest, document, path, seen)
    return None


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
    parent = container.getparent()
    return parent is not form.data_root and form.in_repeat(form.paths[parent])


def _load_setvalues(form):
    """The model's load-time setvalues in the order Core runs them (``xforms-ready``, in document order: README,
    "Load-time values")."""
    return [
        setvalue
        for setvalue in form.model.iterfind(f"{{{XFORMS}}}setvalue")
        if "xforms-ready" in (setvalue.get("event") or "").split()
    ]


def _iteration_ids(form, container):
    """The load-time setvalue of a model iteration's ``@ids``, its query (``modeliteration.js``), or None."""
    target = f"{form.paths[container]}/@ids"
    return next((s for s in _load_setvalues(form) if (s.get("ref") or "").strip() == target), None)


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
    setvalues = _load_setvalues(form)
    earlier = setvalues[: setvalues.index(ids)]
    if not earlier:
        return False
    verdicts = {_hidden_at(form, ancestor, earlier) for ancestor in ancestors}
    if True in verdicts:
        return True
    return None if None in verdicts else False


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
    set_here = {form.node(setvalue.get("ref")) for setvalue in earlier} - {None}
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
    if tree[1] not in ("=", "!="):
        return None
    values = [_value_at(form, side, context, earlier) for side in tree[2:]]
    if None in values:
        return None
    (left, left_number), (right, right_number) = values
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
        if form.node(setvalue.get("ref")) is node:
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
    setvalues = _load_setvalues(form)
    earlier = setvalues[: setvalues.index(setvalue)]
    if any(form.node(other.get("ref")) == node for other in earlier):
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
    paths = _tree_reads(form, ids.get("value"), _node_path(form, form.node(ids.get("ref"))))
    if paths is None:
        return None
    own = form.paths[container]
    verdicts = {
        None if path is None else _blank_at_load(form, path, ids)
        for path in paths
        if path is None or not _under_path(path, own)
    }
    if True in verdicts:
        return True
    return None if None in verdicts else False


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


def second_default(use, manifest):
    """``questions/a-second-default-setvalue-on-one-question``: a setvalue Vellum reads as a question's Default
    Value after another one on the same question, of which its parser keeps only one (``parser.js::parseSetValue``,
    each one replacing the question's ``defaultValue``)."""
    form, setvalue = _setvalue(use)
    if form is None:
        return None
    target = _target(form, setvalue)
    if target is None:
        return None if _model_level(form, setvalue) else False
    if not _default_value(form, setvalue, target):
        return False
    for other in form.model.iterfind(f"{{{XFORMS}}}setvalue"):
        if other is setvalue:
            return False
        held = _target(form, other)
        if held is not None and held == target and _default_value(form, other, held):
            return True
    return False


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
    condition = bind.get(f"{{{VELLUM}}}requiredCondition")
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
    return not (parsed["functions"] == ["jr:itext"] and parsed["expressions"] == ["XPathStringLiteral"])


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


def markdown_differing(use, manifest):
    """``questions/markdown-form-differing-from-the-default-text``: a ``markdown`` value whose content differs from
    its text's default value in the same language, which a Vellum save replaces with it
    (``javaRosa/plugin.js::loadXML`` loads the markdown value as the default text, and the writer writes both from
    it). A text holding no default value has none to differ from: not settled here."""
    form, value = _itext_value(use)
    if form is None:
        return None
    if value is None or value.get("form") != "markdown":
        return False
    plain = [other for other in _children(value.getparent()) if _local(other) == "value" and other.get("form") is None]
    if not plain:
        return None
    return _inner(plain[0]) != _inner(value)


def markdown_in_some_languages(use, manifest):
    """``questions/a-label-with-a-markdown-form-in-some-languages-only-…``: a ``markdown`` value for a text whose
    entry in another language holds no ``markdown`` value."""
    form, value = _itext_value(use)
    if form is None:
        return None
    if value is None or value.get("form") != "markdown":
        return False
    text = value.getparent()
    translation = text.getparent()
    for other in form.translations:
        if other is translation:
            continue
        for entry in _children(other):
            if _local(entry) == "text" and entry.get("id") == text.get("id"):
                if not any(_local(held) == "value" and held.get("form") == "markdown" for held in _children(entry)):
                    return True
    return False


def blank_beside_default_text(use, manifest):
    """``questions/an-explicitly-blank-value-in-a-non-default-language-where-the``: an empty ``<value>`` in a
    language other than the default one where another language's value of the same text and form holds content, so
    a Vellum save fills it: Vellum's default language is the first of the app's languages HQ hands it
    (``views/formdesigner.py``: ``'langs': app.langs``; ``javaRosa/plugin.js``: ``Itext.setDefaultLanguage(langs[0])``),
    it reads the translations of those languages alone, and a value it writes is the language's own only where that
    is not empty, else the default language's, else the first other language's with content
    (``javaRosa/itext.js::getValueOrDefault``). Read on a form the app JSON carries, whose ``langs`` say it; a form
    outside an app JSON does not say: None."""
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
    if translation.get("lang") not in langs or translation.get("lang") == langs[0]:
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
    appearance starting ``floating-`` (its own row)."""
    form, element, value = _control_appearance(use)
    if element is None:
        return None if form is None else False
    if len(value.split()) < 2:
        return False
    if _local(element) == "trigger" and value.startswith("floating-"):
        return False
    return bool(appearance_words(manifest, form, element, value)[1])


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


# The keys a class does not declare that the inventory's rows name, by class (``menus-and-case-lists/
# module-display-separately``, ``display-style-on-an-advanced-or-shadow-module``,
# ``legacy-detail-custom-variables-key``, ``detail-print-template``, ``ui-bookkeeping-keys-…``;
# ``forms-and-case-writes/no-vellum-removed-field-dynamic-key``, ``put-in-root-on-a-form-dynamic-key``,
# ``update-multi-name-update-multi``); the rows' own items spell them, which a test holds the map to.
ROW_UNDECLARED_KEYS = {
    "Module": frozenset({"display_separately"}),
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
    "Form": frozenset({"no_vellum", "put_in_root"}),
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
    names = ROW_UNDECLARED_KEYS.get(use.key[len("schema:") : -len(UNDECLARED)])
    return None if names is None else at.key not in names


# The registry ---------------------------------------------------------------------


# Each value class the check reads, by the id of the entry that names it: a reader of a use (and the
# manifest), giving whether the use falls in that class (True), not (False), or None where the export does not
# say. A REFUSED entry refused only because HQ's build refuses its state needs none (the bar reports it,
# ``proof.checks.manifest_usage.Entry.refused_by_hq_build``).
# The REFUSED classes whose uses are two symptoms the check names apart: each class's part reader by its entry's
# id (``manifest_usage.unclassified`` writes a use's part after its class). Nova's scaffolding nodes are one
# defect's (13) and the ids a person authors another's (15), so each holds its own register entry.
VARIANTS = {
    "questions/question-id-failing-the-grammar-or-meta-in-any-case": nova_scaffolding_part,
    "questions/hidden-value-with-children": nova_scaffolding_part,
}

VALUE_CLASSES = {
    # Questions
    "questions/other-h-head-children-whose-local-name-or-a-descendant-s-core-or": head_child,
    "questions/type-on-a-savetocase-property-leaf-a-create-update-or-index": savetocase_leaf_type,
    "questions/a-select-whose-bind-type-is-neither-a-choice-type-nor-a-string": non_choice_type_on_select,
    "questions/secret-with-a-numeric-bind-type": numeric_type_on_secret,
    "questions/input-whose-bind-type-vellum-does-not-write-xsd-decimal-xsd": type_vellum_does_not_write,
    "questions/an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring": _untyped_numeric("input"),
    "questions/a-secret-whose-bind-has-no-type-with-numeric-or-numbers-ignoring": _untyped_numeric("secret"),
    "questions/long-xsd-long": long_input,
    "questions/print-callout-class-org-commcare-dalvik-action-print-extra-cc": print_callout,
    "questions/input-readonly-true-control-attribute": readonly_input,
    "questions/upload-with-any-other-mediatype-or-none": other_upload_mediatype,
    "questions/a-default-value-s-setvalue-whose-event-does-not-match-where-the": default_event_mismatching_placement,
    "questions/setvalue-event-xforms-value-changed-authored-xforms-revalidate": form_level_setvalue,
    "questions/savetocase-create-at-the-form-root-whose-authored-case-id-xpath": savetocase_blank_create_id,
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
    "questions/default-data-value-datavalue-instance-text": default_data_value,
    "questions/hand-written-case-block-without-vellum-role-incl-a-root-data": hand_written_case_block,
    "questions/attachment-inside-a-savetocase-block": attachment_in_save_to_case,
    "questions/authored-data-meta-block": authored_meta_block,
    "questions/a-root-question-commcare-usercase-in-a-form-with-usercase": usercase_root_question,
    "questions/choice-value-with-whitespace-empty-or-duplicated": choice_value_refused_by_vellum,
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
    "questions/a-second-default-setvalue-on-one-question": second_default,
    "questions/data-root-uiversion-other-than-1-or-absent": data_root_ui_version,
    "questions/requiredcondition-differing-from-a-present-non-false-required": required_condition_differing,
    "questions/validation-message-without-a-validation-condition": message_without_condition,
    "questions/literal-jr-constraintmsg-text-no-itext": literal_validation_message,
    "questions/itemset-label-jr-itext-field": itemset_label_itext,
    "questions/markdown-form-differing-from-the-default-text": markdown_differing,
    "questions/a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk": markdown_in_some_languages,
    "questions/an-explicitly-blank-value-in-a-non-default-language-where-the": blank_beside_default_text,
    "questions/itext-entry-referenced-only-from-jr-itext-in-an-expression": itext_read_only_in_expressions,
    "questions/itext-pragma-entries-pragma-form-descriptor-pragma-skip-full": unreferenced_pragma,
    "questions/an-appearance-holding-such-whitespace-that-some-runtime-reads": appearance_whitespace_read_otherwise,
    "questions/any-other-multi-token-string-holding-a-token-no-runtime-reads-on": appearance_token_no_runtime_reads,
    "questions/data-parent-crossing-a-repeat": data_parent_crossing_a_repeat,
    "questions/any-other-bind-id-named-by-a-control-s-bind": other_bind_id,
    "questions/label-big-image": _big_image("label"),
    "questions/choice-big-image": _big_image("choice"),
    # Application and settings
    "application-and-settings/34p-hq-build-spec-below-nova-s-floor": below_floor,
    "application-and-settings/50pp-hq-location-fixture-restore-only-hierarchical-fixture": only_hierarchical_fixture,
    "application-and-settings/a-non-empty-langs-code-outside-that-grammar-or-repeated": invalid_or_repeated_code,
    "application-and-settings/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare": path_not_from_uploader,
    "application-and-settings/profile-custom-properties-any-other-entry-incl-formplayer-keys": custom_property_other,
    "application-and-settings/profile-features-sense-true-or-profile-properties-cc-entry-mode": (
        sense_or_review_entry_mode
    ),
    # Forms and case writes
    "forms-and-case-writes/form-requires-referral": referral,
    "forms-and-case-writes/form-requires-none-with-child-cases-but-no-open": child_cases_without_open,
    "forms-and-case-writes/subcases-condition-never": subcase_never,
    "forms-and-case-writes/subcases-reference-id-any-other-value": custom_index_name,
    "forms-and-case-writes/subcases-relationship-extension": extension,
    "forms-and-case-writes/subcases-repeat-context-other-than-the-name-question-s-innermost": (
        not_name_question_repeat
    ),
    "forms-and-case-writes/update-case-condition-never-on-a-follow-up-with-no-other-active": (
        update_never_followup_alone
    ),
    "forms-and-case-writes/update-key-with-any-other-index-segment-or-user-where-the": unrecognized_index_key,
    "forms-and-case-writes/an-update-key-with-an-index-segment-on-a-form-that-opens-its": index_key_on_opened_case,
    "forms-and-case-writes/any-other-usercase-preload": usercase_preload_other,
    "forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-in-a-multi-select-module": (
        multi_select_top_level
    ),
    "forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held": load_changes_values,
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
    "case-search/a-commcare-sort-x-commcare-custom-related-case-property-or-case": request_config_key_runtime_value,
    "case-search/an-x-commcare-custom-related-case-property-entry-together-with": related_case_property_twice,
    "case-search/default-properties-entry-keyed-x-commcare-data-registry": data_registry_key,
    "case-search/default-properties-entry-keyed-x-commcare-endpoint-id": endpoint_id_key,
    "case-search/default-properties-entry-with-no-defaultvalue-hq-stores-an-empty": missing_default_value,
    "case-search/that-entry-together-with-blacklisted-owner-ids-expression": blacklisted_owner_ids_twice,
    "case-search/a-default-filter-and-a-search-property-sharing-one-name": shared_by_filter_and_prompt,
    "case-search/appearance-address-with-required-or-validations": address_with_required_or_validations,
    "case-search/hidden-together-with-required-or-validations": hidden_with_required_or_validations,
    "case-search/validations-1": later_validations,
    "case-search/input-select1-select-commcare-reports-itemset-mobile-ucr": mobile_ucr_reports,
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
    "menus-and-case-lists/module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed": not_a_slugify_fixed_point,
    "menus-and-case-lists/two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form": (
        shared_with_another_endpoint
    ),
    "menus-and-case-lists/module-task-list-show-true": task_list_shown,
    "menus-and-case-lists/shadowmodule-case-list-show-true": shown_on_a_shadow_module,
    "menus-and-case-lists/15-address-popup": format_reader("address-popup"),
    "menus-and-case-lists/17-picture": format_reader("picture"),
    "menus-and-case-lists/18-audio": format_reader("audio"),
    "menus-and-case-lists/22-graph": format_reader("graph"),
    "menus-and-case-lists/23-image-cc-case-image": format_reader("image"),
    "menus-and-case-lists/model-product": product,
    "menus-and-case-lists/16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case": clickable_icon_list_empty,
    "menus-and-case-lists/16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint": clickable_icon_on_detail,
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
    "menus-and-case-lists/custom-tile-column-with-grid-null-unplaced": null_on_unplaced_tile,
    "menus-and-case-lists/custom-tile-font-size-null": null_font_size_on_tile,
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
    # Expressions and data
    "expressions-and-data/inline-instance-content-inside-instance-no-src": inline_instance,
    "expressions-and-data/more-than-one-instance-without-an-id": unnamed_instances,
    "expressions-and-data/session-data-supply-point-id-anywhere-except-in-an-advanced-form": supply_point_datum,
    "expressions-and-data/var-in-a-form-expression": var_in_form,
    "expressions-and-data/here-in-a-form": here_in_form,
    "expressions-and-data/jr-choice-name-on-a-lookup-itemset-select": choice_name_on_lookup,
    "expressions-and-data/declared-and-referenced-instance-with-an-unrecognized-src": referenced_unrecognized_source,
    "expressions-and-data/after-a-named-step-data-a-b": parent_after_named_step,
    "expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string": time_operand,
    "expressions-and-data/results-read-in-form-expressions-reached-through-a-search-that": (
        non_inline_search_form("results")
    ),
    "expressions-and-data/search-input-read-in-form-expressions-reached-through-a-search": (
        non_inline_search_form("search-input")
    ),
    "expressions-and-data/legacy-search-input-read-after-the-query-in-the-results-detail": legacy_after_query,
    "case-search/p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of": untyped_right_side,
    "case-search/date-opened-closed-on-or-last-modified-compared-with-any": non_date_value,
    "expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install": (
        android_verified_path_without_entry
    ),
    "menus-and-case-lists/type-index-cache-and-index-order-2": sort_type_index,
    "expressions-and-data/image-tiff-heif": tiff_heif,
    "expressions-and-data/audio-wav-that-is-not-8-or-16-bit-pcm": other_wav,
    "expressions-and-data/audio-3gp": audio_3gp,
    "expressions-and-data/audio-m4a-with-another-brand-isom-mp41-mp42-dash": audio_m4a_other_brand,
    "expressions-and-data/video-av1-mov-avi-ogg-theora-h-263-3gp": av1_mov_avi_theora_h263,
    "forms-and-case-writes/form-filter-using-fixture-value": fixture_value,
}
