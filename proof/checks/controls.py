"""Retaining a control: one document's inputs, kept so each check keeps showing the symptoms its register entries
name there after the emitter that made them is fixed (plan decision 12).

A control (``proof/controls/<name>/``, the document's id unless it is retained
under another name) is the corpus layout
(``proof.checks.corpus``) of the files its checks read:

- ``configurations.json`` and ``verdict.json`` (and ``edit/verdict.json``);
- each captured request of every publish, its body and sidecar and the
  workbook and media upload a sidecar names (``export/<configuration>/``,
  ``edit/export/<configuration>/``);
- the edit (D′'s verdict and publishes, and its batch as its checks read
  it: its footprint, ``edit/batch.json``'s ``footprint`` and
  ``footprintParts``, without the mutations Nova's planner wrote, whose shape
  is Nova's), where a check that reads B-edit or the edit's footprint names
  the control (``EDIT_READERS``);
- each local archive (``local.ccz``, ``local-again.ccz``, ``edit/local.ccz``,
  and ``local-empty-list-text.ccz``, the archive compiled for a configuration
  that holds the empty-list text flag, kept as ``local.ccz`` is), where a
  check that reads that archive names the control (``ARCHIVE_READERS``);
- a targeted document's ``expected.json`` and every other file of its own
  (the restores its expectations name);
- in place of ``document.json`` and ``edit/document.json``, whose ``doc`` is
  Nova's persistable shape, which a later cutover changes, what the checks
  derive from D and D' (``derived.json``, ``derived``): the wire layout and
  languages, the intent (``intent.intent_json``), the lookup tags and the
  case database (``casedata.database_json``) and effective case-property
  types from the emitted catalog. Each is read where a check reads it of a
  document (``Document.derived``).

Never ``inputs.json``: a control's part keys and the evidence store's guard
read its input files from the files themselves
(``proof.observe.unit.input_files``, ``computed_inputs``), so a control edited
by hand is keyed and guarded by what it holds, and its observation and
judgments are stored as a document's are; nor an export's ``outcome.json``,
which no check reads.

A directory a fixed-defect entry or a held stop's ``control`` entry
(``proof/walk-stops.json``) names is never retained again: its bytes are the
pre-fix inputs that entry must keep showing on (``retain`` refuses it). A
remaining defect whose symptom moves on such a document gets a control of its
own, retained under a new name (``--as``).

    python3 -m proof.checks.controls <corpus directory> <document id> <check>[,<check>...] [<controls directory>]
        [--as <control name>]
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from proof.checks import corpus, registers, stops
from proof.checks.intent import document_intent, intent_json
from proof.checks.proof1 import lookup_tags
from proof.observe.casedata import case_database, database_json

# The checks that read a document's edit: B-edit's publish, build and editors (the bar, the intent and manifest
# checks, proofs 1 and 4) and the edit's footprint (proofs 1 and 5). Proof 2, proof 3 and configuration
# sensitivity read A and B alone, so a control none of these checks names keeps no edit, and the unit observes
# no B-edit for it.
EDIT_READERS = frozenset({"bar", "intent", "manifest", "proof1", "proof4", "proof5"})
EDIT = "edit/"
# The checks that read each local archive: the bar admits each, the intent check parses each one's forms (and runs
# a targeted document's local expectations on local.ccz), and the manifest check reads each one's use of the
# surface; proof 1 compares the two exports of D, proof 3 runs local.ccz, and proof 5 compares local.ccz with
# edit/local.ccz. The archive compiled for a configuration holding the empty-list text flag is local.ccz's export
# for that configuration's project space, which proof 3 runs under it, so it is kept as local.ccz is.
ARCHIVE_READERS = {
    "local.ccz": frozenset({"bar", "intent", "manifest", "proof1", "proof3", "proof5"}),
    "local-again.ccz": frozenset({"bar", "intent", "manifest", "proof1"}),
    "edit/local.ccz": frozenset({"bar", "intent", "manifest", "proof5"}),
    corpus.EMPTY_LIST_TEXT_ARCHIVE: frozenset({"bar", "intent", "manifest", "proof1", "proof3", "proof5"}),
}
# What a control never keeps: the input manifest, each export's outcome, and D's and D''s documents.
NOT_KEPT = frozenset({"inputs.json", "document.json", "edit/document.json"})
NOT_KEPT_NAMES = frozenset({"outcome.json"})
BATCH = "edit/batch.json"
BATCH_KEYS = ("footprint", "footprintParts")


def derived(document, *, edit=True) -> dict:
    """What the checks derive from a corpus document's D (and D', where the control keeps the edit: ``edit``), as a
    control retains it (``corpus.DERIVED``)."""

    def of(document_json, *, edit=False):
        return {
            "wire": document_json.get("wire"),
            "intent": intent_json(document_intent(document_json)),
            "lookupTags": lookup_tags(document_json),
            "caseDatabase": database_json(case_database(document_json)),
            "caseTypes": document.case_types(edit=edit),
        }

    found = {"D": of(document.document)}
    if edit and document.edit is not None:
        found["D'"] = of(document.edit_document, edit=True)
    return found


def keeps_edit(checks) -> bool:
    """Whether a control for ``checks`` keeps its document's edit: some check of them reads it (``EDIT_READERS``)."""
    return bool(set(checks) & EDIT_READERS)


def kept(document, checks) -> list:
    """The files of a corpus document a control for ``checks`` keeps, by their path in its directory: each a check
    of them reads (``EDIT_READERS``, ``ARCHIVE_READERS``), and never what no check reads (``NOT_KEPT``)."""
    checks = set(checks)
    edit = keeps_edit(checks)
    found = []
    for path in sorted(p for p in document.root.rglob("*") if p.is_file()):
        relative = path.relative_to(document.root).as_posix()
        if relative in NOT_KEPT or path.name in NOT_KEPT_NAMES:
            continue
        if relative in ARCHIVE_READERS and not checks & ARCHIVE_READERS[relative]:
            continue
        if relative.startswith(EDIT) and not edit:
            continue
        found.append(relative)
    return found


def retain(document, checks, into: Path, *, name=None) -> Path:
    """A control of ``document`` (a corpus document) for ``checks``, written into ``into/<name>``, the document's id
    unless ``name`` names another. A name a fixed-defect entry's control names, or a held stop's ``control`` entry,
    is refused: that directory holds the pre-fix bytes the entry must keep showing on, which a retention would
    replace."""
    if document.kind != "corpus":
        raise corpus.CorpusLayoutError(f"{document.root} is a {document.kind}; a control retains a corpus document.")
    name = document.id if name is None else name
    if not name or "/" in name or name in (".", ".."):
        raise corpus.CorpusLayoutError(f"A control's name is one directory name, and {name!r} is not one.")
    fixed = sorted(entry.id for entry in registers.load_fixed_defects() if entry.control == name)
    held = sorted(f"{entry.reader} {entry.cause}" for entry in stops.load() if entry.control == name)
    if fixed or held:
        holders = [f"the fixed-defect entries {', '.join(fixed)}"] if fixed else []
        holders += [f"the held stops {', '.join(held)} of proof/walk-stops.json"] if held else []
        raise corpus.CorpusLayoutError(
            f"The control {name} holds the pre-fix bytes {' and '.join(holders)} keep showing on, so it is never"
            " retained again. Retain the document under a new name (--as <control name>) and point the entries that"
            " need its new bytes at that one."
        )
    target = Path(into) / name
    if target.exists():
        shutil.rmtree(target)
    for relative in kept(document, checks):
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if relative == BATCH:
            batch = json.loads((document.root / relative).read_text(encoding="utf-8"))
            held = {key: batch[key] for key in BATCH_KEYS if key in batch}
            destination.write_text(json.dumps(held, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
        else:
            shutil.copyfile(document.root / relative, destination)
    (target / corpus.DERIVED).write_text(
        json.dumps(derived(document, edit=keeps_edit(checks)), indent="\t", ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return target


def main(argv):
    argv, name = list(argv), None
    if "--as" in argv:
        at = argv.index("--as")
        name = argv[at + 1] if at + 1 < len(argv) and not argv[at + 1].startswith("-") else ""
        del argv[at : at + 2]
    if len(argv) not in (3, 4) or name == "" or "--as" in argv:
        print(__doc__.rsplit("\n\n", 1)[-1].strip(), file=sys.stderr)
        return 2
    root, document_id, checks = Path(argv[0]), argv[1], argv[2].split(",")
    into = Path(argv[3]) if len(argv) == 4 else corpus.CONTROLS_DIR
    document = corpus.load(root).document(document_id)
    print(retain(document, checks, into, name=name))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
