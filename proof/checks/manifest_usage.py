"""The manifest checks (plan work item 11, decision 7): nothing Nova emits is unclassified.

Decision 7 refuses every surface item no manifest entry names wherever an app
uses it. These checks hold Nova's own exports to that: every surface item an
export uses must be held by an inventory entry
(``lib/commcare/surface/entries/<area>.json``), and every flag HQ reads while
it builds the export (``proof.hq.seams.flags``, recorded in each built part's
``flagsReadByBuild``, ``flag_reads``) must have a gate entry
(``entries/gates.json``). A use or a read no entry holds is a ``manifest``
difference: an item the person must classify (or Nova must stop emitting). A
use whose key no surface item holds is reported the same way, with
``surfaceItem: false``.

Naming a key is not enough where the entries split it by value (decision 6:
one entry per value class): an entry holds the uses of its value class, which
the check reads of each use where it can (``proof.checks.manifest_value_classes``,
from where the use sits in the export). A use a REFUSED entry's class takes is
refused; where the check cannot tell whether a REFUSED class takes a use, the
use is undecided, a gap in the check that no register entry may hold
(``standing``; ``proof.checks.registers`` refuses such an entry). An allowing
entry's class is what its row describes and the check does not read it: it is
taken as the rest of its key's values, every use no REFUSED class takes, so the
extraction makes a use of a key only where a reader of the value reads it (an
appearance read only on the elements its reader compares, ``_appearance_uses``).
A REFUSED entry refused only because HQ's build refuses its state is the bar's,
which reports every export HQ cannot build; and in Nova's own local archives,
which runtimes read and no editor does, a REFUSED entry refuses only for what a
runtime does, a use another REFUSED class takes being the source's, judged on
the app JSON. Each standing is its own symptom, named in the difference's path
after the key: ``/<key>`` (no entry names it), ``/<key>/refused/<value class>``,
``/<key>/undecided/<value class>`` (the REFUSED class the check does not read
there) and ``/<key>/unheld`` (every entry naming the key rules the use out). A
REFUSED class whose uses are two symptoms (Nova's own scaffolding and what a
person authors, ``manifest_value_classes.VARIANTS``) names the part a use is
after its class (``/<key>/refused/<value class>/<part>``).

What an export uses is read from its parsed artifacts, never from Nova's
emitter, and never by matching text a reader does not match itself: the app
JSON Nova's publish sends (each
captured ``app_file``, with the XForm sources it carries), and Nova's local
``.ccz`` archives (suite, media suite, profile and forms). Both are read from
the document's records (``proof.observe.manifest``, observed with its
``local`` part), with what HQ's and Core's readers made of them there; this
module judges the records alone, and imports neither HQ nor Django. Each
family is read by the reader the surface records for it:

- **The app schema** (``schema:<Class>.<key>``, from ``Application``): a key
  is used when its value is not the default HQ writes for it (the item's
  ``default``, compared as JSON values). An object whose ``doc_type`` names a
  class other than its slot's declared item type uses that class
  (``schema:Module``, as ``ModuleBase.wrap`` dispatches it), and the
  document's root uses its own. A key the class does not declare uses the
  class's ``schema:<Class>.<undeclared>`` item (what jsonobject does with any
  such key), its name kept in where it is used.
- **Values the schema's slots name**: a case list column's ``format``
  (``format:<value>``, ``detail_screen.py::get_class_for_format``) and its
  field's type (``detail-field-type:<type>``, ``DetailColumn.field_type``,
  which ``get_column_xpath_generator`` reads for every column that is not a
  calculation; a format HQ registers no class for is ``format:<unregistered>``,
  the class ``get_class_for_format`` falls back to); an add-on turned on
  (``add-on:<slug>``); a profile property, custom property or feature the app
  sets (``setting:properties.<key>``, else the ``profile-property:<key>`` that
  holds it, else the setting spelling; ``setting:features.<key>``); a multimedia map item's class
  (``media-class:<media_type>``); a UI translation the app overrides
  (``ui-string:<id>``, where a runtime reads that id); a search's keys (a default property's or a
  prompt's name, ``csql-key:<key>`` where it is one HQ's search reads as its
  own rather than a case property), a prompt's input and appearance
  (``prompt-input:<input>``, ``prompt-appearance:<appearance>``) and the CSQL
  its ``_xpath_query`` sends (below). HQ's settings of type ``hq`` are the
  ``Application``'s own fields (``commcare-app-settings.yml``), so their use
  is that field's (``schema:Application.<id>``).
- **Every XForm** (each source in the app JSON's ``_attachments``, by the
  form whose ``unique_id`` names it, and each form in a local ``.ccz``),
  parsed with lxml:

  - each element Core's ``XFormParser`` hands to a handler, walked as
    ``XFormParser.parseElement`` walks the document (``jr-control:<element>``:
    the head's ``model`` and ``title``, the body's controls, a group's or
    repeat's children through ``parseGroup``), each bind ``type``
    (``jr-type:<type>``, as ``XFormParser.getDataType`` strips its prefix),
    each action element and the events it names (``jr-action:<element>``,
    ``jr-event:<event>``), each Android extension element
    (``jr-extension:<Parser>``), each appearance token any runtime acts on
    (``appearance:<reader>/<token>``, matched by that reader's own rule as the
    surface records it, on the elements the read compares the appearance of:
    a question's or a group's, of the control and data types that reach it;
    a whitespace token no reader's rule reads is used as
    ``appearance:*/<token>``), and each itext form a translation's value names
    (``itext-form:<reader>/<form>`` for each reader the surface records,
    Core, Android and HQ, or ``itext-form:*/<form>``);
  - the XForm's own vocabulary (``xform:``, ``xform_vocabulary``): every
    element and attribute, by its path from the element a handler table
    dispatched, resolved to the surface's item for it (whose paths use ``*``
    for an element of any name and ``//`` for any depth, and whose bare steps
    match an element of that local name in any namespace, as Core's name
    tests do), the dispatched element by its own name (``xform:input``) and
    each attribute whatever family also classifies its value
    (``xform:model/bind@type``), with the element's namespace where Core
    reads it (``@xmlns``, under the conditions the item records Core reads
    it in: a model child no handler takes, an ``<instance>`` standing for its
    own data). An instance's content is read at any depth
    (``xform:model/instance/*/*``, ``xform:model/instance//*``): its
    elements, their namespaces and the attributes Core reads there by name
    (``jr:template``); its other attributes are answer data, the app's, and
    of the main instance's data root every attribute is vocabulary
    (``xform:model/instance/*``);
  - each question's type as HQ reads it (``mug:<type>``,
    ``xform.py::XForm.get_questions``, which types every question through
    ``_infer_vellum_type``; ``mug:(none)`` where HQ finds no type);
  - each secondary instance: the source Core's runtime gives it by its
    ``src`` (``instance-source:<branch>``,
    ``CommCareInstanceInitializer.generateRoot``'s first branch that matches,
    by the rule the surface records);
  - each hashtag Vellum reads from the form's ``vellum:hashtags`` and
    ``vellum:hashtagTransforms`` (their JSON keys and prefixes), as the
    surface's hashtag it starts with (``hashtag:<hashtag>``, the longest);
  - Vellum's own markup: each attribute in Vellum's namespace
    (``vellum-markup:bind@vellum:relevant``) and each element in it
    (``vellum-markup:h:head/vellum:hashtags``), as the vellum family records
    what Vellum's parser asks of each element.
- **Every expression Core parses**: each XForm attribute the surface's
  ``xform`` family records as ``parsedAs: xpath``, and each suite attribute
  the ``parser`` family records so (a datum's ``nodeset``, a stack
  operation's ``if``; never an id), read through Core's own XPath parser and
  lexer (the Core runner's ``xpathParse`` op, as the record holds it): each
  function it calls (``jr-fn:<name>``, or ``jr-handler:<name>`` for a name
  Core builds as an ``XPathCustomRuntimeFunc`` that a runtime's function
  handler answers), each path through the session instance
  (``session-path:<path>``, the surface's item whose ``*`` steps match it),
  and the grammar Core's parser builds: each expression class, step axis and
  node test (``xpath-expr:``, ``xpath-axis:``, ``xpath-test:``) and each
  lexer token (``xpath-token:``). A path rooted at ``instance(...)`` or
  ``current()`` is XPath grammar, not a call (``XPathPathExpr.getReference``).
- **CSQL**: each search's ``_xpath_query`` (the local suite's query ``data``
  and the app JSON's default property) is an expression whose value is CSQL.
  The strings it can send are read through Core's parser (the runner's
  ``xpathStrings`` op: ``concat()`` and ``if()`` over its string literals,
  every other value a hole), and each is parsed by HQ's own CSQL parser
  (``eulxml.xpath.parse``, which ``case_search/filter_dsl.py::build_filter_from_xpath``
  runs), both as the record holds them: each function (``csql-fn:<name>``),
  operator (``csql-op:<op>``),
  case metadata a step names (``csql-metadata:<name>``, as
  ``comparison.py::property_comparison_query`` reads a step) and distance
  unit (``csql-unit:<unit>``, ``within-distance``'s fourth argument). The
  strings are every branch's, whether or not the branch's condition can hold
  with the others (Nova's quote guards choose a quote by the value, so some
  combinations are strings Core never sends), so a string HQ's parser
  refuses is passed over; an expression none of whose strings it parses is
  used as ``csql:(unparsed)``.
- **Nova's local suites and profile**, walked with Core's own parser graph as
  the surface records it (``parser:<Parser>``, each with the elements it
  reads and the child parsers it hands elements to, from the installed
  ``SuiteParser`` and ``ProfileParser``): each element is used as
  ``parser:<Parser>/<element>`` and each attribute as
  ``parser:<Parser>/<element>@<attribute>`` (or the parser's wildcard
  ``parser:<Parser>/<parent>/*@<attribute>``), a key no parser holds being
  used all the same; each profile property and feature uses its setting; a
  search's instances, keys, prompts and CSQL are read as above (a search is
  the ``<query>`` a session's datums hold, ``SessionDatumParser``'s); a stack
  operation's ``<query>`` is a request to the HQ view its ``value`` names
  (``hq-api:case_fixture``, as HQ's own build points one), whose ``<data>``
  keys are that view's parameters, never a search's (``_stack_query_uses``); and
  each instance id a suite declares uses the scheme HQ's build reads in it
  (``instance-scheme:<scheme>``,
  ``suite_xml/post_process/instances.py::get_instance_factory``, which HQ
  runs over the instance ids in a suite's expressions, never a form's own
  declarations: ``InstancesHelper._get_all_xpaths_for_entry``).
- **Nova's local app strings** (each ``<lang>/app_strings.txt``, read with
  HQ's reader of the format, ``commcare_translations.loads``, which imports
  neither HQ nor Django: ``proof.checks.compare.app_strings``): each id a
  runtime reads as one of its own UI strings (``ui-string:<id>``, an item the
  surface records a reader for, by the id or a prefix a runtime reads ids
  under); the other ids, those only a catalog holds among them, are the
  app's own text.

Every flag the unit's records show HQ reading while it built the export is
held to the gate entries (``flag_reads``), and every soft assertion HQ noted
while it read the exports is a difference of this check.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from urllib.parse import quote, urlsplit

from lxml import etree

from proof.checks import observations
from proof.checks.compare.app_strings import parse_app_strings
from proof.checks.differences import Difference, pointer_token
from proof.checks.manifest_value_classes import (
    VALUE_CLASSES,
    VARIANTS,
    App,
    CsqlAt,
    Form,
    JsonAt,
    Runtime,
    XmlAt,
    appearance_words,
    instance_source,
    protected_constraint_form,
)
from proof.observe.intent import FORM_FILE
from proof.observe.manifest import read_entry

WORKTREE = Path(__file__).resolve().parents[2]
SURFACE_DIR = WORKTREE / "lib" / "commcare" / "surface"

XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"
JAVAROSA = "http://openrosa.org/javarosa"
VELLUM = "http://commcarehq.org/xforms/vellum"
# The prefixes the XForm vocabulary is written with, by namespace (those HQ
# and Vellum write, as the surface's xform family spells them); any other
# namespace is written in Clark notation.
PREFIXES = {
    XFORMS: "",
    XHTML: "h",
    JAVAROSA: "jr",
    "http://openrosa.org/jr/xforms": "orx",
    "http://commcarehq.org/xforms": "cc",
    VELLUM: "vellum",
    "http://opendatakit.org/xforms": "odkx",
    "http://www.w3.org/2001/XMLSchema": "xsd",
}
XFORM_FAMILY = "xform"
# What Vellum's parser asks of its own markup (proof/surface/families/vellum.py), and how it names an element inside
# an instance.
VELLUM_MARKUP = "vellum-markup"
INSTANCE_CONTENT_MARKUP = "model/instance//*"
# The roots of an XForm whose content is vocabulary; an instance's content is answer data.
INSTANCE = f"{{{XFORMS}}}instance"
# The elements every XForm is wrapped in, which XFormParser passes over by design (parseElement's
# suppressWarningArr: html, head, body).
WRAPPERS = frozenset({f"{{{XHTML}}}html", f"{{{XHTML}}}head", f"{{{XHTML}}}body"})
# The query data key whose value HQ's search parses as CSQL (case_search/models.py::CASE_SEARCH_XPATH_QUERY_KEY).
XPATH_QUERY_KEY = "_xpath_query"
# What HQ's CSQL parser reads in a query string, as the observation records it, by the surface family it is in.
CSQL_FAMILIES = {"fn": "csql-fn", "op": "csql-op", "unit": "csql-unit"}
# The format item HQ's build falls back to for a slug it does not register (detail_screen.py::get_class_for_format).
UNREGISTERED_FORMAT = "format:<unregistered>"
# The <query> a session's datums hold (a search), and the one a stack operation holds (a request to an HQ view).
SEARCH_QUERY = "parser:SessionDatumParser/query"
STACK_QUERY = "parser:StackFrameStepParser/query"


class ManifestError(ValueError):
    """The manifest's files, or an export's artifacts, are not ones the checks can read."""


class ObservationMissing(ManifestError):
    """The records hold no reading of something the check reads: the observation did not make it."""


# The manifest ---------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class Manifest:
    """The generated surface and the authored entries, as the checks read them (one object per load, so the
    readers' caches key on it)."""

    items: dict
    gated: frozenset  # every surface key a gate entry names
    parsers: dict = field(default_factory=dict)  # parser name -> its item (children, elements)
    entries: dict = field(default_factory=dict)  # surface key -> (Entry, ...): the inventory entries naming it
    # Each value class's reader by its entry's id (proof.checks.manifest_value_classes.VALUE_CLASSES).
    readers: dict = field(default_factory=lambda: VALUE_CLASSES)
    # The readers of the parts a REFUSED class holds apart, by its entry's id (``VARIANTS``).
    variants: dict = field(default_factory=lambda: VARIANTS)

    def item(self, key):
        return self.items.get(key)

    def family(self, family):
        """Each key of one family, without the family's prefix."""
        return _family(self, family)


@cache
def _family(manifest, family):
    prefix = f"{family}:"
    return tuple(sorted(key[len(prefix) :] for key in manifest.items if key.startswith(prefix)))


def _read(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(f"The manifest file {path} could not be read as JSON ({error}).") from error


@cache
def load_manifest(directory: Path = SURFACE_DIR) -> Manifest:
    surface = _read(directory / "surface.json")
    items = dict(surface.get("items") or {})
    if not items:
        raise ManifestError(f"{directory / 'surface.json'} holds no items.")
    media = _read(directory / "media-formats.json")
    for key, value in (media.get("items") or {}).items():
        items[key if key.startswith("media-format:") else f"media-format:{key}"] = value
    gated, entries = set(), {}
    for path in sorted((directory / "entries").glob("*.json")):
        for entry in _read(path):
            keys = entry.get("surfaceKeys") or ()
            if path.name == "gates.json":
                gated.update(keys)
                continue
            reasons = tuple(sorted({reason["kind"] for reason in entry.get("reasons") or ()}))
            held = Entry(entry["id"], entry["disposition"], entry.get("valueClass"), reasons)
            for key in keys:
                entries.setdefault(key, []).append(held)
    parsers = {key.split(":", 1)[1]: value for key, value in items.items() if _is_parser(key)}
    return Manifest(
        items=items,
        gated=frozenset(gated),
        parsers=parsers,
        entries={key: tuple(sorted(held)) for key, held in entries.items()},
    )


@dataclass(frozen=True, order=True)
class Entry:
    """An inventory entry as the check reads it: its id, its disposition, the value class it covers and, for a
    REFUSED one, the kinds of its reasons (the inventory's rule 5)."""

    id: str
    disposition: str
    value_class: str | None = None
    reasons: tuple = ()

    def as_json(self):
        return {"id": self.id, "disposition": self.disposition, "valueClass": self.value_class}

    def judges_builds(self):
        """Whether the entry's refusal is about what a runtime does with an app (``RUNTIME_REASONS``), so it
        holds a use in a build Nova makes itself (a local archive) as in the source HQ holds."""
        return bool(set(self.reasons) & RUNTIME_REASONS)

    def refused_by_hq_build(self):
        """Whether the entry is refused only because HQ's build refuses the state (``not-hq-buildable``): an
        export in its class fails HQ's build of that export, which the bar holds (``proof.checks.bar``: HQ's
        import, ``validate_app``, ``create_all_files`` and Core's admission of A, B and B-edit)."""
        return bool(self.reasons) and set(self.reasons) <= {"not-hq-buildable"}


# The rule-5 reasons that are about what a runtime does with an app (lib/commcare/surface/schema.ts,
# REFUSAL_REASON_KINDS); every other reason is about how HQ's editors or HQ's build treat the source it holds.
RUNTIME_REASONS = frozenset({"broken-at-runtime", "unavailable-on-declared-platform"})


def _is_parser(key):
    return key.startswith("parser:") and "/" not in key


# Uses -----------------------------------------------------------------------


@dataclass(frozen=True)
class Use:
    """One surface item an export uses: its key, the artifact, and where in it; ``at`` is where it sits in
    what the check parsed (``proof.checks.manifest_value_classes``: ``XmlAt``, ``JsonAt`` or ``CsqlAt``),
    which a value class's reader reads, and no part of the use's identity."""

    key: str
    artifact: str
    where: str
    at: object = field(default=None, compare=False, repr=False)


@dataclass(frozen=True)
class Expression:
    """An expression Core parses, where it is, the instances its document declares, whether its grammar is
    read, and where it sits (its attribute's ``XmlAt``)."""

    artifact: str
    where: str
    text: str
    instances: tuple  # ((id, src), ...) the document declares
    grammar: bool
    at: object = field(default=None, compare=False, repr=False)


@dataclass
class Uses:
    """Every use found in a set of artifacts, and the expressions, CSQL and questions still to be read, with
    the documents they sit in (which take the observation's readings once it is read)."""

    uses: list = field(default_factory=list)
    expressions: list = field(default_factory=list)  # [Expression]
    csql: list = field(default_factory=list)  # [(artifact, where, expression text)]
    questions: list = field(default_factory=list)  # [(artifact, the sha256 of the form's bytes, its Form)]
    roots: set = field(default_factory=set)
    documents: list = field(default_factory=list)  # [Form | Runtime]

    def add(self, key, artifact, where, at=None):
        self.uses.append(Use(key, artifact, where, at))

    def expression(self, artifact, where, text, instances=(), *, grammar=False, at=None):
        if text and text.strip():
            self.expressions.append(Expression(artifact, where, text, tuple(instances), grammar, at))

    def query(self, artifact, where, text):
        if text and text.strip():
            self.csql.append((artifact, where, text))


def _same(a, b):
    """JSON equality as HQ's properties read it: numbers by value, a boolean never a number."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b, strict=True))
    return type(a) is type(b) and a == b


# The app JSON ---------------------------------------------------------------


def app_json_uses(app: dict, manifest: Manifest, artifact: str, found: Uses):
    """The surface items one app JSON uses, its XForm sources included (by their forms' positions), each parsed form
    keeping the form object that names it (``Form.app_form``), which the value classes read of a form's own case
    actions and type."""
    if not isinstance(app, dict):
        raise ManifestError(f"{artifact} is not a JSON object, so it is no app HQ's import reads.")
    root = app.get("doc_type") or "Application"
    document = App(app, artifact)
    found.documents.append(document)
    scope = ((root, app),)
    found.add(f"schema:{root}", artifact, "/", JsonAt(document, scope))
    _walk_object(app, root, "", manifest, artifact, found, document, scope)
    sources = app.get("_attachments") or {}
    for m, module in enumerate(app.get("modules") or []):
        for f, form in enumerate((module or {}).get("forms") or []):
            name = f"{(form or {}).get('unique_id')}.xml"
            source = sources.get(name)
            if isinstance(source, dict):  # a Couch attachment stub carries its data inline
                source = source.get("data")
            if isinstance(source, str) and source:
                parsed = xform_uses(source.encode("utf-8"), manifest, f"{_prefix(artifact)}form:{m}.{f}", found)
                parsed.app_form = (document, form or {})
                document.forms.setdefault((form or {}).get("unique_id"), parsed)


def _prefix(artifact):
    """The export an artifact belongs to ("" for D, "edit/" for D′), so its forms are named under it."""
    return artifact[: artifact.rindex("/") + 1] if "/" in artifact else ""


def _class_of(value, declared):
    """The schema class a value in a slot of ``declared`` item type is wrapped as, and whether doc_type chose it."""
    doc_type = value.get("doc_type") if isinstance(value, dict) else None
    if isinstance(doc_type, str) and doc_type and doc_type != declared:
        return doc_type, True
    return declared, False


def schema_key(manifest, cls, key):
    """The schema item for one key of a class: the key's own, else the class's undeclared-key item."""
    own = f"schema:{cls}.{key}"
    if own in manifest.items:
        return own
    undeclared = f"schema:{cls}.<undeclared>"
    return undeclared if undeclared in manifest.items else own


def _walk_object(value, cls, pointer, manifest, artifact, found, document, scope):
    """The uses of one schema object (``scope``: the objects from the app down to it, each ``(class,
    object)``) and of every object its slots hold."""
    if not isinstance(value, dict):
        return
    _object_uses(cls, value, pointer, manifest, artifact, found, JsonAt(document, scope))
    for key, child in value.items():
        at = f"{pointer}/{pointer_token(key)}"
        slot = JsonAt(document, scope, key)
        item = manifest.item(f"schema:{cls}.{key}")
        if item is None:
            found.add(schema_key(manifest, cls, key), artifact, at, slot)
            continue
        if "default" not in item or not _same(child, item["default"]):
            found.add(f"schema:{cls}.{key}", artifact, at, slot)
        _special(cls, key, child, at, manifest, artifact, found, slot)
        item_type = item.get("itemType")
        if item_type is None or manifest.item(f"schema:{item_type}") is None:
            continue
        kind = item.get("type")
        if kind == "ObjectProperty":
            children = [(at, child)]
        elif kind == "ListProperty" and isinstance(child, list):
            children = [(f"{at}/{index}", element) for index, element in enumerate(child)]
        elif kind == "DictProperty" and isinstance(child, dict):
            children = [(f"{at}/{pointer_token(k)}", element) for k, element in child.items()]
        else:
            children = []
        for where, element in children:
            if not isinstance(element, dict):
                continue
            chosen, dispatched = _class_of(element, item_type)
            wrapped = chosen if manifest.item(f"schema:{chosen}") else item_type
            inner = (*scope, (wrapped, element))
            if dispatched:
                found.add(f"schema:{chosen}", artifact, where, JsonAt(document, inner))
            _walk_object(element, wrapped, where, manifest, artifact, found, document, inner)


def key_name(text):
    """A name as the surface spells it in a key: whitespace and ``%`` percent-encoded, so ``CommCare App
    Name`` is ``CommCare%20App%20Name``. The extractor spells it with ``proof/surface/families/data.py::name``;
    the judge keeps its own copy because the two are keyed apart (the judge's code is ``proof/checks/``,
    ``proof/store/fingerprints.py``; the extraction's is ``proof/surface/``, ``proof/lane/extraction.py``),
    so a helper one imported from the other would change without re-keying it. ``test_manifest`` holds the
    two to one spelling."""
    return quote(text, safe="".join(chr(c) for c in range(33, 127) if chr(c) != "%"))


def setting_key(manifest, kind, name):
    """A profile property or feature the app or its profile sets, by the item that holds it.

    A property is HQ's setting (``commcare-profile-settings.yml``) where HQ's
    settings hold it, else the property item that holds its key: one HQ's
    profile writes itself (``Application.create_profile`` and
    ``profile.xml``), or one the surface authors for a key only Nova's local
    profile sets (``profile-property:``, the key spelled as the surface
    spells it), else the setting spelling, which no item holds.
    """
    key = f"setting:{kind}.{name}"
    property_key = f"profile-property:{key_name(name)}"
    if kind == "properties" and key not in manifest.items and property_key in manifest.items:
        return property_key
    return key


def _special(cls, key, value, at, manifest, artifact, found, slot):
    """The uses a schema slot's value names beyond the slot itself: a format, an add-on, a setting, a class."""
    if cls == "DetailColumn" and key == "format" and isinstance(value, str) and value:
        found.add(format_key(manifest, value), artifact, at, slot)
    elif cls in ("Application", "LinkedApplication") and key == "add_ons" and isinstance(value, dict):
        for slug, on in value.items():
            if on:
                found.add(f"add-on:{slug}", artifact, f"{at}/{pointer_token(slug)}", slot)
    elif cls in ("Application", "LinkedApplication") and key == "profile" and isinstance(value, dict):
        for kind in ("properties", "features"):
            for name in value.get(kind) or {}:
                found.add(setting_key(manifest, kind, name), artifact, f"{at}/{kind}/{pointer_token(name)}", slot)
        # A custom property is a property HQ's profile writes as it is (profile.xml's custom properties).
        for name in value.get("custom_properties") or {}:
            found.add(
                setting_key(manifest, "properties", name),
                artifact,
                f"{at}/custom_properties/{pointer_token(name)}",
                slot,
            )
    elif cls == "HQMediaMapItem" and key == "media_type" and isinstance(value, str) and value:
        found.add(f"media-class:{value}", artifact, at, slot)
    elif cls in ("Application", "LinkedApplication") and key == "translations" and isinstance(value, dict):
        for lang, strings in value.items():
            for name in strings if isinstance(strings, dict) else ():
                _ui_string(name, manifest, artifact, f"{at}/{pointer_token(lang)}/{pointer_token(name)}", found, slot)


def format_key(manifest, slug):
    """A case list column's format: the format HQ registers or its editor offers (``format:<slug>``), else the
    fallback HQ's build builds any other slug with (``format:<unregistered>``,
    ``detail_screen.py::get_class_for_format``)."""
    own = f"format:{slug}"
    return own if own in manifest.items else UNREGISTERED_FORMAT


def _ui_string(name, manifest, artifact, where, found, at=None):
    """A string id a runtime reads as one of its own UI strings: the ``ui-string`` item the surface records a
    reader for (``readBy``), by the id (``ui-string:app.display.name``) or by a prefix a runtime reads ids
    under (``ui-string:android.package.name.*``). Any other id is the app's own text, a catalog's id no
    runtime reads (HQ's historical or other languages' catalogs) included."""
    key = ui_string_key(manifest, name)
    if key is not None:
        found.add(key, artifact, where, at)


def ui_string_key(manifest, name):
    """The ``ui-string`` item a runtime reads an id through (``readBy``), or None."""
    own = manifest.item(f"ui-string:{name}")
    if own is not None and own.get("readBy"):
        return f"ui-string:{name}"
    held = [prefix for prefix in _ui_string_prefixes(manifest) if name.startswith(prefix)]
    return f"ui-string:{max(held, key=len)}*" if held else None


@cache
def _ui_string_prefixes(manifest):
    """Each prefix a runtime reads ui-string ids under: a ``ui-string:<prefix>*`` item with a ``readBy``."""
    return tuple(
        pattern[:-1]
        for pattern in manifest.family("ui-string")
        if pattern.endswith(".*") and (manifest.item(f"ui-string:{pattern}") or {}).get("readBy")
    )


def app_strings_uses(text: bytes, manifest: Manifest, artifact: str, found: Uses):
    """The ids of an app strings file a runtime reads as its own UI strings, read with HQ's reader of the
    format (``commcare_translations.loads``, which HQ's build writes them with as ``dumps``)."""
    for name in sorted(parse_app_strings(text)):
        _ui_string(name, manifest, artifact, name, found)


def _object_uses(cls, value, pointer, manifest, artifact, found, at):
    """The uses one object names through several of its keys: a column's field type, a search's keys and CSQL."""
    if cls == "DetailColumn" and not value.get("useXpathExpression"):
        field_value = value.get("field")
        if isinstance(field_value, str):
            # DetailColumn.field_type: the field's part before the first ":", else "property".
            kind = field_value.split(":", 1)[0] if ":" in field_value else "property"
            found.add(f"detail-field-type:{kind}", artifact, f"{pointer}/field", JsonAt(at.app, at.scope, "field"))
    elif cls == "DefaultCaseSearchProperty":
        name = value.get("property")
        _search_key(name, manifest, artifact, f"{pointer}/property", found, JsonAt(at.app, at.scope, "property"))
        if name == XPATH_QUERY_KEY and isinstance(value.get("defaultValue"), str):
            found.query(artifact, f"{pointer}/defaultValue", value["defaultValue"])
    elif cls == "CaseSearchProperty":
        _search_key(value.get("name"), manifest, artifact, f"{pointer}/name", found, JsonAt(at.app, at.scope, "name"))
        for slot, family in (("input_", "prompt-input"), ("appearance", "prompt-appearance")):
            if isinstance(value.get(slot), str) and value[slot]:
                found.add(f"{family}:{value[slot]}", artifact, f"{pointer}/{slot}", JsonAt(at.app, at.scope, slot))


def search_key(manifest, name):
    """The ``csql-key`` item HQ's search reads a query key as, or None for a case property's key."""
    if not isinstance(name, str) or not name:
        return None
    if f"csql-key:{name}" in manifest.items:
        return f"csql-key:{name}"
    for pattern in manifest.family("csql-key"):
        if pattern.endswith(".*") and name.startswith(pattern[:-1]):
            return f"csql-key:{pattern}"
    return None


def _search_key(name, manifest, artifact, where, found, at=None):
    key = search_key(manifest, name)
    if key is not None:
        found.add(key, artifact, where, at)


# XForms ---------------------------------------------------------------------


def qualified(name: str) -> str:
    """A namespaced name as the XForm vocabulary writes it (``jr:constraintMsg``, ``h:body``, ``bind``)."""
    q = etree.QName(name)
    if q.namespace is None:
        return q.localname
    prefix = PREFIXES.get(q.namespace)
    if prefix is None:
        return f"{{{q.namespace}}}{q.localname}"
    return f"{prefix}:{q.localname}" if prefix else q.localname


def xform_key(element: str, attribute: str | None = None) -> str:
    """The surface key of one piece of XForm vocabulary: an element, or an attribute on it."""
    return f"{XFORM_FAMILY}:{element}" + (f"@{attribute}" if attribute is not None else "")


def _parse(xml: bytes, artifact: str):
    try:
        return etree.fromstring(xml, etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError as error:
        raise ManifestError(
            f"{artifact} is not well-formed XML ({error}), so its vocabulary cannot be read."
        ) from error


def _element_path(element):
    steps = []
    while element is not None:
        parent = element.getparent()
        name = qualified(element.tag)
        if parent is None:
            steps.append(name)
        else:
            same = [child for child in parent if isinstance(child.tag, str) and child.tag == element.tag]
            steps.append(f"{name}[{same.index(element) + 1}]")
        element = parent
    return "/" + "/".join(reversed(steps))


@cache
def _control_handlers(manifest):
    """XFormParser's handler maps as the surface records them: (top level, in groups).

    Android's ``registerHandler`` puts its handlers into both maps
    (``XFormParser.registerHandler``), so they count at both levels.
    """
    top, group = set(), set()
    for key, item in manifest.items.items():
        if key.startswith("jr-control:"):
            name = key.split(":", 1)[1]
            if item.get("atTopLevel") or item.get("android"):
                top.add(name)
            if item.get("inGroups") or item.get("android"):
                group.add(name)
    return top, group


def _controls(form, manifest, artifact, found):
    """The elements XFormParser hands to a handler, walked as ``XFormParser.parseElement`` walks them.

    From the root with the top-level handlers: an element whose local name
    has a handler is that handler's (a group or repeat then parses its
    children with the group-level handlers, ``parseGroup``); any other
    element is passed over and its children parsed with the same handlers.
    """
    top, group = _control_handlers(manifest)
    handled = set()

    def dispatch(element, handlers):
        local = etree.QName(element).localname
        if local in handlers:
            handled.add(element)
            found.add(f"jr-control:{local}", artifact, _element_path(element), XmlAt(form, element))
            if local in ("group", "repeat"):
                for child in element:
                    if isinstance(child.tag, str):
                        dispatch(child, group)
            return
        for child in element:
            if isinstance(child.tag, str):
                dispatch(child, handlers)

    dispatch(form.root, top)
    return handled


@cache
def _extensions(manifest):
    """Android's extension parsers by the element each reads, with the attributes it reads there."""
    found = {}
    for key, item in manifest.items.items():
        if key.startswith("jr-extension:"):
            found.setdefault(item.get("element"), []).append((key, item.get("attributes") or {}))
    return found


def xform_uses(xml: bytes, manifest: Manifest, artifact: str, found: Uses):
    """The surface items one XForm uses.

    First what the handler families name: each element a handler table
    dispatches (a control, an action, an extension), each bind type, event,
    appearance and itext form. Then the XForm's vocabulary
    (``xform_vocabulary``), which also collects the expressions Core parses,
    its instances, its hashtags and its question types. Returns the parsed
    form (``proof.checks.manifest_value_classes.Form``), which every use
    found in it sits in.
    """
    root = _parse(xml, artifact)
    form = Form(root, artifact)
    found.documents.append(form)
    handled = _controls(form, manifest, artifact, found)
    extensions = _extensions(manifest)
    body = root.find(f"{{{XHTML}}}body")
    for element in root.iter():
        if not isinstance(element.tag, str) or _in_instance_content(element):
            continue
        where = _element_path(element)
        local = etree.QName(element).localname
        at = XmlAt(form, element)
        if body is not None and _under(element, body) and element.get("appearance") is not None:
            _appearance_uses(element.get("appearance"), manifest, artifact, f"{where}/@appearance", found, at=at)
        if local == "bind" and element.get("type"):
            found.add(
                f"jr-type:{_data_type(element.get('type'))}", artifact, f"{where}/@type", XmlAt(form, element, "type")
            )
        if element.get("event") is not None:
            handled.add(element)
            found.add(f"jr-action:{local}", artifact, where, at)
            for event in element.get("event").split():
                found.add(f"jr-event:{event}", artifact, f"{where}/@event", XmlAt(form, element, "event"))
        for key, attributes in extensions.get(local, ()):
            reads = set(attributes.get(local, ()))
            if key == "jr-extension:UploadQuestionExtensionParser":
                if not any(qualified(a) in reads or a in reads for a in element.attrib):
                    continue
            else:
                handled.add(element)
            found.add(key, artifact, where, at)
            if key == "jr-extension:IntentExtensionParser" and element.get("appearance") is not None:
                _appearance_uses(
                    element.get("appearance"),
                    manifest,
                    artifact,
                    f"{where}/@appearance",
                    found,
                    readers=("android-IntentExtensionParser",),
                    at=at,
                )
        if _is_itext_value(element) and element.get("form") is not None:
            _itext_form_uses(
                element.get("form"), manifest, artifact, f"{where}/@form", found, XmlAt(form, element, "form")
            )
    # HQ's build reads instance ids in the suite's expressions, never a form's own declarations
    # (suite_xml/post_process/instances.py::InstancesHelper._get_all_xpaths_for_entry).
    instances = _instance_uses(form, manifest, artifact, found, schemes=False)
    xform_vocabulary(form, handled, manifest, artifact, found, instances)
    _hashtag_uses(form, manifest, artifact, found)
    question_type_uses(xml, artifact, found, form)
    return form


def _is_itext_value(element):
    parent = element.getparent()
    return (
        etree.QName(element).localname == "value"
        and parent is not None
        and etree.QName(parent).localname == "text"
        and parent.getparent() is not None
        and etree.QName(parent.getparent()).localname == "translation"
    )


@cache
def _itext_readers(manifest):
    """Each itext form the surface holds, with the runtimes' items that read it."""
    readers = {}
    for reader_and_form in manifest.family("itext-form"):
        readers.setdefault(reader_and_form.split("/", 1)[1], []).append(f"itext-form:{reader_and_form}")
    return {form: tuple(sorted(keys)) for form, keys in readers.items()}


def _itext_form_uses(form, manifest, artifact, where, found, at=None):
    """An itext value's ``form``: each named runtime item, else an unknown form. Once the observation's
    readings arrive, a structurally owned protected-message form is covered by the generic @form item."""
    readers = _itext_readers(manifest).get(form, ())
    for key in readers:
        found.add(key, artifact, where, at)
    if not readers:
        found.add(f"itext-form:*/{form}", artifact, where, at)


# The XForm vocabulary, resolved to the surface's items -----------------------


@dataclass(frozen=True)
class _Pattern:
    """One element item of the xform family as a path pattern: ``*`` any one step, ``""`` (from ``//``) any run,
    and the namespaces Core tests the element's in (the item's ``namespace``; None where it is ``any``)."""

    key: str
    steps: tuple
    gaps: int
    wildcards: int
    namespaces: tuple | None


@cache
def _xform_patterns(manifest):
    patterns = []
    for path in manifest.family(XFORM_FAMILY):
        if "@" in path:
            continue
        steps = tuple(path.replace("//", "/\0/").split("/"))
        steps = tuple("" if step == "\0" else step for step in steps)
        tested = tuple((manifest.item(xform_key(path)) or {}).get("namespace") or ("any",))
        patterns.append(
            _Pattern(
                xform_key(path),
                steps,
                steps.count(""),
                sum(1 for step in steps if step == "*" or step.endswith(":*")),
                None if "any" in tested else tested,
            )
        )
    # Most specific first: fewest runs of any depth, then fewest any-name steps, then the longest.
    return tuple(sorted(patterns, key=lambda p: (p.gaps, p.wildcards, -len(p.steps), p.key)))


def _step(text):
    """A vocabulary path step from its spelling (``input``, ``jr:addCaption``, ``{uri}name``): (that spelling,
    the element's local name)."""
    if text.startswith("{"):
        return text, text.split("}", 1)[1]
    return text, text.rsplit(":", 1)[-1]


def _step_matches(pattern_step, step):
    """Whether a pattern step matches an element's step: ``*`` any element; ``p:*`` any element of that prefix's
    namespace; a prefixed step (``jr:addCaption``, ``{uri}name``) an element of that namespace, as Core tests
    its namespace; a bare step any element of that local name, whatever its namespace, since a handler table
    and a name test compare the local name alone (``XFormParser.parseElement``)."""
    spelled, local = step
    if pattern_step == "*":
        return True
    if pattern_step.endswith(":*"):
        return spelled.startswith(pattern_step[:-1]) and ":" in spelled
    if ":" in pattern_step or pattern_step.startswith("{"):
        return pattern_step == spelled
    return pattern_step == local


def _path_matches(pattern, steps):
    if not pattern:
        return not steps
    head, rest = pattern[0], pattern[1:]
    if head == "":
        return any(_path_matches(rest, steps[index:]) for index in range(len(steps) + 1))
    return bool(steps) and _step_matches(head, steps[0]) and _path_matches(rest, steps[1:])


def xform_candidates(manifest, steps, namespace=XFORMS):
    """The xform family's element items a vocabulary path matches (each step spelled as ``qualified`` spells
    it, or ``(spelling, local name)``), most specific first: its steps match, and the element's ``namespace``
    is one the item says Core tests it in (any, for most)."""
    return list(
        _xform_candidates(manifest, tuple(_step(step) if isinstance(step, str) else step for step in steps), namespace)
    )


@cache
def _xform_candidates(manifest, steps, namespace):
    return tuple(
        pattern.key
        for pattern in _xform_patterns(manifest)
        if _path_matches(pattern.steps, steps)
        and (pattern.namespaces is None or (namespace or "none") in pattern.namespaces)
    )


def _vocabulary_steps(element, handled, *, strict=False):
    """An element's path from the element a handler table dispatched (itself unless ``strict``, or its nearest
    ancestor), each step ``(spelling, local name)``, or None when no dispatched element holds it."""
    steps = []
    node = element
    while node is not None:
        if node in handled and not (strict and node is element):
            # A handler table is keyed by local name and dispatches whatever the namespace (parseElement).
            local = etree.QName(node).localname
            steps.append((local, local))
            return list(reversed(steps))
        steps.append(_step(qualified(node.tag)))
        node = node.getparent()
    return None


def xform_vocabulary(form, handled, manifest, artifact, found, instances=()):
    """The XForm's own vocabulary: each element and attribute, as the surface's xform family keys it.

    An element's path starts at the element one of ``XFormParser``'s handler
    tables dispatched (itself, or its nearest ancestor):
    ``xform:model/itext/translation/text/value``, ``xform:input``,
    ``xform:select1/item/value``, ``xform:model/bind@nodeset``. It is the
    surface's most specific item matching that path (``*`` steps and ``//``
    runs included), and the path itself where none matches; an attribute is
    the first matching item that holds it, else the element's key with it. An
    element no table reaches is named by itself (``xform:h:foo``), except the
    XHTML wrappers XFormParser passes over by design. Vellum's own markup, an
    element or attribute in Vellum's namespace, is Vellum's
    (``vellum-markup:``, ``_vellum_element_uses``, ``vellum_markup_key``),
    in an instance's content too; such an element is Core's as well only where
    a Core item takes it (``xform:group/*``). A step is
    matched as Core matches it: a bare step by the element's local name in any
    namespace, a prefixed one in its namespace, and the element itself in a
    namespace its item says Core tests (``namespace``). Where Core reads an
    element's namespace (an ``@xmlns`` item on its path, or on its path from
    the dispatched element above a dispatched one, as ``parseGroup`` reads
    each repeat child's), and the item's conditions hold of the element
    (``namespace_read_holds``), ``@xmlns`` is used too. An instance's content is read the
    same way, at any depth (``xform:model/instance/*/*``,
    ``xform:model/instance//*``: ``XFormParser.buildInstanceStructure``
    and ``loadInstanceData`` walk every node): its elements, their
    namespaces, and the attributes Core reads by name there (``jr:template``,
    ``jr:modeltype``, ``jr:recordset``). Every other attribute of an
    instance's content is answer data, which Core copies by position into the
    instance as the app's (a case block's ``case_id``); of the main instance's
    data root every attribute is vocabulary (``xform:model/instance/*``). Each
    attribute the surface records as parsed as XPath is collected as an
    expression.
    """
    first = {}  # each item's first element in document order, for a namespace read Core takes on its first value
    for element in form.root.iter():
        if not isinstance(element.tag, str):
            continue
        content = _in_instance_content(element) and not _is_data_root(element)
        where = _element_path(element)
        at = XmlAt(form, element)
        markup = etree.QName(element).namespace == VELLUM
        if markup:
            _vellum_element_uses(element, artifact, where, found, form)
        steps = _vocabulary_steps(element, handled)
        if steps is None:
            if element.tag in WRAPPERS or markup:
                # Core passes over the XHTML wrappers by design, and over Vellum's own elements where no handler
                # table reaches them; Vellum's are its markup, above.
                continue
            steps = [_step(qualified(element.tag))]
        namespace = etree.QName(element).namespace
        candidates = xform_candidates(manifest, steps, namespace)
        if markup and not candidates:
            continue
        key = candidates[0] if candidates else xform_key("/".join(spelled for spelled, _ in steps))
        found.add(key, artifact, where, at)
        namespace_reads = [f"{candidate}@xmlns" for candidate in candidates]
        outer = _vocabulary_steps(element, handled, strict=True) if element in handled else None
        if outer is not None:
            namespace_reads += [f"{candidate}@xmlns" for candidate in xform_candidates(manifest, outer, namespace)]
        for read in namespace_reads:
            first.setdefault(read, element)
        read = next(
            (
                item
                for item in namespace_reads
                if item in manifest.items and namespace_read_holds(manifest.items[item], element, first[item])
            ),
            None,
        )
        if read is not None:
            found.add(read, artifact, f"{where}/namespace()", at)
        if markup:
            continue  # its attributes are Vellum's markup, above
        for attribute, value in element.attrib.items():
            name = qualified(attribute)
            attribute_at = XmlAt(form, element, attribute)
            if etree.QName(attribute).namespace == VELLUM:
                found.add(vellum_markup_key(element, name), artifact, f"{where}/@{name}", attribute_at)
                continue
            held = next(
                (f"{candidate}@{name}" for candidate in candidates if f"{candidate}@{name}" in manifest.items), None
            )
            if held is None and content:
                continue  # answer data, which Core copies into the instance by position
            attribute_key = held or f"{key}@{name}"
            found.add(attribute_key, artifact, f"{where}/@{name}", attribute_at)
            item = manifest.item(attribute_key) or {}
            if "xpath" in (item.get("parsedAs") or ()):
                found.expression(artifact, f"{where}/@{name}", value, instances, grammar=True, at=attribute_at)


def namespace_read_holds(item, element, first):
    """Whether Core reads this element's namespace through an ``@xmlns`` item: always, or where one of the
    item's ``when`` alternatives holds of it, each condition as the xform family records the test Core made
    before the read (``proof/surface/java/.../XForms.java``, ``Conditions``): ``not-named:<name>`` (the
    element's local name is not that one; ``not-named-ignoring-case:`` in any case), ``childless`` (it holds
    no element child: ``XFormParser.saveInstanceNode`` takes an ``<instance>`` itself as its node only then),
    ``without:<attribute>`` (it has no such attribute) and ``first`` (it is the first element of the item's
    path in the document: a field's first value, ``mainInstanceNode``)."""
    alternatives = item.get("when")
    if not alternatives:
        return True
    return any(all(_condition_holds(condition, element, first) for condition in each) for each in alternatives)


def _condition_holds(condition, element, first):
    local = etree.QName(element).localname
    if condition == "childless":
        return not any(isinstance(child.tag, str) for child in element)
    if condition == "first":
        return element is first
    kind, _, value = condition.partition(":")
    if kind == "not-named":
        return local != value
    if kind == "not-named-ignoring-case":
        return local.lower() != value.lower()
    if kind == "without":
        return all(qualified(attribute) != value for attribute in element.attrib)
    raise ManifestError(
        f"The surface records a namespace read under the condition {condition!r}, which the manifest check does not"
        " know how to apply; teach proof/checks/manifest_usage.py::_condition_holds that condition."
    )


def _markup_element(element):
    """How a ``vellum-markup`` key names an element: ``model/instance//*`` inside an instance, whose elements
    are the app's, else its name as the XForm vocabulary writes it (``bind``, ``h:head``)."""
    return INSTANCE_CONTENT_MARKUP if _in_instance_content(element) else qualified(element.tag)


def vellum_markup_key(element, attribute):
    """An attribute in Vellum's namespace: Vellum's, as the surface's vellum family records what Vellum's parser
    asks of each element (``vellum-markup:bind@vellum:relevant``)."""
    return f"{VELLUM_MARKUP}:{_markup_element(element)}@{attribute}"


def _vellum_element_uses(element, artifact, where, found, form):
    """An element in Vellum's namespace (``<vellum:hashtags>``) and its attributes: Vellum's markup, as the
    vellum family records where Vellum's parser looks for each (``vellum-markup:h:head/vellum:hashtags``). Core
    passes over it (``XFormParser.parseElement`` reads it as no element of its own)."""
    parent = element.getparent()
    held_in = _markup_element(parent) if parent is not None else ""
    key = f"{VELLUM_MARKUP}:{held_in}/{qualified(element.tag)}"
    found.add(key, artifact, where, XmlAt(form, element))
    for attribute in element.attrib:
        found.add(
            f"{key}@{qualified(attribute)}",
            artifact,
            f"{where}/@{qualified(attribute)}",
            XmlAt(form, element, attribute),
        )


def _is_data_root(element):
    """The main instance's data root: the first element of the model's first instance."""
    instance = element.getparent()
    if instance is None or instance.tag != INSTANCE or not _is_main_instance(instance):
        return False
    return next((child for child in instance if isinstance(child.tag, str)), None) is element


def _is_main_instance(instance):
    model = instance.getparent()
    if model is None:
        return False
    instances = [child for child in model if isinstance(child.tag, str) and child.tag == INSTANCE]
    return bool(instances) and instances[0] is instance


def _in_instance_content(element):
    """An element inside an instance (answer data or an inline instance's rows), not the instance itself."""
    parent = element.getparent()
    while parent is not None:
        if parent.tag == INSTANCE:
            return True
        parent = parent.getparent()
    return False


def _under(element, ancestor):
    while element is not None:
        if element is ancestor:
            return True
        element = element.getparent()
    return False


def _data_type(text):
    """A bind type as ``XFormParser.getDataType`` reads it: the part after the prefix."""
    return text.split(":", 1)[1] if ":" in text else text


# Instances, hashtags and question types ------------------------------------


def instance_scheme(instance_id):
    """The scheme HQ's build reads in an instance id (``suite_xml/post_process/instances.py::get_instance_factory``).

    The id's part before its first ``:``, or the whole id; an id holding
    ``selected_cases`` without a ``:`` is that scheme.
    """
    if ":" in instance_id:
        return instance_id.split(":", 1)[0]
    return "selected_cases" if "selected_cases" in instance_id else instance_id


def _instance_uses(document, manifest, artifact, found, *, schemes):
    """Each instance a document declares with a source: the source Core gives it, and (where HQ's build reads the
    document's instance ids, ``schemes``) its scheme; the (id, src) pairs, in order."""
    declared = []
    for element in document.root.iter():
        if not isinstance(element.tag, str) or etree.QName(element).localname != "instance":
            continue
        src, instance_id = element.get("src"), element.get("id")
        if src is None:
            continue
        where = _element_path(element)
        found.add(instance_source(manifest, src), artifact, f"{where}/@src", XmlAt(document, element, "src"))
        if instance_id is not None:
            if schemes:
                found.add(
                    f"instance-scheme:{instance_scheme(instance_id)}",
                    artifact,
                    f"{where}/@id",
                    XmlAt(document, element, "id"),
                )
            declared.append((instance_id, src))
    return tuple(declared)


def hashtag_key(manifest, hashtag):
    """The surface's hashtag a hashtag starts with (the longest), or the hashtag itself when none does."""
    held = [tag for tag in manifest.family("hashtag") if hashtag.startswith(tag)]
    return f"hashtag:{max(held, key=len)}" if held else f"hashtag:{hashtag}"


def _hashtag_uses(form, manifest, artifact, found):
    """The hashtags Vellum reads from ``vellum:hashtags`` (its keys) and ``vellum:hashtagTransforms`` (its
    prefixes), as Vellum's ``parser.js`` hands them to ``initHashtags``: JSON."""
    for local, read in (("hashtags", lambda value: value), ("hashtagTransforms", lambda value: value.get("prefixes"))):
        for element in form.root.iter(f"{{{VELLUM}}}{local}"):
            where = _element_path(element)
            try:
                value = json.loads(element.text or "")
            except json.JSONDecodeError as error:
                raise ManifestError(
                    f"{artifact} {where} holds no JSON ({error}), which Vellum's parser reads there."
                ) from error
            for hashtag in sorted(read(value) or {}) if isinstance(value, dict) else ():
                found.add(hashtag_key(manifest, hashtag), artifact, where, XmlAt(form, element))


def question_type_uses(xml: bytes, artifact: str, found: Uses, form=None):
    """Each question's type as HQ reads it, to be read from the observation's readings (``read_observed``)."""
    found.questions.append((artifact, hashlib.sha256(xml).hexdigest(), form))


def _question_uses(artifact, read, found, form=None):
    """The questions HQ's reader found in one form (``XForm.get_questions`` with groups and triggers, each typed
    by ``_infer_vellum_type``): ``mug:<type>``, ``mug:(none)`` where it finds no type, and ``mug:(unreadable)``
    where HQ cannot read the form's questions at all. Each sits at the body control that names its path, the
    first one, where one does."""
    if "unreadable" in read:  # XForm's own refusal of a form it cannot read
        found.add("mug:(unreadable)", artifact, f"/ ({read['unreadable']})")
        return
    for question_type, path in read["questions"]:
        controls = form.question_controls(path) if form is not None else []
        at = XmlAt(form, controls[0]) if controls else None
        found.add(f"mug:{question_type or '(none)'}", artifact, path, at)


# Appearances ----------------------------------------------------------------


def _appearance_uses(value, manifest, artifact, where, found, readers=None, at=None):
    """The appearance tokens a runtime acts on in one element's appearance: each read whose rule acts on the value,
    where the read compares that element's appearance (``AppearanceRule.reads``: Android's ``-`` and ``compact``
    are a select's, Core's ``field-list`` a group's), and each whitespace token no such read reads
    (``appearance:*/<token>``, ``manifest_value_classes.appearance_words``)."""
    matched, unread = appearance_words(manifest, at.document, at.element, value, readers)
    for key in sorted(matched):
        found.add(key, artifact, where, at)
    for word in unread:
        found.add(f"appearance:*/{word}", artifact, where, at)


# Suites and profiles --------------------------------------------------------


def _reads(manifest, parser, element):
    """How much of an element a parser holds items for: its name, and its attributes (wildcards included)."""
    local = etree.QName(element).localname
    parent = element.getparent()
    parent_local = etree.QName(parent).localname if parent is not None else None
    score = int(f"parser:{parser}/{local}" in manifest.items or f"parser:{parser}/{local.lower()}" in manifest.items)
    for attribute in element.attrib:
        name = qualified(attribute)
        if (
            f"parser:{parser}/{local}@{name}" in manifest.items
            or f"parser:{parser}/{parent_local}/*@{name}" in manifest.items
        ):
            score += 1
    return score


def _names(manifest, parser, local):
    return f"parser:{parser}/{local}" in manifest.items or f"parser:{parser}/{local.lower()}" in manifest.items


def _child_parsers(manifest, parsers, element):
    """The parsers ``parsers`` hand ``element`` to, by the child specs the surface records, or ().

    A spec names the element (``entry``), every child of one (``template/*``),
    or a child the surface's reader could not name (``?``). Every parser a
    spec names the element for reads it: ``DetailFieldParser.parseStyle``
    hands one ``style`` to ``StyleParser`` and then to ``GridParser``. Where
    several parsers take the same children by a wildcard and the parent
    chooses by something the spec does not record (``DetailFieldParser.
    parseTemplate`` picks a graph, callout or text parser by the template's
    ``form``), the one holding items for this element (its name, or its
    attributes) is the one: a parser has items for exactly what it reads. A
    wildcard does not take an element whose name the parser tests itself, and
    a ``?`` spec takes an element only when that parser reads something of it.
    """
    local = etree.QName(element).localname
    parent = element.getparent()
    parent_local = etree.QName(parent).localname if parent is not None else None
    named, wildcard, unnamed = [], [], []
    for parser in parsers:
        for child, specs in sorted((manifest.parsers.get(parser) or {}).get("children", {}).items()):
            if manifest.parsers.get(child, {}).get("platform") == "android":
                continue  # Android's overrides read the elements Core's parsers read
            for spec in specs:
                target = spec.split(" (", 1)[0]
                if target == local:
                    named.append(child)
                elif target.endswith("/*") and target[:-2] == parent_local:
                    wildcard.append(child)
                elif target == "?":
                    unnamed.append(child)
    if named:
        return tuple(sorted(set(named)))
    if any(_names(manifest, parser, local) for parser in parsers):
        # The parser tests this element's name itself (DetailParser's ``variables`` among a detail's
        # fields), so only a spec naming it hands it on.
        return ()
    for candidates, alone in ((wildcard, True), (unnamed, False)):
        scored = sorted({(_reads(manifest, child, element), child) for child in candidates}, reverse=True)
        if scored and scored[0][0] > 0:
            return (scored[0][1],)
        if alone and len(set(candidates)) == 1:
            return (candidates[0],)
    return ()


def _element_key(manifest, parsers, element):
    """The item for an element: a parser that reads it, else the one that handed it over, by name.

    A child parser starts at the element its parent tested for
    (``SuiteParser`` tests ``entry`` and hands it to ``EntryParser``), so the
    name is the parent's item when the child holds none. An element neither
    tests but whose parent's children a parser reads by position
    (``parser:ResourceParser/resource/*@authority``) is no item of its own:
    None.
    """
    local = etree.QName(element).localname
    for parser in parsers:
        for name in (local, local.lower()):
            key = f"parser:{parser}/{name}"
            if key in manifest.items:
                return key
    parent = element.getparent()
    if parent is not None:
        prefix = f"parser:{parsers[0]}/{etree.QName(parent).localname}/*@"
        if any(key.startswith(prefix) for key in manifest.items):
            return None
    return f"parser:{parsers[0]}/{local}"


def _attribute_key(manifest, parsers, element, attribute):
    local = etree.QName(element).localname
    name = qualified(attribute)
    parent = element.getparent()
    for parser in parsers:
        key = f"parser:{parser}/{local}@{name}"
        if key in manifest.items:
            return key
        if parent is not None:
            wildcard = f"parser:{parser}/{etree.QName(parent).localname}/*@{name}"
            if wildcard in manifest.items:
                return wildcard
    return f"parser:{parsers[0]}/{local}@{name}"


def runtime_xml_uses(xml: bytes, root_parser: str, manifest: Manifest, artifact: str, found: Uses):
    """The surface items a suite or profile uses, read with Core's parser graph from ``root_parser``.

    An attribute is read as an expression, its grammar with it, only where
    the parser that reads it hands its value to Core's XPath parser (its
    item's ``parsedAs: xpath``): an attribute no parser reads is never
    evaluated, and an id, a path or a profile's text is never an expression.
    A suite's instances, a search's keys and prompts, and the CSQL its
    ``_xpath_query`` sends are read too.
    """
    root = _parse(xml, artifact)
    if root_parser not in manifest.parsers:
        raise ManifestError(f"The surface holds no parser:{root_parser}, which reads {artifact}.")
    document = Runtime(root, artifact)
    found.documents.append(document)
    suite = root_parser != "ProfileParser"
    instances = _instance_uses(document, manifest, artifact, found, schemes=True) if suite else ()
    searches = set()  # each <query> SessionDatumParser reads: a search

    def walk(element, parsers):
        handed = _child_parsers(manifest, parsers, element) if element is not root else ()
        readers = handed + parsers if handed else parsers
        current = handed or parsers
        if any(manifest.parsers[parser].get("readsAttributesByPosition") for parser in current):
            return  # a fixture's rows: data the parser reads by position, not vocabulary
        where = _element_path(element)
        at = XmlAt(document, element)
        key = _element_key(manifest, readers, element)
        if key is not None:
            found.add(key, artifact, where, at)
        for attribute, value in element.attrib.items():
            name = qualified(attribute)
            attribute_at = XmlAt(document, element, attribute)
            attribute_key = _attribute_key(manifest, readers, element, attribute)
            found.add(attribute_key, artifact, f"{where}/@{name}", attribute_at)
            if "xpath" in ((manifest.item(attribute_key) or {}).get("parsedAs") or ()):
                found.expression(artifact, f"{where}/@{name}", value, instances, grammar=True, at=attribute_at)
        if suite:
            if key == SEARCH_QUERY:
                searches.add(element)
            elif key == STACK_QUERY:
                _stack_query_uses(element, manifest, artifact, where, found, document)
            elif element.getparent() in searches:
                _query_uses(element, manifest, artifact, where, found, document)
        else:
            _profile_setting(element, manifest, artifact, where, found, at)
        for child_element in element:
            if isinstance(child_element.tag, str):
                walk(child_element, current)

    walk(root, (root_parser,))


def _query_uses(element, manifest, artifact, where, found, document=None):
    """A search query's data and prompts: the keys HQ's search reads as its own, prompt inputs and appearances,
    and the CSQL of its ``_xpath_query``. A search query is the ``<query>`` a session's datums hold
    (``SessionDatumParser``): Core runs it as a search, and HQ answers it with its case search."""
    local = etree.QName(element).localname
    if local not in ("data", "prompt"):
        return
    _search_key(element.get("key"), manifest, artifact, f"{where}/@key", found, XmlAt(document, element, "key"))
    if local == "data" and element.get("key") == XPATH_QUERY_KEY and element.get("ref") is not None:
        found.query(artifact, f"{where}/@ref", element.get("ref"))
    if local == "prompt":
        for attribute, family in (("input", "prompt-input"), ("appearance", "prompt-appearance")):
            if element.get(attribute):
                found.add(
                    f"{family}:{element.get(attribute)}",
                    artifact,
                    f"{where}/@{attribute}",
                    XmlAt(document, element, attribute),
                )


def _stack_query_uses(element, manifest, artifact, where, found, document=None):
    """A stack operation's ``<query>`` (``StackFrameStepParser``): a request to the HQ view its ``value`` names,
    whose ``<data>`` are that view's parameters, never a search. HQ's own build points the stack query that
    reloads a search's chosen case at ``/phone/case_fixture/``
    (``suite_xml/post_process/workflow.py::WorkflowQueryMeta.to_stack_datum``, with ``case_type`` and
    ``case_id``), which ``ota/views.py::case_fixture`` answers. The view is the ``hq-api`` item one of whose
    routes the URL's path resolves to (as Django resolves it), ``hq-api:(unresolved)`` where none does; each
    parameter the view reads (its ``requestReads``) is a use of the view, and a parameter it never reads is
    ``hq-api:<view>/<key>``, which no item holds."""
    view = endpoint_key(manifest, element.get("value") or "")
    found.add(view, artifact, f"{where}/@value", XmlAt(document, element, "value"))
    item = manifest.item(view) or {}
    reads = set(item.get("requestReads") or ())
    for data in element:
        if not isinstance(data.tag, str) or etree.QName(data).localname != "data" or data.get("key") is None:
            continue
        key = data.get("key")
        part_reads = {read.split(".", 1)[1] for read in reads if "." in read}
        used = view if key in part_reads or "*" in part_reads else f"{view}/{key}"
        found.add(used, artifact, f"{_element_path(data)}/@key", XmlAt(document, data, "key"))


def endpoint_key(manifest, url):
    """The ``hq-api`` view item a URL's path resolves to, by the routes the surface records (Django's own
    patterns, searched as ``URLResolver`` searches them, from the path without its leading slash), or
    ``hq-api:(unresolved)``."""
    path = urlsplit(url).path.lstrip("/")
    matched = sorted(key for key, pattern in _view_routes(manifest) if pattern.search(path))
    if len(set(matched)) > 1:
        raise ManifestError(
            f"The URL {url!r} resolves to more than one HQ view the surface records ({sorted(set(matched))}), so the"
            " manifest check cannot tell which one a stack query requests."
        )
    return matched[0] if matched else "hq-api:(unresolved)"


@cache
def _view_routes(manifest):
    return tuple(
        (key, re.compile(route["pattern"]))
        for key, item in sorted(manifest.items.items())
        if key.startswith("hq-api:") and item.get("kind") == "view"
        for route in item.get("routes") or ()
    )


def _profile_setting(element, manifest, artifact, where, found, at=None):
    local = etree.QName(element).localname
    parent = element.getparent()
    if local == "property" and element.get("key"):
        found.add(setting_key(manifest, "properties", element.get("key")), artifact, where, at)
    elif parent is not None and etree.QName(parent).localname == "features":
        found.add(setting_key(manifest, "features", local), artifact, where, at)


def archive_uses(entries: dict, manifest: Manifest, artifact: str, found: Uses):
    """The surface items a local ``.ccz`` uses, from the entries the manifest reads (``{name: bytes}``,
    ``proof.observe.manifest.read_entry``): its suites, profile, app strings and forms."""
    for name in sorted(entries):
        data = entries[name]
        if not read_entry(name):
            raise ManifestError(f"{artifact} holds {name}, which the manifest check does not read in an archive.")
        if name in ("suite.xml", "media_suite.xml"):
            runtime_xml_uses(data, "SuiteParser", manifest, f"{artifact}/{name}", found)
        elif name == "profile.ccpr":
            runtime_xml_uses(data, "ProfileParser", manifest, f"{artifact}/{name}", found)
        elif name.endswith("/app_strings.txt"):
            app_strings_uses(data, manifest, f"{artifact}/{name}", found)
        else:
            xform_uses(data, manifest, f"{artifact}/form:{_form_position(name)}", found)


def _form_position(name):
    """``modules-<m>/forms-<f>.xml`` as ``<m>.<f>``, the path HQ and Nova both write a form at."""
    matched = FORM_FILE.fullmatch(name)
    return f"{matched.group(1)}.{matched.group(2)}" if matched else None


# Expressions, through Core's parser, as the observation read them -----------------------


def function_key(manifest, name, custom):
    """A function an expression calls: Core's own (``jr-fn:``), or one a runtime's function handler answers
    (``jr-handler:``) where Core builds it as a custom runtime function and the surface holds that handler."""
    if custom and f"jr-handler:{name}" in manifest.items:
        return f"jr-handler:{name}"
    return f"jr-fn:{name}"


def session_path_key(manifest, steps):
    """The surface's session-path item for a path through the session instance: the one whose ``*`` steps match
    it with the fewest, else the path itself."""
    path = "/".join(steps)
    if f"session-path:{path}" in manifest.items:
        return f"session-path:{path}"
    matching = []
    for pattern in manifest.family("session-path"):
        parts = pattern.split("/")
        if len(parts) == len(steps) and all(part in ("*", step) for part, step in zip(parts, steps, strict=True)):
            matching.append((parts.count("*"), pattern))
    return f"session-path:{min(matching)[1]}" if matching else f"session-path:{path}"


@dataclass(frozen=True)
class Readings:
    """What HQ and Core made of a document's exports, as ``proof.observe.manifest.readings`` gives them."""

    questions: dict  # the sha256 of a form's bytes -> HQ's reading of its questions
    expressions: dict  # text -> Core's parse
    strings: dict  # a search's _xpath_query -> the strings Core reads it can send
    csql: dict  # a CSQL string -> what HQ's CSQL parser reads in it, or None
    trees: dict  # an expression -> its structure (observe.manifest.expression_tree, structure_tables), or None
    conditions: dict  # a vellum:requiredCondition -> its structure with its hashtags (observe.manifest.hashtag_tree)
    media: dict  # a local archive's media path -> what the file is (proof.observe.manifest.media_facts)

    @classmethod
    def of(cls, value):
        tables = ("questions", "expressions", "strings", "csql", "trees", "conditions", "media")
        missing = [table for table in tables if table not in value]
        if missing:
            raise ObservationMissing(
                f"The records' manifest readings hold no {', '.join(missing)}, which the manifest check reads"
                " (proof/observe/manifest.py::readings); they were made before the observation read it."
            )
        return cls(*(value[table] for table in tables))

    def read(self, table, key, what):
        held = getattr(self, table)
        if key not in held:
            raise ObservationMissing(
                f"The records hold no {table} reading of {what}, which the manifest check reads. The observation"
                " (proof/observe/manifest.py) reads every attribute value, query and form of every export; one it"
                " passed over means its collection and the judge's walk disagree."
            )
        return held[key]


def read_observed(found: Uses, manifest: Manifest, readings: Readings):
    """Every expression collected, as Core's parser read it (functions, session paths, grammar), every CSQL
    string, as HQ's parser read it, and every form's questions, as HQ's reader read them; each added as uses."""
    for document in found.documents:
        document.readings = readings
    # Core's parser accepts dynamic form names. A protected message's recorded expression and technical
    # label prove which group owns these particular names; its generic @form use already exists. Other
    # custom forms, including identical names on an unrelated group, retain their unknown-form use.
    found.uses = [
        use for use in found.uses if not (use.key.startswith("itext-form:*/") and protected_constraint_form(use))
    ]
    # Constraint messages are compiled lazily by Core's Constraint, so the generated parser inventory
    # does not mark the attribute parsedAs:xpath. Read the grammar of only this classified expression
    # from the parse already recorded by the observation; do not broaden ordinary raw messages.
    pending = {(expression.artifact, expression.where) for expression in found.expressions}
    for use in found.uses:
        if use.key != "xform:model/bind@jr:constraintMsg" or not isinstance(use.at, XmlAt):
            continue
        form, bind = use.at.document, use.at.element
        if isinstance(form, Form) and bind in form.protected_constraint_messages:
            if (use.artifact, use.where) not in pending:
                found.expression(
                    use.artifact,
                    use.where,
                    bind.get(f"{{{JAVAROSA}}}constraintMsg"),
                    form.declared_instances,
                    grammar=True,
                    at=use.at,
                )
                pending.add((use.artifact, use.where))
    for expression in found.expressions:
        parsed = readings.read("expressions", expression.text, f"{expression.text!r} ({expression.artifact})")
        _expression_uses(expression, parsed, manifest, found)
    found.expressions = []
    read_csql(found, manifest, readings)
    for artifact, digest, form in found.questions:
        _question_uses(artifact, readings.read("questions", digest, f"the form {artifact}"), found, form)
    found.questions = []


def _expression_uses(expression, parsed, manifest, found):
    artifact, where, at = expression.artifact, expression.where, expression.at
    if "error" in parsed:
        return  # Core refuses it; the bar reports a form or suite Core cannot read
    custom = set(parsed["custom"])
    for name in parsed["functions"]:
        found.add(function_key(manifest, name, name in custom), artifact, where, at)
    found.roots.update(parsed["roots"])
    sources = dict(expression.instances)
    for path in parsed["instancePaths"]:
        src = sources.get(path["instance"])
        steps = path["steps"]
        if src is None or instance_source(manifest, src) != "instance-source:session":
            continue
        named = []
        for step in steps:
            if step is None or step.startswith("@"):
                break
            named.append(step)
        if named:
            found.add(session_path_key(manifest, named), artifact, where, at)
    if expression.grammar:
        for family, names in (
            ("xpath-expr", parsed["expressions"]),
            ("xpath-axis", parsed["axes"]),
            ("xpath-test", parsed["tests"]),
            ("xpath-token", parsed["tokens"]),
        ):
            for name in names:
                found.add(f"{family}:{name}", artifact, where, at)


def read_csql(found: Uses, manifest: Manifest, readings: Readings):
    """Each CSQL string a search's ``_xpath_query`` can send, as HQ's CSQL parser read it, its vocabulary added
    as uses."""
    for artifact, where, text in found.csql:
        strings = readings.read("strings", text, f"the _xpath_query {text!r} ({artifact})")
        if "error" in strings:
            continue  # Core refuses the expression; the bar reports a suite Core cannot read
        read = []
        for query in strings["strings"]:
            reading = readings.read("csql", query, f"the CSQL string {query!r} ({artifact})")
            read.append((csql_keys(reading, manifest), CsqlAt(query, tuple(map(tuple, reading or ())))))
        if read and all(keys is None for keys, _ in read):
            found.add("csql:(unparsed)", artifact, where)
        for keys, at in read:
            for key in keys or ():
                found.add(key, artifact, where, at)
    found.csql = []


def csql_keys(reading, manifest):
    """The CSQL vocabulary of one query string, from what HQ's CSQL parser read in it
    (``proof.observe.manifest.csql_reading``), or None where that parser refused it: each function, operator
    and distance unit, and each step that names case metadata (``comparison.py::property_comparison_query``
    reads a step as metadata where it is one, else as a case property)."""
    if reading is None:
        return None
    metadata = set(manifest.family("csql-metadata"))
    keys = []
    for kind, value, *_ in reading:
        if kind == "step":
            if value in metadata:
                keys.append(f"csql-metadata:{value}")
        elif kind in CSQL_FAMILIES:
            keys.append(f"{CSQL_FAMILIES[kind]}:{value}")
    return keys


# The checks -----------------------------------------------------------------


# A use's standing against the entries naming its key. HELD, BAR and SOURCE are no difference of this check (an
# allowing class holds the use; the bar reports it; the source export carries it and is judged there); each other is
# a difference, whose path names it after the key (an unnamed key's path is the key alone).
HELD, UNNAMED, REFUSED, UNDECIDED, UNHELD = "held", "unnamed", "refused", "undecided", "unheld"
BAR, SOURCE = "bar", "source"
NOT_DIFFERENCES = frozenset({HELD, BAR, SOURCE})


def standing(manifest: Manifest, use: Use):
    """Whether the entries naming a use's key hold it: the standing and the entries it rests on (``UNNAMED``
    where no entry names the key).

    An entry covers the uses of its value class (decision 6). The check
    reads a REFUSED entry's class of a use where a reader for it exists
    (``Manifest.readers``, ``proof.checks.manifest_value_classes``): the use
    is in it, or not, or the export does not say (None, as where no reader
    exists). A REFUSED entry with no value class covers every use of its
    keys. An allowing entry's class is what its row describes, never read:
    the entries naming a key split its values among them, so an allowing
    class is the rest of the key's values, every use no REFUSED class takes.
    A use no class describes therefore passes where an allowing entry names
    its key, so the extraction makes a use of an item only where its reader
    reads the value (an appearance token only on the elements whose
    appearance that token's reader compares, ``_appearance_uses``).

    Where a REFUSED entry refuses depends on its reasons. One refused only
    because HQ's build refuses the state (``Entry.refused_by_hq_build``) is
    the bar's, which reports every export HQ cannot build: a key every entry
    naming it is the bar's, the inventory naming it only by classes HQ's
    build refuses, is ``BAR`` (the bar reports it, and a refusal the bar
    reports is not reported again), and beside other entries such an entry
    is not read. The inventory's rows hold an app's source as HQ holds it,
    while a local archive is Nova's own build of that source, which runtimes
    read and no editor does: there an entry refused for what a runtime does
    with the app (``Entry.judges_builds``) refuses as anywhere, and one
    refused for how HQ's editors or build treat the source refuses nothing,
    a use its class takes being the source's (``SOURCE``: the same choice in
    the app JSON Nova sends is judged there), while a use its class does not
    take is the build's own (what HQ's build adds to the source, which Nova's
    archives carry as HQ's build does: its meta block's setvalues, its own
    model). Then:

    - a use some refusing entry's class takes is ``REFUSED``, resting on
      each such entry;
    - else a use some refusing entry's class may take, its reader not
      saying, is ``UNDECIDED``, resting on each such entry: the check cannot
      tell the use apart from that refused class, which is a gap in the
      check, never a symptom of the export a register entry may hold;
    - else a use an allowing entry names is ``HELD``;
    - else, in a local archive, a use some source-refused entry's class
      takes is ``SOURCE``, and one some such class may take, its reader not
      saying, ``UNDECIDED``;
    - else every entry naming the key rules the use out, each reader having
      placed it outside its class: ``UNHELD``, resting on them all.
    """
    plan = _standing_plan(manifest, use.key, is_build(use.artifact))
    if plan is None:
        return UNNAMED, ()
    if plan.static is not None:
        return plan.static
    verdicts = {}

    def read(place):
        if place not in verdicts:
            verdicts[place] = plan.readers[place](use, manifest)
        return verdicts[place]

    return _evaluate(plan, read)


@cache
def is_build(artifact):
    """Whether an artifact is in a local archive Nova built (``archive_uses`` names each ``<archive>/<entry>``,
    ``local.ccz/suite.xml``), rather than the app JSON Nova's publish sends HQ."""
    return any(part.endswith(".ccz") for part in artifact.split("/"))


@dataclass(frozen=True)
class _Plan:
    """What ``standing`` needs of one key's entries, in a build or not: every entry naming it; the REFUSED
    entries that refuse a use where it is (``refusing``) and, in a build, those whose class is the source's
    (``source``), each with the place of its value class's reader among ``readers`` (None where the check holds
    none); whether an allowing entry names it; and the standing itself where it needs no reader."""

    entries: tuple
    refusing: tuple  # ((Entry, reader's place or None), ...)
    allowed: bool
    source: tuple  # ((Entry, reader's place or None), ...)
    readers: tuple  # (reader, ...)
    static: tuple | None


class _NeedsReader(Exception):
    """The standing of a key's uses depends on what a reader says of each."""


def _no_reader(place):
    raise _NeedsReader


def _verdict(entry, place, read):
    """Whether an entry's class takes the use: True for one with no value class, else its reader's verdict."""
    if entry.value_class is None:
        return True
    return None if place is None else read(place)


def _evaluate(plan, read):
    refused, unread = [], []
    for entry, place in plan.refusing:
        verdict = _verdict(entry, place, read)
        if verdict:
            refused.append(entry)
        elif verdict is None:
            unread.append(entry)
    if refused:
        return REFUSED, tuple(refused)
    if unread:
        return UNDECIDED, tuple(unread)
    if plan.allowed:
        return HELD, ()
    taken, unsure = [], []
    for entry, place in plan.source:
        verdict = _verdict(entry, place, read)
        if verdict:
            taken.append(entry)
        elif verdict is None:
            unsure.append(entry)
    if taken:
        return SOURCE, tuple(taken)
    if unsure:
        return UNDECIDED, tuple(unsure)
    return UNHELD, plan.entries


@cache
def _standing_plan(manifest, key, built):
    """``standing``'s plan for one key, in a build or not, once per key; None where no entry names it."""
    entries = manifest.entries.get(key)
    if entries is None:
        return None
    if all(entry.disposition == "REFUSED" and entry.refused_by_hq_build() for entry in entries):
        return _Plan(entries, (), False, (), (), (BAR, entries))
    refusing, source, readers = [], [], []
    allowed = False
    for entry in entries:
        if entry.disposition != "REFUSED":
            allowed = True
            continue
        if entry.refused_by_hq_build():
            continue  # the bar's, beside entries that are not
        reader = manifest.readers.get(entry.id) if entry.value_class is not None else None
        held = source if built and not entry.judges_builds() else refusing
        held.append((entry, None if reader is None else len(readers)))
        if reader is not None:
            readers.append(reader)
    plan = _Plan(entries, tuple(refusing), allowed, tuple(source), tuple(readers), None)
    try:
        static = _evaluate(plan, _no_reader)
    except _NeedsReader:
        return plan
    return _Plan(entries, plan.refusing, allowed, plan.source, (), static)


@cache
def _path(key, kind, entry=None):
    """A standing's path: ``/<key>``, ``/<key>/refused/<value class>``, ``/<key>/undecided/<value class>`` or
    ``/<key>/unheld`` (a REFUSED entry with no value class refuses as ``/<key>/refused``)."""
    path = f"/{pointer_token(key)}"
    if kind == UNNAMED:
        return path
    path += f"/{kind}"
    if kind in (REFUSED, UNDECIDED) and entry is not None and entry.value_class is not None:
        path += f"/{pointer_token(entry.value_class)}"
    return path


def unclassified(document: str, found: Iterable[Use], manifest: Manifest, *, limit=5):
    """One difference per (artifact, path) for each use the entries do not hold, with where it is used
    (``standing``): a use whose key no inventory entry names is ``/<key>``; one a REFUSED entry's class takes is
    ``/<key>/refused/<value class>``, once per such class, with the part of the class it is where the class
    holds parts apart (``Manifest.variants``: ``/<key>/refused/<value class>/<part>``); one a REFUSED class
    may take, which the check cannot read there, is ``/<key>/undecided/<value class>``, once per such class;
    and one every entry rules out is ``/<key>/unheld``. Each names the entries it rests on. A use the bar
    reports, or one the source export carries (``BAR``, ``SOURCE``), is none.
    """
    by_class = {}
    for use in found:
        kind, entries = standing(manifest, use)
        if kind in NOT_DIFFERENCES:
            continue
        for entry in entries if kind in (REFUSED, UNDECIDED) else (None,):
            path = _path(use.key, kind, entry)
            variant = manifest.variants.get(entry.id) if kind == REFUSED and entry is not None else None
            part = variant(use, manifest) if variant is not None else None
            if part:
                path += f"/{pointer_token(part)}"
            held = by_class.setdefault((use.artifact, path), {"key": use.key, "places": set(), "entries": set()})
            held["places"].add(use.where)
            held["entries"].update((entry,) if entry is not None else entries)
    differences = []
    for (artifact, path), held in sorted(by_class.items()):
        key = held["key"]
        places = sorted(held["places"])
        after = {"key": key, "surfaceItem": key in manifest.items, "uses": len(places), "at": places[:limit]}
        if held["entries"]:
            after["entries"] = [entry.as_json() for entry in sorted(held["entries"])]
        differences.append(Difference("manifest", document, artifact, path, path, "refused", None, after))
    return differences


def flag_key(symbol: str, manifest: Manifest) -> str:
    """A flag HQ read, by the surface item that holds it: a toggle, or a feature preview."""
    for family in ("toggle", "feature-preview"):
        if f"{family}:{symbol}" in manifest.items:
            return f"{family}:{symbol}"
    return f"toggle:{symbol}"


def ungated(document: str, reads: dict, manifest: Manifest):
    """One difference per flag HQ read (``{symbol: [configuration]}``) that no gate entry names."""
    differences = []
    for symbol, configurations in sorted(reads.items()):
        key = flag_key(symbol, manifest)
        if key in manifest.gated:
            continue
        path = f"/{pointer_token(key)}"
        differences.append(
            Difference(
                "manifest",
                document,
                "flags",
                path,
                path,
                "refused",
                None,
                {"key": key, "surfaceItem": key in manifest.items, "configurations": sorted(set(configurations))},
            )
        )
    return differences


def observed_exports(document, records):
    """The manifest's record of the document's exports (``proof.observe.manifest``), from its ``local`` part."""
    observed = ((records.local or {}).get("hooks") or {}).get("manifest")
    if observed is None:
        raise ObservationMissing(
            f"The records of {document.id} hold no manifest observation in their local part, which reads every"
            " export the document sends (proof/observe/manifest.py::observe_local); they were made without it."
        )
    return observed


# The fields of an uploaded app JSON HQ's import reads none of: the create deletes them
# (``models/applications.py::_import_app``: ``del source_doc['build_spec']``, so the new app takes HQ's default
# build) and the update keeps the app's own (``_merge_source_into_app``'s excluded fields).
UNREAD_BY_IMPORT = frozenset({"build_spec"})


def as_imported(upload):
    """An uploaded app JSON as HQ's import reads it: without the fields it never reads (``UNREAD_BY_IMPORT``), so
    what an upload sends there is no use of the app HQ holds."""
    if not isinstance(upload, dict):
        return upload
    return {key: value for key, value in upload.items() if key not in UNREAD_BY_IMPORT}


def export_uses(document, records, manifest: Manifest) -> Uses:
    """Every surface item a corpus document's exports use: D's and D′'s publishes and local archives.

    Each archive is its own artifact (``local.ccz``, ``local-again.ccz``,
    ``edit/local.ccz``); every publish of D (its create and republish under
    each configuration) is ``app.json`` and every publish of D′ is
    ``edit/app.json``, so an app file sent twice with the same bytes is read
    once, and each is read as HQ's import reads it (``as_imported``).
    """
    observed = observed_exports(document, records)
    blobs = records.blobs
    found = Uses()
    expected = {
        *(f"{name}/{step}" for name in document.exports for step in ("create", "republish")),
        *(f"edit/{name}/update" for name in (document.edit.exports if document.edit is not None else ())),
    }
    if set(observed["uploads"]) != expected:
        raise ObservationMissing(
            f"The records of {document.id} hold the publishes {sorted(observed['uploads'])}, and the document"
            f" sends {sorted(expected)}."
        )
    seen = set()
    for key, ref in sorted(observed["uploads"].items()):
        artifact = "edit/app.json" if key.startswith("edit/") else "app.json"
        if (artifact, ref) in seen:
            continue
        seen.add((artifact, ref))
        try:
            app = json.loads(blobs.get(ref))
        except json.JSONDecodeError as error:
            raise ManifestError(f"{document.id}'s {key} app_file is not JSON ({error}).") from error
        app_json_uses(as_imported(app), manifest, artifact, found)
    for artifact, entries in sorted(observed["archives"].items()):
        archive_uses({name: blobs.get(ref) for name, ref in entries.items()}, manifest, artifact, found)
    read_observed(found, manifest, Readings.of(blobs.get_json(observed["readings"])))
    return found


def _built_reads(document, name, part, record, built="state"):
    """The flags one part's record shows HQ reading while it built (``flagsReadByBuild``, which
    ``proof.observe.unit`` counts over HQ's build alone): none where the part built nothing (its ``built``
    entry is absent: a publish HQ refused)."""
    if record is None or record.get(built) is None:
        return ()
    if "flagsReadByBuild" not in record:
        raise ObservationMissing(
            f"The records of {document.id} hold no flagsReadByBuild in {name}/{part}, which the manifest check reads:"
            " the flags HQ read while it built that state (proof/observe/unit.py). They were made before the unit"
            " counted a build's reads apart from its publish's."
        )
    return record["flagsReadByBuild"]


def flag_reads(document, records) -> dict:
    """Every flag HQ read while it built D's and D′'s publishes: ``{symbol: [configuration]}``, D′'s configurations
    as ``edit/<name>``.

    A build's reads are the gates (plan work item 11, decision 8): A's build,
    B's, B aligned to A's and B-edit's, each part's ``flagsReadByBuild``. What HQ reads while it imports or updates
    the app is not a build's read: ``project_db/signals.py::_sync_domain``
    reads ``PROJECT_DB`` from ``ApplicationBase.save``, and
    ``ApplicationMediaMixin.get_media_objects`` reads ``CAUTIOUS_MULTIMEDIA``
    only on the import's ``_update_valid_domains_for_media``.
    """
    reads = {}

    def add(symbols, where):
        for symbol in symbols:
            if where not in reads.setdefault(symbol, []):
                reads[symbol].append(where)

    for name in sorted(document.exports):
        held = records.configurations[name]
        add(_built_reads(document, name, "a", held.a), name)
        add(_built_reads(document, name, "b", held.b), name)
        add(_built_reads(document, name, "b_aligned", held.b_aligned, built="aligned"), name)
    if document.edit is not None:
        for name in sorted(document.edit.exports):
            held = records.configurations[name]
            add(_built_reads(document, name, "a", held.a), f"edit/{name}")
            add(_built_reads(document, name, "b_edit", held.part("b_edit")), f"edit/{name}")
    return reads


def read_notes(document, records):
    """Every soft assertion HQ noted while its readers read the exports, as this check's ``error``."""
    found = []
    for note in observed_exports(document, records).get("softAssertions", []):
        path = f"/{pointer_token(note['where'])}"
        found.append(Difference("manifest", document.id, "soft_assert:readers@local", path, path, "error", None, note))
    return found


def manifest_differences(document, records, manifest: Manifest | None = None):
    """The manifest check on one document: its unclassified uses, its ungated flag reads, and every note HQ made
    in the operations the check holds and while its readers read the exports."""
    manifest = manifest or load_manifest()
    found = export_uses(document, records, manifest)
    return (
        unclassified(document.id, found.uses, manifest)
        + ungated(document.id, flag_reads(document, records), manifest)
        + observations.soft_assertion_differences(records, "manifest")
        + read_notes(document, records)
    )
