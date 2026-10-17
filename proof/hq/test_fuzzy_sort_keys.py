"""Finding 51: a fuzzy search over a case list finds a near miss only through a field's sort key.

Core matches a misspelled search term only against the sort key a field
keeps (``util/EntitySortUtil.sortEntities``, ``cases/entity/Entity.
getSortFieldPieces``), so two exports of one list that keep their keys on
different fields find different cases for one near miss. HQ's build keeps a
key on the first field of a list with no order rule (its default sort
element, ``suite_xml/sections/details.py::get_default_sort_elements``) and
gives an order rule to the first field whose ``field`` is the rule's
(``app_manager/util.py::get_sort_and_sort_only_columns``); Nova's local
archive once kept no key on an unsorted list and kept a rule's key on the
field it was authored on.

Contract, with fuzzy search on, Core's own case list run over each archive
(the Core runner's ``evaluate``):

- on each retained control, the pre-fix archive and HQ's build of its
  retained publish differ as the finding says: over ``case-operation-query``
  a near miss of a case's name finds it on HQ's build and nothing on the
  local archive; over the second menu of ``targeted-shared-property-sort``,
  whose rule sat on a hidden column after an image map over the same
  property, ``alpah`` finds Amina on the local archive and nothing on HQ's
  build, which gave the rule to the image map, whose key is its mapping
  position;
- on each document as Nova now exports it, the local archive and HQ's build
  find the same cases for the same near miss;
- everywhere, the exact word finds its case, so a list that never finds
  anything cannot pass.

Plausible failures: a reader that does not search fuzzily (the controls'
near misses would find nothing on both), a local archive whose keys sit on
other fields than HQ's build's (the documents' searches would differ), and a
harness that opened another list than the one named (the exact word would
find nothing).
"""

from __future__ import annotations

import base64
import tempfile
from pathlib import Path

import pytest

from proof.rules.conftest import published, restore

# Each list searched: the menu's command, a word a row shows, and its near miss.
SEARCHES = {
    "case-operation-query": ("m0-f0", "proof", "proox"),
    "targeted-shared-property-sort": ("m1-f0", "alpha", "alpah"),
}


def _restore(app, document):
    """The cases the list is searched over: a targeted document's own restore, or HQ's restore of the lane's case
    database for the document, as proof 3 restores it (a control's, the one it retains)."""
    from proof.observe import casedata

    own = document.root / "restore.xml"
    if own.is_file():
        return own.read_bytes()
    return restore(app, casedata.document_case_database(document))


def _found(core_runner, archive, restored, command, term):
    """The case ids Core's case list shows for ``term`` with fuzzy search on, over an archive or a directory of its
    entries."""
    from proof.observe.sessions import admitted

    with admitted(core_runner, archive) as report:
        assert report.get("admitted") and report.get("app") is not None, report.get("problems")
        result = core_runner.evaluate(
            app=report["app"],
            restoreBase64=base64.b64encode(restored).decode("ascii"),
            session={"command": command},
            caseList={"searchText": term, "fuzzy": True},
        )
    return [row["caseId"] for row in result["caseList"]["rows"]]


def _searched(core_runner, document):
    """Each term searched on the document's local archive and on HQ's build of its publish:
    ``{term: {"local": [...], "hq": [...]}}``."""
    from proof.checks import proof3

    command, word, near_miss = SEARCHES[document.id]
    with published(document, core_runner) as app:
        built = app.spell().build
        assert built.files is not None and not built.raised, built.raised
        restored = _restore(app, document)
        with tempfile.TemporaryDirectory(prefix="proof-fuzzy-sort-keys-") as directory:
            arranged = proof3.arrange_build(built.files, Path(directory) / "build")
            return {
                term: {
                    "local": _found(core_runner, document.local_ccz, restored, command, term),
                    "hq": _found(core_runner, arranged, restored, command, term),
                }
                for term in (word, near_miss)
            }


@pytest.mark.parametrize("document_id", sorted(SEARCHES))
def test_a_near_miss_finds_its_case_on_one_export_of_a_control_and_alike_on_both_of_the_document(
    hq, core_runner, documents, hq_controls, document_id
):
    _, word, near_miss = SEARCHES[document_id]
    control = _searched(core_runner, hq_controls[document_id])
    emitted = _searched(core_runner, documents[document_id])

    for found in (control, emitted):
        assert found[word]["local"] and found[word]["local"] == found[word]["hq"], found[word]
    # The control's two exports keep the key on different fields, so the near miss finds its case on one alone.
    if document_id == "case-operation-query":
        assert control[near_miss]["local"] == [] and control[near_miss]["hq"], control[near_miss]
    else:
        assert control[near_miss]["local"] and control[near_miss]["hq"] == [], control[near_miss]
    # Nova's exports keep their keys where HQ's build does, so the same near miss finds the same cases.
    assert emitted[near_miss]["local"] == emitted[near_miss]["hq"], emitted[near_miss]
