"""Formplayer submits the case blocks Nova's generated groups hold as Core does, and refuses where a guard fails.

Nova writes every case operation's block inside a ``nova_operations`` group,
a conditional update or close inside a ``nova_condition_<operation>`` group
whose relevance is the condition, each guard as an update-only block after
its operation's (blank ``case_id`` where its test fails), a root create keyed
by an answer inside a one-row repeat, and one block's read of another's id
through ``current()`` (``lib/commcare/xform/caseOps.ts``). Each document is
published as Nova publishes it and released and served by HQ's own views
(``proof.formplayer.hq``), and its forms are walked by Formplayer
(``proof.formplayer.walk``) and by Core's own session over the same build
and restore (``apps.core_sessions``), each with one answer table.

Contract, on ``case-operation-conditional``, ``case-operation-key``,
``case-operation-query``, ``case-operation-sequence``,
``case-capture-multiple`` and ``case-extension-registration``: with every
text answered ``yes`` (each condition true) and with every text answered
``no`` (each condition false), some run of Formplayer's walk submits, for
each form Core's session submits, the case blocks Core's submission holds,
each where Core's holds it, with every id and every instant marked by where
it first appears; and HQ's case processing of the two submissions
(``operations.process_case_blocks``) leaves the same cases. With every text
answered three spaces, the create's text guard of ``case-operation-sequence``
fails, its block's ``case_id`` is blank, and Formplayer refuses the
submission for that reason (``stops.formplayer_cause``), sending HQ nothing.
``case-operation-sequence`` declares Android only, so Formplayer's walk
answers its date and time question as Core's session does.

The lane's answer table answers no text ``yes``, so its walks reach every
condition false; a failing guard needs a whitespace-only name, which no walk
gives. The plausible failures: a block Formplayer submits outside its group,
or inside a group whose condition it does not apply (a conditional update
run where its condition is false, or a guard run where its create did not);
a read between blocks Formplayer resolves to another node than Core does (an
update of no case, or of the wrong one); a keyed create whose row Formplayer
never makes; and a guard Formplayer lets through.
"""

from __future__ import annotations

import copy
import re
import tempfile
from dataclasses import replace

import pytest
from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import Walk, load_answer_table, screen_kind

SUBMITTED = (
    "case-operation-conditional",
    "case-operation-key",
    "case-operation-query",
    "case-operation-sequence",
    "case-capture-multiple",
    "case-extension-registration",
)
GUARDED = "case-operation-sequence"
# Its follow-up form, whose create carries the text guard.
GUARDED_FORM = "Edit"
CASE = "{http://commcarehq.org/case/transaction/v2}case"
# What Core's session and Formplayer's walk draw for themselves: an id (a UUID, or Core's mark for one it drew,
# ``proof/core/src/nova/proof/core/Generated.java``) and an instant.
DRAWN_ID = re.compile(r"@generated:uuid:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
INSTANT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?")
# Core's case parser's refusal of a block whose case id is blank (``CaseXmlParserUtil.validateMandatoryProperty``),
# as a walk stop names it.
BLANK_CASE_ID = "submit-refused:the-case-id-attribute-of-a-case-wasn-t-set"
PARSER = etree.XMLParser(resolve_entities=False, no_network=True)


def _table(text):
    """The lane's answer table with every text question answered ``text`` alone."""
    table = copy.deepcopy(load_answer_table())
    table["dataTypes"]["text"] = [text]
    # Core otherwise falls back to the generic binary value, while Formplayer's image widget takes the
    # image entry. Give both readers the same file for each native control, before comparing their blocks.
    for control, kind in (("image", "image"), ("audio", "audio"), ("video", "video"), ("document", "file")):
        table["controls"][control] = list(table["novaKinds"][kind])
    return table


class _Marks:
    """Each drawn id and instant of one submission written by where it first appears, so two readers' drawings of
    the same submission read alike."""

    def __init__(self, uploads=None):
        self.ids: dict[str, str] = {}
        self.uploads = dict(uploads or {})

    def __call__(self, value):
        if value is None:
            return None

        def mark(found):
            return self.ids.setdefault(found.group(0), f"@id:{len(self.ids) + 1}")

        text = str(value)
        for stored, given in self.uploads.items():
            text = text.replace(stored, given)
        return INSTANT.sub("@instant", DRAWN_ID.sub(mark, text))


def _blocks(instance: str, marks: _Marks):
    """Every case block of a submission in document order: where it sits (the local names of the elements above
    it), its attributes and each action's children with their attributes and text, every drawn value marked."""
    root = etree.fromstring(instance.encode("utf-8"), PARSER)
    found = []
    for block in root.iter(CASE):
        place = "/".join(etree.QName(element).localname for element in reversed(list(block.iterancestors())))
        actions = [
            (
                etree.QName(action).localname,
                [
                    (
                        etree.QName(child).localname,
                        sorted((name, marks(value)) for name, value in child.attrib.items()),
                        marks((child.text or "").strip()),
                    )
                    for child in action
                    if isinstance(child.tag, str)
                ],
            )
            for action in block
            if isinstance(action.tag, str)
        ]
        found.append((place, sorted((name, marks(value)) for name, value in block.attrib.items()), actions))
    return found


def _cases(served, instance: str, marks: _Marks):
    """HQ's case processing of a submission, up to its case database: each case it touched, by its marked id."""
    from proof.hq import operations
    from proof.observe.sessions import stand_ins

    submission = instance.encode("utf-8")
    with served.run("case-processing"):
        processed = operations.process_case_blocks(served.unit, submission, attachments=stand_ins(submission))
    assert processed.refusal is None, processed.refusal
    return {
        marks(case_id): (
            meta.is_creation,
            meta.case.type,
            marks(meta.case.name),
            meta.case.closed,
            marks(meta.case.owner_id),
            sorted((name, marks(value)) for name, value in (meta.case.case_json or {}).items()),
            sorted((index.identifier, marks(index.referenced_id), index.relationship) for index in meta.case.indices),
        )
        for case_id, meta in processed.touched.items()
    }


def _formplayer_forms(trace):
    """Each submission Formplayer's walk sent HQ, by the title of the form it submitted."""
    found = {}
    for run in trace["runs"]:
        form = next((step["response"] for step in run["steps"] if screen_kind(step.get("response")) == "form"), None)
        for step in run["steps"]:
            for sent in step.get("submissions") or ():
                answers = (step.get("submitted") or {}).get("answers") or {}
                uploads = {
                    answers[str(attempt["ix"])]: attempt["value"]
                    for attempt in step.get("answers") or []
                    if attempt.get("media") and str(attempt["ix"]) in answers
                }
                found.setdefault(form["title"], []).append({"instance": sent["instance"], "uploads": uploads})
    return found


def _core_forms(core):
    """Each submission Core's session made, by the title of the form it submitted."""
    found = {}
    for run in core["runs"]:
        if run.get("end") != "submitted":
            continue
        last = run["trace"][-1]
        from proof.observe.sessions import unmarked_submission

        instance, _ = unmarked_submission(run)
        found.setdefault(last["title"], []).append(instance.decode("utf-8"))
    return found


def _walked(served, runner, table):
    """Formplayer's walk of the served state, its questions answered from ``table``."""
    return replace(Walk.of(served, runner=runner), answer_table=table).run()


def _core_session(core_runner, published, restore, table):
    """Core's own session over the build and restore Formplayer was served, its questions answered from
    ``table``."""
    from proof.observe.build import arrange
    from proof.observe.sessions import admitted

    with tempfile.TemporaryDirectory(prefix="proof-case-blocks-core-") as directory:
        with admitted(core_runner, arrange(published.build.files, directory)) as report:
            assert report.get("admitted") and report.get("app") is not None, report
            return core_runner.session(report["app"], restore=restore, answer_table=table)


@pytest.mark.parametrize("document_id", SUBMITTED)
def test_formplayer_submits_each_generated_groups_blocks_as_core_does(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence, document_id
):
    """For each answer table, the case blocks of a form Core submits are those of some submission of the same form
    Formplayer's walk made, and HQ processes the two to the same cases."""
    with apps.published(formplayer_documents[document_id], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            compared = {}
            for name, text in (("true", "yes"), ("false", "no")):
                table = _table(text)
                formplayer = _formplayer_forms(_walked(served, formplayer_runner, table))
                restore = served.hq.restores[0]
                core = _core_forms(_core_session(core_runner, published, restore, table))
                assert core, f"Core's session submitted no form of {document_id} with every text {text!r}."
                for title, submissions in core.items():
                    core_marks = _Marks()
                    expected = submissions[0]
                    blocks = _blocks(expected, core_marks)
                    cases = _cases(served, expected, core_marks)
                    paired = []
                    for submitted in formplayer.get(title, ()):
                        instance = submitted["instance"]
                        marks = _Marks(submitted["uploads"])
                        if _blocks(instance, marks) == blocks:
                            paired.append(_cases(served, instance, marks) == cases)
                    compared[f"{name}:{title}"] = {"core": blocks, "formplayer": formplayer.get(title, [])}
                    evidence("compared", compared)
                    assert paired, (
                        f"No submission of {title!r} Formplayer made of {document_id} with every text {text!r} holds"
                        f" the case blocks Core's does: {blocks}"
                    )
                    assert any(paired), (
                        f"HQ's case processing of Formplayer's {title!r} leaves other cases than of Core's, on"
                        f" {document_id} with every text {text!r}."
                    )
    evidence("blocks", compared)


def test_a_failing_guard_makes_formplayer_refuse_the_submission(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    """With the operation's name three spaces, the create's text guard leaves its block's ``case_id`` blank, and
    Formplayer refuses every submission of the form for that blank id and sends HQ none of them."""
    from proof.checks import stops

    with apps.published(formplayer_documents[GUARDED], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            trace = _walked(served, formplayer_runner, _table("   "))
    formed = [
        run
        for run in trace["runs"]
        if any(
            screen_kind(step.get("response")) == "form" and step["response"].get("title") == GUARDED_FORM
            for step in run["steps"]
        )
    ]
    evidence("refused", [{"end": run["end"], "cause": stops.formplayer_cause(run)} for run in formed])
    assert formed, f"Formplayer's walk of {GUARDED} reached no form {GUARDED_FORM!r}."
    for run in formed:
        assert stops.formplayer_cause(run) == BLANK_CASE_ID, run["steps"][-1].get("submit")
        assert all(not step.get("submissions") for step in run["steps"]), run["steps"][-1]
