"""Proof 6's judge sees what it must, through the real reader bundle, over CommCare HQ's retained answers and planted
records, with no HQ.

Contract (``proof.checks.proof6``): over HQ's own answers for the corpus
document ``navigation-base`` after Nova's first publish (``proof/hq-reads/``),
a source with one menu's name changed gives one ``document@A`` difference at
that name and one at the id a reading gives the menu from it, and one with a
key no entry names (a key of a menu's case details) gives ``reading@A``
``/unrecognized``; a Nova-born document that differs from its reading by one
canonical pair (a menu's purpose note, which no export carries) gives none.
Over HQ's answers for the base ``hq-plain`` (``proof/hq-apps/hq-plain/``), the
same pair on a document made in HQ gives one difference at A and one at B and
none at B-edit, since D is in the reader's image and D′ is not; and a base read
under a declaration its reading does not offer gives one at
``/appSettings/runsOnlyOn``. The plausible failure: a judge that reports
nothing, or applies the canonical form where the claim is exact.

On a document whose republish runs Nova's review of a person's saves, HQ's
answer after the saves (the ``saved`` read) that reads as the review's reading
gives nothing, and one with a menu's name changed gives one
``document@saved`` difference at that name and one at the menu's id; a review that read HQ's app and
found changes and recorded no reading is refused by name, and a review that
found nothing to bring in with no reading of the app (unchanged, or the same
files), or a republish sent with no review, asks nothing; the read is told
what HQ served at each path of its media map. The ids the capture's peer
minted for a form a person adds are HQ's at that position
(``aligned_identity``). The plausible failure: a peer that models a save
otherwise than HQ stores it, which the review's verdict then rests on, passing
unseen.

With no bundle: a document whose saves are brought in is read back at B
alone, and a difference keeps the value each document holds at its path.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from proof.checks import cases, proof6

PROOF_DIR = Path(__file__).resolve().parents[1]
READS = PROOF_DIR / "hq-reads"
HQ_APPS = PROOF_DIR / "hq-apps"
PURPOSE = "A note no export carries"


def _answer(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class _Held:
    def __init__(self, parts):
        self.parts = parts
        self.a = parts.get("a")
        self.b = parts.get("b")
        self.b_aligned = None

    def part(self, name):
        return self.parts.get(name)


def _records(document_id, parts):
    return SimpleNamespace(document=document_id, configurations={"minimum": _Held(parts)}, blobs=None)


def _with_reads(label, reads):
    return {"state": {"planted": True}, "apiReads": {label: reads}}


def _planted(real, **overrides):
    """A document with ``real``'s attributes, one or more of them replaced."""
    held = {
        name: getattr(real, name)
        for name in (
            "id",
            "kind",
            "document",
            "document_path",
            "edit",
            "hq_side",
            "brings_in",
            "migration_witness",
            "hq_authored",
        )
    }
    held["exports"] = {"minimum": None}
    held.update(overrides)
    return SimpleNamespace(**held)


def _purpose(document_json):
    """``document_json`` with a purpose note on its first menu: the other member of the canonical pair
    ``purpose-notes-are-absent``, which no export carries."""
    planted = copy.deepcopy(document_json)
    doc = planted["doc"]
    doc["modules"][doc["moduleOrder"][0]]["purpose"] = PURPOSE
    return planted


# navigation-base: a Nova-born document ----------------------------------------------------------


def _navigation_reads(source=None):
    return {
        "application": _answer(READS / "reading" / "application.json"),
        "source": source or _answer(READS / "navigation-base" / "app-source.json"),
        "currentVersion": _answer(READS / "reading" / "current-version.json"),
        "media": [],
    }


def _navigation(document_json=None, source=None):
    real = cases.load_corpus().document("navigation-base")
    document = _planted(real, edit=None, hq_side=None, brings_in=None, migration_witness=False, hq_authored=False)
    if document_json is not None:
        document.document = document_json
    records = _records(real.id, {"a": _with_reads("published", _navigation_reads(source))})
    return document, records


def _with_body(answer, change):
    body = json.loads(answer["body"])
    change(body)
    return {**answer, "body": json.dumps(body)}


# A menu renamed in HQ reads back with that name and the id a reading gives a menu, the slug of its name
# (``lib/commcare/reader/assemble.ts``'s ``menu-and-form-ids-as-read``): two value differences, the name's and the
# id's, and nothing else.
RENAMED_MENU = [("/modules/*/id", "changed"), ("/modules/*/name", "changed")]


def test_a_menu_name_changed_in_hq_s_source_is_one_value_difference_at_that_name():
    def renamed(body):
        names = body["modules"][0]["name"]
        for lang in names:
            names[lang] = f"{names[lang]} (changed)"

    source = _with_body(_answer(READS / "navigation-base" / "app-source.json"), renamed)
    document, records = _navigation(source=source)
    found = proof6.differences(document, records)
    assert [(d.artifact, d.path, d.kind) for d in found] == [
        ("document@A", path, kind) for path, kind in RENAMED_MENU
    ], found


def test_a_key_no_entry_names_reads_as_an_account_at_unrecognized():
    # A key a menu's pair of case details does not declare: no entry names ``schema:DetailPair.<undeclared>``, while
    # an unknown key at the app's top level is the INERT entry
    # ``application-and-settings/any-other-unknown-top-level-key-that-names-no-application``.
    def unknown(body):
        body["modules"][0]["case_details"]["proof_key_no_entry_names"] = "x"

    source = _with_body(_answer(READS / "navigation-base" / "app-source.json"), unknown)
    document, records = _navigation(source=source)
    found = proof6.differences(document, records)
    assert {(d.artifact, d.path) for d in found} == {("reading@A", "/unrecognized")}, found


def test_a_nova_born_document_differing_from_its_reading_by_a_canonical_pair_reads_back_whole():
    real = cases.load_corpus().document("navigation-base")
    document, records = _navigation(document_json=_purpose(real.document))
    assert proof6.differences(document, records) == []


# A review of a person's saves: HQ's answer after the saves reads as the review read the capture's peer -----------


def _reviewed(statement="records", saved_source=None, *, reading=True, reading_id="planted", kind="nothing"):
    """navigation-base as a document whose republish runs Nova's review of a person's saves (``statement``): the
    review (of ``kind``) has the document's own reading (or none), and HQ's answer after the saves is
    navigation-base's source (or ``saved_source``)."""
    real = cases.load_corpus().document("navigation-base")
    review = {"kind": kind, "reason": "reads-the-same", "readingId": reading_id}
    if kind == "changes":
        review = {"kind": kind, "readingId": reading_id}
    brought = SimpleNamespace(review=review, reading={"doc": real.document["doc"], "identity": []} if reading else None)
    document = _planted(
        real,
        edit=None,
        hq_side={"republish": statement},
        brings_in=None,
        migration_witness=False,
        hq_authored=False,
        exports={"minimum": SimpleNamespace(brought_in=brought)},
    )
    a = _with_reads("published", _navigation_reads())
    a["apiReads"]["saved"] = _navigation_reads(saved_source)
    return document, _records(real.id, {"a": a})


def test_hq_s_answer_after_the_saves_reading_as_the_review_read_them_holds():
    document, records = _reviewed()
    assert proof6.differences(document, records) == []
    # A review that found HQ's app unchanged read nothing beyond the baseline, and a republish sent with no review
    # (``proceeds``) has none: neither asks the hold.
    unchanged, records = _reviewed(reading=False, reading_id=None)
    assert proof6.saved_requests(unchanged, records) == ([], [])
    # A review whose files alone read as the baseline's made no reading of the app either.
    same_files, records = _reviewed(reading=False)
    assert proof6.saved_requests(same_files, records) == ([], [])
    proceeds, records = _reviewed("proceeds")
    assert proof6.saved_requests(proceeds, records) == ([], [])


def test_hq_s_answer_after_the_saves_reading_otherwise_than_the_review_read_them_is_one_difference():
    def renamed(body):
        names = body["modules"][0]["name"]
        for lang in names:
            names[lang] = f"{names[lang]} (changed)"

    source = _with_body(_answer(READS / "navigation-base" / "app-source.json"), renamed)
    document, records = _reviewed(saved_source=source)
    found = proof6.differences(document, records)
    assert [(d.artifact, d.path, d.kind) for d in found] == [
        ("document@saved", path, kind) for path, kind in RENAMED_MENU
    ], found
    assert "a person's saves" in proof6.fixed_point_message(document.id, found)


def test_a_review_that_found_changes_and_recorded_no_reading_is_refused_by_name():
    document, records = _reviewed(reading=False, kind="changes")
    with pytest.raises(proof6.ReadsMissing, match="broughtIn.reading"):
        proof6.saved_requests(document, records)


def test_the_review_s_ids_hq_did_not_mint_are_hq_s_at_their_position():
    """The capture's peer mints its own ids for a form a person adds, which HQ mints otherwise: such a row is HQ's
    form at the same position, and a row whose ids HQ holds, or whose position's ids another row names, is kept."""
    doc = {"moduleOrder": ["menu"], "formOrder": {"menu": ["kept", "added", "taken"]}}
    source = {
        "modules": [
            {
                "unique_id": "hq-menu",
                "forms": [
                    {"unique_id": "hq-kept", "xmlns": "x-kept"},
                    {"unique_id": "hq-added", "xmlns": "x-added"},
                    {"unique_id": "hq-kept", "xmlns": "x-kept"},
                ],
            }
        ]
    }

    def row(uuid, unique_id, xmlns=None, kind="form"):
        return {"entityKind": kind, "novaEntityUuid": uuid, "uniqueId": unique_id, "xmlns": xmlns}

    rows = [
        row("menu", "hq-menu", kind="module"),
        row("kept", "hq-kept", "x-kept"),
        row("added", "peer-added", "peer-x-added"),
        row("taken", "peer-taken", "peer-x-taken"),
    ]
    assert proof6.aligned_identity(doc, rows, source) == [
        row("menu", "hq-menu", kind="module"),
        row("kept", "hq-kept", "x-kept"),
        row("added", "hq-added", "x-added"),
        row("taken", "peer-taken", "peer-x-taken"),
    ]


# hq-plain: a document made in CommCare HQ ---------------------------------------------------------


def _base_reads(base="hq-plain"):
    directory = HQ_APPS / base
    if not (directory / "app-source.json").is_file():
        raise AssertionError(
            f"proof/hq-apps/{base}/ holds no app-source.json, the retained answers these controls read. The lane writes"
            " the tree (proof/matrix/test_retained.py) and python3 -m proof.matrix.adopt copies it in."
        )
    reads = {
        "application": _answer(directory / "application.json"),
        "source": _answer(directory / "app-source.json"),
        "currentVersion": _answer(directory / "current-version.json"),
    }
    if (directory / "source-factories.json").is_file():
        reads["sourceFactoryReads"] = json.loads((directory / "source-factories.json").read_text())
    if (directory / "project-spaces.json").is_file():
        reads["projectSpaces"] = {
            "all": _answer(directory / "project-spaces.json"),
            **{
                key: _answer(directory / filename)
                for key, filename in (("flagged", "project-spaces-flag.json"), ("caseListActions", "project-spaces-case-list-actions.json"))
                if (directory / filename).is_file()
            },
        }
    from proof.matrix.lane_input import fixture_rows_tag

    data = {
        "lookupTables": _answer(directory / "lookup-tables.json"),
        "fixtureRows": {
            tag: _answer(path)
            for path in sorted(directory.glob("fixture-rows*.json"))
            if (tag := fixture_rows_tag(path.name)) is not None
        },
    }
    for key, name in (("locationTypes", "location-types.json"), ("locations", "locations.json"), ("locationsV1", "locations-v1.json")):
        if (directory / name).is_file():
            data[key] = _answer(directory / name)
    reads["projectData"] = data
    media = directory / "media-reads.json"
    reads["media"] = _answer(media) if media.is_file() else []
    return reads


def _base(**overrides):
    real = cases.load_corpus().document("hq-plain")
    document = _planted(real, hq_side=None, brings_in=None, migration_witness=False, hq_authored=True)
    document.authored = real.authored
    document.hq_authored_facts = real.hq_authored_facts
    for name, value in overrides.items():
        setattr(document, name, value)
    reads = _base_reads()
    parts = {
        "a": _with_reads("authored", reads),
        "b": _with_reads("published", reads),
        "b_edit": _with_reads("published", reads),
    }
    return document, _records(real.id, parts)


def test_a_base_differing_from_its_reading_by_a_canonical_pair_differs_at_a_and_b_and_not_at_b_edit():
    real = cases.load_corpus().document("hq-plain")
    planted = _purpose(real.document)
    document, records = _base(
        document=planted,
        edit=SimpleNamespace(),
        edit_document=copy.deepcopy(planted),
    )
    found = proof6.differences(document, records)
    assert sorted((d.artifact, d.path, d.kind) for d in found) == [
        ("document@A", "/modules/*/purpose", "removed"),
        ("document@B", "/modules/*/purpose", "removed"),
    ], found


def test_a_base_read_under_a_declaration_its_reading_does_not_offer_differs_at_runs_only_on():
    real = cases.load_corpus().document("hq-plain")
    facts = {**real.hq_authored_facts, "declaration": {"runsOnlyOn": "web-apps", "splitDatetime": True}}
    document, records = _base(edit=None, hq_authored_facts=facts)
    records.configurations["minimum"].parts.pop("b")
    found = proof6.differences(document, records)
    assert [(d.artifact, d.path) for d in found] == [("document@A", "/appSettings/runsOnlyOn")], found


# What the judge asks and keeps, with no bundle ------------------------------------------------------


def test_a_document_whose_saves_are_brought_in_is_read_back_at_b_alone():
    """``document.json`` of a document whose republish brings a person's saves in is the document the bring-in gave,
    and the A Nova's first publish left serves the one before the saves: a read of A held to it would report the
    saves themselves. The plausible failure: a judge that holds A to the brought-in document, or drops B."""
    brought = SimpleNamespace(
        migration_witness=False,
        hq_authored=False,
        brings_in={"moduleOrder": []},
        edit=SimpleNamespace(),
        hq_side={"republish": "brings-in"},
    )
    assert proof6.planned_reads(brought) == [("B", "published", "read-back", True)]
    recorded = SimpleNamespace(**{**vars(brought), "brings_in": None, "hq_side": {"republish": "records"}})
    assert proof6.planned_reads(recorded) == [("A", "published", "read-back", True)]


def test_a_document_difference_keeps_the_values_both_documents_hold_there():
    answer = {
        "kind": "read",
        "differences": [
            {"path": ["forms", "6003a32a-dc61-54e6-a90b-2420a581363a", "icon"], "kind": "value", "expected": "a"},
            {"path": ["fields", "0e4fae0d-fc0c-5299-ac5b-38d355af3d9d"], "kind": "added", "found": {"id": "q"}},
        ],
    }
    found = proof6.answer_differences("planted", "A", answer)
    assert [(d.path, d.kind, d.before, d.after) for d in found] == [
        ("/forms/*/icon", "changed", "a", None),
        ("/fields/*", "added", None, {"id": "q"}),
    ]


def test_the_saved_read_is_told_what_hq_served_at_each_path_and_is_refused_without_it():
    """The ``saved`` read names each file of HQ's app after the saves by the bytes HQ served at its path (the read's
    ``media``, handed to the reader as ``servedMedia``), and the document it is matched against carries no path the
    review recorded; a ``saved`` read that holds no media reads is refused by name. The plausible failure: a ``saved``
    read whose media index comes from the review it holds HQ to, which cannot differ on which file HQ serves at a
    path a person saved a picture over (``proof/reader/__tests__/laneReading.test.ts`` holds the index itself)."""
    served = [{"path": "jr://file/commcare/image/own.png", "status": 200, "sha256": "0" * 64}]

    def planted(media):
        reading = {"doc": {"moduleOrder": [], "formOrder": {}}, "identity": []}
        brought = SimpleNamespace(review={"kind": "changes", "readingId": "planted"}, reading=reading)
        document = SimpleNamespace(
            id="planted",
            document={"doc": {"appId": "planted-app"}, "media": {}},
            hq_side={"republish": "brings-in"},
            exports={"minimum": SimpleNamespace(brought_in=brought)},
        )
        reads = {key: value for key, value in _navigation_reads().items() if key != "media"}
        if media is not None:
            reads["media"] = media
        return document, _records("planted", {"a": _with_reads("saved", reads)})

    document, records = planted(served)
    [(request, state, stated)], before = proof6.saved_requests(document, records)
    assert (state, stated, before) == ("saved", None, [])
    assert request["input"]["servedMedia"] == served
    assert "mediaPaths" not in request["input"]["document"]
    assert request["expected"] == {"moduleOrder": [], "formOrder": {}}
    document, records = planted(None)
    with pytest.raises(proof6.ReadsMissing, match="holds no media reads"):
        proof6.saved_requests(document, records)
