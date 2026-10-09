"""Proof 3's observation: sessions on each build over the document's cases, and HQ's processing of each submission.

The sessions run in the Core runner, each build installed as a runtime
installs it: an HQ build arranged as HQ's archive download arranges it
(``proof.observe.build.arrange``), Nova's local archive as it is. The script
is derived on ``build(A)``, the baseline (``CoreRunner.session`` with no
script: every menu command and every reachable form with the first case of
each list), and replays on the local archive and, where the raw builds of A
and of B aligned to A differ, on that build. HQ's builds read the restore
HQ writes over the unit's state (``proof.observe.casedata.restore``, with the
lookup tables Nova's push uploaded: A's restore is made over A, B's over B);
the local archive reads a restore with no tables, since it carries its own.

Every session's submission is given to HQ's case processing
(``proof.hq.operations.process_case_blocks``) over the same cases, with the
files a device sends beside it, and what HQ read and made of it is kept
(``processed_runs``), with where the form holds each case block HQ read
(``block_paths``). HQ reads a form's files while processing its cases
only for a case block's attachment that names one (``src``), under
``MM_CASE_PROPERTIES`` (``form_processor/backends/sql/update_strategy.py::
SqlCaseUpdateStrategy._apply_attachments_action``), and reads then only that
the file is there, its length, its type and an image's size, so each such
file is given as a stand-in (``stand_ins``). Where HQ asks for a file even
so (``AttachmentNotFound``) the run is kept as needing the form's files
(``needsFiles``), which the judge reports as a refused comparison. A refusal HQ answers a device with is data; anything
else HQ raises propagates and ends the check, since HQ answers no outcome
for it (``form_processor/submission_post.py::SubmissionPost.run`` logs it and
re-raises).

Every CSQL string a search of build(A) sent in those sessions (each search
request's ``_xpath_query``, with the request's case types), and every one
its suite sends whatever a run gives it (a query's ``_xpath_query`` that is a
string literal, ``literal_queries``), is compiled by HQ's case search
compiler, as HQ's case search compiles what Formplayer or a device sends,
under the configuration's flags (``search_compiles``), for the intent check:
each is a string a run sends, with the values the run gave its prompts.

Each HQ step runs in one of the unit's operations, and every step that
writes (a lookup upload) in a fork of the state it reads, so the unit is back
where it was when the observation returns. What it records (``sessions``):
each side's admission report, trace and processed runs (the traces and the
processing as blobs), HQ's compile of each CSQL string build(A)'s sessions
sent (``csql``), and each lookup upload HQ refused to serve.
"""

from __future__ import annotations

import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path

from proof.checks.compare.trace import renamespace
from proof.checks.compare.xml_tree import parse_xml
from proof.observe import casedata
from proof.observe.build import _placed, admission_placeholders, arrange
from proof.observe.record import bytes_digest, digest
from proof.observe.runs import (
    GENERATED_NAMESPACE,
    GENERATED_PREFIX,
    Run,
    script_of,
    submission_of,
    unbuildable,
    xmlns_alignment,
)


@contextmanager
def admitted(core_runner, path):
    """Core's admission report for an archive (a ``.ccz`` or a directory), its app released on exit."""
    report = core_runner.admit(path)
    app = report.get("app")
    try:
        yield report
    finally:
        if app is not None and core_runner.holds(app):
            core_runner.release(app)


def _admission(report, path):
    """The admission report without the root the runner read the archive under or the archive's path
    (``build.admission_placeholders``)."""
    kept = {key: value for key, value in report.items() if key not in ("app", "appHandle", "archiveRoot")}
    return _placed(kept, admission_placeholders(report, path))


def run_sessions(core_runner, side, path, restore, script=None):
    """The build's sessions over the restore: derived when ``script`` is None, else the script replayed."""
    with admitted(core_runner, path) as report:
        admission = _admission(report, path)
        if not report.get("admitted") or report.get("app") is None:
            return Run(side, admission, None)
        trace = core_runner.session(report["app"], restore=restore, script=script)
    return Run(side, admission, trace)


# Submissions ----------------------------------------------------------------


def _tokens(run):
    """The runner's marks in a run, each with the value HQ is given for it: the clock's own, or a fixed id."""
    clock = (run.get("generated") or {}).get("clock") or {}
    tokens = dict(clock)
    for index in range(1, int((run.get("generated") or {}).get("uuids") or 0) + 1):
        tokens[f"{GENERATED_PREFIX}{index}"] = str(uuid.uuid5(GENERATED_NAMESPACE, str(index)))
    return tokens


def _replace_all(text, tokens):
    for token in sorted(tokens, key=len, reverse=True):
        if token in text:
            text = text.replace(token, tokens[token])
    return text


def unmarked_submission(run, xmlns=None):
    """The run's submission as the device sends it: each mark replaced by its value, in the parsed document."""
    from lxml import etree

    root = renamespace(parse_xml(submission_of(run)), xmlns or {})
    tokens = _tokens(run)
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        for key, value in element.attrib.items():
            element.set(key, _replace_all(value, tokens))
        if element.text:
            element.text = _replace_all(element.text, tokens)
        if element.tail:
            element.tail = _replace_all(element.tail, tokens)
    return etree.tostring(root, encoding="utf-8", xml_declaration=True), tokens


def _remarked(value, tokens):
    """HQ's record of a submission with each generated id given back its mark, so two runs read alike."""
    marks = {value: token for token, value in tokens.items() if token.startswith(GENERATED_PREFIX)}
    if isinstance(value, str):
        return _replace_all(value, marks)
    if isinstance(value, list):
        return [_remarked(item, tokens) for item in value]
    if isinstance(value, dict):
        return {_replace_all(key, marks): _remarked(item, tokens) for key, item in value.items()}
    return value


CASE_XMLNS = "http://commcarehq.org/case/transaction/v2"
# What a file the device sends stands as: the device's capture is not known here, and HQ's case processing reads
# only that the file is there, its length, its type and (for an image it can open) its size.
STAND_IN = b"proof stand-in for a file the device sent"


def stand_ins(submission):
    """A stand-in file for each file a case block's attachment names (``src``), as the device sends it beside the
    submission, by name: ``(content, content type)``, the type guessed from the name as HQ guesses it
    (``CaseAttachment.from_form_attachment``)."""
    import mimetypes

    files = {}
    for element in parse_xml(submission).iter(f"{{{CASE_XMLNS}}}attachment"):
        for child in element:
            source = child.get("src") if isinstance(child.tag, str) else None
            if source:
                files[source] = (STAND_IN, mimetypes.guess_type(source)[0] or "application/octet-stream")
    return files


def _without_dates_modified(value):
    """HQ's JSON of a form with every ``@date_modified`` taken out (``block_paths``)."""
    if isinstance(value, dict):
        return {key: _without_dates_modified(item) for key, item in value.items() if key != "@date_modified"}
    if isinstance(value, list):
        return [_without_dates_modified(item) for item in value]
    return value


def block_paths(submission, blocks):
    """Where the form holds each of ``blocks`` (HQ's case blocks of ``submission``, in the order HQ read them):
    HQ's path to each, the keys of the form's JSON from its root to the element holding the block.

    HQ reads the blocks from the submission's JSON
    (``form_processor/utils/xform.py::convert_xform_to_json``) with
    ``casexml/apps/case/xform.py::extract_case_blocks``, which names each
    one's path when asked (``include_path``), so the same reading of the
    same bytes names where each block is; the blocks of a repeat's rows
    share one path. The only thing that reading does besides walking the
    JSON is validate each block's ``@date_modified``
    (``casexml/apps/case/util.py::validate_phone_datetime``, which notes an
    empty one as a soft assertion and raises on one it cannot parse); HQ's
    processing already validated them, so they are taken out first and this
    reading notes nothing HQ did not.
    """
    from casexml.apps.case.xform import extract_case_blocks
    from corehq.form_processor.utils.xform import convert_xform_to_json

    if not blocks:
        return []
    found = extract_case_blocks(_without_dates_modified(convert_xform_to_json(submission)), include_path=True)
    if [held.caseblock.get("@case_id") for held in found] != [block.get("@case_id") for block in blocks]:
        raise AssertionError(
            "HQ's reading of a submission's case blocks with their paths found other blocks than its case"
            f" processing read ({[held.caseblock.get('@case_id') for held in found]} against"
            f" {[block.get('@case_id') for block in blocks]}), though both read the same bytes with"
            " casexml/apps/case/xform.py::extract_case_blocks; look at what proof.hq.operations.process_case_blocks"
            " reads besides the submission's JSON."
        )
    return [list(held.path) for held in found]


def case_processing(state, database, run, xmlns=None, *, files=True):
    """What HQ's case processing reads from one run's submission and makes of it, over the case database.

    The submission is given with a stand-in for each file its case blocks
    name (``stand_ins``), as a device sends its files beside it; with
    ``files`` False, with none, as when the device sent none.
    """
    from corehq.form_processor.exceptions import AttachmentNotFound

    from proof.hq import operations

    if submission_of(run) is None:
        return {"submitted": False}
    submission, tokens = unmarked_submission(run, xmlns)
    try:
        processed = operations.process_case_blocks(
            state,
            submission,
            cases=casedata.hq_cases(database, state.domain),
            attachments=stand_ins(submission) if files else None,
        )
    except AttachmentNotFound as error:
        return _remarked(
            {"submitted": True, "needsFiles": {"class": type(error).__name__, "message": str(error)}}, tokens
        )
    cases = {}
    for case_id, touched in sorted(processed.touched.items()):
        case = touched.case
        cases[case_id] = {
            "creation": touched.is_creation,
            "type": case.type,
            "name": case.name,
            "owner_id": case.owner_id,
            "closed": case.closed,
            "external_id": case.external_id,
            "properties": dict(sorted(case.case_json.items())),
            "indices": {
                index.identifier: {
                    "referenced_type": index.referenced_type,
                    "referenced_id": index.referenced_id,
                    "relationship": index.relationship,
                }
                for index in case.live_indices
            },
        }
    refusal = processed.refusal
    return _remarked(
        {
            "submitted": True,
            "blocks": processed.case_blocks,
            "blockPaths": block_paths(submission, processed.case_blocks),
            "refusal": None if refusal is None else {"class": type(refusal).__name__, "message": str(refusal)},
            "cases": cases,
        },
        tokens,
    )


def processed_runs(state, database, trace, xmlns=None, *, files=True):
    """HQ's case processing of every run's submission in a trace (``case_processing``), in run order."""
    return {"runs": [case_processing(state, database, run, xmlns, files=files) for run in trace["runs"]]}


# Restores --------------------------------------------------------------------


def _workbook_digest(captured):
    return bytes_digest(captured.body_path.read_bytes()).encode() if captured is not None else b"none"


def hq_restore(unit, database, captured, label, operation=None):
    """HQ's restore over the unit's state, serving the tables ``captured`` uploads, in a fork; or the refusal.

    Returns ``({"served": True}, restore bytes)`` or ``({"refused": reason}, None)``. ``operation`` is the
    unit's operation (``unit.operation`` by default, or the part's logged one).
    """
    operation = operation or unit.operation
    with unit.fork(), operation(label, _workbook_digest(captured)):
        try:
            tables = casedata.lookup_fixtures(unit, captured) if captured is not None else []
        except casedata.LookupTablesNotServed as refused:
            return {"refused": refused.reason}, None
        return {"served": True}, casedata.restore(database, unit.domain, tables)


def local_restore(unit, database, operation=None):
    """The restore a local archive's sessions read: the cases, and no table (the archive carries its own)."""
    with (operation or unit.operation)("restore-local", b""):
        return casedata.restore(database, unit.domain)


# The observation ---------------------------------------------------------------


def _side(core_runner, unit, database, side, path, restore, blobs, *, operation, script=None, baseline=None):
    """One side's sessions, and HQ's processing of their submissions, as a record."""
    run = run_sessions(core_runner, side, path, restore, script)
    recorded = {"admission": run.admission, "trace": None, "processed": None}
    if run.trace is None:
        return run, recorded
    xmlns = xmlns_alignment(run.admission, baseline.admission) if baseline is not None else None
    with operation(f"case-processing:{side}", digest([run.trace, xmlns]).encode()):
        processed = processed_runs(unit, database, run.trace, xmlns)
    recorded["trace"] = blobs.put_json(run.trace)
    recorded["processed"] = blobs.put_json(processed)
    return run, recorded


# The query data a search sends HQ (``case_search/const.py``): its CSQL and its case types.
XPATH_QUERY_KEY, CASE_TYPE_KEY = "_xpath_query", "case_type"
# What Core's ``xpathStrings`` writes for a value only the run time knows; a literal holds none, and a ref that
# reads one is left to the strings the sessions send (``literal_queries``).
LITERAL_HOLE = "proofvalue"


def _raise_site(error):
    """Where HQ raised ``error``: the innermost frame of its traceback under HQ's ``corehq``, as
    ``<file under corehq>::<function>``."""
    traceback, site = error.__traceback__, "?"
    while traceback is not None:
        code = traceback.tb_frame.f_code
        name = code.co_filename.replace("\\", "/")
        if "/corehq/" in name:
            site = f"{name.rsplit('/corehq/', 1)[1]}::{code.co_name}"
        traceback = traceback.tb_next
    return site


def csql_compile(unit, query, case_types):
    """HQ's compile of one CSQL string in a case search's context (``operations.compile_case_search``):
    ``{"compiled": true}`` (a related lookup past its flag's gate runs its own query of HQ's case search index
    while it compiles, ``xpath_functions/ancestor_functions.py``, over the unit's indexes,
    ``proof.hq.elasticsearch``); or ``{"raised": {"class", "site", "message"}}`` where HQ refuses it
    (``CaseFilterError`` and its subclasses, ``CaseSearchException``), the site being where it raised
    (``_raise_site``). Anything else HQ raises is the
    harness's, and propagates."""
    from corehq.apps.case_search.exceptions import CaseFilterError, CaseSearchException

    from proof.hq import operations

    try:
        operations.compile_case_search(unit, query, case_types)
    except (CaseFilterError, CaseSearchException) as error:
        return {"raised": {"class": type(error).__name__, "site": _raise_site(error), "message": str(error)}}
    return {"compiled": True}


def search_queries(suite_xml):
    """Each ``<query>`` of a suite, as ``(case type refs, CSQL refs)``: the ``ref`` of each ``data`` element it
    sends HQ under ``case_type`` and under ``_xpath_query`` (``suite_xml/post_process/remote_requests.py``)."""
    from lxml import etree

    try:
        root = etree.fromstring(suite_xml, etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError:
        return []  # a suite that is not well-formed is the bar's to report
    found = []
    for query in root.iter():
        if not isinstance(query.tag, str) or etree.QName(query).localname != "query":
            continue
        refs = {CASE_TYPE_KEY: [], XPATH_QUERY_KEY: []}
        for data in query:
            if not isinstance(data.tag, str) or etree.QName(data).localname != "data":
                continue
            ref = (data.get("ref") or "").strip()
            if ref and data.get("key") in refs:
                refs[data.get("key")].append(ref)
        if refs[XPATH_QUERY_KEY]:
            found.append((tuple(refs[CASE_TYPE_KEY]), tuple(refs[XPATH_QUERY_KEY])))
    return found


def literal_queries(core_runner, suite_xml):
    """The CSQL strings a suite's searches send whatever the run gives them: each query's ``_xpath_query`` whose
    ``ref`` Core parses as one string literal (``xpathParse``), its value (``xpathStrings``), with the case types
    the query's literal ``case_type`` refs name. A ref that reads anything at run time is left to the strings the
    sessions send."""
    queries = search_queries(suite_xml)
    refs = sorted({ref for case_types, csql in queries for ref in (*case_types, *csql)})
    if not refs:
        return set()
    parsed = core_runner.request("xpathParse", deadline=60.0, expressions=refs)["results"]
    strings = core_runner.request("xpathStrings", deadline=60.0, expressions=refs, hole=LITERAL_HOLE)["results"]
    value = {}
    for ref, reading, result in zip(refs, parsed, strings, strict=True):
        held = result.get("strings") or []
        if reading.get("expressions") == ["XPathStringLiteral"] and not reading.get("functions") and len(held) == 1:
            value[ref] = held[0]
    found = set()
    for case_types, csql in queries:
        types = tuple(sorted(value[ref] for ref in case_types if ref in value))
        found |= {(value[ref], types) for ref in csql if ref in value}
    return found


def search_compiles(unit, trace, operation, *, core_runner=None, suite=None):
    """HQ's compile (``csql_compile``) of every CSQL string a trace's searches sent, each search request's
    ``_xpath_query`` (a step's ``params`` and each request it made) with the case types the request names, and of
    each one the build's suite sends whatever a run gives it (``literal_queries``, where ``suite`` names its
    bytes), in one operation of the unit; ``[]`` where there is none."""
    wanted = set() if suite is None else literal_queries(core_runner, suite)
    for run in (trace or {}).get("runs") or []:
        for step in (run or {}).get("trace") or []:
            if not isinstance(step, dict):
                continue
            for request in [step, *(step.get("requests") or [])]:
                params = request.get("params") if isinstance(request, dict) else None
                if not isinstance(params, dict):
                    continue
                case_types = tuple(sorted(str(value) for value in params.get(CASE_TYPE_KEY) or []))
                for query in params.get(XPATH_QUERY_KEY) or []:
                    wanted.add((str(query), case_types))
    if not wanted:
        return []
    found = []
    with operation("csql-compile", digest(sorted(wanted)).encode()):
        for query, case_types in sorted(wanted):
            found.append({"query": query, "caseTypes": list(case_types), **csql_compile(unit, query, case_types)})
    return found


def observe(unit, *, document, export, a_build, b_aligned, b_differs, restore_a, core_runner, blobs, operation=None):
    """Proof 3's sessions for one configuration, as the ``b_aligned`` record's ``sessions``; None where none run.

    ``restore_a`` is the ``a`` record's restore over A (its lookup outcome and
    restore bytes); ``b_differs`` whether the raw builds of A and of B aligned
    to A differ, so that B's sessions run; ``operation`` the unit's operation
    each HQ step runs in (``unit.operation`` by default, or the part's logged
    one, which records what HQ noted in each).
    """
    operation = operation or unit.operation
    if a_build is None or unbuildable(a_build) is not None or document.local_ccz is None:
        return None
    database = casedata.document_case_database(document)
    lookups_a, restore_hq = restore_a
    recorded = {"lookupsA": lookups_a}
    if restore_hq is None:
        return recorded
    restore_plain = local_restore(unit, database, operation)
    # The restore the local archive's sessions read, kept for the readers that read the document's archives
    # outside the unit (the Android stage, ``proof.android``).
    recorded["restoreLocal"] = blobs.put(restore_plain)
    with tempfile.TemporaryDirectory(prefix="proof-observe-sessions-") as scratch:
        baseline, recorded["baseline"] = _side(
            core_runner,
            unit,
            database,
            "A",
            arrange(a_build.files, Path(scratch, "A")),
            restore_hq,
            blobs,
            operation=operation,
        )
        if baseline.trace is None:
            return recorded
        recorded["csql"] = search_compiles(
            unit, baseline.trace, operation, core_runner=core_runner, suite=(a_build.files or {}).get("suite.xml")
        )
        script = script_of(baseline.trace)
        _, recorded["local"] = _side(
            core_runner,
            unit,
            database,
            "local.ccz",
            document.local_ccz,
            restore_plain,
            blobs,
            operation=operation,
            script=script,
            baseline=baseline,
        )
        if b_aligned is None or b_aligned.files is None or not b_differs or unbuildable(b_aligned) is not None:
            return recorded
        restore_b = restore_hq
        if export.republish.lookups is not None:
            recorded["lookupsB"], restore_b = hq_restore(
                unit, database, export.republish.lookups, "restore-b", operation
            )
            if restore_b is None:
                return recorded
        _, recorded["b"] = _side(
            core_runner,
            unit,
            database,
            "B",
            arrange(b_aligned.files, Path(scratch, "B")),
            restore_b,
            blobs,
            operation=operation,
            script=script,
        )
    return recorded
