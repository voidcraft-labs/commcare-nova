"""What the corpus checks run over, and how each holds its differences to the register.

Each corpus check is one test per document (``document_params``): it runs
every scenario the document carries (each configuration it is exported
under, its edit, its local exports) and reports the complete set of
differences it finds. ``hold`` then holds that set to the known-defect
register (decision 12) and writes it to ``$PROOF_OUT/checks/<check>/``:
every difference must fall in a registered class, and every entry naming
the document and the check must match one of them. That evidence, from
every shard, is what ``python -m proof.checks.registers verify`` reads to
hold the whole run to the register.

A control (``proof/controls/<document id>/``, the retained inputs of one
document, ``proof.checks.controls``) is run by each check a register entry
naming it names (``control_params``), and there every such entry must match:
the check keeps showing the symptom on the retained pre-fix inputs.
"""

from __future__ import annotations

import json
import os
from dataclasses import replace
from functools import cache
from pathlib import Path

import pytest

from proof.checks import corpus, registers
from proof.checks.differences import sorted_differences


@cache
def load_corpus():
    return corpus.load(corpus.corpus_root())


@cache
def load_register():
    """The register, its entries held to every document the corpus emitted: an entry naming one the run's sample
    leaves out is held on its control alone (``proof.checks.registers.verify_evidence``)."""
    documents = load_corpus().emitted
    return registers.load_known_defects(
        documents={document.id for document in documents},
        targeted={document.id for document in documents if document.targeted},
        # A fuzz document's source is ``fuzz:<generator>:<seed>:<index>`` (proof/corpus/entryWriter.ts::sourceName).
        fuzz={document.id for document in documents if document.source.startswith("fuzz:")},
    )


def document_params():
    return [pytest.param(document, id=document.id) for document in load_corpus().documents]


def control_params(check):
    """The controls whose register entry this check shows, as parameters; none until an entry names one."""
    by_control = {entry.control: entry for entry in load_register() if entry.check == check}
    return [
        pytest.param(document, id=f"control-{document.id}")
        for document in corpus.load_controls()
        if document.id in by_control
    ]


def evidence(check, document, differences, **extra):
    """The check's differences on one document, written for the lane's artifacts."""
    out = os.environ.get("PROOF_OUT")
    if not out:
        return
    directory = Path(out, "checks", check)
    directory.mkdir(parents=True, exist_ok=True)
    record = {"check": check, "document": document.id, "kind": document.kind, **extra}
    record["differences"] = [difference.as_json() for difference in sorted_differences(differences)]
    (directory / f"{document.kind}-{document.id}.json").write_text(
        json.dumps(record, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8"
    )


def hold(check, document, differences, entries, **extra):
    """Hold one check's differences on one document (or control) to the register.

    These are the shards' own differences, so they are held to the entries the shards' checks show
    (``registers.LANE``): an entry of the Android stage (an ``android@...`` artifact) is held by that stage's
    own judge of this check over what CommCare Android read (``proof.android.stage``), which reads the records
    this check's document observed. A control only such entries name is run here for those records, and holds
    nothing of this stage.
    """
    if check not in registers.HELD_CHECKS:
        raise AssertionError(
            f"{check} holds its differences to the register, and registers.HELD_CHECKS does not list it, so the"
            " register would refuse every entry naming it. List it there with its test."
        )
    evidence(check, document, differences, **extra)
    named = [entry for entry in entries if entry.control == document.id and entry.check == check]
    entries = registers.of_stage(entries, registers.LANE)
    if document.kind == "control":
        owners = [entry for entry in entries if entry.control == document.id and entry.check == check]
        if named and not owners:
            return
        # A control retains its targeted document's inputs, so an entry's pinned values hold there too.
        unseen = [
            entry
            for entry in owners
            if not any(entry.matches(replace(d, document=entry.document)) for d in differences)
        ]
        assert owners and not unseen, (
            f"The control {document.id} no longer shows the symptom its register entries name"
            f" ({[f'{e.id}: {e.check} {e.artifact} {e.path}' for e in unseen or owners]}); {check} must keep"
            " seeing each on the retained pre-fix inputs."
        )
        return
    result = registers.reconcile(check, document.id, differences, entries)
    assert result.holds, result.explain()
