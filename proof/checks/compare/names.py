"""Which element names in an XForm's data, a submission and Core's case database are the app's, and which CommCare's.

A structural path names what a difference is, never which document it is
on, so an element name the app authored (a question, group or repeat id, a
case property, an index identifier, an attachment name, a Nova operation or
container name) is ``*`` in a path and kept in ``at``, while a name a
reader gives meaning to stays as it is. Each is decided from the readers:

- **A form's data** (an XForm's main instance, and the submission Core
  serializes from it). Its root is HQ's ``data`` node, kept. Below it, a
  name in the data node's namespace is the app's question, group or repeat
  id, except where a reader finds an element by its name:

  - ``case``: a case transaction block, which Core's submission processing
    finds by name in any namespace (commcare-core
    ``core/parse/CommCareTransactionParserFactory.java::getParser``,
    ``"case".equalsIgnoreCase(name)``) and HQ by its key
    (``casexml/apps/case/xform.py::_extract_case_blocks``, ``const.CASE_TAG``);
  - ``meta``: the form's metadata block, which HQ reads by that key
    (``form_processor/utils/xform.py::extract_meta_instance_id``,
    ``app_manager/xform.py::XForm.get_meta_blocks``);
  - ``subcase_<n>``: the element HQ's builder writes each child case's block
    in (``app_manager/models/form_actions.py::OpenSubCaseAction.form_element_name``,
    ``subcase_{id}``, the action's position, so ``subcase_*``);
  - ``item``: a query-bound repeat's row, the element Vellum's model
    iteration names (Vellum ``src/modeliteration.js``, ``/item``), which Nova
    writes the same way (``lib/commcare/xform/formPath.ts``), and the row of
    Nova's selected-cases container (``caseOps.ts``);
  - Nova's reserved ``__nova_`` names (``lib/commcare/constants.ts``,
    ``RESERVED_XFORM_NODE_PREFIX``), kept without their minted part
    (``NOVA_MINTED``).

  An element in another namespace belongs to that namespace's reader (the
  ``orx`` metadata HQ writes, ``app_manager/xform.py::XForm._add_meta_2``;
  a Connect block, which Connect finds by its name and namespace,
  commcare-connect ``form_receiver/processor.py::_get_matching_blocks`` over
  ``$..deliver``, ``$..module``, ``$..assessment``), so its name is kept.
  A run of the app's own elements (a question in a group in a repeat) is one
  ``*``: how deep the app nests its data is the document's. A query-bound
  repeat's row is part of the run it sits in (``/data/q/item/r/@count`` is
  ``/data/*/@count``, a repeat's count however many query-bound rows hold
  it), and is kept only where it ends the run (``/data/*/item``, the row
  itself, and ``/data/*/item/case``, a block in a row). So a path keeps at
  most where a block sits (the form's root, the app's own container, a
  query-bound row, a Nova container) and never how deep.
- **A case block** (``case``): its children are Core's case parser's
  (``xml/CaseXmlParser.java``: ``create``, ``update``, ``close``,
  ``index``, ``attachment``). Under ``create`` and ``update`` a name either
  reader reads as a field of the case itself is kept (``CASE_FIELDS``), and
  every other is a case property; under ``index`` each name is an index
  identifier, under ``attachment`` an attachment name, each the app's.
- **Core's case database** (the ``casedb`` instance the runner serializes,
  commcare-core ``cases/instance/CaseChildElement.java::buildAndCacheInternalTree``):
  each ``case`` is keyed by its ``@case_id``; its ``case_name``,
  ``date_opened`` and ``last_modified`` children are Core's, its ``index``
  and ``attachment`` children hold identifiers and attachment names, and
  every other child is a case property.

A bind's ``nodeset`` and a ``setvalue``'s ``ref`` name a node of the form's
data by its path; each is written with the names of the nodes it walks,
each as the data's naming writes it (``data_path``), so a bind of a guard
block's case id and a bind of a question are two paths. Where HQ finds a
case block (``casexml/apps/case/xform.py::extract_case_blocks`` with
``include_path``: the keys of the form's JSON from its root to the block) is
written the same way (``block_path``), and so is where a block sits in a
parsed submission (``element_block_path``, each name in its own namespace).
"""

from __future__ import annotations

import functools
import re

from lxml import etree

CASE_XMLNS = "http://commcarehq.org/case/transaction/v2"
XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"

# What each element of a form's data is to its readers (``Naming.context``).
DATA = "data"  # the app's own elements: questions, groups, repeats
FOREIGN = "foreign"  # an element another reader names: metadata, a Connect block, Core's own
CASE = "case"  # a case transaction block
CASE_FIELDS_BLOCK = "case-fields"  # a case block's create or update
CASE_KEYED = "case-keyed"  # a case block's index or attachment: every child is the app's name
CASEDB = "casedb"  # Core's case database root
CASEDB_CASE = "casedb-case"  # one case in Core's case database

# A case block's children, as Core's case parser reads them (``CaseXmlParserUtil``): each one's children's context.
CASE_BLOCK_CHILDREN = {
    "create": CASE_FIELDS_BLOCK,
    "update": CASE_FIELDS_BLOCK,
    "index": CASE_KEYED,
    "attachment": CASE_KEYED,
    "close": FOREIGN,
}
# The children of a case block's create or update read as a field of the case itself: Core's
# (``CaseXmlParser.java``: ``createCase``'s case_type, owner_id and case_name; ``updateCase``'s case_type,
# case_name, date_opened, owner_id, external_id, category and state) and HQ's
# (``casexml/apps/case/xml/parser.py::CaseActionBase.V2_PROPERTY_MAPPING``: case_type, case_name,
# external_id, user_id, owner_id, date_opened). Every other child is a case property.
CASE_FIELDS = frozenset(
    {"case_type", "case_name", "owner_id", "external_id", "user_id", "date_opened", "category", "state"}
)
# The children Core writes for every case of its case database (``CaseChildElement.buildAndCacheInternalTree``),
# with the context of their own children.
CASEDB_CHILDREN = {"case_name": FOREIGN, "date_opened": FOREIGN, "last_modified": FOREIGN, "index": CASE_KEYED}
CASEDB_CHILDREN["attachment"] = CASE_KEYED

# Nova's reserved names (``lib/commcare/xform/caseOps.ts``): the containers it writes under fixed names, and the
# names it mints, each a fixed prefix and what Nova minted after it (``NOVA_MINTED``, written ``*``): a guard's
# operation uuid and kind (``__nova_guard_<uuid>_text``), a subcase's position (``__nova_subcase_<n>``), a field's
# id (``constraintCollections.ts``'s ``__nova_constraint_<field>_<n>``, ``captureUrlNode.ts``'s
# ``__nova_url_<name>``, ``datetimeCaseValue.ts``'s ``__nova_datetime_<field>``).
NOVA_PREFIX = "__nova_"
NOVA_CONTAINERS = frozenset(
    {
        "__nova_operations",
        "__nova_subcases",
        "__nova_selected_cases",
        "__nova_update_selected_cases",
        "__nova_close_selected_cases",
    }
)
NOVA_MINTED = re.compile(r"__nova_([a-z]+)_.+")
# HQ's child case element (``OpenSubCaseAction.form_element_name``).
SUBCASE = re.compile(r"subcase_[0-9]+")
# A query-bound repeat's row (Vellum ``src/modeliteration.js``).
MODEL_ITERATION_ROW = "item"
# The metadata block, by the names HQ reads it under.
META_NAMES = frozenset({"meta", "Meta"})


def nova_name(name):
    """How a path writes one of Nova's reserved names: its fixed part kept, its minted part ``*``."""
    if name in NOVA_CONTAINERS:
        return name
    minted = NOVA_MINTED.fullmatch(name)
    return f"__nova_{minted.group(1)}_*" if minted else name


def data_name(local):
    """How a path writes the name of one element of a form's data in the data's own namespace."""
    if local.startswith(NOVA_PREFIX):
        return nova_name(local)
    if SUBCASE.fullmatch(local):
        return "subcase_*"
    if local == MODEL_ITERATION_ROW or local in META_NAMES:
        return local
    return "*"


APP = "*"


def split_tag(tag):
    """(namespace, local name) of an lxml tag (``{namespace}local``)."""
    if tag[:1] == "{":
        namespace, _, local = tag[1:].partition("}")
        return namespace, local
    return None, tag


def child_name(context, local, namespace, data_namespace):
    """(name a path writes, the element's own context) for one child, named ``local`` in ``namespace``, of an
    element in ``context``; ``APP`` (``*``) where the name is the app's.

    ``data_namespace`` is the namespace of the form's data node; a name read
    from a path rather than a document is given in it, read as the data's
    own.
    """
    if context in (DATA, FOREIGN):
        if local.lower() == "case":
            return local, CASE
        if namespace != data_namespace:
            return local, FOREIGN
        return data_name(local), FOREIGN if local in META_NAMES else DATA
    if context == CASE:
        return local, CASE_BLOCK_CHILDREN.get(local, FOREIGN)
    if context == CASE_FIELDS_BLOCK:
        return (local if local in CASE_FIELDS else APP), FOREIGN
    if context == CASE_KEYED:
        return APP, FOREIGN
    if context == CASEDB:
        return local, CASEDB_CASE if local == "case" else FOREIGN
    if context == CASEDB_CASE:
        if local in CASEDB_CHILDREN:
            return local, CASEDB_CHILDREN[local]
        return APP, FOREIGN
    return local, context


@functools.lru_cache(maxsize=65536)
def is_data_path(text):
    """Whether ``text`` is a plain absolute path of element names, an attribute last at most (``/data/a/@b``).

    Each step is checked as an XML name (``etree.QName`` refuses anything
    else); anything else (a predicate, a function, a relative or ``#form/``
    path) is not one, and is written whole as ``*``.
    """
    if not text or not text.startswith("/") or text.endswith("/"):
        return False
    steps = text[1:].split("/")
    for index, step in enumerate(steps):
        name = step[1:] if step.startswith("@") and index == len(steps) - 1 else step
        local = name.rpartition(":")[2]
        if not local or any(character in local for character in "[]()*'\" =,|"):
            return False
        try:
            etree.QName(local)
        except ValueError:
            return False
    return True


def data_names(data_root):
    """Every element of a form's data by its path of local names below the root (the first of same-named
    siblings, as Core resolves a path), with the name a path writes for it and its context (``child_name``)."""
    found = {}
    if data_root is None:
        return found
    namespace = split_tag(data_root.tag)[0]
    pending = [((), data_root, DATA)]
    while pending:
        steps, element, context = pending.pop()
        for child in element:
            if not isinstance(child.tag, str):
                continue
            child_namespace, local = split_tag(child.tag)
            key = (*steps, local)
            if key in found:
                continue
            shown, own = child_name(context, local, child_namespace, namespace)
            found[key] = (shown, own)
            pending.append((key, child, own))
    return found


def is_row(name, context, parent):
    """Whether an element written ``name`` in ``context`` under one written ``parent`` is a query-bound repeat's
    row inside a run of the app's own elements: ``item`` in the data's own namespace, under an app element."""
    return name == MODEL_ITERATION_ROW and context == DATA and parent == APP


class Written:
    """A path's steps as a comparison writes them below the form's data root: a run of the app's own names one
    ``*``, a query-bound row inside the run part of it, kept only where it ends the run (``is_row``)."""

    __slots__ = ("row", "steps")

    def __init__(self, steps=()):
        self.steps = list(steps)
        self.row = False

    def add(self, name, context):
        """One more element step, written ``name`` in its own ``context`` (``child_name``)."""
        last = self.steps[-1] if self.steps else None
        if name == APP and (last == APP or self.row):
            if self.row:
                self.steps.pop()
                self.row = False
            return
        self.row = is_row(name, context, last)
        self.steps.append(name)

    def keep(self, step):
        """One more step written as it is: the data's root, an attribute, a block's own ``case``."""
        self.steps.append(step)
        self.row = False


def data_path(text, data_root, names=None):
    """``text`` (a bind's ``nodeset`` or a ``setvalue``'s ``ref``) with each name as the form's data writes it.

    Each step is resolved in ``data_root`` (the form's data node) by its
    local name, as Core resolves a path in the main instance, so it is
    written as that element's name (``child_name``); a step no element of
    the data holds is written by its name alone, read as the data's own. An
    attribute step is kept, and a run of the app's own names is one ``*``
    (a query-bound row inside it is part of it, ``Written``), as the
    comparison writes a run of the app's elements. A value that is not a
    plain path is ``*``. ``names`` is ``data_names(data_root)``, given by a
    caller resolving many paths in one form.
    """
    if not is_data_path(text):
        return APP
    if names is None:
        names = data_names(data_root)
    steps = text[1:].split("/")
    namespace = split_tag(data_root.tag)[0] if data_root is not None else None
    root_local = split_tag(data_root.tag)[1] if data_root is not None else None
    shown = Written()
    context = DATA
    resolved = True
    below = ()
    for index, step in enumerate(steps):
        if step.startswith("@"):
            shown.keep(step)
            continue
        local = step.rpartition(":")[2]
        if index == 0:
            shown.keep(local)
            resolved = local == root_local
            continue
        below = (*below, local)
        held = names.get(below) if resolved else None
        if held is None:
            resolved = False
            name, context = child_name(context, local, namespace, namespace)
        else:
            name, context = held
        shown.add(name, context)
    return "/" + "/".join(shown.steps)


def block_path(keys):
    """Where HQ finds a case block, as a path writes it: ``keys`` is HQ's path to it (the keys of the form's JSON
    from its root, ``casexml/apps/case/xform.py::extract_case_blocks(..., include_path=True)``), each the local
    name of an element of the form's data (HQ's JSON drops namespaces, ``xml2json.get_tag_and_xmlns``), written
    as the data's naming writes it (``child_name``, ``Written``), then the block's own ``case``. A block at the
    form's root is ``case``; a guard's is ``__nova_operations/__nova_guard_*/case``."""
    shown = Written()
    context = DATA
    for key in keys:
        name, context = child_name(context, key, None, None)
        shown.add(name, context)
    shown.keep("case")
    return "/".join(shown.steps)


def element_block_path(block):
    """Where a case block element sits in a parsed form's data: ``(written, concrete)``.

    ``written`` is the path ``block_path`` writes for HQ's path to the same
    block, each element the block sits under named in its own namespace
    (``child_name``, as the data's naming names it) and the block's own
    name last; ``concrete`` is the local names it sits under, then its own,
    joined by ``/`` (as ``proof.checks.proof3.block_key`` joins HQ's).
    """
    ancestors = list(block.iterancestors())[::-1]
    data_namespace = split_tag(ancestors[0].tag)[0] if ancestors else None
    shown = Written()
    context = DATA
    concrete = []
    for ancestor in ancestors[1:]:
        namespace, local = split_tag(ancestor.tag)
        name, context = child_name(context, local, namespace, data_namespace)
        shown.add(name, context)
        concrete.append(local)
    local = split_tag(block.tag)[1]
    shown.keep(local)
    return "/".join(shown.steps), "/".join([*concrete, local])
