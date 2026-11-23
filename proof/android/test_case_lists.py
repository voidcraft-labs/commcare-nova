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

- ``targeted-preview-android-renders``: a custom tile of three cells whose
  vertical alignments are top, middle and bottom, which Nova writes as
  ``start``, ``center`` and ``end``. Android matches only ``top``, ``center``
  and ``bottom`` (``views/EntityViewTile.java::computeGravity``), so only the
  middle cell takes its alignment, and a text view given no vertical gravity
  draws at the top: the top and bottom cells both read ``top``. Preview
  running as Android draws them the same way (``lib/preview/platform.ts``,
  ``tileVerticalAlign``).

Plausible failures: a search that finds every row whatever it is asked (each
finds one), a hidden field a device draws, a tile ordered by its names (the
default), two exports that differ (each assertion holds on both), and a tile
cell drawn at an alignment Preview does not draw.
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


def test_list_first_waits_for_search_on_android_with_either_default_results_preference(
    android_documents, hq
):
    """Both exported apps open the worker's list and draw the prompt before the worker presses Search."""
    from proof.android import observe
    from proof.observe.record import Blobs

    document = android_documents["targeted-search-workflow-android"]
    with _archives(document, _restored(document)) as (served, archives):
        for label, archive in archives.items():
            blobs = Blobs()
            result = observe.app(served, blobs, label=label, archive=archive)
            answer = blobs.get_json(result["answer"])
            for menu in ("m0", "m1"):
                browse = answer["walks"][menu]["steps"]
                assert browse[-1]["screen"] == LIST, (label, menu, browse)
                assert all(step["screen"] != "QueryRequestActivity" for step in browse)
                searched = answer["walks"][f"{menu}/@action:0"]["steps"]
                query = next(
                    step["query"]
                    for step in searched
                    if step["screen"] == "QueryRequestActivity"
                )
                assert query["finishingBeforePress"] is False, (label, menu, query)
                assert query["opened"] and "patient_name" in query["prompts"], (
                    label,
                    menu,
                    query,
                )


# The first rule's values, set by hand so its order is the reverse of the names'.
RANKS = {"targeted-amina-visit": "zulu", "targeted-baraka-visit": "mike", "targeted-chausiku-visit": "alpha"}
PLACED = [["Chausiku", "Lakeside"], ["Baraka", "Hilltop"], ["Amina", "Riverside"]]


def test_checkbox_search_sends_each_checked_value_on_both_archives(android_documents, hq):
    from proof.android import observe
    from proof.observe.record import Blobs

    document = android_documents["prompt-checkboxes"]
    database = _restored(document)
    database = replace(
        database, user_data=(*((k, v) for k, v in database.user_data if k != "region_group"), ("region_group", "A"))
    )
    command = "search_command.m0"
    with _archives(document, database) as (served, archives):
        for label, archive in archives.items():
            blobs = Blobs()
            result = observe.app(served, blobs, label=label, archive=archive, commands=[command])
            answer = blobs.get_json(result["answer"])
            assert answer["install"] == "Installed", label
            walk = answer["walks"][command]
            [query] = [step["query"] for step in walk["steps"] if "typed" in step.get("query", {})]
            assert query["items"]["regions"] == ["East", "North & coast"], (label, query)
            assert query["RemoteQuerySessionManager.getRawQueryParams"]["regions"] == ["north"]
            typed = query["typed"]
            assert typed["given"]["regions"] == "East"
            assert typed["RemoteQuerySessionManager.getRawQueryParams"]["regions"] == ["east", "north"]


@pytest.mark.parametrize(("document_id","period","screen_text"), [
    ("prompt-periods","__range__2024-01-01__2024-12-31","2024-01-01 to 2024-12-31"),
    ("prompt-period-fallback","awaiting dates","awaiting dates"),
    ("prompt-period-spellings","2024-01-02__2024-02-12__2024-05-21","2024-01-02__2024-02-12__2024-05-21"),
])
def test_installed_app_sends_fixed_starting_dates_on_both_archives(android_documents, hq, document_id, period, screen_text):
    from proof.android import observe
    from proof.observe.record import Blobs

    document = android_documents[document_id]
    command = "search_command.m0"
    with _archives(document, _restored(document)) as (served, archives):
        for label, archive in archives.items():
            blobs = Blobs()
            result = observe.app(served, blobs, label=label, archive=archive, commands=[command])
            answer = blobs.get_json(result["answer"])
            assert answer["install"] == "Installed", (label, answer)
            [opened] = [step["query"] for step in answer["walks"][command]["steps"]
                        if "RemoteQuerySessionManager.getRawQueryParams" in step.get("query", {})]
            params = opened["RemoteQuerySessionManager.getRawQueryParams"]
            assert params["period"] == [period], (label, opened)
            assert opened["pickerText"]["period"] == screen_text, (label, opened)
            assert set(opened["prompts"]) >= {"period", "visit_date"}, (label, opened)


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


def _gravities(view, texts):
    """Each of ``texts`` a laid-out view shows, by its text view's gravity (``Views.java::gravity``)."""
    found = {view["text"]: view["gravity"]} if view.get("text") in texts else {}
    for child in view.get("children", ()):
        found.update(_gravities(child, texts))
    return found


def test_a_tile_cell_takes_only_middle_vertical_alignment(android_documents, hq):
    """The visit list's tile draws Amina's name at the top, her village in the middle and her status ``open``,
    whose cell asked for the bottom, at the top too, on both exports."""
    document = android_documents["targeted-preview-android-renders"]
    cells = {"Amina", "Riverside", "open"}
    with _archives(document, _restored(document)) as (served, archives):
        listed = {name: _list(served, archive, name, "m1-f0", []) for name, archive in archives.items()}
    for name, held in listed.items():
        (row,) = held["rows"]
        gravities = _gravities(row, cells)
        assert set(gravities) == cells, (name, row)
        assert {text: gravity.split("|")[1] for text, gravity in gravities.items()} == {
            "Amina": "top",
            "Riverside": "center_vertical",
            "open": "top",
        }, (name, gravities)

def _visible_query_buttons(view):
    if view.get("visibility") in {"gone", "invisible"}:
        return
    if view["class"].endswith("Button"):
        yield view
    for child in view.get("children", ()):
        yield from _visible_query_buttons(child)


def test_search_on_clear_keeps_androids_search_button_without_adding_a_clear_action(android_documents, hq, evidence):
    """Install each export. Search on the Android menu opens its query, with its sole visible Search button."""
    from proof.android import observe
    from proof.observe.record import Blobs

    document = android_documents["targeted-search-workflow"]
    with _archives(document, _restored(document)) as (served, archives):
        for label, archive in archives.items():
            blobs = Blobs()
            result = observe.app(served, blobs, label=label, archive=archive, views=True)
            walked = blobs.get_json(result["answer"])["walks"]
            # Recent patients enables search-on-clear. Nearby patients keeps it off.
            for menu, prompt in (("m1", "area"), ("m2", "patient_name")):
                assert walked[menu]["steps"][-1]["screen"] == LIST, (label, menu)
                pressing_search = walked[f"{menu}/@action:0"]["steps"]
                query = next(step["query"] for step in pressing_search if step["screen"] == "QueryRequestActivity")
                assert query["opened"] and prompt in query["prompts"], (label, menu, query)
                buttons = list(_visible_query_buttons(query["controls"]))
                evidence(f"{label}-{menu}-query-buttons", buttons)
                assert query["submitButton"]["text"].strip() and buttons == [query["submitButton"]], (label, menu, buttons)
