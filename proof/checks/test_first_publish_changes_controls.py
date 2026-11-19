"""The first-publish judge's three holds, over planted evidence in both profiles, with no HQ.

Contract (``proof.checks.changes``): a difference only a row of an entry that
does not apply matches is ``/<id>/unsaid``, and one a row of an applying entry
matches is none (hold 1); an applying entry that matches nothing is
``/<id>/unseen`` (hold 2), but where every row of it names a served reader's
artifact and the run observes no served reader, which leaves it to the run that
does; with the readers on, it is held; a ``proof3`` difference is matched only
by a ``proof3`` row (hold 3); and the inert allowance matches a source
difference under a place the claim log holds as inert. The plausible failures:
an undeclared difference absorbed by an entry that does not apply, an entry
declared in vain, and a served reader's entry failed with the readers off or
skipped with them on.
"""

from __future__ import annotations

from types import SimpleNamespace

from proof.checks import changes
from proof.checks.differences import Difference

REGISTER = changes.parse(
    [
        {"change": "forms-and-settings-rewritten", "rows": [{"check": "source", "artifact": "app.json", "path": "/x"}]},
        {"change": "case-names-checked", "rows": [{"check": "source", "artifact": "app.json", "path": "/modules/*"}]},
        {
            "change": "hidden-values-added",
            "rows": [{"check": "proof3", "artifact": "formplayer@B", "path": "/runs/*/screens"}],
        },
    ]
)


def _document(*ids):
    return SimpleNamespace(id="hq-planted", hq_authored=True, first_publish=tuple(ids))


def _source(at):
    return Difference("source", "hq-planted", "app.json", at, at, "changed", None, None)


def _paths(found):
    return sorted(difference.path for difference in found)


def test_a_difference_an_applying_entry_declares_is_held_and_one_it_does_not_is_unsaid():
    checked = {"source": [_source("/modules/0/name"), _source("/x")]}
    held, ids = changes.declared(
        _document("forms-and-settings-rewritten"), "source", checked["source"], register=REGISTER
    )
    assert [d.at for d in held] == ["/x"] and ids == {"forms-and-settings-rewritten"}
    found = changes.differences(
        _document("forms-and-settings-rewritten"), checked, inert=frozenset(), readers=frozenset(), register=REGISTER
    )
    assert _paths(found) == ["/case-names-checked/unsaid"]


def test_an_applying_entry_that_matches_nothing_is_unseen():
    found = changes.differences(
        _document("forms-and-settings-rewritten", "case-names-checked"),
        {"source": [_source("/x")]},
        inert=frozenset(),
        readers=frozenset(),
        register=REGISTER,
    )
    assert _paths(found) == ["/case-names-checked/unseen"]


def test_a_served_reader_s_entry_is_left_to_the_readers_and_held_with_them():
    document = _document("forms-and-settings-rewritten", "hidden-values-added")
    checked = {"source": [_source("/x")]}
    off = changes.differences(document, checked, inert=frozenset(), readers=frozenset(), register=REGISTER)
    assert off == []
    on = changes.differences(document, checked, inert=frozenset(), readers=frozenset({"formplayer"}), register=REGISTER)
    assert _paths(on) == ["/hidden-values-added/unseen"]


def test_a_proof3_difference_is_matched_only_by_a_proof3_row():
    proof3 = Difference("proof3", "hq-planted", "formplayer@B", "/modules/*", "/modules/0", "changed", None, None)
    held, _ = changes.declared(_document("case-names-checked"), "proof3", [proof3], register=REGISTER)
    assert held == []


def test_the_inert_allowance_holds_a_source_difference_under_an_inert_place():
    document = _document("forms-and-settings-rewritten")
    under = _source("/profile/properties/purge-freq")
    held, ids = changes.declared(
        document, "source", [under], inert=frozenset({"/profile/properties/purge-freq"}), register=REGISTER
    )
    assert held == [under] and ids == {"forms-and-settings-rewritten"}
    assert changes.declared(document, "source", [under], register=REGISTER)[0] == []


def test_no_entry_is_read_on_a_document_not_made_in_hq():
    document = SimpleNamespace(id="nova", hq_authored=False, first_publish=())
    assert changes.declared(document, "source", [_source("/x")], register=REGISTER) == ([], frozenset())
