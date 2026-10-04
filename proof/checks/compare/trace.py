"""Two Core runner traces compared as JSON, with the XML documents they carry compared as XML.

A trace (``proof.core.client.CoreRunner.session``) is JSON: each run's
script and the trace of what Core showed and did at each step. Two traces of
the same script are compared position by position with JSON Pointer paths
(``/runs/*/trace/*/…``), after the spelling rules the caller gives for the
``trace`` artifact (``compare.spelling``), so a step that differs, or that only
one build could take, is its own difference. A case list's rows are the one
collection keyed otherwise: their order where they stand, and each row's
fields and sort keys by the case it selects (``rows_by_case``), as Core keys
an entity.

Some step fields hold an XML document the runner serialized
(``XML_FIELDS``: a form's submission and the case database after it). Each
is taken out of the JSON and compared as a parsed tree
(``compare.xml_tree``, whitespace exact: the runner serialized both), its
differences rooted at the field's pointer: a submission named as the form's
data (``compare.names``: the app's question, group and repeat ids ``*``, a
case block's parts and the metadata kept), the case database as Core's (each
case keyed by its ``@case_id``). A document only one side holds is compared
whole as JSON, and one that does not parse is refused at
``<field>/not-well-formed``. ``xmlns`` maps the other trace's form
namespaces to the baseline's, in its values and in the namespaces of its XML
documents (proof 1 judges identity, so a moved namespace is not a behavior).

Every id the runtime generated is marked by the runner as
``@generated:uuid:<n>``, numbered in the order the runner first met it
(``proof/core/src/nova/proof/core/Generated.java``), so one id more early in
a run renumbers every later one. Before the comparison each mark is named
instead by the first place both runs hold one (``generated_labels``:
``@generated:trace/<step>/<pointer>``, into an XML field by the element
path), so an id keeps its name on both sides wherever the other ids are
drawn, and two ids keep two names. HQ's case processing of the same run
holds the same marks, and is named the same way (``relabel_generated``).
How many ids a run generated (``generated.uuids``) is not compared: every
one is marked wherever it occurs, so a count that differs always comes with
the difference where one side holds an id the other does not
(``uncounted``).

A run's ``end`` names how the runner left it (``SessionOp.java``,
``FormRun.java``: ``submitted``, ``form-error``, ``submission-refused``...),
the runner's own vocabulary, so a changed end is reported at
``/runs/*/end/<before>/<after>``: a run that no longer submits and one that
now errs are two classes.

A step that stopped short names its cause in its path (``stops_by_cause``).
Core's refusal of the step's submission (``processing``, the exception
Core's submission processing raised, ``FormRun.java::submit``) and an
exception Core raised running the step (``error``, ``FormRun.java::run``,
``SessionOp.java``) are named by the exception's class and where it was
constructed (``exception_cause``: the first frame of its stack outside the
Java platform and the exception's own classes, the line that holds its
message's template where that frame makes the message, and one line for
every message a helper or a rewrap carries where it takes the message from
its caller), never by the message, which holds the app's values; where Core's
case parser refused a case block missing an attribute it requires, by that
attribute, the block's first action and where the block sits, written as
proof 3 writes the block HQ refused
(``/runs/*/trace/*/processing/<class>/case_id/update/__nova_operations~1__nova_guard_*~1case``).
A failure the runner records as text, which carries no exception, is named
by the end it leaves its run with (``failure_cause``). The runner records a
stop in place of what the step would have held past it and ends the run
with it, so where only one side stopped, what it left out that the other
side holds is compared under the stop's path
(``.../processing/<cause>/caseDb``, ``.../error/<cause>/events/*``,
``_left_out``), and the run's changed end carries the cause after its
transition: each cause of a step that stopped short is its own class.

Objects whose keys are the app's data are written ``*`` in a structural path
(``TRACE_DATA_MAPS``). A search's query parameters (``params``, on its step
and on each request the step made, and the prompt answers the script gave
it, ``PROMPTED_PARAMS``) hold CommCare's own keys (``case_type``,
``_xpath_query``, every key a suite ``<data>`` names) beside the keys of the
search's prompts, which are the app's case properties: only a key the step's
own prompts name is the app's data (``prompt_keys_as_data``), so a lost
``case_type`` and a lost prompt are two classes.
"""

from __future__ import annotations

import re
from dataclasses import replace
from typing import NamedTuple

from proof.checks.compare.json_tree import compare_json
from proof.checks.compare.names import element_block_path, split_tag
from proof.checks.compare.spelling import normalized
from proof.checks.compare.xml_tree import NOT_WELL_FORMED, XmlNotWellFormed, compare_xml_trees, parse_xml
from proof.checks.differences import Difference, pointer_token

# Fields of a trace step that hold an XML document the runner serialized, each with how its names are read
# (``compare.xml_tree.NAMINGS``): a submission as the form's data, the case database by its root.
XML_FIELDS = {"submission": "data", "caseDb": "auto"}
# A generated id's mark as the runner writes it (``proof.observe.runs.GENERATED_PREFIX`` and its number).
GENERATED_PREFIX = "@generated:uuid:"
GENERATED_MARK = re.compile(r"@generated:uuid:[0-9]+")
GENERATED_LABEL = "@generated:"
# The count of the ids the runtime generated in a run, which the runner keeps beside them (``Generated.java::mark``).
GENERATED_COUNT = "uuids"
# Objects in a trace whose keys are all the app's data: a search's prompt
# errors, keyed by its prompts.
TRACE_DATA_MAPS = frozenset({"/runs/*/trace/*/promptErrors"})
# Where a search step holds maps keyed by query parameter, as the tokens of a
# concrete pointer after ``/runs/<run>/trace/<step>`` (None for any position):
# its query parameters, each request's, and the prompt answers the script gave
# it. A key there is the app's data only where the step's own prompts name it
# (``prompt_keys_as_data``).
PROMPTED_PARAMS = (("params",), ("requests", None, "params"), ("chosen", "search"))
# The step fields the runner records why a step stopped short in: ``processing``, Core's refusal of a form's
# submission (``FormRun.java::submit``), and ``error``, a failure running the step (``FormRun.java::run`` and
# ``submit``, ``SessionOp.java``). Either ends the run, with an end that names where it came.
REFUSAL = "processing"
ERROR = "error"
STOPS = (REFUSAL, ERROR)
# A form step records its screen and xmlns, its title once the form opened, its events one by one as Core steps
# through it, then ``unansweredRequired`` where a required question has no value or else its submission, Core's
# processing of it, the case database and the stack after submit (``FormRun.java::run``, ``walk``, ``submit``).
# A stop on a form leaves out the fields past where it came, which the end it leaves its run with names: the form
# was not installed or did not open (nothing from its title on), Core raised filling it in (no event past the last
# it recorded, nothing after the events), serializing it, processing it (``submission-refused``), or reading the
# case database after it and finishing its session (``end-of-form-navigation-failed``: one try block reads the case
# database, then finishes the session and records the stack after submit, so the stop leaves out the stack after
# submit and, where it came before the case database was read, that too). ``_left_out`` moves only a field the
# stopping step does not hold, so a case database it holds is compared as itself.
FORM_SCREEN = "form"
FORM_LEFT_OUT = {
    "form-missing": ("title", "events", "unansweredRequired", "submission", "caseDb", "stackAfterSubmit"),
    "form-did-not-open": ("title", "events", "unansweredRequired", "submission", "caseDb", "stackAfterSubmit"),
    "form-error": ("events", "unansweredRequired", "submission", "caseDb", "stackAfterSubmit"),
    "submission-not-serialized": ("submission", "caseDb", "stackAfterSubmit"),
    "submission-refused": ("caseDb", "stackAfterSubmit"),
    "end-of-form-navigation-failed": ("caseDb", "stackAfterSubmit"),
}
# A form's field whose items the runner records one by one (``FormRun.java::walk``: an event once Core stepped
# to it and, for a question, the runner answered it), so a stop leaves out the items past the last it holds.
FORM_STOPPED_LISTS = frozenset({"events"})
# Core's refusal of a case block missing an attribute its case parser requires: the exception, and the attributes
# in the order the parser checks them (commcare-core ``xml/CaseXmlParser.java::parse``, ``validateMandatoryProperty``
# of ``case_id`` and then ``date_modified``, ``xml/CaseXmlParserUtil.java``).
INVALID_STRUCTURE = "org.javarosa.xml.util.InvalidStructureException"
MANDATORY_ATTRIBUTES = ("case_id", "date_modified")
# The namespace whose elements Core's submission processing hands its ledger parser
# (``core/process/XmlFormRecordProcessor.java::process``, ``LedgerXmlParsers.STOCK_XML_NAMESPACE``).
LEDGER_XMLNS = "http://commcarehq.org/ledger/v1"


def map_strings(value, mapping):
    """``value`` with every string equal to a key of ``mapping`` replaced by its mapped value."""
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [map_strings(item, mapping) for item in value]
    if isinstance(value, dict):
        return {key: map_strings(item, mapping) for key, item in value.items()}
    return value


def renamespace(root, mapping):
    """The parsed document with every element in a mapped namespace moved to its counterpart."""
    from lxml import etree

    for element in root.iter():
        if isinstance(element.tag, str):
            name = etree.QName(element)
            if name.namespace in mapping:
                element.tag = etree.QName(mapping[name.namespace], name.localname).text
    return root


def _pull_xml(value, pointer, structural, found):
    """``value`` with each runner-serialized XML document taken out into ``found`` by its JSON Pointer."""
    if isinstance(value, dict):
        kept = {}
        for key, item in value.items():
            token = pointer_token(key)
            if key in XML_FIELDS and isinstance(item, str):
                found[f"{pointer}/{token}"] = (f"{structural}/{token}", item, XML_FIELDS[key])
                kept[key] = "<xml>"
            else:
                kept[key] = _pull_xml(item, f"{pointer}/{token}", f"{structural}/{token}", found)
        return kept
    if isinstance(value, list):
        return [_pull_xml(item, f"{pointer}/{index}", f"{structural}/*", found) for index, item in enumerate(value)]
    return value


def _restore_pointer(value, pointer, text):
    """Put a pulled document back where only one side holds it, so it is reported whole."""
    tokens = [token.replace("~1", "/").replace("~0", "~") for token in pointer.split("/")[1:]]
    holder = value
    for token in tokens[:-1]:
        holder = holder[int(token)] if isinstance(holder, list) else holder[token]
    holder[tokens[-1]] = text


def _prefixed(difference, structural, concrete):
    path = structural if difference.path == "/" else f"{structural}{difference.path}"
    at = concrete if difference.at == "/" else f"{concrete}{difference.at}"
    return replace(difference, path=path, at=at)


def _xml_root(text, *, check, artifact, document, structural, concrete, side, found):
    try:
        return parse_xml(text)
    except XmlNotWellFormed as error:
        found.append(
            Difference(
                check,
                document,
                artifact,
                f"{structural}{NOT_WELL_FORMED}",
                f"{concrete}{NOT_WELL_FORMED}",
                "refused",
                str(error) if side == "before" else None,
                str(error) if side == "after" else None,
            )
        )
        return None


def _step(trace, run, step):
    try:
        found = trace["runs"][run]["trace"][step]
    except (IndexError, KeyError, TypeError):
        return {}
    return found if isinstance(found, dict) else {}


def _prompt_keys(trace, run, step):
    return {prompt.get("key") for prompt in _step(trace, run, step).get("prompts") or [] if isinstance(prompt, dict)}


def prompt_keys_as_data(differences, before, after):
    """The differences with each query parameter key a search step's own prompts name written ``*`` in ``path``.

    ``before`` and ``after`` are the two compared traces; a key is the app's
    data where either side's step names it as a prompt. Every other key (the
    query's own vocabulary) stays in the path.
    """
    found = []
    for difference in differences:
        at = difference.at.split("/")
        path = difference.path.split("/")
        if len(at) > 6 and at[1:2] == ["runs"] and at[3:4] == ["trace"] and len(path) == len(at):
            for shape in PROMPTED_PARAMS:
                position = 5 + len(shape)
                tokens = at[5:position]
                if len(at) > position and all(
                    want is None or want == got for want, got in zip(shape, tokens, strict=True)
                ):
                    key = at[position].replace("~1", "/").replace("~0", "~")
                    run, step = int(at[2]), int(at[4])
                    if key in _prompt_keys(before, run, step) | _prompt_keys(after, run, step):
                        path[position] = "*"
                        difference = replace(difference, path="/".join(path))
                    break
        found.append(difference)
    return found


# Where a step stopped short: Core's refusal of a submission, an exception Core raised ------------------------


def transaction_blocks(element):
    """Each element below ``element`` that Core's submission processing hands a parser, in its order:
    ``(kind, element)``, ``ledger`` or ``case``.

    Core reads a submission with a deep pull parser (commcare-core
    ``core/process/XmlFormRecordProcessor.java::process``,
    ``data/xml/DataModelPullParser.java::parseBlock``): every element below
    the root in document order, an element in the ledger namespace handed
    to the ledger parser and one named ``case`` in any namespace (any
    letter case) to the case parser, each whole, and every other element
    read into. It stops at the first that raises (``failfast``).
    """
    for child in element:
        if not isinstance(child.tag, str):
            continue
        namespace, local = split_tag(child.tag)
        if namespace == LEDGER_XMLNS:
            yield "ledger", child
        elif local.lower() == "case":
            yield "case", child
        else:
            yield from transaction_blocks(child)


def _attribute(element, name):
    """An attribute as Core's pull parser reads it with no namespace: the first named ``name`` in any namespace."""
    for key, value in element.attrib.items():
        if split_tag(key)[1] == name:
            return value
    return None


def refused_block(root, failure):
    """The case block Core refused for an attribute its case parser requires, ``(attribute, element)``, where
    ``failure`` (the step's ``processing``) is that refusal; else None.

    The block is the first case block in Core's order (``transaction_blocks``)
    missing a required attribute (``MANDATORY_ATTRIBUTES``, empty or absent),
    and ``failure`` is its refusal only where it carries the message Core
    makes of it (``CaseXmlParserUtil.validateMandatoryProperty``: ``The
    <attribute> attribute of a <case> <the case's id, empty for its own>
    wasn't set``, then the parser's position): a block Core read earlier may
    have raised for another cause, which names no block here.
    """
    for kind, block in transaction_blocks(root):
        if kind != "case":
            continue
        case_id = _attribute(block, "case_id")
        if not case_id:
            attribute, named = "case_id", ""
        elif not _attribute(block, "date_modified"):
            attribute, named = "date_modified", case_id
        else:
            continue
        expected = f"The {attribute} attribute of a <case> {named} wasn't set. Source: <"
        if failure.get("class") == INVALID_STRUCTURE and str(failure.get("message")).startswith(expected):
            return attribute, block
        return None
    return None


def exception_cause(failure):
    """An exception Core raised, as the runner records it (``FormRun.java::failure``: its ``class``,
    ``message`` and ``site``), as a path names it: ``/<class>/<site>``.

    The site is where the exception was constructed, as its class, method,
    file and line: the first frame of its stack that is neither the Java
    platform's nor in the exception's own class or a superclass of it
    (``FormRun.java::site``), in Core's code, the runner's, or a library on
    Core's classpath. Where that frame makes the message from a template of
    its own, one template is one cause whatever values its message carries,
    and two templates of one exception class are two causes, even in one
    method (``FunctionUtils.toDate`` makes three); a static factory of the
    exception's own class that takes its message from its caller
    (``InvalidStructureException.readableInvalidStructureException``) is
    passed over for that caller. Where the frame takes its message from its
    caller in any other way, every message it carries is one cause: a
    helper that builds the exception from the text it is given (kxml2's
    ``KXmlParser.exception``), a rewrap of another exception's message
    (``new XPathException(e.getMessage())``, in
    ``XPathClosestPointOnPolygonFunc`` and others), and a Core
    ``WrappedException``, named by the line that wraps, which holds what it
    wrapped only in its message (it sets no cause). The message is no part
    of the path: Core
    writes the app's values into it (a reference, an instance name, an
    answer, an index). An exception whose stack holds no such frame
    (``site`` null) is named by its class alone.
    """
    cause = f"/{pointer_token(str(failure.get('class')))}"
    site = failure.get("site")
    return cause if site is None else f"{cause}/{pointer_token(str(site))}"


# A case block's actions in the order HQ applies a block at its first (``casexml/apps/case/const.py::CASE_ACTIONS``).
BLOCK_ACTIONS = ("create", "update", "index", "close", "attachment")


def block_action(block):
    """The first action a case block holds, in ``BLOCK_ACTIONS``' order (``update`` for one that holds none, a
    no-op HQ reads as an update): ``create`` for a block that opens a case, ``update`` for one that writes an
    existing case."""
    held = {split_tag(child.tag)[1] for child in block if isinstance(child.tag, str)}
    return next((action for action in BLOCK_ACTIONS if action in held), "update")


def refusal_cause(step):
    """Core's refusal of a step's submission as a path names it after ``/processing``: ``(path, at)``.

    A case block missing an attribute Core's case parser requires
    (``refused_block``) is named by the exception's class, that attribute,
    the block's first action (``block_action``) and where the block sits
    (``compare.names.element_block_path``, one JSON Pointer token, as proof 3
    names the block HQ refused): an empty case id in a guard's block is
    ``/<class>/case_id/update/__nova_operations~1__nova_guard_*~1case``. Any
    other refusal is named by its exception (``exception_cause``).
    """
    failure = step.get(REFUSAL)
    if not isinstance(failure, dict):
        return "", ""
    submission = step.get("submission")
    if isinstance(submission, str):
        try:
            root = parse_xml(submission)
        except XmlNotWellFormed:
            root = None
        refused = refused_block(root, failure) if root is not None else None
        if refused is not None:
            attribute, block = refused
            cause = f"/{pointer_token(str(failure.get('class')))}/{attribute}/{block_action(block)}"
            written, concrete = element_block_path(block)
            return f"{cause}/{pointer_token(written)}", f"{cause}/{pointer_token(concrete)}"
    cause = exception_cause(failure)
    return cause, cause


def failure_cause(failure, end):
    """A step's ``error`` as a path names it after ``/error``: ``(path, at, whether the run's end carries it)``.

    An exception Core raised running the step (``FormRun.java::run`` and
    ``submit``, ``SessionOp.java``) is named by ``exception_cause``, and its
    run's changed end carries it after its transition. A failure the runner
    records as text carries no exception: the runner's own statement that
    Core has no form with the step's xmlns (``FormRun.java::run``), or
    Core's text for a search response it could not read
    (``SessionOp.java::search``: commcare-core
    ``RemoteQuerySessionManager.buildExternalDataInstance`` keeps only the
    message of the exception it caught). Each ends its run with an end of its
    own (``form-missing``, ``search-failed``), which names it: ``/<end>``,
    and its run's changed end names it already.
    """
    if isinstance(failure, dict) and "class" in failure:
        cause = exception_cause(failure)
        return cause, cause, True
    cause = f"/{pointer_token(str(end))}"
    return cause, cause, False


class Stop(NamedTuple):
    """A step that stopped short: its cause as a path names it after the stop's field (``path``, and ``at``
    with its concrete names), what the field holds, and whether its run's changed end carries the cause."""

    path: str
    at: str
    value: object
    on_end: bool


def stop_cause(field, step, end):
    """Why a step stopped short as its path names it after ``/<field>`` (``STOPS``; ``end`` is its run's):
    ``(path, at, whether the run's end carries it)``."""
    if field == REFUSAL:
        return (*refusal_cause(step), True)
    return failure_cause(step.get(field), end)


def _run_end(trace, run):
    try:
        found = trace["runs"][run]
    except (IndexError, KeyError, TypeError):
        return None
    return found.get("end") if isinstance(found, dict) else None


def _stops(trace):
    """Each step that stopped short, ``{field: {(run, step): Stop}}`` (``STOPS``, ``stop_cause``)."""
    found = {field: {} for field in STOPS}
    for run_index, run in enumerate((trace or {}).get("runs") or []):
        steps = run.get("trace") if isinstance(run, dict) else None
        for step_index, step in enumerate(steps if isinstance(steps, list) else []):
            if not isinstance(step, dict):
                continue
            for field in STOPS:
                if field in step:
                    path, at, on_end = stop_cause(field, step, run.get("end"))
                    found[field][(run_index, step_index)] = Stop(path, at, step[field], on_end)
    return found


def _left_out(step, other, end, tokens):
    """Whether a stop left out of ``step`` (the stopping side's step, ``end`` its run's end) what a difference's
    concrete tokens after the step name, where ``other`` is the other side's step at the same place.

    - A step that holds nothing but its screen and its stop is one the stop
      came before the runner recorded anything of: the runner names its
      screen by where the session stood (``SessionOp.java::errorStep``'s
      ``session`` where Core could not say what the session needs next; in
      the catch around a screen, the screen Core asked for, or ``form``). All
      that differs in it is the stop's: each field of the other step, its
      screen's change too.
    - A form step beside a form step leaves out the fields its stop came
      before (``FORM_LEFT_OUT``, by the end its run left with), and of its
      events those past the last it holds (``FORM_STOPPED_LISTS``).
    - Any other step beside a step of the same screen leaves out each field it
      does not hold: the runner puts a screen's fields one after another,
      each whole (``SessionOp.java``), so a field missing is one the stop
      came before.
    - Beside a step of another screen it leaves out nothing: the two are
      different screens, whatever the stop.
    """
    if not set(step) - {"screen", *STOPS}:
        return True
    screen = step.get("screen")
    if screen != other.get("screen"):
        return False
    name = tokens[0].replace("~1", "/").replace("~0", "~")
    if name not in step:
        return screen != FORM_SCREEN or name in FORM_LEFT_OUT.get(end, ())
    held = step[name]
    if screen == FORM_SCREEN and name in FORM_STOPPED_LISTS and name in FORM_LEFT_OUT.get(end, ()):
        return isinstance(held, list) and len(tokens) > 1 and tokens[1].isdigit() and int(tokens[1]) >= len(held)
    return False


def _stopped_difference(check, document, artifact, base, held, kind):
    """One side's stop, or both sides' of one cause, as a difference at ``<base path><cause>``."""
    before, after = held
    shown = before if before is not None else after
    return Difference(
        check,
        document,
        artifact,
        base[0] + shown.path,
        base[1] + shown.at,
        kind,
        None if before is None else before.value,
        None if after is None else after.value,
    )


def stops_by_cause(differences, before, after, stops, *, check, document, artifact):
    """The differences with each step that stopped short named by its cause (``STOPS``, ``stop_cause``).

    ``stops`` are each side's (``_stops``), whose stop fields the JSON
    comparison did not read at the steps both sides hold. At such a step
    each stop is a difference at ``/runs/*/trace/*/<field><cause>``
    (``/runs/*/trace/*/processing/<class>/...``,
    ``/runs/*/trace/*/error/<class>/<site>``): one side's only is ``added``
    or ``removed``, two of one cause are ``changed`` where they differ (one
    template, two messages), and two of two causes are two differences.
    Where only one side stopped, what the stop left out of that side's step
    (``_left_out``) is that stop's too, compared under its path
    (``/runs/*/trace/*/processing/<cause>/caseDb``,
    ``/runs/*/trace/*/error/<cause>/events/*``); and a run's changed end
    carries, after its transition, the cause of each side's stop in that
    run that its end does not name already
    (``/runs/*/end/submitted/submission-refused/<cause>``,
    ``/runs/*/end/submitted/form-error/<cause>``). So each cause of a step
    that stopped short is its own class, wherever it occurs.
    """
    one_sided = {}
    compared = set()
    ends = {}
    for field in STOPS:
        held_before, held_after = stops[0][field], stops[1][field]
        for key in set(held_before) | set(held_after):
            if not (_step(before, *key) and _step(after, *key)):
                continue
            compared.add((field, key))
            if (key in held_before) != (key in held_after):
                side = 0 if key in held_before else 1
                one_sided.setdefault(key, []).append((field, side, held_before.get(key) or held_after.get(key)))
        # A run's stop ends it (``SessionOp.java``, ``FormRun.java``), so each run holds one at most.
        for side, held in ((0, held_before), (1, held_after)):
            for (run, _), stop in held.items():
                ends.setdefault(run, [None, None])[side] = stop
    found = []
    for difference in differences:
        tokens = difference.at.split("/")
        if len(tokens) > 5 and tokens[1] == "runs" and tokens[3] == "trace" and tokens[5] not in STOPS:
            key = (int(tokens[2]), int(tokens[4]))
            for field, side, stop in one_sided.get(key, ()):
                stopped, other = (before, after) if side == 0 else (after, before)
                if _left_out(_step(stopped, *key), _step(other, *key), _run_end(stopped, key[0]), tokens[5:]):
                    path = difference.path.split("/")
                    difference = replace(
                        difference,
                        path="/".join([*path[:5], field]) + stop.path + "/" + "/".join(path[5:]),
                        at="/".join([*tokens[:5], field]) + stop.at + "/" + "/".join(tokens[5:]),
                    )
                    break
        elif difference.path.startswith("/runs/*/end/") and len(tokens) > 3 and tokens[3] == "end":
            for stop in ends.get(int(tokens[2]), ()):
                if stop is not None and stop.on_end:
                    difference = replace(difference, path=difference.path + stop.path, at=difference.at + stop.at)
        found.append(difference)
    for field, key in sorted(compared):
        run, step = key
        base = (f"/runs/*/trace/*/{field}", f"/runs/{run}/trace/{step}/{field}")
        held_before, held_after = stops[0][field].get(key), stops[1][field].get(key)
        if held_before is not None and held_after is not None and held_before.path == held_after.path:
            if held_before.value != held_after.value:
                found.append(_stopped_difference(check, document, artifact, base, (held_before, held_after), "changed"))
            continue
        if held_before is not None:
            found.append(_stopped_difference(check, document, artifact, base, (held_before, None), "removed"))
        if held_after is not None:
            found.append(_stopped_difference(check, document, artifact, base, (None, held_after), "added"))
    return found


# Generated ids --------------------------------------------------------------


def _xml_places(element, at, places):
    """Each (place, text) of an XML element, in document order: its attributes by name, its text, then each child
    and the text after it (its tail, at the child's own place: ``name[n]/tail()``, or ``node()[n]/tail()`` for
    a comment or processing instruction, by its position among the element's nodes)."""
    for name in sorted(element.attrib):
        places.append((f"{at}/@{name}", element.attrib[name]))
    places.append((f"{at}/text()", element.text or ""))
    counts = {}
    for index, child in enumerate(element, start=1):
        if isinstance(child.tag, str):
            local = child.tag.rpartition("}")[2]
            counts[local] = counts.get(local, 0) + 1
            place = f"{at}/{local}[{counts[local]}]"
            _xml_places(child, place, places)
        else:
            place = f"{at}/node()[{index}]"
        places.append((f"{place}/tail()", child.tail or ""))
    return places


def _field_order(key):
    """A step's fields in the order a generated id is made in them: every other field by name, then the form's
    submission, then the case database the submission made (``XML_FIELDS``)."""
    return (list(XML_FIELDS).index(key) + 1 if key in XML_FIELDS else 0, key)


def _places(value, at, places):
    """Each (place, text) of one run's value, in order: a list's items in order, an object's keys by
    ``_field_order``."""
    if isinstance(value, dict):
        for key in sorted(value, key=_field_order):
            item = value[key]
            place = f"{at}/{pointer_token(key)}"
            places.append((f"{place}/key()", key))
            if key in XML_FIELDS and isinstance(item, str):
                if GENERATED_PREFIX not in item:
                    continue
                try:
                    root = parse_xml(item)
                except XmlNotWellFormed:
                    places.append((place, item))
                    continue
                local = root.tag.rpartition("}")[2]
                _xml_places(root, f"{place}/{local}[1]", places)
            else:
                _places(item, place, places)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _places(item, f"{at}/{index}", places)
    elif isinstance(value, str):
        places.append((at, value))
    return places


def _run_places(run):
    """Each (place, [mark, ...]) of one run, in order (its steps, then its other fields), marks as they occur."""
    places = []
    if isinstance(run, dict):
        _places(run.get("trace"), "trace", places)
        _places({key: item for key, item in run.items() if key != "trace"}, "", places)
    found = []
    for place, text in places:
        marks = GENERATED_MARK.findall(text)
        if marks:
            found.append((place.lstrip("/"), marks))
    return found


def _label(place, index):
    return f"{GENERATED_LABEL}{place}" if index == 0 else f"{GENERATED_LABEL}{place}#{index}"


def generated_labels(before, after):
    """Each run's generated ids on both sides, named by the first place both sides hold one: ``[(before's {mark:
    label}, after's {mark: label})]``, run by run.

    A run is read in order (its steps, then its other fields), each value at
    its place: a JSON Pointer from the run (``trace/<step>/step/value``),
    continued into an XML field by each element's name and position among
    its same-named siblings, attributes by name, then text, and the text
    after each child at that child's own place (``_xml_places``). In a step, the
    submission is read after every other field and the case database last
    (``_field_order``), so an id is named where the form made it. Two ids at
    the first place both runs hold one (the ``n``-th mark of each value) are
    one id, named ``@generated:<place>`` (``#<n>`` after a value's first);
    an id the other run holds nowhere it does is named by its own first
    place. So an id keeps its name wherever the other ids were drawn, a block
    the other build writes elsewhere keeps its case's name by the case
    database both hold, and two names are never one.
    """
    runs_before = (before or {}).get("runs") or []
    runs_after = (after or {}).get("runs") or []
    found = []
    for index in range(max(len(runs_before), len(runs_after))):
        places_before = _run_places(runs_before[index]) if index < len(runs_before) else []
        places_after = _run_places(runs_after[index]) if index < len(runs_after) else []
        held_after = dict(places_after)
        labels_before, labels_after = {}, {}
        for place, marks in places_before:
            others = held_after.get(place) or []
            for position, (mark, other) in enumerate(zip(marks, others, strict=False)):
                if mark not in labels_before and other not in labels_after:
                    labels_before[mark] = labels_after[other] = _label(place, position)
        for places, labels in ((places_before, labels_before), (places_after, labels_after)):
            for place, marks in places:
                for position, mark in enumerate(marks):
                    labels.setdefault(mark, _label(place, position))
        found.append((labels_before, labels_after))
    return found


def relabel_generated(value, labels):
    """``value`` (a run, or HQ's processing of it) with every generated mark replaced by its label, keys too."""
    if not labels:
        return value
    if isinstance(value, str):
        return GENERATED_MARK.sub(lambda match: labels.get(match.group(0), match.group(0)), value)
    if isinstance(value, list):
        return [relabel_generated(item, labels) for item in value]
    if isinstance(value, dict):
        return {relabel_generated(key, labels): relabel_generated(item, labels) for key, item in value.items()}
    return value


def relabelled(before, after, labels=None):
    """Both traces with each run's generated marks named by ``labels`` (``generated_labels`` of the two, made
    here where the caller gives none)."""
    if labels is None:
        labels = generated_labels(before, after)

    def named(trace, side):
        if not isinstance(trace, dict) or not isinstance(trace.get("runs"), list):
            return trace
        runs = [relabel_generated(run, labels[index][side]) for index, run in enumerate(trace["runs"])]
        return {**trace, "runs": runs}

    return named(before, 0), named(after, 1)


def uncounted(trace):
    """The trace without each run's count of the ids the runtime generated (``generated.uuids``), in place.

    The count is how many ids the runner marked in the run
    (``Generated.java::mark``: ``found.size()``, each distinct id it found
    in the run's script, trace and end, every one of them replaced wherever
    it occurs by its mark). Both sides' marks are named by the first place
    both runs hold one, two marks two names (``generated_labels``), and every
    place a mark can be is compared. So two runs that compare equal hold the
    same names, as many as their counts: a count that differs always comes
    with a difference where one side holds a mark the other does not. The
    count is that difference again, and is not compared; the observation
    reads it only to give HQ each mark's value
    (``proof.observe.sessions._tokens``), whose effects HQ's case processing
    compares.
    """
    for run in (trace or {}).get("runs") or []:
        generated = run.get("generated") if isinstance(run, dict) else None
        if isinstance(generated, dict):
            generated.pop(GENERATED_COUNT, None)
    return trace


def ends_as_vocabulary(differences):
    """The differences with a changed run end written as ``/runs/*/end/<before>/<after>`` (the runner's names)."""
    found = []
    for difference in differences:
        if (
            difference.path == "/runs/*/end"
            and difference.kind == "changed"
            and isinstance(difference.before, str)
            and isinstance(difference.after, str)
        ):
            transition = f"/{pointer_token(difference.before)}/{pointer_token(difference.after)}"
            difference = replace(difference, path=difference.path + transition, at=difference.at + transition)
        found.append(difference)
    return found


# What each row of a case list holds beside the case it selects (``SessionOp.java::describeList``): the text each
# field shows and each field's sort key.
ROW_FIELDS = ("fields", "sortFields")


def _case_rows(rows):
    """Whether a step's ``rows`` are a case list's, each row naming the case selecting it returns, once each."""
    if not isinstance(rows, list) or not all(isinstance(row, dict) and "caseId" in row for row in rows):
        return False
    case_ids = [row["caseId"] for row in rows]
    return len(set(map(str, case_ids))) == len(case_ids)


def _sort_keys(before, after, *, check, document, artifact, path, at):
    """Two rows' sort keys compared field by field, a field with no sort key (``null``: Core sorts and searches
    it by the text it shows, ``EntitySorter.getCmp``, ``Entity.getSortFieldPieces``) read as having none, so a
    key only one side has is ``added`` or ``removed`` and two keys that differ are ``changed``."""
    found = []
    before, after = before or [], after or []
    for index in range(max(len(before), len(after))):
        key_a = before[index] if index < len(before) else None
        key_b = after[index] if index < len(after) else None
        if key_a == key_b:
            continue
        kind = "added" if key_a is None else "removed" if key_b is None else "changed"
        found.append(Difference(check, document, artifact, f"{path}/*", f"{at}/{index}", kind, key_a, key_b))
    return found


def rows_by_case(before, after, *, check, document, artifact):
    """The rows of each case list both traces show at one step compared by the case each selects, as Core keys an
    entity; their order is compared where they stand (``/runs/*/trace/*/rows/*/caseId``).

    Each row's fields and sort keys are compared with the same case's row on
    the other side (``/runs/*/trace/*/rows/*/fields/*``,
    ``/runs/*/trace/*/rows/*/sortFields/*``, the case id in ``at``), so a list
    whose rows come in another order shows that once, as its order, and not
    again as every field of every row it moved; a case only one side lists is
    its row ``added`` or ``removed`` (``/runs/*/trace/*/rows/*``). Both sides'
    rows are left holding their case ids alone, for the order. A list whose
    rows name no case (a list shown without a selection) is compared where its
    rows stand.
    """
    found = []
    runs_a, runs_b = before.get("runs") or [], after.get("runs") or []
    for run in range(min(len(runs_a), len(runs_b))):
        steps_a = (runs_a[run] or {}).get("trace") if isinstance(runs_a[run], dict) else None
        steps_b = (runs_b[run] or {}).get("trace") if isinstance(runs_b[run], dict) else None
        if not isinstance(steps_a, list) or not isinstance(steps_b, list):
            continue
        for step in range(min(len(steps_a), len(steps_b))):
            step_a, step_b = steps_a[step], steps_b[step]
            if not isinstance(step_a, dict) or not isinstance(step_b, dict):
                continue
            rows_a, rows_b = step_a.get("rows"), step_b.get("rows")
            if not (_case_rows(rows_a) and _case_rows(rows_b)):
                continue
            path, base = "/runs/*/trace/*/rows/*", f"/runs/{run}/trace/{step}/rows"
            held_a = {str(row["caseId"]): row for row in rows_a}
            held_b = {str(row["caseId"]): row for row in rows_b}
            for case_id in sorted(set(held_a) | set(held_b)):
                at = f"{base}/{pointer_token(case_id)}"
                row_a, row_b = held_a.get(case_id), held_b.get(case_id)
                if row_a is None or row_b is None:
                    shown = row_a if row_b is None else row_b
                    value = {key: shown.get(key) for key in ROW_FIELDS if key in shown}
                    kind = "removed" if row_b is None else "added"
                    found.append(
                        Difference(
                            check,
                            document,
                            artifact,
                            path,
                            at,
                            kind,
                            value if kind == "removed" else None,
                            value if kind == "added" else None,
                        )
                    )
                    continue
                found += compare_json(
                    row_a.get("fields"),
                    row_b.get("fields"),
                    check=check,
                    document=document,
                    artifact=artifact,
                    root_path=f"{path}/fields",
                    root_at=f"{at}/fields",
                )
                found += _sort_keys(
                    row_a.get("sortFields"),
                    row_b.get("sortFields"),
                    check=check,
                    document=document,
                    artifact=artifact,
                    path=f"{path}/sortFields",
                    at=f"{at}/sortFields",
                )
            for row in [*rows_a, *rows_b]:
                for key in ROW_FIELDS:
                    row.pop(key, None)
    return found


def compare_traces(before, after, *, check, document, rules, artifact="trace", xmlns=None, labels=None):
    """Every difference between two traces, as ``artifact``, after the spelling rules in ``rules`` for ``trace``.

    ``rules`` are the rules applied (``compare.spelling``; the judges give the
    registered set). ``xmlns`` maps the other (``after``) trace's form
    namespaces to the baseline's, in its values and in its XML documents.
    Each side's generated ids are named by the first place both sides hold
    one first (``relabelled``); ``labels`` is ``generated_labels(before,
    after)``, given by a caller that names HQ's processing of the same runs
    with it too.
    """
    xmlns = xmlns or {}
    before, after = relabelled(before, after, labels)
    before = uncounted(normalized("trace", before, rules))
    after = uncounted(normalized("trace", map_strings(after, xmlns), rules))
    stops = (_stops(before), _stops(after))
    documents_before, documents_after = {}, {}
    shown_before = _pull_xml(before, "", "", documents_before)
    shown_after = _pull_xml(after, "", "", documents_after)
    for pointer, (_, text, _) in documents_before.items():
        if pointer not in documents_after:
            _restore_pointer(shown_before, pointer, text)
    for pointer, (_, text, _) in documents_after.items():
        if pointer not in documents_before:
            _restore_pointer(shown_after, pointer, text)
    for field in STOPS:
        for run, step in set(stops[0][field]) | set(stops[1][field]):
            held = (_step(shown_before, run, step), _step(shown_after, run, step))
            if all(held):
                for shown in held:
                    shown.pop(field, None)
    keyed = rows_by_case(shown_before, shown_after, check=check, document=document, artifact=artifact)
    found = stops_by_cause(
        ends_as_vocabulary(
            prompt_keys_as_data(
                keyed
                + compare_json(
                    shown_before,
                    shown_after,
                    check=check,
                    document=document,
                    artifact=artifact,
                    data_maps=TRACE_DATA_MAPS,
                ),
                before,
                after,
            )
        ),
        before,
        after,
        stops,
        check=check,
        document=document,
        artifact=artifact,
    )
    for pointer in sorted(set(documents_before) & set(documents_after)):
        structural, text_before, naming = documents_before[pointer]
        _, text_after, _ = documents_after[pointer]
        if text_before == text_after and not xmlns:
            continue
        place = {"check": check, "artifact": artifact, "document": document, "structural": structural}
        roots = [
            _xml_root(text_before, **place, concrete=pointer, side="before", found=found),
            _xml_root(text_after, **place, concrete=pointer, side="after", found=found),
        ]
        if None in roots:
            continue
        compared = compare_xml_trees(
            roots[0],
            renamespace(roots[1], xmlns),
            check=check,
            document=document,
            artifact=artifact,
            blank_text="exact",
            naming=naming,
        )
        found += [_prefixed(difference, structural, pointer) for difference in compared]
    return found
