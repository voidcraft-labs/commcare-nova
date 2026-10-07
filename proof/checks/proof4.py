"""Proof 4, HQ editability: HQ's own editors open and save Nova's next publish and leave it unchanged.

B is what Nova's next publish of a document leaves in HQ (plan work item 11):
of D again (``B``: Nova's first publish, A, then the republish over it) or
of D′ after the document's edit batch (``B-edit``: A, then the publish of D′
over it), each as the unit observes it (``proof.observe.unit``). Under each
configuration the document is exported under (its minimum and maximum, and
each single-flag configuration a reproduction names: ``Document.exports``),
HQ's editors save over each B (``proof.observe.proof4``, whose record this
module judges):

- **pages**: every app-manager save HQ offers for B's content, made as a
  person makes it without changing a value: app settings, add-ons and UI
  translations; for each module, its settings, its case list (whose save
  carries the module's case search whenever the project searches,
  ``details/bootstrap3/screen.js::serialize``) and its case detail
  (``proof.editors.pages.CASE_DETAIL``); for each form, its settings, its
  case management (basic or advanced by its module's type) and its user
  properties (``pages.USER_PROPERTIES``);
- **Vellum**: every form opened and saved twice, the second time on what the
  first save left (``vellum again``), each open's report whole: what Vellum
  says of the form its own first save wrote shows whether it would say it
  again.

Every page save and every form's first Vellum save is made over B itself, in
a fork of B's state of its own, and judged against B (plan work item 11,
proof 4: "each app-manager page saves over it ... the saved app is built and
traced against B"); a form's second Vellum save is made in the first's fork,
over what the first left, and judged against that state (``State``: its
stored app, its build and its sessions), so it reports only what the second
round trip changes. A change is named by the editor that made it, whatever
the other editors do:

1. the editor's own report (``editor:<editor>``): a page HQ withholds
   (``/offered/<cause>``), a save the page refuses with a dialog and never
   sends (``/save/unsent/<what the dialog says>``), a save HQ's view
   refuses, an alert the save adds to the page, any other dialog the page
   shows (``/dialogs/<type>/<what it says>``), a message HQ's views leave for
   the page, a Save button that does not end "Saved", an error the page's
   JavaScript raises, an HQ view raising on what the editor sent it
   (``/raised/<view>/<class>``); and
   Vellum's load failure, parse errors and warnings, question errors and
   warnings, serialization warnings (which stop its save), pre-save alerts
   and refusals to save (``vellum_report``, ``page_report``);
2. the stored app: HQ's app document (``app.json@<editor>``), compared as
   JSON without what every save of it rewrites
   (``proof.observe.proof4.BOOKKEEPING``), and each form's stored XForm
   (``source:form:<m>.<f>@<editor>``), parsed by lxml and compared as a tree,
   with whitespace-only text read as none, as HQ's build reads it
   (``xform.py::XForm.render`` indents every form it builds); every other
   attachment by its content (``attachment:<name>@<editor>``). An attribute
   Core's parser reads, in a stored or a built form, is compared as Core
   reads it (``proof.observe.proof4.xpath_reading``): as XPath on the element
   it is on (``XPATH_ATTRIBUTES`` and ``ITEMSET_PATHS``: a bind's node set
   and conditions, a control's ``ref``, an itemset's ``nodeset`` and its
   value's ``ref``...), or as ``ItemSetParsingUtils.setLabel`` reads an
   itemset label's ``ref`` (``ITEMSET_LABEL``: an itext when it opens with
   ``jr:itext(`` and ends with ``)``, then a path). Two spellings Core reads
   alike (``xpathSame``, recorded by the observation) are one value, any
   other two are two values, never compared by pattern over the text (plan
   work item 4). Every other attribute is compared as written: a question's
   or item's label, hint, help or alert ``ref`` names an itext by its exact
   spelling;
3. the saved app's build, wherever the save changed what HQ stores at all:
   the spelling rules and Core's readings decide which stored differences
   step 2 reports, never whether the build is compared, since HQ's build
   reads the form's text too (``xform.py::XForm.add_missing_instances``
   finds the instances a form reads by a pattern that wants ``instance(``,
   ``suite_xml/post_process/instances.py::instance_re``, so an
   ``instance ('ledgerdb')`` that Core reads as ``instance('ledgerdb')``
   loses its declaration). The build is made with the build HQ keeps of the
   state the save was made over as HQ's previous build (saved(build(B)), or
   the first Vellum save's own build kept), so HQ's own ``set_form_versions``
   decides each form's version, and is compared with that state's build as
   proof 2 compares ``build(A)`` with ``build(B)`` (``compare_builds``):
   ``validate_app@<editor>``, ``build@<editor>`` and every built file as
   ``<artifact>@<editor>``;
4. where the build still differs, both builds run as proof 3 runs two HQ
   builds (``proof.checks.proof3``). Sessions run only on builds a runtime
   installs (``proof.observe.runs.unbuildable``: HQ releases and serves Web
   Apps only a build whose ``validate_app()`` lists no error), and only over
   a restore HQ can serve the document's tables in, and only on a saved
   build Core admits; otherwise the comparison is ``refused``
   ``trace@<editor>`` differences, each naming its cause in its path as
   proof 3 names it (``/unbuildable/...``, ``/lookups-not-served/<why>``,
   ``/not_admitted/...``), and none where the cause is reported already: B's
   build unbuildable or not admitted, and a lookup upload HQ answered as
   failed, are the bar's, the first Vellum save's build is that save's own
   to report. Core admits
   the saved build (``admission@<editor>``, each problem the admission of the
   state's build did not have), the scripted sessions derived on build(B)
   replay on it over the document's case data (``proof.checks.casedata``),
   and the traces (``trace@<editor>``, ``proof3.compare_traces``) and HQ's
   case processing of every submission (``case_blocks@<editor>``,
   ``proof3.compare_case_processing``) are compared. A submission's
   ``version`` is its form's version, which HQ's ``set_form_versions`` gives
   anew to a form whose content changed: the version clause of proof 2 holds
   there too (``trace_versions``). HQ's case processing runs with HQ's soft
   assertions as production runs them (``proof.hq.boot``), and every note HQ
   makes in proof 4's operations and requests is this check's difference
   (``observations.soft_assertion_differences``): a save's case processing is
   an operation named for its editor
   (``soft_assert:proof4-case-processing@<editor>@<B>``,
   ``proof.observe.proof4.processing_label``), B's own sessions' is
   ``soft_assert:proof4-case-processing@<B>``. So a change is seen as a build
   failure, a build difference, or a behavior difference.

Every difference's artifact ends with the B it was seen over and the
configuration (``@<B or B-edit>@<configuration>``, ``Over``), so a register
entry names the configuration a symptom needs (``*`` for any). The spelling
rules (``proof.rules``) apply to each artifact by its base name
(``app.json``, ``form:<m>.<f>`` for a form, stored or built, ``trace``,
``case_blocks``), before the editor is added to the reported artifact.
Positions are B's: module ``m`` and form ``f`` as HQ's build numbers them
(``modules-<m>/forms-<f>.xml``).

Every message an editor reports is keyed by what it says (``message_key``):
its text with the app's names written ``*`` (each path or hashtag it names
written as the place in Nova's and CommCare's structure it refers to,
``reference_kind``; what a pair of quotes holds; a question's own id), and
its concrete text in ``at``. Vellum's question messages are keyed by Vellum's
message key and that text, and a logic warning once for each unknown
reference it names, by what the reference refers to.

This module reads records only: it imports neither HQ nor Django
(``test_judge_purity``).
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, replace
from pathlib import PurePosixPath

from lxml import etree

from proof.checks import observations, proof3
from proof.checks.bar import admission_differences, error_path, problem_value, refusal_differences
from proof.checks.compare import names
from proof.checks.compare.build_files import compare_parsed_builds
from proof.checks.compare.json_tree import compare_json
from proof.checks.compare.trace import generated_labels
from proof.checks.compare.versions import CONTENT_VERSION, apply_version_clause
from proof.checks.compare.xml_tree import XmlNotWellFormed, compare_xml_trees, parse_xml
from proof.checks.differences import Difference, pointer_token
from proof.checks.proof2 import parsed_build
from proof.checks.proof5 import DATA_MAPS, _language_maps
from proof.observe.proof4 import (
    OFFERED,
    SKIPPED,
    VELLUM,
    VELLUM_AGAIN,
    WITHHELD,
    apply_patch,
    outcome_from_delta,
    xpath_reading,
)
from proof.observe.runs import unbuildable
from proof.rules import normalized, rules_for

CHECK = "proof4"
# The two Bs: Nova's next publish of D, and its publish of D′ after the edit batch.
REPUBLISH = "B"
EDIT = "B-edit"

# The levels of Vellum's question messages that report a problem
# (``mugs.js``: ``ERROR``, ``WARNING``); ``INFO`` messages tell a person
# something about a question that is not wrong, and are kept in the evidence.
VELLUM_PROBLEM_LEVELS = frozenset({"error", "warning"})

XFORMS = "http://www.w3.org/2002/xforms"


class RecordIncomplete(AssertionError):
    """The record holds less than the judge reads: the observation and the judge disagree on what to run."""


class Offer:
    """Whether a page offers a save without a change: offered, skipped (nothing to save), or withheld by HQ."""

    OFFERED = OFFERED
    SKIPPED = SKIPPED
    WITHHELD = WITHHELD


# Positions and names --------------------------------------------------------------


@dataclass(frozen=True)
class Scope:
    """Where an editor saves: the app, one module, or one form, by B's positions."""

    module: int | None = None
    form: int | None = None

    @property
    def path(self):
        if self.module is None:
            return ""
        return "/modules/*" if self.form is None else "/modules/*/forms/*"

    @property
    def at(self):
        if self.module is None:
            return ""
        return f"/modules/{self.module}" if self.form is None else f"/modules/{self.module}/forms/{self.form}"

    @property
    def name(self):
        if self.module is None:
            return "app"
        return f"module {self.module}" if self.form is None else f"form {self.module}.{self.form}"


@dataclass(frozen=True)
class Over:
    """Which B the editors save over (``REPUBLISH`` or ``EDIT``), under which configuration (its name)."""

    state: str
    configuration: str

    def named(self, difference):
        """The difference with the B and the configuration added to its artifact."""
        return replace(difference, artifact=f"{difference.artifact}@{self.state}@{self.configuration}")


def _report(document, editor, scope, path, at, kind, before, after):
    return Difference(
        CHECK, document, f"editor:{editor}", f"{scope.path}{path}", f"{scope.at}{at}", kind, before, after
    )


def _json(value):
    return json.loads(json.dumps(value, default=str))


def _named(differences, editor):
    """The differences with the editor added to each artifact (``<artifact>@<editor>``) and the check proof 4's."""
    return [replace(difference, check=CHECK, artifact=f"{difference.artifact}@{editor}") for difference in differences]


# Attributes as Core reads them ------------------------------------------------------------------


def xpath_readings(answers):
    """Core's reading of each recorded spelling pair (``xpathSame``): ``{(reading, a, b): same}``."""
    return {(reading, a, b): bool(result["same"]) for reading, a, b, result in answers or []}


def _form_artifact(artifact):
    base = artifact.split("@", 1)[0]
    return base.startswith("source:form:") or base.rsplit("/", 1)[-1].startswith("form:")


def without_same_xpath(differences, readings):
    """The differences but each attribute of a form Core reads (``xpath_reading``) whose two spellings Core reads
    alike."""
    kept = []
    for difference in differences:
        reading = None
        if difference.kind == "changed" and _form_artifact(difference.artifact):
            reading = xpath_reading(difference.path)
        if reading is None or not readings.get((reading, difference.before, difference.after)):
            kept.append(difference)
    return kept


# The stored app -------------------------------------------------------------


@dataclass(frozen=True)
class Stored:
    """What HQ stores for the app: its document without the save's bookkeeping, and its attachments."""

    doc: dict
    langs: frozenset
    # Each form's source by its position (m, f).
    sources: dict
    # Every attachment that is no form's source, by its name, as the record holds its content: ``{"text"}`` for
    # UTF-8 and ``{"base64"}`` for any other bytes (``proof.observe.proof4.stored_app``).
    attachments: dict


def _shown_attachment(held):
    """An attachment's content as a difference shows it: its text, or how many bytes it holds."""
    if held is None:
        return None
    if "text" in held:
        return held["text"]
    import base64

    return f"{len(base64.b64decode(held['base64']))} bytes"


def stored_from(value) -> Stored:
    """The stored app a record holds (``proof.observe.proof4.stored_app``'s JSON)."""
    sources = {}
    for position, source in value["sources"].items():
        m, f = position.split(".")
        sources[(int(m), int(f))] = source
    return Stored(
        doc=value["doc"],
        langs=frozenset(value["langs"]),
        sources=sources,
        attachments=dict(value["attachments"]),
    )


def _app_json_maps(before, after):
    maps = set(DATA_MAPS)
    for stored in (before, after):
        _language_maps(stored.doc, "", stored.langs, maps)
    return frozenset(maps)


def _source_root(source, artifact):
    """A stored form's source parsed and normalized by the rules registered for its form artifact."""
    root = parse_xml(source)
    for normalize in rules_for(artifact):
        root = normalize(root)
    return root


def stored_differences(before: Stored, after: Stored, *, document, editor, readings=None):
    """Every difference the save made to what HQ stores, after the spelling rules, each attribute Core reads
    compared as Core reads it."""
    found = compare_json(
        normalized("app.json", before.doc),
        normalized("app.json", after.doc),
        check=CHECK,
        document=document,
        artifact="app.json",
        data_maps=_app_json_maps(before, after),
    )
    for m, f in sorted(set(before.sources) | set(after.sources)):
        artifact = f"form:{m}.{f}"
        source_artifact = f"source:{artifact}"
        a, b = before.sources.get((m, f)), after.sources.get((m, f))
        if a is None or b is None:
            kind = "added" if a is None else "removed"
            found.append(Difference(CHECK, document, source_artifact, "/", "/", kind, a, b))
            continue
        if a == b:
            continue
        try:
            root_a, root_b = _source_root(a, artifact), _source_root(b, artifact)
        except XmlNotWellFormed as error:
            found.append(Difference(CHECK, document, source_artifact, "/", "/", "refused", None, str(error)))
            continue
        found += compare_xml_trees(root_a, root_b, check=CHECK, document=document, artifact=source_artifact)
    # Compared by content; shown as text, or as a length for bytes that are not text.
    for name in sorted(set(before.attachments) | set(after.attachments)):
        a, b = before.attachments.get(name), after.attachments.get(name)
        if a != b:
            kind = "added" if a is None else "removed" if b is None else "changed"
            shown_a, shown_b = _shown_attachment(a), _shown_attachment(b)
            found.append(Difference(CHECK, document, f"attachment:{name}", "/", "/", kind, shown_a, shown_b))
    return _named(without_same_xpath(found, readings or {}), editor)


# The build -------------------------------------------------------------------


def _keyed_changes(check, document, artifact, before, after):
    """Two ``{(structural path, concrete path): [value, ...]}`` compared at each path: a value only one side holds
    is ``removed`` or ``added`` there, and the values both sides hold at it, paired in their canonical order, are
    ``changed`` where they differ."""
    found = []
    for path, at in sorted(set(before) | set(after)):
        values_a = sorted(before.get((path, at), []), key=lambda value: json.dumps(value, sort_keys=True))
        values_b = sorted(after.get((path, at), []), key=lambda value: json.dumps(value, sort_keys=True))
        kept_a = [value for value in values_a if value not in values_b]
        kept_b = [value for value in values_b if value not in values_a]
        for value_a, value_b in zip(kept_a, kept_b, strict=False):
            found.append(Difference(check, document, artifact, path, at, "changed", value_a, value_b))
        for value_a in kept_a[len(kept_b) :]:
            found.append(Difference(check, document, artifact, path, at, "removed", value_a, None))
        for value_b in kept_b[len(kept_a) :]:
            found.append(Difference(check, document, artifact, path, at, "added", None, value_b))
    return found


def _validation_errors(errors):
    """``validate_app``'s errors keyed as the bar paths them (``bar.error_path``: the module and form as far as an
    error names them, then its type)."""
    keyed = {}
    for error in errors or []:
        keyed.setdefault(error_path(error), []).append(error)
    return keyed


def _build_raises(raised):
    """What each build step raised, keyed by the step and the exception's class (``/<step>/<class>``), as proof 3
    names a build that raised (``proof3.unbuildable_refusals``)."""
    keyed = {}
    for step, value in sorted((raised or {}).items()):
        path = f"/{pointer_token(step)}/{pointer_token((value or {}).get('class', '?'))}"
        keyed.setdefault((path, path), []).append(value)
    return keyed


def compare_builds(before, after, *, check, document):
    """Two builds of one app compared as proof 2 compares ``build(A)`` and ``build(B)``.

    Each build's ``validate_app()`` errors, each where the bar names it
    (``bar.error_path``: ``/modules/*/forms/*/<error type>``), and what each
    build step raised, by the step and the exception's class
    (``/create_all_files/<class>``), so a later error of another type or
    another exception is a difference of its own; then every file both builds
    wrote (``proof2.parsed_build``), after the spelling rules, with the
    version clause deciding which versions may differ. A build that wrote
    nothing (``create_all_files()`` raised) has no files to compare; what it
    raised is the difference.
    """
    found = _keyed_changes(
        check,
        document,
        "validate_app",
        _validation_errors(normalized("validate_app", before.errors)),
        _validation_errors(normalized("validate_app", after.errors)),
    )
    found += _keyed_changes(
        check,
        document,
        "build",
        _build_raises(normalized("build", before.raised)),
        _build_raises(normalized("build", after.raised)),
    )
    if before.files is None or after.files is None:
        return found
    parsed_a, parsed_b = apply_version_clause(
        parsed_build(before),
        parsed_build(after),
        app_version_before=before.app_version,
        app_version_after=after.app_version,
    )
    return found + compare_parsed_builds(parsed_a, parsed_b, check=check, document=document)


def build_differences(before, after, *, document, editor, readings=None):
    """The saved app's build against build(B), as proof 2 compares two builds, each attribute Core reads compared
    as Core reads it."""
    found = compare_builds(before, after, check=CHECK, document=document)
    return _named(without_same_xpath(found, readings or {}), editor)


def admission_changes(before, after, *, document, editor):
    """Each problem Core's admission of the saved build reports that its admission of build(B) did not."""
    known = {json.dumps(problem_value(problem), sort_keys=True) for problem in (before or {}).get("problems", [])}
    found = []
    for difference in admission_differences(document, editor, after):
        if difference.after is not None and json.dumps(difference.after, sort_keys=True) in known:
            continue
        found.append(replace(difference, check=CHECK))
    return found


# The version clause over traces -----------------------------------------------------


def _children(element, namespace, name):
    return [child for child in element if isinstance(child.tag, str) and child.tag == f"{{{namespace}}}{name}"]


def _data_node(form_root):
    """An XForm's data node: the first element of its model's first instance."""
    for head in form_root:
        if not isinstance(head.tag, str) or etree.QName(head).localname != "head":
            continue
        for model in _children(head, XFORMS, "model"):
            for instance in _children(model, XFORMS, "instance"):
                return next((child for child in instance if isinstance(child.tag, str)), None)
    return None


def _built_forms(outcome):
    """Each form a build wrote (``modules-<m>/forms-<f>.xml``) as (xmlns, version, data node without version)."""
    found = {}
    for path, content in (outcome.files or {}).items():
        if not PurePosixPath(path).match("modules-*/forms-*.xml"):
            continue
        root = parse_xml(content)
        data = _data_node(root)
        if data is None:
            continue
        version = data.get("version")
        if version is not None:
            del data.attrib["version"]
        found[path] = (etree.QName(data).namespace, version, root)
    return found


def content_versions(before, after):
    """The forms whose built content differs between two builds, each side's ``{xmlns: version}``.

    The content is the form file with its data node's ``version`` aside, as
    proof 2's version clause reads it (``proof.checks.compare.versions``):
    HQ's ``set_form_versions`` keeps a form's version only where its content
    hashes the same as the previous build's.
    """
    forms_a, forms_b = _built_forms(before), _built_forms(after)
    changed_a, changed_b = {}, {}
    for path in sorted(set(forms_a) & set(forms_b)):
        (xmlns_a, version_a, root_a), (xmlns_b, version_b, root_b) = forms_a[path], forms_b[path]
        if compare_xml_trees(root_a, root_b, check=CHECK, document="-", artifact="-"):
            changed_a[xmlns_a] = version_a
            changed_b[xmlns_b] = version_b
    return changed_a, changed_b


def _submission_version(text, changed):
    try:
        root = parse_xml(text)
    except XmlNotWellFormed:
        return text
    namespace = etree.QName(root).namespace
    if namespace in changed and root.get("version") == changed[namespace]:
        root.set("version", CONTENT_VERSION)
        return etree.tostring(root, encoding="unicode")
    return text


def trace_versions(trace, changed):
    """A copy of a trace whose submissions of a form in ``changed`` read their version as ``CONTENT_VERSION``.

    ``changed`` is one side of ``content_versions``: a submission's root (the
    form's data node, as Core serializes it) carries the form's version, so
    where the form's content differs between the builds its version may
    differ, and is read as the same value on both sides; anywhere else it is
    compared as it is.
    """
    shown = copy.deepcopy(trace)
    for run in shown.get("runs") or []:
        for step in run.get("trace") or []:
            if isinstance(step, dict) and isinstance(step.get("submission"), str):
                step["submission"] = _submission_version(step["submission"], changed)
    return shown


# What an editor's message says ------------------------------------------------------------------

# HQ's case hashtags (``app_schemas/casedb_schema.py::_get_case_schema_subsets``, ``generation_names``): ``#case/``
# (or ``#registry_case/``) then the ancestor generations by name, then a property, the app's.
CASE_HASHTAGS = frozenset({"#case", "#registry_case"})
CASE_GENERATIONS = frozenset({"parent", "grandparent"})
# The characters a name in a message is made of, for telling where one stands whole.
NAME_CHARACTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.")


def reference_kind(reference, data_root=None):
    """A reference a message names, as its class writes it: what it refers to, the app's names written ``*``.

    A path in the form's data (absolute under its data node ``data_root``,
    or Vellum's ``#form/`` hashtag for one, which Vellum reads as that
    node's path, ``xpath.js``) is written as the comparisons write a data
    path (``compare.names.data_path``: CommCare's, Vellum's and Nova's names
    kept, each run of the app's names one ``*``); HQ's case hashtags keep
    ``#case/`` and the ancestor generations (``CASE_GENERATIONS``) and write
    the property ``*``; any other hashtag keeps its namespace (``#user/*``).
    Anything else is kept as it is.
    """
    root = None if data_root is None else names.split_tag(data_root.tag)[1]
    if reference.startswith("#"):
        namespace, _, rest = reference.partition("/")
        if namespace == "#form" and root is not None:
            return names.data_path(f"/{root}/{rest}", data_root)
        if namespace in CASE_HASHTAGS:
            kept = [step for step in rest.split("/")[:-1] if step in CASE_GENERATIONS]
            return "/".join([namespace, *kept, names.APP])
        return f"{namespace}/{names.APP}" if rest else reference
    if root is not None and (reference == f"/{root}" or reference.startswith((f"/{root}/", f"/{root}["))):
        return names.data_path(reference, data_root)
    return reference


def _reference_end(text, start):
    """Where a reference that starts at ``start`` ends: at the first character no path holds, outside a
    predicate."""
    depth, index = 0, start
    while index < len(text):
        character = text[index]
        if character == "[":
            depth += 1
        elif character == "]":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and character not in NAME_CHARACTERS and character not in "/@:#*":
            break
        index += 1
    return index


def _reference_at(text, index, root):
    """The reference starting at ``index`` (a hashtag, or a path under the form's data node, named ``root``), or
    None."""
    if index > 0 and (text[index - 1] in NAME_CHARACTERS or text[index - 1] in "/#@"):
        return None
    if text[index] == "#":
        namespace_end = index + 1
        while namespace_end < len(text) and text[namespace_end] in NAME_CHARACTERS:
            namespace_end += 1
        if namespace_end == index + 1 or namespace_end >= len(text) or text[namespace_end] != "/":
            return None
        return text[index : _reference_end(text, index)]
    if root is not None and text.startswith(f"/{root}", index):
        after = index + len(root) + 1
        if after == len(text) or text[after] not in NAME_CHARACTERS:
            return text[index : _reference_end(text, index)]
    return None


def _quoted(text):
    """The text with what each pair of quotes holds written ``*``: HQ and Vellum quote the names they write into
    a message (``'{nodeID}'``, ``"{caseProperty}"``, HQ's ``'{}'``). A quote opens where no name character comes
    before it and closes where none comes after it, so an apostrophe inside a word is no quote."""
    found, index = [], 0
    while index < len(text):
        character = text[index]
        if character in "'\"" and (index == 0 or text[index - 1] not in NAME_CHARACTERS):
            close = index + 1
            while close < len(text):
                if text[close] == character and (close + 1 == len(text) or text[close + 1] not in NAME_CHARACTERS):
                    break
                close += 1
            if close < len(text) and close > index + 1:
                found.append(f"{character}{names.APP}{character}")
                index = close + 1
                continue
        found.append(character)
        index += 1
    return "".join(found)


def _own_name(text, name, kind):
    """The text with ``name`` (a question's own id) written ``kind`` where it opens the text whole: the one place
    Vellum writes an id unquoted (``mugs/baseSpecs.js``, ``"{nodeID} is not a valid Question ID. ..."``)."""
    if text.startswith(name) and (len(text) == len(name) or text[len(name)] not in NAME_CHARACTERS):
        return kind + text[len(name) :]
    return text


def message_key(text, *, data_root=None, question=None):
    """What an editor's message says, as its class: the message with the app's names written ``*``.

    Each reference it names (a hashtag, or a path under the form's data node
    ``data_root``) is written as what it refers to (``reference_kind``),
    what a pair of quotes holds is written ``*`` (``_quoted``), and the
    question the message is on (its path, ``question``) has its own id
    written as the comparisons write that node (``compare.names.data_path``)
    where the id opens the message (``_own_name``): Vellum writes a
    question's id into two messages (``mugs/baseSpecs.js``), quoted in one
    (``'{nodeID}'``) and opening the other, so the same word elsewhere in a
    message is the message's own. Runs of white space are one space.
    """
    root = None if data_root is None else names.split_tag(data_root.tag)[1]
    own = None
    if question and root is not None and question.startswith(f"/{root}/"):
        shown = reference_kind(question, data_root)
        # A path the comparisons write whole as ``*`` (a step no XML name) is the app's to its last step.
        own = (question.rsplit("/", 1)[-1], shown.rsplit("/", 1)[-1] if shown != names.APP else names.APP)
    found, plain, index = [], [], 0

    def flush():
        if plain:
            segment = _quoted("".join(plain))
            if own is not None and own[0] and own[0] != own[1] and not found:
                segment = _own_name(segment, *own)
            found.append(segment)
            plain.clear()

    while index < len(text):
        reference = _reference_at(text, index, root) if text[index] in "#/" else None
        if reference:
            flush()
            found.append(reference_kind(reference, data_root))
            index += len(reference)
            continue
        plain.append(text[index])
        index += 1
    flush()
    return " ".join("".join(found).split())


def data_root(source):
    """A form's data node (the first element of its model's first instance), or None where it has none."""
    try:
        return _data_node(parse_xml(source or ""))
    except XmlNotWellFormed:
        return None


# What an editor reports ------------------------------------------------------

UNKNOWN_QUESTION = "Unknown question: "
UNKNOWN_QUESTIONS = "Unknown questions:\n- "


def unknown_references(message):
    """The references a Vellum logic warning names (``logic.js::_addReferences``: ``"Unknown question: "`` and
    one, or ``"Unknown questions:"`` and each on a line of its own after ``"- "``), or None for any other
    message."""
    if message.startswith(UNKNOWN_QUESTION):
        return [message[len(UNKNOWN_QUESTION) :]]
    if message.startswith(UNKNOWN_QUESTIONS):
        return message[len(UNKNOWN_QUESTIONS) :].split("\n- ")
    return None


def broken_report(broken, *, document, editor, scope):
    """A broken run as differences: one per failed request, by HQ's view and what it raised."""
    return [
        _report(
            document,
            editor,
            scope,
            f"/raised/{pointer_token(failed['view'])}/{pointer_token(failed['raised'])}",
            f"/raised/{pointer_token(failed['view'])}/{pointer_token(failed['raised'])}",
            "error",
            None,
            _json(failed),
        )
        for failed in broken["failed"]
    ]


def _body_json(body):
    """A save's answer as HQ's page reads it for its refusal: the JSON object, or nothing."""
    try:
        value = json.loads(body or "null")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _raised_in(report):
    """The section's requests an HQ view raised on (a 500 the page saw), as a broken run lists them."""
    failed = [exchange for exchange in report["exchanges"] if exchange["error"] and not exchange["refusal"]]
    if not failed:
        return None
    return {
        "kind": "broken",
        "failed": [
            {
                "method": exchange["method"],
                "view": exchange["urlName"],
                "status": exchange["status"],
                "raised": exchange["raised"],
                "traceback": exchange["error"],
            }
            for exchange in failed
        ],
    }


def _said(path, text, **key):
    """A message's (structural, concrete) path steps: keyed by what it says (``message_key``), and by its text."""
    return (f"{path}/{pointer_token(message_key(text, **key))}", f"{path}/{pointer_token(text)}")


def thrown_message(text):
    """An uncaught exception's message without its stack: the lines of the text the browser reports
    (``driver.mjs::thrownText``, V8's ``Error.stack``: the message, then a line ``    at …`` for each frame) up to
    its first frame. The frames name the editor bundle's lines, which another bundle moves."""
    lines = str(text).split("\n")
    for index, line in enumerate(lines):
        if index and line.lstrip().startswith("at "):
            return "\n".join(lines[:index])
    return str(text)


def _page_error(text, **key):
    """A page error's (structural, concrete) path steps: keyed by its message alone (``thrown_message``), with the
    whole text, stack included, where it is."""
    return (
        f"/page_errors/{pointer_token(message_key(thrown_message(text), **key))}",
        f"/page_errors/{pointer_token(str(text))}",
    )


def _refusal_text(save, response):
    """What HQ's answer to a refused save says: its JSON's message, or the answer's text where it is no JSON
    (``HttpResponseBadRequest(str(error))``, as ``views/modules.py::edit_module_detail_screens`` answers a case
    search it cannot read)."""
    for key in ("message", "error", "errors"):
        if response.get(key):
            return json.dumps(response[key], sort_keys=True) if not isinstance(response[key], str) else response[key]
    if response:
        return json.dumps(response, sort_keys=True)
    return save.get("body") or ""


def page_report(report, *, document, scope, editor):
    """What a page save reports beside what it stored: the page's refusal or HQ's, alerts, dialogs, messages, its
    end state, page errors.

    Each is keyed by what it says (``message_key``): a save the page answered
    with a dialog and never sent by what the dialog says
    (``/save/unsent/<message>``; its Save button left as it was, which is
    that refusal and no other), a refused save by HQ's status and the
    answer's message (``/save/<status>/<message>``), an alert by its text,
    any other dialog by its type and text (``/dialogs/<type>/<message>``), a
    page error by its message without its stack (``thrown_message``), a
    message by the HQ view that left it and its text, and a Save button that
    did not end "Saved" by the state it ended in. HQ's views leave messages for the page
    (``django.contrib.messages``: the page view's ``get_form_view_context``
    reports a form it cannot validate or a case configuration it cannot
    read, a save view the reason it changed nothing); the page shows them
    when it loads, so they are reported from every request the page made. A
    section whose page saw an HQ view raise (a 500) is reported as broken,
    by each request that raised, as a page that failed is.
    """
    if report["kind"] == "broken":
        return broken_report(report, document=document, editor=editor, scope=scope)
    raised = _raised_in(report)
    if raised is not None:
        return broken_report(raised, document=document, editor=editor, scope=scope)
    found = []
    save = report["save"]
    unsent = report.get("unsent")
    dialogs = list(report.get("dialogs") or [])
    if unsent is not None:
        path, at = _said("/save/unsent", unsent["message"])
        found.append(_report(document, editor, scope, path, at, "refused", None, unsent))
        # The dialog is the refusal's cause, reported in its path.
        if unsent in dialogs:
            dialogs.remove(unsent)
    else:
        response = _body_json(save["body"])
        if save["status"] >= 400 or response.get("success") is False:
            path, at = _said(f"/save/{save['status']}", _refusal_text(save, response))
            refusal = {"status": save["status"], "response": _json(response), "messages": save["messages"]}
            if not response:
                refusal["body"] = save["body"]
            found.append(_report(document, editor, scope, path, at, "refused", None, refusal))
    for alert in report["alerts"]:
        path, at = _said("/alerts", alert)
        found.append(_report(document, editor, scope, path, at, "error", None, alert))
    for dialog in dialogs:
        path, at = _said(f"/dialogs/{pointer_token(dialog['type'])}", dialog["message"])
        found.append(_report(document, editor, scope, path, at, "error", None, dialog))
    for exchange in report["exchanges"]:
        view = pointer_token(exchange["urlName"] or "-")
        for message in exchange["messages"]:
            path, at = _said(f"/messages/{view}", message)
            found.append(_report(document, editor, scope, path, at, "error", None, message))
    if unsent is None and report["barState"] != "savebtn-bar-saved":
        state = f"/state/{pointer_token(report['barState'])}"
        found.append(_report(document, editor, scope, state, state, "error", None, report["barState"]))
    for error in report["pageErrors"]:
        path, at = _page_error(error)
        found.append(_report(document, editor, scope, path, at, "error", None, error))
    return found


def form_error_key(message, data):
    """A Vellum form error's class: its text as ``message_key`` writes it, the form's paths by what they refer to.

    Vellum's parse errors and warnings carry no key of their own
    (``parser.js``: ``form.updateError({level, message})``); their text is a
    fixed sentence, or one naming a bind's or a node's path (``"Bind Node
    [{path}] found but has no associated Data node…"``, ``"Ambiguous bind: "``
    and a node set), which ``message_key`` writes as the place in Nova's
    structure it names (``reference_kind``: a guard block's case id, a
    Save to Case attachment, a repeat's ``@count``...), so one sentence over
    one kind of node is one class on any form.
    """
    return message_key(message, data_root=data)


def _answer(body):
    try:
        value = json.loads(body or "null")
    except ValueError:
        return {"body": body}
    return value if isinstance(value, dict) else {"body": value}


def vellum_report(report, *, document, editor, scope):
    """What Vellum reports opening and saving a form: everything that is not a clean open and save.

    Each is keyed by what it says (``message_key``, the form's data node
    read from the source Vellum opened): its load failure by the failure's
    text (``/load/<text>``); a form error by its level and text
    (``form_error_key``); a question's message by its attribute, Vellum's
    message key and its text, with the question's own id written as its
    step is (``/questions/*/<attribute>/<key>/<text>``), and a logic
    warning once for each unknown reference it names, by what that refers
    to (``/questions/*/<attribute>/logic-bad-path-warning/<reference>``,
    ``reference_kind``); a serialization warning likewise; a pre-save alert
    by its text, and a page error by its message without its stack
    (``thrown_message``); Vellum's refusal to save by its reason; a
    save HQ refused by HQ's view and the answer's status; and a run that did
    not end on a saved form by its Save button's state and each modal's
    text. Vellum's flag for broken references is not read (the driver does
    not record it, ``driver/steps/vellum/record.js``): it is
    ``logic.js::hasBrokenReferences`` over the same unknown references the
    questions' logic warnings name, each of which is reported.
    """
    if report["kind"] == "broken":
        return broken_report(report, document=document, editor=editor, scope=scope)
    outputs = report["outputs"]
    record, saved, after = outputs["record"], outputs["save"], outputs["after"]
    found = []
    data = data_root(report["source"])

    def add(path, at, kind, value):
        found.append(_report(document, editor, scope, path, at, kind, None, _json(value)))

    def said(path, text, value, kind="error", **key):
        add(*_said(path, text, data_root=data, **key), kind, value)

    if not record["loaded"]:
        said("/load", str(record.get("loadError") or ""), record.get("loadError"), kind="refused")
    for error in record.get("formErrors", []):
        level = pointer_token(error.get("level", "error"))
        message = str(error.get("message"))
        add(
            f"/form_errors/{level}/{pointer_token(form_error_key(message, data))}",
            f"/form_errors/{level}/{pointer_token(message)}",
            "error",
            message,
        )
    for question in record.get("questions", []):
        for message in question["messages"]:
            if message["level"] not in VELLUM_PROBLEM_LEVELS:
                continue
            step = f"{pointer_token(message['attribute'])}/{pointer_token(message['key'])}"
            value = {"level": message["level"], "message": message["message"], "type": question["type"]}
            where = f"/questions/{pointer_token(question['path'])}/{step}"
            references = unknown_references(message["message"])
            if references is not None:
                for reference in references:
                    add(
                        f"/questions/*/{step}/{pointer_token(reference_kind(reference, data))}",
                        f"{where}/{pointer_token(reference)}",
                        "error",
                        {**value, "reference": reference},
                    )
                continue
            text = message_key(message["message"], data_root=data, question=question["path"])
            add(f"/questions/*/{step}/{pointer_token(text)}", where, "error", value)
    for warning in record.get("serializationWarnings", []):
        key = pointer_token(warning.get("key") or "-")
        text = message_key(str(warning.get("message") or ""), data_root=data, question=warning.get("path"))
        add(
            f"/serialization_warnings/*/{key}/{pointer_token(text)}",
            f"/serialization_warnings/{pointer_token(warning.get('path') or '-')}/{key}",
            "error",
            warning,
        )
    for alert in record.get("preSaveAlerts", []):
        said("/pre_save_alerts", str(alert), alert)
    if record["loaded"] and not saved["saved"]:
        reason = str(saved.get("reason") or "")
        add(f"/save/{pointer_token(reason)}", f"/save/{pointer_token(reason)}", "refused", saved.get("reason"))
    for save in report["saves"]:
        answer = _answer(save["body"])
        if save["status"] >= 400 or answer.get("status") not in (None, "ok"):
            cause = f"/save/{pointer_token(save['urlName'])}/{save['status']}/{pointer_token(answer.get('status'))}"
            add(cause, cause, "refused", {"status": save["status"], "response": answer})
    # The run waited for Vellum's save to be over (its Save button "Saved", no request of its own in flight,
    # proof.editors.vellum); a button left elsewhere, or a modal, is Vellum refusing or failing the save.
    if saved["saved"]:
        if after["saveButton"] != "saved":
            state = f"/state/{pointer_token(after['saveButton'])}"
            add(state, state, "error", {"save_button": after["saveButton"], "modals": after["modals"]})
        for modal in after["modals"]:
            said("/state/modals", str(modal), modal)
    for error in outputs["pageErrors"]:
        add(*_page_error(error, data_root=data), "error", error)
    return found


# One B ---------------------------------------------------------------------------------


def withheld_cause(reason):
    """Why HQ withheld a page, as its path names it: the user case HQ does not allow, or the form's errors HQ's page
    found (``proof.observe.proof4.case_management_decided``, ``user_properties_decided``)."""
    reason = reason if isinstance(reason, dict) else {}
    if "allow_usercase" in reason:
        return "allow_usercase"
    return "+".join(key for key in ("form_errors", "xform_validation_errored") if reason.get(key)) or "-"


@dataclass(frozen=True)
class State:
    """A state a save was made over, as the record holds it: B, or what a form's first Vellum save left.

    ``stored_json`` and ``stored`` are its stored app (as the record's JSON
    and read, ``stored_from``), ``build`` its build, and ``sessions`` the
    record of its sessions: B's baseline, or the first save's trace where
    its raw build differed from B's (else B's stand for it).
    """

    stored_json: dict
    stored: Stored
    build: object
    sessions: dict
    # What Formplayer and the Web Apps client made of the state once served (``proof.observe.served``): its
    # Formplayer side record and the client's screens; a save's where it was served, else those of the state it
    # was made over, which stand for it. None where the state was not served.
    served: dict | None = None


class _Judged:
    """One B's record judged: its differences, named by the B and configuration, and its saves."""

    def __init__(self, document, record, blobs, over, b_build, lookup_upload=None):
        self.document = document
        # What HQ answered B's lookup workbook upload (``observations``' ``lookup_uploads``), which the bar reports.
        self.lookup_upload = lookup_upload
        self.record = record
        self.blobs = blobs
        self.over = over
        self.b_build = b_build
        stored_json = blobs.get_json(record["stored"])
        self.baseline = record["baseline"]
        served = record.get("served") or {}
        self.b = State(
            stored_json, stored_from(stored_json), b_build, self.baseline, served if served.get("served") else None
        )
        self.differences = []
        self.saves = []

    def _blob(self, ref):
        return None if ref is None else self.blobs.get_json(ref)

    def save_entry(self, over, editor, scope, target, offer=OFFERED, reason=None):
        entry = {
            "state": self.over.state,
            "configuration": self.over.configuration,
            "over": over,
            "editor": editor,
            "scope": scope.name,
            "target": target,
            "offer": offer,
            "reason": _json(reason),
            "stored_changed": False,
            "built": False,
            "ran": False,
            "differences": 0,
        }
        self.saves.append(entry)
        return entry

    def skip(self, over, editor, scope, target, offer, reason):
        self.save_entry(over, editor, scope, target, offer, reason)
        if offer == WITHHELD:
            path = f"/offered/{pointer_token(withheld_cause(reason))}"
            self.differences.append(
                self.over.named(_report(self.document, editor, scope, path, path, "refused", None, _json(reason)))
            )

    def judge_save(self, over, editor, scope, target, entry, reported, base):
        """One save's differences against ``base``, the state it was made over: what the editor reported
        (``reported``), then what it stored, built and ran; returns the state the save left.

        The build is compared wherever the save changed what HQ stores
        (``entry["stored"]``, the record's raw patch, which the observation
        built), whatever the spelling rules and Core's readings leave of that
        change: they say which stored differences to report, and HQ's build
        is a reader of its own (``stored_changed`` is what was reported).
        """
        save = self.save_entry(over, editor, scope, target)
        found = list(reported)
        left = base
        if entry["stored"] is not None:
            readings = xpath_readings(self._blob(entry.get("xpath")))
            stored_json = apply_patch(base.stored_json, self._blob(entry["stored"]))
            after = stored_from(stored_json)
            stored = stored_differences(base.stored, after, document=self.document, editor=editor, readings=readings)
            save["stored_changed"] = bool(stored)
            found += stored
            built = outcome_from_delta(entry["build"], base.build, self.blobs, f"B after {editor} ({scope.name})")
            differences = build_differences(base.build, built, document=self.document, editor=editor, readings=readings)
            save["built"] = True
            found += differences
            if differences:
                behavior, save["ran"] = self.behavior_differences(editor, base, built, entry.get("trace"))
                found += behavior
            trace = entry.get("trace")
            served = entry.get("served")
            if served is not None and "refused" in served:
                # HQ releases no build of the saved app, so a worker is never served it: by what HQ raised.
                cause = f"/release-refused/{pointer_token(served['refused'])}"
                found += _named(
                    [Difference(CHECK, self.document, "release", cause, cause, "refused", None, served)], editor
                )
                served = None
            elif served is not None and base.served is not None:
                found += self.served_differences(editor, base.served, served, content_versions(base.build, built))
            left = State(
                stored_json,
                after,
                built,
                base.sessions if trace is None else trace,
                base.served if served is None or base.served is None else {**base.served, **served},
            )
        save["differences"] = len(found)
        self.differences.extend(self.over.named(difference) for difference in found)
        return left

    def served_differences(self, editor, base, served, versions=None):
        """What Formplayer and the Web Apps client make of the saved app against the state it was saved over
        (``proof.checks.served``): Formplayer's sessions (``formplayer@<editor>``), the client's screens
        where the observation showed them (``webapps@<editor>``: it shows them wherever Formplayer's answers or
        what HQ's page hands the client differ, and the same answers and page show the same screens), and a
        release whose archive is not the build compared above (``release@<editor>``)."""
        from proof.checks import served as compare

        found = compare.formplayer_differences(
            self._blob(base["formplayer"]["trace"]),
            self._blob(served["formplayer"]["trace"]),
            check=CHECK,
            document=self.document,
            artifact="formplayer",
            versions=versions,
        )
        if served.get("webapps") is not None and base.get("webapps") is not None:
            found += compare.webapps_differences(
                self._blob(base["webapps"]),
                self._blob(served["webapps"]),
                check=CHECK,
                document=self.document,
                artifact="webapps",
            )
        if served.get("releaseDiffers"):
            cause = "/release-differs"
            found.append(
                Difference(CHECK, self.document, "release", cause, cause, "refused", None, served["releaseDiffers"])
            )
        return _named(found, editor)

    def behavior_differences(self, editor, base, built, trace):
        """The saved build run as proof 3 runs two HQ builds, against the build of the state it was made over
        (``base``); and whether both ran sessions.

        No sessions run where either build is one HQ releases no app from, nor
        over a restore HQ refuses, nor on a saved build Core does not admit;
        the comparison is then refused, each cause in its path as proof 3
        names it (``proof3.unbuildable_refusals``: ``/unbuildable/...``;
        ``proof3.lookup_refusal``: ``/lookups-not-served/<why>``;
        ``proof3.admission_refusals``: ``/not_admitted/...``), except where the
        cause is reported already: B's build unbuildable or not admitted, and
        a lookup upload HQ answered as failed, are the bar's
        (``validate_app@<B>``, ``<step>@<B>``, ``admission@<B>``,
        ``lookups@<B>``), and the first Vellum save's build unbuildable or not
        admitted is that save's own (its ``validate_app``, ``build`` and
        ``admission`` differences, and its own refusal).
        """
        artifact = f"trace@{editor}"
        if unbuildable(base.build) is not None:
            return [], False
        if unbuildable(built) is not None:
            refused = proof3.unbuildable_refusals(self.document, artifact, built)
            return [replace(d, check=CHECK) for d in refused], False
        if "restore" in self.baseline:
            refused = proof3.lookup_refusal(self.document, artifact, self.baseline["restore"], self.lookup_upload)
            return [replace(d, check=CHECK) for d in refused], False
        if trace is None or "admission" not in trace:
            raise RecordIncomplete(
                f"{self.document}'s proof 4 record holds no sessions of the build {editor} saved over"
                f" {self.over.state} under {self.over.configuration}, though the judge finds the build differs"
                " from the build of the state it was saved over after the spelling rules and both builds are ones"
                " HQ releases. The observation (proof.observe.proof4) runs them wherever the raw builds differ,"
                " which the rules only narrow."
            )
        found = admission_changes(
            base.sessions.get("admission"), trace["admission"], document=self.document, editor=editor
        )
        if base.sessions.get("trace") is None:
            return [replace(difference, check=CHECK) for difference in found], False
        if trace.get("trace") is None:
            found += proof3.admission_refusals(self.document, artifact, trace["admission"])
            return [replace(difference, check=CHECK) for difference in found], False
        versions_before, versions_after = content_versions(base.build, built)
        traces = (
            trace_versions(self._blob(base.sessions["trace"]), versions_before),
            trace_versions(self._blob(trace["trace"]), versions_after),
        )
        labels = generated_labels(*traces)
        found += proof3.compare_traces(self.document, artifact, *traces, runtimes=proof3.RUNTIMES["B"], labels=labels)
        found += proof3.compare_case_processing(
            self.document,
            f"case_blocks@{editor}",
            self._blob(base.sessions["processed"]),
            self._blob(trace["processed"]),
            labels=labels,
        )
        return [replace(difference, check=CHECK) for difference in found], True

    def judge(self):
        for view in self.record["views"]:
            scope = Scope(*view["scope"])
            sections = {entry["section"]: entry for entry in view["sections"]}
            for offer in view["offers"]:
                editor = offer["section"]
                if offer["offer"] != OFFERED:
                    self.skip("pages", editor, scope, view["target"], offer["offer"], offer["reason"])
                    continue
                entry = sections[editor]
                reported = page_report(self._blob(entry["report"]), document=self.document, scope=scope, editor=editor)
                self.judge_save("pages", editor, scope, view["target"], entry, reported, self.b)
        for form in self.record["vellum"]:
            scope = Scope(*form["scope"])
            if form["offer"] != OFFERED:
                self.skip("vellum", VELLUM, scope, form["target"], form["offer"], form["reason"])
                continue
            # The first save over B, the second over what the first left; each open reports all Vellum said of
            # the form it opened, B's or the first save's.
            base = self.b
            for editor, entry in zip((VELLUM, VELLUM_AGAIN), form["runs"], strict=False):
                reported = vellum_report(
                    self._blob(entry["report"]), document=self.document, editor=editor, scope=scope
                )
                base = self.judge_save("vellum", editor, scope, form["target"], entry, reported, base)
            if "again" in form:
                again = form["again"]
                self.skip("vellum", VELLUM_AGAIN, scope, form["target"], again["offer"], again["reason"])
        return self


def judge_b(document, record, blobs, over: Over, b_build, lookup_upload=None):
    """Proof 4's differences and saves over one B (``record``: its ``proof4`` record; ``b_build``: build(B);
    ``lookup_upload``: what HQ answered B's lookup workbook upload, None where Nova's publish sent none)."""
    judged = _Judged(document, record, blobs, over, b_build, lookup_upload).judge()
    return judged.differences, judged.saves


# A document ---------------------------------------------------------------------------


def edit_refusals(document, records, name, record):
    """Each request HQ's own views refused while Formplayer walked B-edit that they did not refuse while it
    walked A (``formplayer``, ``served.refusal_differences``): what the edit's publish made HQ refuse a
    worker. A's own are proof 3's."""
    from proof.checks import served as compare

    held = record.get("served") or {}
    if not held.get("served"):
        return []
    a = ((records.configurations[name].a or {}).get("hooks") or {}).get("served") or {}
    known = {
        (entry.get("view"), entry.get("status"), entry.get("raised"))
        for entry in ((a.get("A") or {}).get("formplayer") or {}).get("hq") or []
    }
    new = [
        entry
        for entry in held["formplayer"]["hq"]
        if (entry.get("view"), entry.get("status"), entry.get("raised")) not in known
    ]
    return compare.refusal_differences(new, check=CHECK, document=document, artifact="formplayer")


def _bs(document):
    """Each B proof 4 saves over, in the order the document's exports name their configurations."""
    for name in document.exports:
        yield name, REPUBLISH, "b"
        if document.edit is not None and name in document.edit.exports:
            yield name, EDIT, "b_edit"


def document_editability(document, records):
    """Proof 4's differences and saves over every B of a document, judged from its records.

    A B HQ refused (its publish, or A's before it) is that refusal, as this
    check's difference: there is no B to edit.
    """
    found, saves = [], []
    for name, state, part in _bs(document):
        over = Over(state, name)
        view = observations.republish_view(records, name) if part == "b" else observations.edit_view(records, name)
        if view.b is None:
            found += [over.named(d) for d in refusal_differences(document.id, view.refusals, check=CHECK)]
            continue
        record = (records.configurations[name].part(part) or {}).get("proof4")
        if record is None:
            raise RecordIncomplete(
                f"{document.id}'s {part} record under {name} holds no proof 4 observation though HQ holds"
                f" {state}. The unit calls proof.observe.proof4.observe_b at every B it builds; look for a path"
                " through proof.observe.unit._Unit.observe_b that returns before it."
            )
        b_build = replace(view.b.build, state=REPUBLISH)
        differences, judged = judge_b(document.id, record, records.blobs, over, b_build, view.lookup_uploads.get(state))
        found += differences
        saves += judged
        if state == EDIT:
            found += [over.named(d) for d in edit_refusals(document.id, records, name, record)]
    return found + observations.soft_assertion_differences(records, CHECK), saves
