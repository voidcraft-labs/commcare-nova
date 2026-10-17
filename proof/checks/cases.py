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

A control (``proof/controls/<name>/``, the retained inputs of one document,
``proof.checks.controls``) is run by each check a known-defect or fixed-defect
entry naming it names (``control_params``), and there every such entry must
match: the check keeps showing the symptom on the retained pre-fix inputs.

A document heavy enough is observed in pieces (``proof.lane.blocks``): each
configuration by an item of its own (``piece_params``, the items of
``proof/checks/pieces.py``), before the document's checks, which then read
what the pieces kept (``proof.checks.observations``).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from functools import cache
from pathlib import Path

import pytest

from proof.checks import corpus, registers
from proof.checks.differences import sorted_differences
from proof.checks.sharding import PIECES_ENVIRONMENT


@cache
def load_corpus():
    return corpus.load(corpus.corpus_root())


@cache
def _known_entries():
    """The whole known-defect register, its entries held to every document the corpus emitted."""
    documents = load_corpus().emitted
    return registers.load_known_defects(
        documents={document.id for document in documents},
        targeted={document.id for document in documents if document.targeted},
        # A fuzz document's source is ``fuzz:<generator>:<seed>:<index>`` (proof/corpus/entryWriter.ts::sourceName).
        fuzz={document.id for document in documents if document.source.startswith("fuzz:")},
    )


@cache
def load_register():
    """The register this run holds its checks to, its entries held to every document the corpus emitted: an entry
    naming one the run's sample leaves out is held on its control alone
    (``proof.checks.registers.verify_evidence``). A run that observes only some readers, or none
    (``PROOF_READERS``, ``proof.lane.readers``), holds every entry but those whose artifacts the readers it does not
    observe write, which it cannot show and the nightly holds (``registers.held_entries``)."""
    from proof.lane import readers

    return registers.held_entries(_known_entries(), readers=readers.named())


@cache
def load_fixed():
    """The fixed register's entries this run holds on their controls: every one but those whose artifacts the
    readers it does not observe write (``registers.held_entries``), each checked against the whole known-defect
    register, whose ids none may carry."""
    from proof.lane import readers

    fixed = registers.load_fixed_defects(known=_known_entries())
    return registers.held_entries(fixed, readers=readers.named())


def document_params():
    return [pytest.param(document, id=document.id) for document in load_corpus().documents]


def control_params(check):
    """The controls a held entry of this check names, known or fixed, as parameters; none until an entry names
    one."""
    named = {entry.control for entry in (*load_register(), *load_fixed()) if entry.check == check}
    return [
        pytest.param(document, id=f"control-{document.id}")
        for document in corpus.load_controls()
        if document.id in named
    ]


@dataclass(frozen=True)
class Piece:
    """One configuration of one document or control, observed by a group of its own."""

    document: object
    configuration: str

    @property
    def group(self) -> str:
        return f"{self.document.group}@{self.configuration}"

    @property
    def id(self) -> str:
        """The item's id, which ``proof.checks.sharding.piece_item`` writes from the group's name alone."""
        prefix = "control-" if self.document.kind == "control" else ""
        return f"{prefix}{self.document.id}@{self.configuration}"


def queued_pieces(environ=None) -> frozenset[str] | None:
    """The pieces the lane's main queue names (``PROOF_LANE_PIECES``, which the lane's server sets where its queue
    names any), or None where no queue is named."""
    path = (os.environ if environ is None else environ).get(PIECES_ENVIRONMENT)
    if not path:
        return None
    queue = json.loads(Path(path).read_text(encoding="utf-8"))
    return frozenset(
        queued["group"] for block in queue["blocks"] for queued in block["groups"] if "@" in queued["group"]
    )


def pieces(documents, controls, named: frozenset[str] | None) -> list[Piece]:
    """Every piece of ``documents`` and ``controls`` that ``named`` holds (every one, where it is None)."""
    wholes = None if named is None else {name.partition("@")[0] for name in named}
    found = [
        Piece(document, configuration)
        for document in [*documents, *controls]
        if wholes is None or document.group in wholes
        for configuration in sorted(document.exports)
    ]
    return [piece for piece in found if named is None or piece.group in named]


def piece_params():
    """The pieces ``proof/checks/pieces.py`` gives an item each: those the lane's queue names, each of which the
    corpus or the controls must hold; with no queue, every configuration of every document and control, for a
    person who names one by hand."""
    named = queued_pieces()
    found = pieces(load_corpus().documents, corpus.load_controls(), named)
    missing = sorted((named or frozenset()) - {piece.group for piece in found})
    if missing:
        raise AssertionError(
            f"The queue {os.environ[PIECES_ENVIRONMENT]} names the pieces {', '.join(missing[:5])}"
            + (f" and {len(missing) - 5} more" if len(missing) > 5 else "")
            + ", and the corpus and the controls hold no such document under that configuration: the queue was"
            " built over another corpus."
        )
    return [pytest.param(piece, id=piece.id) for piece in found]


def _ordered(value):
    """``value`` with every object's keys in sorted order, all the way down."""
    if isinstance(value, dict):
        return {key: _ordered(value[key]) for key in sorted(value, key=str)}
    if isinstance(value, (list, tuple)):
        return [_ordered(item) for item in value]
    return value


def evidence(check, document, differences, **extra):
    """The check's differences on one document, written for the lane's artifacts.

    What a difference quotes of a record (``before``, ``after``) and what a check adds beside its differences are
    written with each object's keys in sorted order: a record read back from the evidence store lists them so
    (it is kept as canonical JSON), where one just observed lists them as HQ built them, and the same records
    write the same bytes either way. A document judged from the store (one whose pieces observed it, among them)
    then writes the evidence the same document observed in its own group writes.
    """
    out = os.environ.get("PROOF_OUT")
    if not out:
        return
    directory = Path(out, "checks", check)
    directory.mkdir(parents=True, exist_ok=True)
    record = {"check": check, "document": document.id, "kind": document.kind}
    record.update({name: _ordered(value) for name, value in extra.items()})
    record["differences"] = [
        {**written, "before": _ordered(written["before"]), "after": _ordered(written["after"])}
        for written in (difference.as_json() for difference in sorted_differences(differences))
    ]
    (directory / f"{document.kind}-{document.id}.json").write_text(
        json.dumps(record, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8"
    )


def hold(check, document, differences, entries, **extra):
    """Hold one check's differences on one document (or control) to the register: on a control, the entries of
    ``entries`` and of the fixed register (``load_fixed``) that name it must each still show; on a document, every
    difference must fall in a class of ``entries``, and one in a fixed entry's class names that fixed defect."""
    if check not in registers.HELD_CHECKS:
        raise AssertionError(
            f"{check} holds its differences to the register, and registers.HELD_CHECKS does not list it, so the"
            " register would refuse every entry naming it. List it there with its test."
        )
    evidence(check, document, differences, **extra)
    if document.kind == "control":
        owners = [entry for entry in (*entries, *load_fixed()) if entry.control == document.id and entry.check == check]
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
    result = registers.reconcile(check, document.id, differences, entries, fixed=load_fixed())
    assert result.holds, result.explain()
