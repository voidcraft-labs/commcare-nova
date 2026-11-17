"""The judge of the changes Nova's review lists for the next publish, over planted evidence, with no HQ.

Contract (``proof.checks.changes``): on a document whose saves in CommCare HQ
are brought in, proofs 1 to 3 accept exactly the differences a row of a change
the review listed names, by check, artifact, structural path and kind; a
difference only a row of a change the review did not list matches is
``/<id>/unsaid``; a listed change that matches nothing is ``/<id>/unseen``,
but where every row of it names a served reader's artifact and the run
observes no served reader, or names a check the judge was not handed; nothing
applies on a document that brings nothing in, or on a control. The register's
own rows for ``media-files-renamed`` hold the differences
``targeted-hq-changes-media`` showed, a picture's reference moved from the
path of the bytes Nova published to the path of the bytes the person put in
its place, and none beside them. The plausible failures: a difference absorbed
on a document whose review never mentioned it, a change declared in vain, a
row wider than the move it names, and a served reader's change failed with
the readers off or skipped with them on.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from proof.checks import changes
from proof.checks.differences import Difference

DOCUMENT = "targeted-hq-changes-media"
OLD = "jr://file/commcare/50a8af47cc2e68f022bfb93e26be925081df6d21b3d4c276cdabdbd8d31de83d.png"
NEW = "jr://file/commcare/c5f74c6dda51d3941b4d17d05991f900debbf387ff748eda65d2f03dda227b2e.png"
OLD_NAME = OLD.rsplit("/", 1)[1]
NEW_NAME = NEW.rsplit("/", 1)[1]
ITEXT = "/html/head[*]/model[*]/itext[*]/translation[@lang=*]/text[@id=*]/value[@form=image]/text()"
IMAGE = "/runs/*/trace/*/events/*/image"


def _pointer(path):
    return path.replace("~", "~0").replace("/", "~1")


def _moved():
    """What proofs 1, 2 and 3 showed on ``targeted-hq-changes-media`` under one configuration: the picture's
    reference moved from the path of Nova's bytes to the path of the person's, on A against B and on A against the
    local archive, which is the document the bring-in gave."""
    return {
        "proof1": [
            Difference(
                "proof1",
                DOCUMENT,
                "app.json",
                "/multimedia_map/*",
                f"/multimedia_map/{_pointer(OLD)}",
                "removed",
                {},
                None,
            ),
            Difference(
                "proof1",
                DOCUMENT,
                "app.json",
                "/multimedia_map/*",
                f"/multimedia_map/{_pointer(NEW)}",
                "added",
                None,
                {},
            ),
            Difference(
                "proof1",
                DOCUMENT,
                "app.json",
                "/modules/*/forms/*/media/*",
                f"/modules/0/forms/0/media/{_pointer(OLD)}",
                "removed",
                {"mapped": True},
                None,
            ),
            Difference(
                "proof1",
                DOCUMENT,
                "app.json",
                "/modules/*/forms/*/media/*",
                f"/modules/0/forms/0/media/{_pointer(NEW)}",
                "added",
                None,
                {"mapped": True},
            ),
        ],
        "proof2": [
            Difference(
                "proof2",
                DOCUMENT,
                "form:0.0",
                ITEXT,
                "/html/head[1]/model[1]/itext[1]/translation[@lang=en]/text[@id=note-label]/value[@form=image]/text()",
                "changed",
                OLD,
                NEW,
            ),
            Difference(
                "proof2",
                DOCUMENT,
                "media_suite.xml",
                "/suite/media[*]/resource[@id=*]",
                f"/suite/media[1]/resource[@id=media-07a8e9c6c3fda495a7ba1a43892c5b38-{OLD_NAME}]",
                "removed",
                "<resource/>",
                None,
            ),
            Difference(
                "proof2",
                DOCUMENT,
                "media_suite.xml",
                "/suite/media[*]/resource[@id=*]",
                f"/suite/media[1]/resource[@id=media-07a8e9c6c3fda495a7ba1a43892c5b38-{NEW_NAME}]",
                "added",
                None,
                "<resource/>",
            ),
        ],
        "proof3": [
            Difference("proof3", DOCUMENT, "trace@B", IMAGE, "/runs/0/trace/2/events/0/image", "changed", OLD, NEW),
            Difference(
                "proof3", DOCUMENT, "trace@local.ccz", IMAGE, "/runs/0/trace/2/events/0/image", "changed", OLD, NEW
            ),
        ],
    }


def _document(*listed, kind="corpus"):
    return SimpleNamespace(id=DOCUMENT, kind=kind, next_publish=tuple(listed))


def _all(checked):
    return [difference for found in checked.values() for difference in found]


def _paths(found):
    return sorted(difference.path for difference in found)


def test_the_register_s_rows_hold_the_move_the_media_document_showed_where_its_review_lists_it():
    register = changes.load()
    checked = _moved()
    document = _document("media-files-renamed")
    for check, found in checked.items():
        held, ids = changes.declared(document, check, found, register=register)
        assert held == found and ids == {"media-files-renamed"}, check
        assert changes.undeclared(document, check, found, register=register) == []
    assert changes.differences(document, checked, readers=frozenset(), register=register) == []


def test_the_rows_hold_nothing_beside_the_move():
    """A difference of the same document and checks the move does not make stays for the register: another
    question's picture form, a sound in place of a picture, a form's namespace, an entry's suite resource."""
    register = changes.load()
    beside = [
        Difference(
            "proof1", DOCUMENT, "app.json", "/modules/*/forms/*/xmlns", "/modules/0/forms/0/xmlns", "changed", "a", "b"
        ),
        Difference(
            "proof1",
            DOCUMENT,
            "app.json",
            "/multimedia_map/*/multimedia_type",
            f"/multimedia_map/{_pointer(NEW)}/multimedia_type",
            "changed",
            "a",
            "b",
        ),
        Difference("proof2", DOCUMENT, "form:0.1", ITEXT, "/html/head[1]", "changed", OLD, NEW),
        Difference(
            "proof2", DOCUMENT, "form:0.0", ITEXT.replace("image", "audio"), "/html/head[1]", "changed", OLD, NEW
        ),
        Difference(
            "proof2",
            DOCUMENT,
            "suite.xml",
            "/suite/xform[*]/resource[@id=*]",
            "/suite/xform[1]",
            "removed",
            "<resource/>",
            None,
        ),
        Difference(
            "proof3",
            DOCUMENT,
            "trace@B",
            "/runs/*/trace/*/events/*/audio",
            "/runs/0/trace/2/events/0/audio",
            "changed",
            OLD,
            NEW,
        ),
    ]
    document = _document("media-files-renamed")
    for difference in beside:
        held, ids = changes.declared(document, difference.check, [difference], register=register)
        assert held == [] and ids == frozenset(), difference.describe()


def test_the_same_move_where_the_review_lists_nothing_is_held_by_nothing_and_reported_unsaid():
    register = changes.load()
    checked = _moved()
    document = _document()
    for check, found in checked.items():
        assert changes.declared(document, check, found, register=register) == ([], frozenset())
        assert changes.undeclared(document, check, found, register=register) == found
    found = changes.differences(document, checked, readers=frozenset(), register=register)
    assert {difference.path for difference in found} == {"/media-files-renamed/unsaid"}
    assert len(found) == len(_all(checked))


def test_a_listed_change_that_shows_nothing_is_unseen():
    register = changes.load()
    found = changes.differences(
        _document("media-files-renamed"),
        {"proof1": [], "proof2": [], "proof3": []},
        readers=frozenset(),
        register=register,
    )
    assert _paths(found) == ["/media-files-renamed/unseen"]
    assert "media-files-renamed" in changes.unseen_message(DOCUMENT, found[0])


def test_no_change_applies_on_a_control_or_on_a_document_that_brings_nothing_in():
    register = changes.load()
    checked = _moved()
    on_control = _document("media-files-renamed", kind="control")
    nova = SimpleNamespace(id="nova", kind="corpus")
    for document in (on_control, nova):
        for check, found in checked.items():
            assert changes.declared(document, check, found, register=register) == ([], frozenset())


REGISTER = changes.parse(
    [
        {
            "change": "media-files-renamed",
            "rows": [
                {"check": "source", "artifact": "app.json", "path": "/multimedia_map/*"},
                {"check": "proof1", "artifact": "app.json", "path": "/multimedia_map/*", "kind": "removed"},
            ],
        },
        {"change": "location-list-setting-reset", "rows": [{"check": "source", "artifact": "app.json", "path": "/x"}]},
        {
            "change": "hidden-values-added",
            "rows": [{"check": "proof3", "artifact": "formplayer@B", "path": "/runs/*/screens"}],
        },
    ]
)


def test_a_row_names_one_kind_and_one_check():
    document = _document("media-files-renamed")
    removed, added = _moved()["proof1"][:2]
    # The added map entry is held by no row: the proof 1 row names the removed kind alone, and the source row, whose
    # pointer covers the entry's, names another check.
    assert changes.declared(document, "proof1", [removed, added], register=REGISTER) == (
        [removed],
        frozenset({"media-files-renamed"}),
    )


def test_a_listed_change_the_judge_has_no_check_for_is_left_to_the_judge_that_has():
    """A change every row of which names ``source`` is held only by a judge handed the stored-app comparison."""
    document = _document("location-list-setting-reset")
    proofs = {"proof1": [], "proof2": [], "proof3": []}
    assert changes.differences(document, proofs, readers=frozenset(), register=REGISTER) == []
    found = changes.differences(document, {**proofs, "source": []}, readers=frozenset(), register=REGISTER)
    assert _paths(found) == ["/location-list-setting-reset/unseen"]


def test_a_served_reader_s_change_is_left_to_the_readers_and_held_with_them():
    document = _document("hidden-values-added")
    proofs = {"proof1": [], "proof2": [], "proof3": []}
    assert changes.differences(document, proofs, readers=frozenset(), register=REGISTER) == []
    found = changes.differences(document, proofs, readers=frozenset({"formplayer"}), register=REGISTER)
    assert _paths(found) == ["/hidden-values-added/unseen"]


def test_the_register_loads_and_refuses_what_the_judge_cannot_hold():
    """``proof/first-publish-changes.json`` loads as the judge reads it, and the loader refuses two objects of one
    change, two rows of one class in an object, a row of any check but the four, and a kind outside the five."""
    held = changes.load()
    assert held and len({change.change for change in held}) == len(held)
    assert all(row.check in changes.ROW_CHECKS for change in held for row in change.rows)
    row = {"check": "source", "artifact": "app.json", "path": "/name"}
    for refused, says in (
        ([{"change": "a", "rows": []}, {"change": "a", "rows": []}], "two objects of the change a"),
        ([{"change": "a", "rows": [row, row]}], "twice"),
        ([{"change": "a", "rows": [{**row, "check": "intent"}]}], "names the check 'intent'"),
        ([{"change": "a", "rows": [{**row, "kind": "moved"}]}], "left out for every kind"),
    ):
        with pytest.raises(changes.ChangesError, match=says):
            changes.parse(refused)
    assert changes.parse([{"change": "a", "rows": [row]}])[0].rows[0].path == "/name"


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def test_the_rows_command_prints_each_unheld_class_of_a_document_s_evidence_once(tmp_path):
    moved = _moved()
    removed, added = moved["proof1"][:2]
    image = moved["proof3"][0]
    evidence = {"proof1": [removed, added], "proof3": [image, image]}
    for check, found in evidence.items():
        _write(
            tmp_path / "blocks" / "b1" / "checks" / check / f"corpus-{DOCUMENT}.json",
            {"check": check, "document": DOCUMENT, "differences": [d.as_json() for d in found]},
        )
    _write(tmp_path / "corpus" / DOCUMENT / "hq-side.json", {"republish": "brings-in", "publishChanges": []})
    printed = changes.rows(tmp_path, DOCUMENT, register=REGISTER)
    assert printed == [
        {"check": "proof1", "artifact": "app.json", "path": "/multimedia_map/*", "kind": "removed"},
        {"check": "proof1", "artifact": "app.json", "path": "/multimedia_map/*", "kind": "added"},
        {"check": "proof3", "artifact": "trace@B", "path": IMAGE, "kind": "changed"},
    ]
    # Where the review lists the change, what its rows hold is no longer printed.
    _write(
        tmp_path / "corpus" / DOCUMENT / "hq-side.json",
        {"republish": "brings-in", "publishChanges": ["media-files-renamed"]},
    )
    assert changes.rows(tmp_path, DOCUMENT, register=REGISTER) == printed[1:]
