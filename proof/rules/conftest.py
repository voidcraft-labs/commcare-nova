"""What a spelling rule's own test runs: a corpus document published into HQ, spelled two ways, built and run.

Each rule's test (``proof/rules/test_<rule>.py``) proves that HQ's build or
Core's run does not depend on the one spelling the rule erases. It publishes
a corpus document as Nova's publish leaves it in HQ (A: Nova's create, with
the lookup workbook and media Nova's push sends beside it, applied through
HQ's own import, ``proof.hq.operations``), and in a fork of that state of
its own for each spelling (``unit.fork``) writes the app document or a
form's source the way an editor writes it, reads back what HQ stores
(``proof.observe.proof4.stored_app``, as proof 4 reads it), and builds it
(``proof.observe.build.build_state``, every form judged by the Core runner).
Every spelling is written through the same path, Nova's own included, so
the two builds differ by the spelling alone. Where HQ's build carries the
spelling, Core's runner admits each build as HQ's download arranges it and
runs the sessions it derives on the first over the document's case database
and HQ's restore, replaying them on the second (``proof.checks.proof3``),
and HQ processes each run's submission in a fork (``proof.observe.
sessions``), so the traces and the case processing can be compared.

The comparisons are the lane's own (``proof.observe.builds.
build_differences`` for builds under the version clause, the XML and JSON
comparators for what HQ stores, ``proof.checks.compare.trace`` for traces,
``proof.checks.proof3.compare_case_processing``), each given the rules
explicitly: none for what the spelling must not change, the rule alone for
what it erases.

``DOCUMENTS`` names every corpus document a rule's test reads, which keys the
package's outcome in the evidence store (``proof.store.queue.PACKAGE_DATA``).
"""

from __future__ import annotations

import copy
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path

import pytest

from proof.checks import casedata, proof3
from proof.checks.compare.json_tree import compare_json
from proof.checks.compare.trace import compare_traces, generated_labels
from proof.checks.compare.xml_tree import compare_xml_trees, parse_xml
from proof.checks.differences import Difference
from proof.rules import normalized

# The check the comparisons name (a known one; the differences are compared here, never reported).
CHECK = "proof4"
# Every corpus document a rule's test reads, by id, and no other: ``rule_documents`` hands a test these alone.
DOCUMENTS = (
    "arithmetic",
    "case-capture-multiple",
    "case-capture-repeat",
    "case-extension-registration",
    "case-operation-sequence",
    "expander-conditional-required-generates-required-xpath-ae4797f7-0",
    "expander-expanddoc-hq-json-projection-sort-elements-1e1c54c0-0",
    "expander-expanddoc-hq-json-projection-sort-elements-5899296f-0",
    "expander-form-hashtag-expansion-emits-the-editor-1daa5537-0",
    "expander-form-hashtag-expansion-emits-validate-msg-as-an-fe6783cb-0",
    "nested-menu-parent",
    "nested-menu-same-multiple",
    "search-browse",
    "targeted-connect-deliver-rename",
    "tile-boxed",
)


class _Named(dict):
    """The documents ``DOCUMENTS`` names, by id; asking for any other fails the test, since the package's stored
    outcome is keyed by those documents alone."""

    def __missing__(self, document_id):
        pytest.fail(
            f"A rule's test read the corpus document {document_id}, which proof/rules/conftest.py::DOCUMENTS does not"
            " name, so a change to it would not invalidate the package's stored outcome. Add it to DOCUMENTS."
        )


@pytest.fixture(scope="session")
def rule_documents():
    """The corpus documents ``DOCUMENTS`` names, by id, and no other; a test of a document the corpus lacks fails."""
    from proof.checks import corpus

    found = {document.id: document for document in corpus.load(corpus.corpus_root()).emitted}
    missing = sorted(set(DOCUMENTS) - set(found))
    if missing:
        pytest.fail(
            f"The corpus holds no {missing}, which proof/rules/conftest.py::DOCUMENTS names as the documents the rules'"
            " own tests build. Name documents the corpus holds."
        )
    return _Named({document_id: found[document_id] for document_id in DOCUMENTS})


def rewritten(change=None):
    """A form source's text to its text with ``change`` made to its parsed root (none: the same document,
    serialized again), so every spelling of a form reaches HQ through one serializer."""
    from lxml import etree

    def apply(source):
        root = parse_xml(source)
        if change is not None:
            change(root)
        return etree.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8")

    return apply


def edited(change):
    """The app's JSON to its JSON with ``change`` made to it in place."""

    def apply(doc):
        change(doc)
        return doc

    return apply


@dataclass
class Spelling:
    """One spelling of the app: what HQ stores for it (``stored_app``'s JSON) and HQ's build of it."""

    stored: dict
    build: object


class Published:
    """A corpus document published into a check's HQ state, ready to be spelled two ways."""

    def __init__(self, document, export, unit, app_id):
        self.document, self.export, self.unit, self.app_id = document, export, unit, app_id

    def _app(self):
        from proof.hq import operations

        return operations.held_app(self.unit, self.app_id)

    def _write(self, doc=None, sources=None):
        """Write the app document (``doc``: the app's JSON to the JSON to store) and form sources (``sources``:
        ``{"m.f": source text to source text}``), each through the path every spelling takes."""
        app = self._app()
        held = copy.deepcopy(app.to_json())
        changed = doc(copy.deepcopy(held)) if doc is not None else held
        type(app).wrap(changed).save()
        app = self._app()
        for position, change in sorted((sources or {}).items()):
            m, f = (int(part) for part in position.split("."))
            form = app.modules[m].forms[f]
            form.source = change(form.source)
        app.save()

    def spell(self, *, doc=None, sources=None, previous=None):
        """In a fork of the published state: the app written as ``doc`` and ``sources`` say, read back and built."""
        from proof.hq.seams import build_seams
        from proof.observe.build import build_state
        from proof.observe.proof4 import stored_app

        with self.unit.fork():
            self._write(doc, sources)
            stored, _ = stored_app(self.unit, self.app_id)
            with build_seams(previous=previous):
                outcome, _ = build_state(self._app(), self.unit.record, "spelled")
            return Spelling(stored=stored, build=outcome)

    def processed(self, database, trace):
        """HQ's case processing of every run of ``trace``, in a fork."""
        from proof.observe.sessions import processed_runs

        with self.unit.fork():
            return processed_runs(self.unit, database, trace)


@contextmanager
def published(document, core_runner, configuration="minimum"):
    """``document`` as Nova's first publish leaves it in HQ under ``configuration``, in a check's state."""
    from proof.hq import operations
    from proof.hq.check import hq_check

    export = document.exports[configuration]
    with hq_check(export.configuration.hq(), validate=core_runner.validate_form) as (unit, _):
        if export.create.lookups is not None:
            uploaded = operations.upload_lookup_workbook(unit, export.create.lookups.workbook(), replace=True)
            assert uploaded.errors == [], uploaded.errors
        result = operations.apply_upload(unit, export.create.upload())
        assert 200 <= result.status < 300 and result.response.get("success"), result.response
        app_id = result.response["app_id"]
        if export.create.media is not None:
            media = operations.apply_media_upload(unit, app_id, export.create.media.upload())
            assert media.status == 200, media.response
        yield Published(document, export, unit, app_id)


# What HQ stores, compared ---------------------------------------------------------------------------------------


def stored_differences(before, after, *, rules=()):
    """Every difference between two stored apps (``stored_app`` JSON) after ``rules``: the app document as JSON and
    each form's source as an XML tree, as proof 4 compares them (``proof.checks.proof4.stored_differences``)."""
    found = compare_json(
        normalized("app.json", before["doc"], rules),
        normalized("app.json", after["doc"], rules),
        check=CHECK,
        document="-",
        artifact="app.json",
    )
    for position in sorted(set(before["sources"]) | set(after["sources"])):
        artifact = f"form:{position}"
        a, b = before["sources"].get(position), after["sources"].get(position)
        if a is None or b is None:
            found.append(
                Difference(CHECK, "-", f"source:{artifact}", "/", "/", "added" if a is None else "removed", a, b)
            )
            continue
        found += compare_xml_trees(
            normalized(artifact, parse_xml(a), rules),
            normalized(artifact, parse_xml(b), rules),
            check=CHECK,
            document="-",
            artifact=f"source:{artifact}",
        )
    return found


def build_differences(before, after, *, rules=()):
    """Every difference between two builds of one app after ``rules``, under proof 2's version clause."""
    from proof.observe.alignment import Alignment
    from proof.observe.builds import build_differences as compared

    return compared("-", before, after, Alignment((), (), (), ()), rules=rules)


def assert_spelled(nova, other, rule, where):
    """``other`` stores the app as ``nova`` does but for the spelling: some difference, each at a structural path
    ``where`` accepts, and none once ``rule`` reads both."""
    found = shown(stored_differences(nova.stored, other.stored))
    assert found, "the two spellings stored the same app, so the test shows nothing"
    stray = [d for d in found if not where(d[1])]
    assert stray == [], f"the spelling stored more than the rule names: {stray}"
    left = shown(stored_differences(nova.stored, other.stored, rules=(rule,)))
    assert left == [], f"the rule left part of the spelling: {left}"


def assert_same_build(first, second):
    """HQ built the two spellings alike, file for file, under the version clause, and built each whole."""
    for spelled in (first, second):
        assert spelled.build.files is not None and not spelled.build.raised, spelled.build.raised
    found = shown(build_differences(first.build, second.build))
    assert found == [], f"HQ's build depends on the spelling: {found}"


def shown(differences):
    """The differences as (artifact, path, kind) triples, for an assertion's message and its comparison."""
    return sorted({(difference.artifact, difference.path, difference.kind) for difference in differences})


# Core's run, compared ----------------------------------------------------------------------------------------------


@dataclass
class Ran:
    """One build's sessions: Core's admission, its trace, and HQ's processing of each run's submission."""

    admission: dict
    trace: dict | None
    processed: dict | None


def restore(app, database):
    """HQ's restore over the published state for ``database``, serving the tables its publish uploaded."""
    from proof.observe.sessions import hq_restore

    status, held = hq_restore(app.unit, database, app.export.create.lookups, "restore")
    assert held is not None, f"HQ's restore refused the document's lookup tables: {status}"
    return held


def run(app, core_runner, outcome, restored, database, script=None, *, files=None):
    """Core's sessions on a build (``files`` in place of its own, where given), HQ processing each submission."""
    with tempfile.TemporaryDirectory(prefix="proof-rules-") as directory:
        arranged = proof3.arrange_build(files if files is not None else outcome.files, Path(directory) / "build")
        ran = proof3.run_sessions(core_runner, "B", arranged, restored, script)
    if ran.trace is None:
        return Ran(ran.admission, None, None)
    return Ran(ran.admission, ran.trace, app.processed(database, ran.trace))


def runs_alike(app, core_runner, first, second, *, database=None, rules=(), second_files=None, first_files=None):
    """Both builds' sessions (the second replaying the first's script) and their differences after ``rules``:
    ``(first Ran, second Ran, trace and case-processing differences)``."""
    database = database or casedata.case_database(app.document.document)
    restored = restore(app, database)
    ran_first = run(app, core_runner, first, restored, database, files=first_files)
    assert ran_first.trace is not None, f"Core did not admit the first build: {ran_first.admission}"
    opened = [step for each in ran_first.trace["runs"] for step in each["trace"] if step.get("screen") == "form"]
    assert opened, "the sessions open no form, so they run nothing the spelling could change"
    ran_second = run(
        app, core_runner, second, restored, database, proof3.script_of(ran_first.trace), files=second_files
    )
    assert ran_second.trace is not None, f"Core did not admit the second build: {ran_second.admission}"
    return ran_first, ran_second, trace_differences(ran_first, ran_second, rules=rules)


def trace_differences(first, second, *, rules=()):
    """The differences between two runs' traces and HQ's processing of them, after ``rules``."""
    runtimes = proof3.RUNTIMES["B"]
    labels = generated_labels(first.trace, second.trace)
    found = compare_traces(
        proof3.comparable_trace(first.trace, runtimes),
        proof3.comparable_trace(second.trace, runtimes),
        check=CHECK,
        document="-",
        rules=rules,
        artifact="trace",
        labels=labels,
    )
    found += proof3.compare_case_processing("-", "case_blocks", first.processed, second.processed, labels=labels)
    return found


def with_blank_case(database, case_type, properties):
    """``database`` with one more case of ``case_type`` holding each of ``properties`` blank."""
    template = next(case for case in database.cases if case.case_type == case_type)
    blank = replace(
        template,
        case_id=f"{template.case_id}-blank",
        name=f"{template.name} blank",
        properties=tuple((name, "" if name in properties else value) for name, value in template.properties)
        + tuple((name, "") for name in properties if name not in dict(template.properties)),
    )
    return replace(database, cases=(*database.cases, blank))
