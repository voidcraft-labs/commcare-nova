"""What CommCare Android makes of a list's hidden columns, on HQ's build and on Nova's local archive.

Contract (``proof/android/README.md``, "Checks"): each test reads a corpus
document as the pull request's own emitter wrote it, published as the
corpus captured it (``proof.rules.conftest.published``), released and served
by HQ's own views with the cases the document's own restore fixes
(``proof.formplayer.hq.serve`` over ``proof.observe.casedata.
database_of_restore``, which gives every case to the lane's worker), and
installed twice on a device whose network is HQ's views over that state
(``observe.app``): HQ's download of the release (``observe.release_archive``),
which a worker installs from HQ, and the document's local archive naming the
app HQ holds (``proof.observe.served.local_archive``), which a worker
downloads. Each list the walk opens is searched for the test's terms
(``searches``) with fuzzy search as installed, on and off
(``Lists.java::searched``); a search's result is the first text of each row it
finds.

- ``targeted-hidden-column``: a column hidden from Results is a field of the
  list on both exports, HQ's ``invisible`` column, and Core's search matches
  every field's text (``util/EntitySortUtil.sortEntities``), so a search for
  ``Riverside``, which only the hidden column holds, finds Amina's row alone.
- ``targeted-tile-hidden-order``: a tile list's order rules on two columns
  hidden from Results are sort rows with no stored column, for which HQ's
  build and the local archive append a zero-width field with no cell.
  ``rank`` is set by hand so the first rule's order is the reverse of the
  names', and the served worker owns every case, so the owner rule ties.
  The rows come Chausiku, Baraka, Amina; each row lays out its two placed
  cells and no other; the Sort menu lists Name and Village alone; and a
  search for ``zulu``, which no placed cell holds, finds Amina's row alone.

Plausible failures: a search that finds every row whatever it is asked (each
finds one), a hidden field a device draws, a tile ordered by its names (the
default), and two exports that differ (each assertion holds on both).
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace

import pytest

pytestmark = pytest.mark.reader("android")

LIST = "EntitySelectActivity"
FUZZY = ("asInstalled", "fuzzyOn", "fuzzyOff")


@contextmanager
def _archives(document, database):
    """HQ's release of ``document`` served over ``database``, and the two archives a worker installs of it:
    ``(served, {"hq": ..., "local": ...})``."""
    from proof.android import observe
    from proof.formplayer import hq as formplayer_hq
    from proof.observe.served import local_archive
    from proof.rules.conftest import published

    with (
        published(document, None) as app,
        formplayer_hq.serve(app.unit, document, app.app_id, database=database) as served,
    ):
        yield served, {"hq": observe.release_archive(served), "local": local_archive(document.local_ccz, app.app_id)}


def _restored(document):
    from proof.observe import casedata

    return casedata.database_of_restore((document.root / "restore.xml").read_bytes())


def _list(served, archive, label, command, searches):
    """The first list the walk of ``command`` opens on a device that installed ``archive``."""
    from proof.android import observe
    from proof.observe.record import Blobs

    blobs = Blobs()
    found = observe.app(served, blobs, label=label, archive=archive, commands=[command], searches=searches)
    answer = blobs.get_json(found["answer"])
    assert answer["install"] == "Installed", answer["install"]
    walk = answer["walks"][command]
    raised = walk.get("raised") or {}
    assert "steps" in walk, f"the walk raised {raised.get('class')}: {raised.get('stack', '')[:3000]}"
    (first, *_) = [step["list"] for step in walk["steps"] if step["screen"] == LIST]
    return first


def _texts(view):
    """Every text a laid-out view shows, in the order its tree holds them."""
    found = [view["text"]] if view.get("text") else []
    for child in view.get("children", ()):
        found.extend(_texts(child))
    return found


def _searched(listed, term):
    """What a search for ``term`` found, with fuzzy search as installed, on and off."""
    return {setting: listed["searches"][setting][term] for setting in FUZZY}


def test_a_list_search_finds_a_hidden_columns_value_on_both_exports(android_documents, hq):
    document = android_documents["targeted-hidden-column"]
    with _archives(document, _restored(document)) as (served, archives):
        listed = {name: _list(served, archive, name, "m0-f0", ["Riverside"]) for name, archive in archives.items()}
    for name, held in listed.items():
        assert _searched(held, "Riverside") == {setting: ["Amina"] for setting in FUZZY}, name


# The first rule's values, set by hand so its order is the reverse of the names'.
RANKS = {"targeted-amina-visit": "zulu", "targeted-baraka-visit": "mike", "targeted-chausiku-visit": "alpha"}
PLACED = [["Chausiku", "Lakeside"], ["Baraka", "Hilltop"], ["Amina", "Riverside"]]


def _ranked(database):
    return replace(
        database,
        cases=tuple(
            replace(
                case,
                properties=tuple(
                    (name, RANKS[case.case_id] if name == "rank" else value) for name, value in case.properties
                ),
            )
            for case in database.cases
        ),
    )


def test_a_tiles_hidden_order_rules_order_the_rows_and_are_searched(android_documents, hq):
    document = android_documents["targeted-tile-hidden-order"]
    with _archives(document, _ranked(_restored(document))) as (served, archives):
        listed = {name: _list(served, archive, name, "m0-f0", ["zulu"]) for name, archive in archives.items()}
    for name, held in listed.items():
        # The first rule orders the rows, and each row lays out its two placed cells and no other.
        assert [_texts(row) for row in held["rows"]] == PLACED, name
        # The Sort menu offers the placed columns alone: the carriers have no header.
        assert held[f"{LIST}.getSortOptionsList"] == ["Name", "Village"], name
        # Only the first hidden column holds zulu, and the search finds Amina's row alone.
        assert _searched(held, "zulu") == {setting: ["Amina"] for setting in FUZZY}, name
