"""The first-publish judge's holds, over planted evidence in both profiles, with no HQ.

Contract (``proof.checks.changes``): a change holds a difference only where a
row of it names the difference's class and one of its places stands at the
difference's location (``locate``), so a difference of its class at another
form, another node, another menu or another case type is not its own: no
applying change holds it, and a row of an entry that does not apply makes it
``/<id>/unsaid`` (hold 1); proof 2's and proof 3's differences are located
through what the records say of where each build element, run, step and case
stands (``Sites``: a suite entry by its command, a session run by the form its
script opens, a case by its type), and one the records do not place is
located nowhere, which only the change that stands everywhere stands at; of
the applying changes that hold a difference, only those whose place there is
the most exact see it, so ``forms-and-settings-rewritten``, which stands
everywhere, sees only what no other change's place holds, two changes at one
node both see it, and an applying change that sees nothing is
``/<id>/unseen`` (hold 2), even while the change that stands everywhere sees
its form; but where every row of it names a served reader's artifact and the
run observes no served reader, which leaves it to the run that does; a
``proof3`` difference is matched only by a ``proof3`` row (hold 3); the inert
allowance matches a source difference under a place the claim log holds as
inert, but not where a claim of another standing shares that place or stands
under it on the difference's branch; a difference at a place Nova keeps (a
media path the document holds, the property a case list column shows) is
declared by no entry, however wide its row, and no row may name one; and the
register and a document's list refuse a change that could never be seen
apart, and the change that stands everywhere a row over a form's whole source.
The plausible failures: an undeclared difference absorbed by an applying
entry's wide row at a node the change never touched (the date and time split's
rows holding any question's answer, finding 9 of layer 9's review; a change at
one form holding another form's run, a menu's change holding another menu's
build), an entry seen through a row it shares with the change that stands
everywhere (finding 10), a form source difference no change makes held by the
change that stands everywhere, a column a change adds that its places miss, an
icon column's picture placed off its column, an entry declared in vain, a
served reader's entry failed with the readers off or skipped with them on, a
kept value rewritten under an inert claim recorded at its container, and a held
picture or column changed under a media or case list entry's broad row.
"""

from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from proof.checks import changes, parity, source
from proof.checks.compare.trace import compare_traces
from proof.checks.compare.xml_tree import compare_xml
from proof.checks.differences import Difference

RESIDUE = "forms-and-settings-rewritten"
FORM = "/form/0.0"
REGISTER = changes.parse(
    [
        {
            "change": RESIDUE,
            "placeKinds": ["app-wide"],
            "rows": [{"check": "source", "artifact": "app.json", "path": "/x"}],
        },
        {
            "change": "case-names-checked",
            "placeKinds": ["menu"],
            "rows": [{"check": "source", "artifact": "app.json", "path": "/modules/*"}],
        },
        {
            "change": "hidden-values-added",
            "placeKinds": ["form-node"],
            "rows": [{"check": "proof3", "artifact": "formplayer@B", "path": "/runs/*/screens"}],
        },
    ]
)
# Two changes whose rows overlap with the change that stands everywhere: each names every form source, as
# twenty entries of the register do, and the change that stands everywhere names every bind of every form.
OVERLAPPING = changes.parse(
    [
        {
            "change": RESIDUE,
            "placeKinds": ["app-wide"],
            "rows": [{"check": "source", "artifact": "app.json", "path": "/_attachments/*/data/*/:bind"}],
        },
        {
            "change": "row-predicate-current",
            "placeKinds": ["form-node"],
            "rows": [{"check": "source", "artifact": "app.json", "path": "/_attachments/*"}],
        },
        {
            "change": "blank-translations-filled",
            "placeKinds": ["form-part", "form-node"],
            "rows": [{"check": "source", "artifact": "app.json", "path": "/_attachments/*"}],
        },
    ]
)
# The same, with the change that stands everywhere narrowed to the respelling it makes (a bind's form builder
# shadow), as its rows read once a lane run's evidence writes them: what it does not name, it cannot hold.
NARROW_RESIDUE = changes.parse(
    [
        {
            "change": RESIDUE,
            "placeKinds": ["app-wide"],
            "rows": [
                {"check": "source", "artifact": "app.json", "path": "/_attachments/*/data/*/:bind/@vellum:calculate"}
            ],
        },
        {
            "change": "row-predicate-current",
            "placeKinds": ["form-node"],
            "rows": [{"check": "source", "artifact": "app.json", "path": "/_attachments/*/data/*/:bind/@calculate"}],
        },
    ]
)


def _document(*changes_and_places):
    """A document made in HQ whose ``first-publish.json`` lists each ``(id, places)``, or each id alone at the
    whole app where it is the change that stands everywhere and at the first form otherwise."""
    listed = []
    for one in changes_and_places:
        if isinstance(one, str):
            one = (one, ("",) if one == RESIDUE else (FORM,))
        listed.append((one[0], tuple(one[1])))
    return SimpleNamespace(id="hq-planted", hq_authored=True, first_publish_places=tuple(listed))


def _source(at):
    return Difference("source", "hq-planted", "app.json", at, at, "changed", None, None)


def _part(at, path="/_attachments/*/data/*/:bind/@calculate"):
    return Difference("source", "hq-planted", "app.json", path, at, "changed", "a", "b")


def _d(check, artifact, path, at, kind):
    return Difference(check, "d", artifact, path, at, kind, None, None)


def _paths(found):
    return sorted(difference.path for difference in found)


def test_hiding_an_implicit_incomplete_forms_tile_only_covers_its_removal_from_web_apps():
    name = "incomplete-forms-tile-hidden"
    document = _document((name, ("/app/profile/properties/cc-show-incomplete",)))
    path = "/home/tiles/incomplete"
    removed = _d("proof3", "webapps@B", path, path, "removed")
    changed = _d("proof3", "webapps@B", path, path, "changed")
    other = _d("proof3", "webapps@B", "/home/tiles/sync", "/home/tiles/sync", "removed")
    held, ids = changes.declared(document, "proof3", [removed, changed, other])
    assert held == [removed]
    assert ids == {name}
    assert changes.declared(_document(), "proof3", [removed])[0] == []


def test_the_source_witness_holds_only_two_new_off_settings_at_their_exact_keys():
    from proof.checks.source import compare_sources

    incomplete = "incomplete-forms-tile-hidden"
    document = _document(RESIDUE, (incomplete, ("/app/profile/properties/cc-show-incomplete",)))
    before = {"profile": {}}
    after = {"profile": {"properties": {"cc-show-saved": "no", "cc-show-incomplete": "no", "other": "no"}}}
    found = compare_sources(document.id, before, after)
    held, ids = changes.declared(document, "source", found)
    assert ids == {RESIDUE, incomplete}
    assert [d.at for d in found if d not in held] == ["/profile/properties/other"]
    assert changes.declared(document, "source", compare_sources(document.id, after, before))[0] == []
    after["profile"]["properties"].update({"cc-show-incomplete": "yes", "cc-show-saved": {"nested": "no"}})
    assert changes.declared(document, "source", compare_sources(document.id, before, after))[0] == []


def test_a_difference_an_applying_entry_declares_is_held_and_one_it_does_not_is_unsaid():
    checked = {"source": [_source("/modules/0/name"), _source("/x")]}
    document = _document(RESIDUE)
    held, ids = changes.declared(document, "source", checked["source"], register=REGISTER)
    assert [d.at for d in held] == ["/x"] and ids == {RESIDUE}
    found = changes.differences(document, checked, readers=frozenset(), register=REGISTER)
    assert _paths(found) == ["/case-names-checked/unsaid"]


def test_an_applying_entry_that_matches_nothing_is_unseen():
    found = changes.differences(
        _document(RESIDUE, ("case-names-checked", ["/menu/0"])),
        {"source": [_source("/x")]},
        readers=frozenset(),
        register=REGISTER,
    )
    assert _paths(found) == ["/case-names-checked/unseen"]


def test_a_difference_of_an_applying_change_s_class_at_another_menu_is_not_its_own():
    document = _document(RESIDUE, ("case-names-checked", ["/menu/0"]))
    at_its_menu, at_another = _source("/modules/0/name"), _source("/modules/1/name")
    held, ids = changes.declared(document, "source", [at_its_menu, at_another], register=REGISTER)
    assert held == [at_its_menu] and ids == {"case-names-checked"}
    assert changes.undeclared(document, "source", [at_its_menu, at_another], register=REGISTER) == [at_another]


def test_a_served_reader_s_entry_is_left_to_the_readers_and_held_with_them():
    document = _document(RESIDUE, ("hidden-values-added", [f"{FORM}/xform/data/q"]))
    # The judge of an app made in HQ is handed all four checks, proof 3 among them, so an entry made of proof 3 rows
    # is judged (``changes._unjudged`` leaves alone only an entry none of whose checks the judge was handed).
    checked = {"source": [_source("/x")], "proof1": [], "proof2": [], "proof3": []}
    off = changes.differences(document, checked, readers=frozenset(), register=REGISTER)
    assert off == []
    on = changes.differences(document, checked, readers=frozenset({"formplayer"}), register=REGISTER)
    assert _paths(on) == ["/hidden-values-added/unseen"]


def test_a_proof3_difference_is_matched_only_by_a_proof3_row():
    proof3 = Difference("proof3", "hq-planted", "formplayer@B", "/modules/*", "/modules/0", "changed", None, None)
    held, _ = changes.declared(_document(("case-names-checked", ["/menu/0"])), "proof3", [proof3], register=REGISTER)
    assert held == []


# The places: overlapping rows, the most exact place, and the two findings' scenarios ------------------------------


def test_a_change_whose_rows_it_shares_with_the_change_that_stands_everywhere_is_unseen_without_a_difference_there():
    # Finding 10's scenario: both changes listed; every form source differs, as Nova's rewrite of every form makes
    # it, but not at the slot the expression stage held up to the rewrite.
    document = _document(RESIDUE, ("row-predicate-current", [f"{FORM}/xform/data/visits"]))
    elsewhere = _part("/_attachments/form:0.0.xml/data/age/:bind/@calculate")
    found = changes.differences(document, {"source": [elsewhere]}, readers=frozenset(), register=OVERLAPPING)
    assert _paths(found) == ["/row-predicate-current/unseen"]
    held, ids = changes.declared(document, "source", [elsewhere], register=OVERLAPPING)
    assert held == [elsewhere] and ids == {RESIDUE}
    # Accepted: a difference at the slot is the change's, and the change that stands everywhere does not see it.
    at_it = _part("/_attachments/form:0.0.xml/data/visits/:bind/@calculate")
    held, ids = changes.declared(document, "source", [at_it], register=OVERLAPPING)
    assert held == [at_it] and ids == {"row-predicate-current"}
    assert (
        changes.differences(document, {"source": [at_it, elsewhere]}, readers=frozenset(), register=OVERLAPPING) == []
    )


def test_a_change_at_another_form_is_not_seen_by_a_difference_of_this_form():
    document = _document(RESIDUE, ("row-predicate-current", ["/form/0.1/xform/data/visits"]))
    same_node_other_form = _part("/_attachments/form:0.0.xml/data/visits/:bind/@calculate")
    found = changes.differences(document, {"source": [same_node_other_form]}, readers=frozenset(), register=OVERLAPPING)
    assert _paths(found) == ["/row-predicate-current/unseen"]


def test_the_most_exact_place_sees_a_difference_and_two_changes_at_one_node_both_see_it():
    one_node = f"{FORM}/xform/data/visits"
    # A translation filled under any node of the form, and a rewrite at one node: at that node's itext the node
    # place matches more steps by name than the form's itext part does.
    document = _document(
        RESIDUE, ("row-predicate-current", [one_node]), ("blank-translations-filled", [f"{FORM}/xform/**/:itext"])
    )
    text = _part("/_attachments/form:0.0.xml/data/visits/:itext/label/hin/default", "/_attachments/*/data/*/:itext")
    assert changes.declared(document, "source", [text], register=OVERLAPPING)[1] == {"row-predicate-current"}
    other_text = _part("/_attachments/form:0.0.xml/data/age/:itext/label/hin/default", "/_attachments/*/data/*/:itext")
    assert changes.declared(document, "source", [other_text], register=OVERLAPPING)[1] == {"blank-translations-filled"}
    # Two changes at one node of one form: a difference there shows both, and the judge does not guess which.
    tied = _document(RESIDUE, ("row-predicate-current", [one_node]), ("blank-translations-filled", [one_node]))
    assert changes.declared(tied, "source", [text], register=OVERLAPPING)[1] == {
        "row-predicate-current",
        "blank-translations-filled",
    }
    assert changes.differences(tied, {"source": [text]}, readers=frozenset(), register=OVERLAPPING) == [
        Difference(
            "changes", "hq-planted", "register", f"/{RESIDUE}/unseen", f"/{RESIDUE}/unseen", "changed", None, None
        )
    ]


def test_a_change_left_off_the_list_is_unsaid_where_the_change_that_stands_everywhere_does_not_name_its_class():
    # Finding 10's other direction: the reading lists only the change that stands everywhere while the publish makes
    # another. Once that change's rows name only its own respelling, the other change's difference is unsaid.
    document = _document(RESIDUE)
    rewritten = _part("/_attachments/form:0.0.xml/data/visits/:bind/@calculate")
    respelled = _part(
        "/_attachments/form:0.0.xml/data/visits/:bind/@vellum:calculate",
        "/_attachments/*/data/*/:bind/@vellum:calculate",
    )
    found = changes.differences(
        document, {"source": [rewritten, respelled]}, readers=frozenset(), register=NARROW_RESIDUE
    )
    assert _paths(found) == ["/row-predicate-current/unsaid"]
    assert changes.undeclared(document, "source", [rewritten, respelled], register=NARROW_RESIDUE) == [rewritten]
    # Accepted: listed at that node, the change holds it.
    listed = _document(RESIDUE, ("row-predicate-current", [f"{FORM}/xform/data/visits"]))
    assert (
        changes.differences(listed, {"source": [rewritten, respelled]}, readers=frozenset(), register=NARROW_RESIDUE)
        == []
    )


def _trace(at, path, kind="changed", artifact="trace@B"):
    return Difference("proof3", "hq-planted", artifact, path, at, kind, None, None)


def _run_at_form(run, position, *, steps):
    """Sites where every step of the run, and the run, stand at the form at ``position``."""
    place = ("form", position)
    return changes.Sites(runs={run: place}, steps={(run, step): place for step in range(steps)})


SPLIT = "date-and-time-questions-split"
SPLIT_PLACES = [
    f"{FORM}/actions",
    f"{FORM}/xform/data/visit_datetime",
    f"{FORM}/xform/data/visit_datetime_date",
    f"{FORM}/xform/data/visit_datetime_time",
]


def test_the_date_and_time_split_holds_its_own_nodes_and_no_other_question_s_answer_or_event():
    # Finding 9's scenario, over the register as the lane reads it: the split's proof 3 rows name any submitted
    # answer, any data node added and any event added or removed; its places name the question it split and the
    # two it inserted.
    document = _document(RESIDUE, (SPLIT, SPLIT_PLACES))
    answer = "/runs/*/trace/*/submission/data/*/text()"
    split_answer = _trace("/runs/0/trace/4/submission/data/visit_datetime[1]/text()", answer)
    new_node = _trace(
        "/runs/0/trace/4/submission/data/visit_datetime_date[1]", "/runs/*/trace/*/submission/data/*", "added"
    )
    new_event = _trace(
        "/runs/0/trace/3/events/question:~1data~1visit_datetime_time[1]", "/runs/*/trace/*/events/*", "added"
    )
    other_answer = _trace("/runs/0/trace/4/submission/data/bmi_calc[1]/text()", answer)
    skipped = _trace("/runs/0/trace/3/events/question:~1data~1weight[1]", "/runs/*/trace/*/events/*", "removed")
    found = [split_answer, new_node, new_event, other_answer, skipped]
    sites = _run_at_form(0, "0.0", steps=5)
    held, ids = changes.declared(document, "proof3", found, sites=sites)
    assert held == [split_answer, new_node, new_event] and ids == {SPLIT}
    assert changes.undeclared(document, "proof3", found, sites=sites) == [other_answer, skipped]
    # Neither is said by the split, nor by any change that does not apply whose rows name the class.
    judged = changes.differences(document, {"proof3": found}, sites=sites, readers=frozenset())
    assert not [difference for difference in judged if difference.path == f"/{SPLIT}/unseen"]


def test_a_listed_change_with_no_difference_at_its_places_is_unseen_while_the_whole_app_s_change_sees_its_form():
    document = _document(RESIDUE, (SPLIT, SPLIT_PLACES))
    elsewhere = Difference(
        "proof1", "hq-planted", "form:0.0", "/questions/*", "/questions/~1data~1weight", "added", None, None
    )
    rewritten = _part("/_attachments/form:0.0.xml/data/weight/:bind/@vellum:nodeset", "/_attachments/*/data/*/:bind")
    found = changes.differences(
        document, {"source": [rewritten], "proof1": [elsewhere]}, readers=frozenset({"formplayer"})
    )
    assert f"/{SPLIT}/unseen" in _paths(found)


# What a document's records say of where its runs, steps, cases and build elements stand, for the cases below.
LOCATED = changes.Sites(
    runs={0: ("form", "0.1"), 1: ("form", "2.1")},
    steps={
        (0, 1): ("form", "0.1"),
        (1, 0): ("menu", "2"),
        (1, 2): ("menu", "2", "case_details", "short"),
        (1, 3): ("menu", "2", "search_config"),
    },
    choices={(1, 0, 1): ("form", "2.1")},
    cases={"@generated:trace/0/x": ("patient",), "c1": ("household",)},
    builds={("suite.xml", "entry[7]"): ("form", "2.0"), ("suite.xml", "xform[2]"): ("form", "1.0")},
    media={"r1": "jr://file/commcare/image/a.png"},
)


@pytest.mark.parametrize(
    ("difference", "location"),
    [
        (
            _d("proof1", "form:0.1", "/questions/*", "/questions/~1data~1g~1q", "added"),
            ("form", "0.1", "xform", "data", "g", "q"),
        ),
        (_d("proof1", "form:0.1", "/order", "/order", "changed"), ("form", "0.1", "xform", "data", "**")),
        (
            _d("proof1", "case_types", "/*/properties/*", "/household/properties/external_id", "added"),
            ("case", "household", "external_id"),
        ),
        (
            _d("proof1", "app.json", "/modules/*/forms/*/media/*", "/modules/0/forms/1/media/jr:~1~1f", "added"),
            ("form", "0.1", "media", "jr://f"),
        ),
        (
            _d("source", "app.json", "/_attachments/*/title", "/_attachments/form:2.0.xml/title", "changed"),
            ("form", "2.0", "xform", "title"),
        ),
        (
            _d("source", "app.json", "/modules/*/name", "/modules/3/name/en", "changed"),
            ("menu", "3", "name", "en"),
        ),
        (
            _d(
                "proof1",
                "case_types",
                "/*/properties/*",
                "/member/properties/parent~1external_id",
                "added",
            ),
            ("case", "member", "parent", "external_id"),
        ),
        (
            _d(
                "proof3",
                "trace@local.ccz",
                "/runs/*/trace/*/caseDb/casedb/case[@case_id=*]/*/text()",
                "/runs/1/trace/2/caseDb/casedb/case[@case_id=@generated:trace/0/x]/visit_time/text()",
                "changed",
            ),
            ("case", "patient", "visit_time"),
        ),
        (
            _d(
                "proof3",
                "case_blocks@B",
                "/runs/*/blocks/*/subcase_*~1case/*/create/case_name",
                "/runs/0/blocks/c1/subcase_0~1case/0/create/case_name",
                "changed",
            ),
            ("form", "0.1", "xform", "data", "subcase_0", "case", "create", "case_name"),
        ),
        (
            _d("proof3", "case_blocks@B", "/runs/*/cases/*/name", "/runs/0/cases/c1/name", "changed"),
            ("case", "household", "name"),
        ),
        (
            _d("proof3", "trace@B", "/runs/*/trace/*/title", "/runs/0/trace/1/title", "changed"),
            ("form", "0.1", "xform", "title"),
        ),
        (
            _d(
                "proof3",
                "trace@B",
                "/runs/*/trace/*/submission/data/case[*]/update[*]/*/text()",
                "/runs/0/trace/1/submission/data/case[1]/update[1]/weight[1]/text()",
                "changed",
            ),
            ("form", "0.1", "xform", "data", "case", "update", "weight"),
        ),
        (
            _d("proof3", "trace@B", "/runs/*/trace/*/choices/*/text", "/runs/1/trace/0/choices/1/text", "changed"),
            ("form", "2.1", "name"),
        ),
        (
            _d("proof3", "trace@B", "/runs/*/trace/*/headers/*", "/runs/1/trace/2/headers/0", "changed"),
            ("menu", "2", "case_details", "short", "**"),
        ),
        (
            _d("proof3", "trace@B", "/runs/*/trace/*/params/_xpath_query/*", "/runs/1/trace/3/params/x", "added"),
            ("menu", "2", "search_config", "**"),
        ),
        # A run the records do not place, and a served reader's walk, name no place.
        (_d("proof3", "trace@B", "/runs/*/trace/*/title", "/runs/9/trace/1/title", "changed"), ()),
        (_d("proof3", "formplayer@B", "/runs/*/screens", "/runs/0/screens", "changed"), ()),
        (
            _d(
                "proof2",
                "suite.xml",
                "/suite/entry[*]/session[*]/datum[@id=*]/@nodeset",
                "/suite/entry[7]/session[1]/datum[@id=case_id]/@nodeset",
                "changed",
            ),
            ("menu", "2", "case_details", "short", "filter"),
        ),
        (
            _d(
                "proof2",
                "suite.xml",
                "/suite/entry[*]/stack[*]/create[*]/@if",
                "/suite/entry[2]/command[@id=m0-f1]/x",
                "changed",
            ),
            ("form", "0.1", "**"),
        ),
        (
            _d("proof2", "suite.xml", "/suite/detail[@id=*]/x", "/suite/detail[@id=m3_case_short]/x", "changed"),
            ("menu", "3", "case_details", "short", "**"),
        ),
        (
            _d("proof2", "suite.xml", "/suite/menu[@id=*]/text[*]", "/suite/menu[@id=m1]/text[1]", "added"),
            ("menu", "1", "**"),
        ),
        (
            _d("proof2", "suite.xml", "/suite/xform[*]/resource[@id=*]/@descriptor", "/suite/xform[2]/x", "changed"),
            ("form", "1.0", "name"),
        ),
        (
            _d(
                "proof2",
                "app_strings:en",
                "/m*.*.*_*_*.header",
                "/m3.case_short.case_dob_2.header",
                "added",
            ),
            ("menu", "3", "case_details", "short", "columns", "1", "header"),
        ),
        (_d("proof2", "app_strings:default", "/forms.m*f*", "/forms.m1f2", "changed"), ("form", "1.2", "name")),
        (
            _d("proof2", "app_strings:en", "/modules.m*.icon", "/modules.m4.icon", "removed"),
            ("menu", "4", "media_image"),
        ),
        (
            _d("proof2", "form:0.1", "/html/x", "/html/x", "changed"),
            ("form", "0.1", "xform", "**"),
        ),
        (
            _d("proof2", "media_suite.xml", "/suite/media[resource/@id=*]", "/suite/media[resource/@id=r1]", "added"),
            ("app", "multimedia_map", "jr://file/commcare/image/a.png"),
        ),
        (_d("proof2", "suite.xml", "/suite/x", "/suite/x", "changed"), ()),
    ],
)
def test_each_check_s_difference_is_located_in_the_tree_the_places_name(difference, location):
    assert changes.locate(difference, LOCATED) == location


def test_a_place_stands_at_a_location_at_or_under_it_and_counts_the_steps_it_names_alike():
    assert changes.exactness("", ("form", "0.0")) == 0
    assert changes.exactness(f"{FORM}/xform/data/q", ("form", "0.0", "xform", "data", "q", ":bind", "@calculate")) == 5
    assert changes.exactness(f"{FORM}/xform/**/:itext", ("form", "0.0", "xform", "data", "q", ":itext", "label")) == 4
    assert changes.exactness(f"{FORM}/xform/data/q", ("form", "0.0", "xform", "data", "**")) == 4
    # A location above the place, and one beside it, are not at it.
    assert changes.exactness(f"{FORM}/xform/data/q", ("form", "0.0", "xform")) is None
    assert changes.exactness(f"{FORM}/xform/data/q", ("form", "0.0", "xform", "data", "r")) is None


# The register and a document's list refuse a change that could never be seen apart ---------------------------


def _entry(change, kinds, rows=()):
    return {"change": change, "placeKinds": kinds, "rows": list(rows)}


@pytest.mark.parametrize(
    ("register", "refusal"),
    [
        ([{"change": "hidden-values-added", "rows": []}], "exactly change, placeKinds and rows"),
        ([_entry("hidden-values-added", [])], "at least one"),
        ([_entry("hidden-values-added", ["form-node", "app-wide"])], "beside other kinds"),
        ([_entry("hidden-values-added", ["question"])], "which no place is"),
        ([_entry(RESIDUE, ["app-wide"]), _entry("hidden-values-added", ["app-wide"])], "app-wide"),
    ],
)
def test_the_register_refuses_a_change_that_could_never_be_seen_apart(register, refusal):
    with pytest.raises(changes.ChangesError, match=refusal):
        changes.parse(register)
    assert changes.parse([_entry(RESIDUE, ["app-wide"]), _entry("hidden-values-added", ["form-node"])])


@pytest.mark.parametrize(
    ("listed", "refusal"),
    [
        ((("hidden-values-added", ()),), "no place"),
        ((("hidden-values-added", ("/menu/0",)),), "does not declare"),
        ((("hidden-values-added", ("/nowhere",)),), "does not declare"),
        (((RESIDUE, ("/app",)),), "stands everywhere"),
        ((("validation-counts-moved", (f"{FORM}/xform/data/q",)),), "no entry"),
    ],
)
def test_a_document_s_list_is_refused_where_a_change_has_no_place_of_its_own(listed, refusal):
    register = changes.parse([_entry(RESIDUE, ["app-wide"]), _entry("hidden-values-added", ["form-node"])])
    document = SimpleNamespace(id="hq-planted", hq_authored=True, first_publish_places=listed)
    with pytest.raises(changes.ChangesError, match=refusal):
        changes.placed(document, register)
    accepted = SimpleNamespace(
        id="hq-planted",
        hq_authored=True,
        first_publish_places=((RESIDUE, ("",)), ("hidden-values-added", (f"{FORM}/xform/data/q",))),
    )
    assert changes.placed(accepted, register) == {RESIDUE: ("",), "hidden-values-added": (f"{FORM}/xform/data/q",)}


def test_the_register_as_the_lane_reads_it_loads_with_one_change_that_stands_everywhere():
    register = changes.load()
    assert [change.change for change in register if change.app_wide] == [RESIDUE]
    assert all(change.kinds and changes.APP_WIDE not in change.kinds for change in register if not change.app_wide)


def test_a_document_whose_saves_are_brought_in_holds_each_change_of_its_review_everywhere():
    document = SimpleNamespace(id="nova", hq_authored=False, kind="corpus", next_publish=("hidden-values-added",))
    assert changes.placed(document, REGISTER) == {"hidden-values-added": ("",)}


# The inert allowance and the places Nova keeps ----------------------------------------------------------------


def _inert_held(at, *, inert, other=()):
    places = changes.ClaimPlaces(inert=frozenset(inert), other=frozenset(other))
    difference = _source(at)
    document = _document(RESIDUE)
    held, _ = changes.declared(document, "source", [difference], places=places, register=REGISTER)
    return held == [difference]


def test_the_inert_allowance_holds_a_source_difference_under_an_inert_place():
    assert _inert_held("/profile/properties/purge-freq", inert={"/profile/properties/purge-freq"})
    # A claim of another standing above the inert place (the profile's own) says nothing of the key under it.
    assert _inert_held(
        "/profile/properties/purge-freq", inert={"/profile/properties/purge-freq"}, other={"/profile/properties"}
    )
    assert not _inert_held("/profile/properties/purge-freq", inert=())


def test_the_inert_allowance_holds_nothing_where_a_kept_claim_shares_its_place():
    # A key no runtime reads and a catalog key CommCare HQ fills are both recorded at /translations: the log does not
    # tell which key changed, so neither is held.
    assert not _inert_held("/translations/en/catalog.key", inert={"/translations"}, other={"/translations"})
    assert not _inert_held("/translations/en/unread.key", inert={"/translations"}, other={"/translations"})
    assert _inert_held("/translations/en/unread.key", inert={"/translations"})


def test_the_inert_allowance_holds_nothing_on_the_branch_of_a_kept_claim_under_its_place():
    inert, other = {"/add_ons"}, {"/add_ons/kept"}
    assert not _inert_held("/add_ons/kept", inert=inert, other=other)
    assert not _inert_held("/add_ons/kept/x", inert=inert, other=other)
    assert not _inert_held("/add_ons", inert=inert, other=other)  # the whole map, the kept key in it
    assert _inert_held("/add_ons/other", inert=inert, other=other)


def test_the_claim_places_read_the_log_s_records_on_the_app_s_json_by_standing():
    log = "".join(
        json.dumps({"artifact": artifact, "where": where, "key": None, "entry": "e", "standing": standing}) + "\n"
        for artifact, where, standing in (
            ("app.json", "/translations", "inert"),
            ("app.json", "/translations", "kept"),
            ("app.json", "/name", "held"),
            ("form:0.0", "/h:html", "inert"),
        )
    )
    assert parity.claim_places(log) == changes.ClaimPlaces(
        inert=frozenset({"/translations"}), other=frozenset({"/translations", "/name"})
    )


def _record(where, standing, entry="e", *, at=None):
    value = {"artifact": "app.json", "where": where, "key": "schema:Application.translations", "entry": entry}
    value["standing"] = standing
    if at is not None:
        value["at"] = at
    return json.dumps(value) + "\n"


def test_a_translation_key_s_claim_is_placed_at_the_key_it_reads_and_only_an_inert_one_is_held():
    # Contract: every claim of a language's key names the map's schema key, so it stands at /translations, where the
    # join reads it, and reads its own key (``at``), where the inert allowance reads it. The plausible failure, run 7
    # on hq-languages and starter-agriculture: an inert override's removal unheld beside the kept claims at
    # /translations, or a folded or kept key's removal held by an inert claim beside it.
    log = "".join(
        (
            _record("/translations", "take", "container"),
            _record("/translations", "kept", "catalog-fill"),
            # hq-languages: an English override equal to the form's own name, which has no effect.
            _record("/translations", "inert", "generated-no-effect", at="/translations/en/forms.m0f0"),
            # A generated key folded into the text it names, and a key a runtime reads, kept.
            _record("/translations", "held", "generated-over-one-text", at="/translations/en/forms.m0f1"),
            _record("/translations", "kept", "runtime-ui-string", at="/translations/en/cchq.case"),
            # starter-agriculture: a language the app does not hold, read past whole.
            _record("/translations", "inert", "key-no-runtime-reads", at="/translations/fra"),
        )
    )
    places = parity.claim_places(log)
    assert places == changes.ClaimPlaces(
        inert=frozenset({"/translations/en/forms.m0f0", "/translations/fra"}),
        other=frozenset({"/translations", "/translations/en/forms.m0f1", "/translations/en/cchq.case"}),
    )

    def held(at):
        found, _ = changes.declared(_document(RESIDUE), "source", [_source(at)], places=places, register=REGISTER)
        return bool(found)

    assert held("/translations/en/forms.m0f0")
    assert held("/translations/fra/cchq.case")
    assert not held("/translations/en/forms.m0f1")
    assert not held("/translations/en/cchq.case")
    assert not held("/translations/en/other.key")


HELD_PICTURE = "jr://file/commcare/image/held.png"
OTHER_PICTURE = "jr://file/commcare/image/other.png"


def _app(held_id, other_id, shown, calculated):
    return {
        "multimedia_map": {
            HELD_PICTURE: {"multimedia_id": held_id, "unique_id": "u-held"},
            OTHER_PICTURE: {"multimedia_id": other_id, "unique_id": "u-other"},
        },
        "modules": [
            {
                "case_details": {
                    "short": {
                        "columns": [
                            {"field": shown, "useXpathExpression": False},
                            {"field": calculated, "useXpathExpression": True},
                        ]
                    }
                }
            }
        ],
    }


def test_a_difference_at_a_place_nova_keeps_is_declared_by_no_entry_however_wide():
    # The changes register as the lane reads it: media-files-renamed's /multimedia_map/*, sort-rule-kept-as-hidden-
    # column's /modules/*/case_details/short/columns and instant-comparison's /modules/*/case_details/* each cover a
    # held place's pointer, and each stands there.
    document = _document(
        RESIDUE,
        ("media-files-renamed", [f"/app/multimedia_map/{HELD_PICTURE.replace('/', '~1')}", "/app/multimedia_map"]),
        (
            "sort-rule-kept-as-hidden-column",
            ["/menu/0/case_details/short/sort_elements/0/field", "/menu/0/case_details/short/columns/2"],
        ),
        ("instant-comparison", ["/menu/0/case_details/short"]),
    )
    found = source.compare_sources(
        document.id,
        _app("m-held", "m-other", "name", "age + 1"),
        _app("m-held-again", "m-other-again", "dob", "age+1"),
        held_paths={HELD_PICTURE},
    )
    kept_paths = {"/multimedia_map/*/held", "/modules/*/case_details/short/columns/*/held"}
    assert {difference.path for difference in found} >= kept_paths
    held_ones = [difference for difference in found if difference.path in kept_paths]
    others = [difference for difference in found if difference.path not in kept_paths]
    assert others and all(changes.held(difference) for difference in held_ones)
    for places in (
        changes.NO_CLAIMS,
        changes.ClaimPlaces(inert=frozenset({"/multimedia_map", "/modules/0/case_details/short/columns"})),
    ):
        declared, _ = changes.declared(document, "source", found, places=places)
        assert declared == others
        assert changes.undeclared(document, "source", found, places=places) == held_ones
    judged = changes.differences(document, {"source": found}, readers=frozenset())
    assert not [difference for difference in judged if difference.path.endswith("/unsaid")]


@pytest.mark.parametrize("path", ["/multimedia_map/*/held", "/modules/*/case_details/*/columns/*/held/field"])
def test_the_register_refuses_a_row_naming_a_place_nova_keeps(path):
    row = {"check": "source", "artifact": "app.json", "path": path}
    with pytest.raises(changes.ChangesError, match="holds what Nova keeps"):
        changes.parse([_entry("media-files-renamed", ["app"], [row])])
    assert changes.parse([_entry("media-files-renamed", ["app"], [{**row, "path": "/multimedia_map/*"}])])


def test_the_rows_command_names_the_change_whose_place_stands_where_an_unheld_difference_is(tmp_path):
    checks = tmp_path / "blocks" / "b0" / "checks" / "source"
    checks.mkdir(parents=True)
    differences = [
        {"artifact": "app.json", "path": "/multimedia_map/*/held", "at": "/multimedia_map/p/held/multimedia_id"},
        {"artifact": "app.json", "path": "/name", "at": "/name"},
        {"artifact": "app.json", "path": "/modules/*/case_list/label", "at": "/modules/0/case_list/label"},
    ]
    record = {"differences": [{**difference, "kind": "changed"} for difference in differences]}
    (checks / "corpus-hq-planted.json").write_text(json.dumps(record), encoding="utf-8")
    corpus = tmp_path / "corpus" / "hq-planted"
    corpus.mkdir(parents=True)
    listed = {"changes": [{"id": "case-names-checked", "places": ["/menu/0"]}]}
    (corpus / "first-publish.json").write_text(json.dumps(listed), encoding="utf-8")
    # The held place gets no row; the menu's label, at the place of a change whose rows do not name it, gets the row
    # and that change; the app's name, at no applying change's place, gets the row and no change.
    assert changes.rows(tmp_path, "hq-planted", register=OVERLAPPING) == [
        {"row": {"check": "source", "artifact": "app.json", "path": "/name"}, "at": []},
        {
            "row": {"check": "source", "artifact": "app.json", "path": "/modules/*/case_list/label"},
            "at": ["case-names-checked"],
        },
    ]


def test_no_entry_is_read_on_a_document_not_made_in_hq():
    document = SimpleNamespace(id="nova", hq_authored=False, first_publish_places=())
    assert changes.declared(document, "source", [_source("/x")], register=REGISTER) == ([], frozenset())


# The review's second round: each place a change stands at is its own, over the register as the lane reads it -----


DATETIME = "date-and-time-saved-as-hq-stores-it"
# Where the producer places a date and time saved on form 0.0 (``firstPublishChanges.ts::datetimeWritePlaces``).
DATETIME_PLACES = [f"{FORM}/xform/**/case/update/visited_at", "/case/patient/visited_at"]
# Run 0 opens form 0.0, run 4 form 2.0; case c1 is a patient, case c2 a household.
TWO_FORMS = changes.merged_sites(
    _run_at_form(0, "0.0", steps=8),
    _run_at_form(4, "2.0", steps=8),
    changes.Sites(cases={"c1": ("patient",), "c2": ("household",)}),
)


def _held_by(document, difference, sites=TWO_FORMS):
    return changes.declared(document, difference.check, [difference], sites=sites)[1]


def test_a_date_and_time_saved_on_one_form_holds_no_other_form_s_run_and_no_other_property_or_type():
    document = _document(RESIDUE, (DATETIME, DATETIME_PLACES))
    update = "/runs/*/trace/*/submission/data/case[*]/update[*]/*/text()"
    own = _trace("/runs/0/trace/6/submission/data/case[1]/update[1]/visited_at[1]/text()", update)
    assert _held_by(document, own) == {DATETIME}
    # The review's scenario (a): another form's run writing another property, and another case type's value.
    other_form = _trace("/runs/4/trace/6/submission/data/case[1]/update[1]/weight[1]/text()", update)
    same_property_other_form = _trace("/runs/4/trace/6/submission/data/case[1]/update[1]/visited_at[1]/text()", update)
    other_property = _trace("/runs/0/trace/6/submission/data/case[1]/update[1]/weight[1]/text()", update)
    database = "/runs/*/trace/*/caseDb/casedb/case[@case_id=*]/*/text()"
    own_case = _trace("/runs/0/trace/7/caseDb/casedb/case[@case_id=c1]/visited_at/text()", database)
    other_type = _trace("/runs/0/trace/7/caseDb/casedb/case[@case_id=c2]/visited_at/text()", database)
    for difference in (other_form, same_property_other_form, other_property, other_type):
        assert _held_by(document, difference) == frozenset(), difference.at
    assert _held_by(document, own_case) == {DATETIME}
    # With no record of where the run stands, the difference stands nowhere a change's place is.
    assert _held_by(document, own, changes.NO_SITES) == frozenset()


def test_a_case_name_checked_on_one_form_holds_no_other_form_s_case_block():
    places = [
        f"{FORM}/actions",
        f"{FORM}/xform/**/case/update/case_name",
        "/case/patient/name",
    ]
    document = _document(RESIDUE, ("case-names-checked", places))
    block = "/runs/*/blocks/*/case/*/update/case_name"
    # The review's scenario (b): form 1.2's case name, in run 4's form here.
    other = Difference(
        "proof3",
        "hq-planted",
        "case_blocks@B",
        block,
        "/runs/4/blocks/c9/case/0/update/case_name",
        "changed",
        None,
        None,
    )
    own = Difference(
        "proof3",
        "hq-planted",
        "case_blocks@B",
        block,
        "/runs/0/blocks/c1/case/0/update/case_name",
        "changed",
        None,
        None,
    )
    assert _held_by(document, other) == frozenset()
    assert _held_by(document, own) == {"case-names-checked"}
    name = "/runs/*/cases/*/name"
    assert _held_by(
        document,
        Difference("proof3", "hq-planted", "case_blocks@B", name, "/runs/0/cases/c1/name", "changed", None, None),
    ) == {"case-names-checked"}
    assert (
        _held_by(
            document,
            Difference("proof3", "hq-planted", "case_blocks@B", name, "/runs/0/cases/c2/name", "changed", None, None),
        )
        == frozenset()
    )


def test_native_case_name_checks_hold_only_the_declared_form_node_and_java_trim():
    name = "case-names-checked"
    position = "0.0"
    form = ("form", position, "xform", "data")
    prefix = "/runs/0/steps/3/submissions/0/instance/data/"
    shape = "/runs/*/steps/*/submissions/*/instance/data/"
    document = _document((name, ["/form/0.0/xform/data/head_name", "/form/0.0/xform/data/nova_trimmed_head_name"]))
    for artifact in ("formplayer@B", "formplayer@local.ccz"):
        node = Difference(
            "proof3",
            document.id,
            artifact,
            shape + "nova_trimmed_*[*]",
            prefix + "nova_trimmed_head_name[1]",
            "added",
            None,
            "<nova_trimmed_head_name/>",
        )
        case = Difference(
            "proof3",
            document.id,
            artifact,
            shape + "case[*]/create[*]/case_name[*]/text()",
            prefix + "case[1]/create[1]/case_name[1]/text()",
            "changed",
            "  proof text\t",
            "proof text",
        )
        sites = changes.Sites(
            served={
                (artifact, node.at): (*form, "nova_trimmed_head_name"),
                (artifact, case.at): (*form, "head_name"),
            }
        )
        assert _held_by(document, node, sites) == _held_by(document, case, sites) == {name}
        child = replace(
            case,
            path=case.path.replace("data/case", "data/subcase_*[*]/case"),
            at=case.at.replace("data/case", "data/subcase_0[1]/case"),
        )
        child_sites = changes.Sites(served={(artifact, child.at): (*form, "head_name")})
        assert _held_by(document, child, child_sites) == {name}
        assert not _held_by(document, replace(child, after="changed"), child_sites)
        assert not _held_by(document, child, changes.Sites(served={(artifact, child.at): (*form, "other_name")}))
        for other in (
            replace(case, after="new name"),
            replace(case, before="\xa0proof text"),
            replace(case, before="   ", after=""),
            replace(case, before=" " + "😀" * 128, after="😀" * 128),
            replace(node, kind="removed"),
        ):
            assert not _held_by(document, other, sites)
        unrelated = changes.Sites(
            served={
                (artifact, node.at): (*form, "nova_trimmed_unrelated"),
                (artifact, case.at): ("form", "1.0", "xform", "data", "case", "create", "case_name"),
            }
        )
        assert not _held_by(document, node, unrelated) and not _held_by(document, case, unrelated)
        assert not _held_by(document, case, changes.NO_SITES)


def test_the_split_holds_no_other_form_s_question_of_the_same_name_and_a_title_no_other_form_s():
    split = _document(RESIDUE, (SPLIT, ["/form/2.0/xform/data/visit", "/form/2.0/actions"]))
    answer = _trace("/runs/0/trace/3/submission/data/visit[1]/text()", "/runs/*/trace/*/submission/data/*/text()")
    assert _held_by(split, answer) == frozenset()  # scenario (c): run 0 opens form 0.0
    moved = _trace("/runs/4/trace/3/submission/data/visit[1]/text()", "/runs/*/trace/*/submission/data/*/text()")
    assert _held_by(split, moved) == {SPLIT}
    titles = _document(RESIDUE, ("form-titles-written", ["/form/2.0/xform/title"]))
    title = "/runs/*/trace/*/title/form"
    assert _held_by(titles, _trace("/runs/0/trace/1/title/form", title)) == frozenset()  # (d)
    assert _held_by(titles, _trace("/runs/4/trace/1/title/form", title)) == {"form-titles-written"}


def _built(artifact, path, at, kind="changed"):
    return Difference("proof2", "hq-planted", artifact, path, at, kind, None, None)


@pytest.mark.parametrize("build_element", ("remote-request", "entry"))
def test_repeated_search_order_change_covers_original_filter_and_exact_built_and_sent_values(build_element):
    change = "search-order-direction-signs-respelled"
    document = _document(RESIDUE, (change, ["/menu/0/search_config/default_properties/0/defaultValue"]))
    sites = changes.Sites(
        builds={("suite.xml", f"{build_element}[1]"): ("menu", "0")},
        steps={(0, 0): ("menu", "0", "search_config")},
    )

    def app(first, second):
        return {
            "modules": [{
                "search_config": {"default_properties": [
                    {"property": "commcare_sort", "defaultValue": first},
                    {"property": "region", "defaultValue": second},
                ]},
            }],
        }

    def suite(first, second):
        return (
            f'<suite><{build_element}><session><query>'
            f'<data key="commcare_sort" ref="{first}"/><data key="commcare_sort" ref="{second}"/>'
            '<data key="region" ref="&apos;north&apos;"/>'
            f'</query></session></{build_element}></suite>'
        )

    def run(first, second):
        params = {"commcare_sort": [first, second], "region": ["north"]}
        return {
            "end": "incomplete",
            "script": [],
            "trace": [{"screen": "search", "params": params, "requests": [{"kind": "search", "params": params}]}],
        }

    changed = source.compare_sources("hq-planted", app("'++priority'", "'north'"), app("'+priority'", "'south'"))
    assert len(changed) == 2
    assert [_held_by(document, item, sites) for item in changed] == [{change}, frozenset()]

    built = compare_xml(
        suite("'++priority'", "'-name'"), suite("'+priority'", "'-name'"),
        check="proof2", document="hq-planted", artifact="suite.xml",
    )
    assert [item.path for item in built] == [
        f"/suite/{build_element}[*]/session[*]/query[*]/data[@key=commcare_sort][*]/@ref",
    ]
    assert _held_by(document, built[0], sites) == {change}

    position_swapped = compare_xml(
        suite("'+priority'", "'-name'"), suite("'-name'", "'+priority'"),
        check="proof2", document="hq-planted", artifact="suite.xml",
    )
    assert len(position_swapped) == 2
    assert all(not _held_by(document, item, sites) for item in position_swapped)
    assert not _held_by(document, replace(built[0], after="'-priority'"), sites)

    sent = compare_traces(
        {"runs": [run("++priority", "-name")]}, {"runs": [run("+priority", "-name")]},
        check="proof3", document="hq-planted", artifact="trace@B", rules=(),
    )
    assert {item.path for item in sent} == {
        "/runs/*/trace/*/params/commcare_sort/*",
        "/runs/*/trace/*/requests/*/params/commcare_sort/*",
    }
    assert all(_held_by(document, item, sites) == {change} for item in sent)


def test_a_menu_s_change_holds_no_other_menu_s_build_difference():
    # The review's second defect: each of its scenarios, over the register's own rows.
    sites = changes.Sites(
        builds={("suite.xml", "remote-request[1]"): ("menu", "0"), ("suite.xml", "remote-request[7]"): ("menu", "2")},
        steps={
            (2, 4): ("menu", "1"),
            (2, 5): ("menu", "3", "case_details", "short"),
            (2, 6): ("menu", "2", "search_config"),
            (2, 7): ("menu", "0", "search_config"),
        },
        choices={(2, 4, 1): ("form", "1.0"), (2, 4, 0): ("menu", "0")},
    )
    recut = _document(RESIDUE, ("search-filter-rows-recut", ["/menu/0/search_config/default_properties"]))
    query = "/suite/remote-request[*]/session[*]/query[*]/data[@key=_xpath_query][@ref=*]"

    def clause(position):
        at = f"/suite/remote-request[{position}]/session[1]/query[1]/data[@key=_xpath_query][@ref=typed]"
        return _built("suite.xml", query, at, "added")

    assert _held_by(recut, clause(1), sites) == {"search-filter-rows-recut"}
    assert _held_by(recut, clause(7), sites) == frozenset()
    hidden = _document(
        RESIDUE,
        (
            "sort-rule-kept-as-hidden-column",
            ["/menu/0/case_details/short/sort_elements/0/field", "/menu/0/case_details/short/columns/5"],
        ),
    )
    header = "/m*.*.*_*_*.header"
    assert (
        _held_by(hidden, _built("app_strings:en", header, "/m3.case_short.case_dob_2.header", "added"), sites)
        == frozenset()
    )
    assert _held_by(
        hidden, _built("app_strings:en", header, "/m0.case_short.case_visits_6.header", "added"), sites
    ) == {"sort-rule-kept-as-hidden-column"}
    spaces = _document(RESIDUE, ("text-spaces-dropped", ["/menu/0/name"]))
    text = "/runs/*/trace/*/choices/*/text"
    assert _held_by(spaces, _trace("/runs/2/trace/4/choices/1/text", text), sites) == frozenset()
    assert _held_by(spaces, _trace("/runs/2/trace/4/choices/0/text", text), sites) == {"text-spaces-dropped"}
    blank = _document(
        RESIDUE, ("sort-by-entry-with-a-blank-name-dropped", ["/menu/0/case_details/short/sort_elements/0/display"])
    )
    assert _held_by(blank, _trace("/runs/2/trace/5/headers/1", "/runs/*/trace/*/headers/*"), sites) == frozenset()
    params = "/runs/*/trace/*/params/_xpath_query/*"
    assert _held_by(recut, _trace("/runs/2/trace/6/params/_xpath_query/x", params, "added"), sites) == frozenset()
    assert _held_by(recut, _trace("/runs/2/trace/7/params/_xpath_query/x", params, "added"), sites) == {
        "search-filter-rows-recut"
    }


def test_the_change_that_stands_everywhere_holds_no_form_source_difference_its_rows_do_not_name():
    # The review's fifth defect: an untouched question's calculate changed, with only that change applying.
    document = _document(RESIDUE)
    changed = _part("/_attachments/form:1.0.xml/data/total/:bind/@calculate")
    assert changes.declared(document, "source", [changed])[0] == []
    assert changes.undeclared(document, "source", [changed]) == [changed]


@pytest.mark.parametrize("path", ["/_attachments", "/_attachments/*", "/_attachments/form:0.0.xml"])
def test_the_register_refuses_a_row_of_the_change_that_stands_everywhere_over_a_form_s_whole_source(path):
    row = {"check": "source", "artifact": "app.json", "path": path}
    with pytest.raises(changes.ChangesError, match="every part of every form's source"):
        changes.parse([_entry(RESIDUE, ["app-wide"], [row])])
    # A part class is no form's whole source, and a change with places of its own may name the whole.
    assert changes.parse([_entry(RESIDUE, ["app-wide"], [{**row, "path": "/_attachments/*/data/*/:bind"}])])
    assert changes.parse([_entry(RESIDUE, ["app-wide"]), _entry("hidden-values-added", ["form-node"], [row])])


def test_the_hidden_column_a_sort_rule_adds_is_held_at_the_column_the_producer_places():
    # The review's sixth defect: a retained base's two columns added in menu 0, over the register's own rows.
    places = [
        "/menu/0/case_details/short/sort_elements/0/field",
        "/menu/0/case_details/short/sort_elements/1/field",
        "/menu/0/case_details/short/columns/5",
        "/menu/0/case_details/short/columns/6",
    ]
    document = _document(RESIDUE, ("sort-rule-kept-as-hidden-column", places))
    column = "/modules/*/case_details/short/columns/*"
    added = [
        Difference(
            "source", "hq-planted", "app.json", column, f"/modules/0/case_details/short/columns/{n}", "added", None, {}
        )
        for n in (5, 6)
    ]
    assert changes.declared(document, "source", added)[0] == added
    elsewhere = Difference(
        "source", "hq-planted", "app.json", column, "/modules/3/case_details/short/columns/5", "added", None, {}
    )
    assert changes.undeclared(document, "source", [elsewhere]) == [elsewhere]


def test_a_case_list_icon_s_picture_is_held_at_its_column_and_in_its_menu_s_media():
    # The review's seventh defect: the producer places the reference by the value naming it and the menu's media.
    picture = "jr:~1~1file~1commcare~1image~1a.png"
    places = [
        f"/app/multimedia_map/{picture}",
        "/menu/0/case_details/short/columns/2/enum/0/value",
        f"/menu/0/media/{picture}",
    ]
    document = _document(RESIDUE, ("media-files-renamed", places))
    value = Difference(
        "source",
        "hq-planted",
        "app.json",
        "/modules/*/case_details/*/columns/*/enum/*/value/*",
        "/modules/0/case_details/short/columns/2/enum/0/value/en",
        "changed",
        None,
        None,
    )
    listed = Difference(
        "proof1",
        "hq-planted",
        "app.json",
        "/modules/*/forms/*/media/*",
        f"/modules/0/media/{picture}",
        "removed",
        None,
        None,
    )
    assert changes.declared(document, "source", [value])[1] == {"media-files-renamed"}
    assert changes.locate(listed) == ("menu", "0", "media", "jr://file/commcare/image/a.png")


def test_sites_two_configurations_place_apart_are_no_place_and_round_trip_through_the_evidence():
    one = changes.Sites(runs={0: ("form", "0.0")}, cases={"c1": ("patient",)})
    other = changes.Sites(runs={0: ("form", "1.0")}, cases={"c1": ("patient",)})
    merged = changes.merged_sites(one, other)
    assert merged.runs == {0: None} and merged.cases == {"c1": ("patient",)}
    document = _document(RESIDUE, (DATETIME, DATETIME_PLACES))
    own = _trace(
        "/runs/0/trace/6/submission/data/case[1]/update[1]/visited_at[1]/text()",
        "/runs/*/trace/*/submission/data/case[*]/update[*]/*/text()",
    )
    steps = changes.merged_sites(_run_at_form(0, "0.0", steps=8), _run_at_form(0, "1.0", steps=8))
    assert _held_by(document, own, steps) == frozenset()
    assert changes.Sites.from_json(json.loads(json.dumps(TWO_FORMS.as_json()))) == TWO_FORMS


def test_the_rows_command_locates_proof_3_evidence_by_the_sites_the_changes_check_wrote(tmp_path):
    record = {
        "differences": [
            {
                "artifact": "trace@B",
                "path": "/runs/*/trace/*/title",
                "at": "/runs/4/trace/1/title",
                "kind": "changed",
            }
        ]
    }
    for check, written in (("proof3", record), ("changes", {"differences": [], "sites": TWO_FORMS.as_json()})):
        directory = tmp_path / "blocks" / "b0" / "checks" / check
        directory.mkdir(parents=True)
        (directory / "corpus-hq-planted.json").write_text(json.dumps(written), encoding="utf-8")
    corpus = tmp_path / "corpus" / "hq-planted"
    corpus.mkdir(parents=True)
    listed = {"changes": [{"id": "form-titles-written", "places": ["/form/2.0/xform/title"]}]}
    (corpus / "first-publish.json").write_text(json.dumps(listed), encoding="utf-8")
    register = changes.parse([_entry(RESIDUE, ["app-wide"]), _entry("form-titles-written", ["form-part"])])
    assert changes.rows(tmp_path, "hq-planted", register=register) == [
        {
            "row": {"check": "proof3", "artifact": "trace@B", "path": "/runs/*/trace/*/title", "kind": "changed"},
            "at": ["form-titles-written"],
        }
    ]


def test_a_trace_places_each_run_step_choice_and_case_where_the_runner_took_it():
    # A run that opens menu 1's list and then form 1.0, as the runner records it (``SessionOp.java``).
    from proof.checks import proof3

    database = '<casedb><case case_id="c1" case_type="patient"/><case case_id="c2" case_type="visit"/></casedb>'
    trace = {
        "runs": [
            {
                "script": [{"command": "m1"}, {"select": "c1"}, {"command": "m1-f0"}],
                "trace": [
                    {"screen": "menu", "root": "root", "choices": [{"command": "m0"}, {"command": "m1"}]},
                    {"screen": "case-list", "detail": "m1_case_short"},
                    {"screen": "menu", "root": "m1", "choices": [{"command": "m1-f0"}]},
                    {"screen": "search"},
                    {"screen": "form", "xmlns": "x", "caseDb": database},
                ],
            },
            {"script": [{"command": "m2"}], "trace": [{"screen": "menu", "root": "root", "choices": []}]},
        ]
    }
    processed = {"runs": [{"cases": {"c3": {"type": "household"}}}]}
    sites = proof3.trace_sites(trace, processed)
    assert sites.runs == {0: ("form", "1.0"), 1: ("menu", "2")}
    assert sites.steps[(0, 0)] is None  # the root menu is no menu's
    assert sites.steps[(0, 1)] == ("menu", "1", "case_details", "short")
    assert sites.steps[(0, 2)] == ("menu", "1")
    assert sites.steps[(0, 3)] == ("menu", "1", "search_config")
    assert sites.steps[(0, 4)] == ("form", "1.0")
    assert sites.choices == {(0, 0, 0): ("menu", "0"), (0, 0, 1): ("menu", "1"), (0, 2, 0): ("form", "1.0")}
    assert sites.cases == {"c1": ("patient",), "c2": ("visit",), "c3": ("household",)}


def test_a_build_places_its_entries_requests_forms_and_media_by_what_it_holds_there():
    from proof.checks import proof2

    suite = b"""<suite>
      <xform><resource id="u1"><location authority="local">./modules-0/forms-1.xml</location></resource></xform>
      <entry><form>x</form><command id="m0-f1"/></entry>
      <entry><command id="m2-case-list"/></entry>
      <remote-request><command id="search_command.m3"/></remote-request>
    </suite>"""
    media = b"""<suite><media path="../../commcare/image">
      <resource id="r1"><location authority="remote">https://hq/a/hqmedia/file/CommCareImage/x/a%20b.png</location>
      </resource></media></suite>"""
    sites = proof2.build_sites({"suite.xml": suite, "media_suite.xml": media, "p1/suite.xml": suite})
    assert sites.builds == {
        ("suite.xml", "xform[1]"): ("form", "0.1"),
        ("suite.xml", "entry[1]"): ("form", "0.1"),
        ("suite.xml", "entry[2]"): ("menu", "2"),
        ("suite.xml", "remote-request[1]"): ("menu", "3"),
    }
    assert sites.media == {"r1": "jr://file/commcare/image/a b.png"}


def test_a_picture_left_out_of_a_menu_holds_that_menu_s_suite_text_and_no_other_menu_s():
    places = ["/app/multimedia_map/jr:~1~1file~1gone.png", "/menu/1/media_image", "/menu/1/media/jr:~1~1file~1gone.png"]
    document = _document(RESIDUE, ("media-references-with-no-file-removed", places))
    text = "/suite/menu[@id=*]/text[*]"
    held = _built("suite.xml", text, "/suite/menu[@id=m1]/text[1]", "added")
    assert _held_by(document, held, changes.NO_SITES) == {"media-references-with-no-file-removed"}
    other = _built("suite.xml", text, "/suite/menu[@id=m2]/text[1]", "added")
    assert _held_by(document, other, changes.NO_SITES) == frozenset()


def test_a_menu_s_name_holds_its_forms_suite_descriptors_and_no_other_menu_s():
    # HQ writes a form's resource descriptor from its menu's name and its own (``FormResourceContributor``), so a
    # menu's name written again holds the descriptor of each of its forms there, and of no other menu's form.
    sites = changes.Sites(
        builds={("suite.xml", "xform[1]"): ("form", "1.0"), ("suite.xml", "xform[2]"): ("form", "0.0")}
    )
    path = "/suite/xform[*]/resource[@id=*]/@descriptor"
    own = _built("suite.xml", path, "/suite/xform[1]/resource[@id=r1]/@descriptor")
    other = _built("suite.xml", path, "/suite/xform[2]/resource[@id=r2]/@descriptor")
    assert changes.locations(own, sites) == (("form", "1.0", "name"), ("menu", "1", "name"))
    menu = _document(RESIDUE, ("text-spaces-dropped", ["/menu/1/name"]))
    assert _held_by(menu, own, sites) == {"text-spaces-dropped"}
    assert "text-spaces-dropped" not in _held_by(menu, other, sites)
    form = _document(RESIDUE, ("text-spaces-dropped", ["/form/0.0/name"]))
    assert _held_by(form, other, sites) == {"text-spaces-dropped"}
    assert "text-spaces-dropped" not in _held_by(form, own, sites)
    # Any other attribute of the resource stands at its form alone.
    version = _built(
        "suite.xml", "/suite/xform[*]/resource[@id=*]/@version", "/suite/xform[1]/resource[@id=r1]/@version"
    )
    assert changes.locations(version, sites) == (("form", "1.0", "name"),)


def test_the_app_s_name_stands_at_every_text_hq_writes_from_it():
    assert changes.locate(_built("profile.ccpr", "/profile/@name", "/profile/@name")) == ("app", "name")
    assert changes.locate(_built("profile.ccpr", "/profile/@version", "/profile/@version")) == (
        "app",
        "profile",
        changes.BELOW,
    )
    for key in ("app.display.name", "homescreen.title"):
        assert changes.locate(_built("app_strings:default", "/x", f"/{key}")) == ("app", "name")


def test_a_sort_only_element_s_header_stands_at_the_element_and_a_shown_column_s_at_its_column():
    from proof.checks import proof2

    # HQ's build writes a sort element no column shows as a column of its own, numbered by its order among the
    # sort elements (``util.py::create_temp_sort_column``): its header's key spells the second position, where a
    # shown column stands.
    doc = {
        "modules": [
            {
                "case_details": {
                    "short": {
                        "columns": [{"field": "name"}, {"field": "village"}, {"field": "opened"}],
                        "sort_elements": [{"field": "feeling_sick"}, {"field": "name"}, {"field": "_cc_calculated_2"}],
                    }
                }
            },
            {"case_details": {"short": {"columns": [{"field": "name"}]}}},
        ]
    }
    sites = proof2.header_sites(doc)
    key = "m0.case_short.case_feeling_sick_2.header"
    element = ("menu", "0", "case_details", "short", "sort_elements", "0", changes.BELOW)
    assert sites.builds == {(changes.APP_STRINGS, key): element}
    assert changes.Sites.from_json(json.loads(json.dumps(sites.as_json()))) == sites
    header = "/m*.*.*_*_*.header"
    sort_only = _built("app_strings:en", header, f"/{key}", "removed")
    assert changes.locate(sort_only, sites) == element
    kept = ["/menu/0/case_details/short/sort_elements/0/field", "/menu/0/case_details/short/columns/3"]
    document = _document(RESIDUE, ("sort-rule-kept-as-hidden-column", kept))
    assert _held_by(document, sort_only, sites) == {"sort-rule-kept-as-hidden-column"}
    # Read as the column at its key's number, the header would stand at a shown column no change moves.
    assert changes.locate(sort_only) == ("menu", "0", "case_details", "short", "columns", "1", "header")
    assert _held_by(document, sort_only, changes.NO_SITES) == frozenset()
    shown = _built("app_strings:en", header, "/m0.case_short.case_village_2.header", "removed")
    assert _held_by(document, shown, sites) == frozenset()


# Layer 9's seventh run: a difference no applying change holds, named once ---------------------------------------

# The register's shape that run met: twenty entries each naming every form source by one shared row, one of them
# naming a bind's calculation by a row of its own as well, and the change that stands everywhere narrowed to the
# form builder's shadows.
SHARED = ("hidden-values-added", "case-names-checked", "instant-comparison", "empty-rows-guard", "media-paths-joined")
SHAPE = changes.parse(
    [
        _entry(
            RESIDUE,
            ["app-wide"],
            [{"check": "source", "artifact": "app.json", "path": "/_attachments/*/data/*/:bind/@vellum:nodeset"}],
        ),
        *[
            _entry(change, ["form-node"], [{"check": "source", "artifact": "app.json", "path": "/_attachments/*"}])
            for change in SHARED
        ],
        _entry(
            "row-predicate-current",
            ["form-node"],
            [
                {"check": "source", "artifact": "app.json", "path": "/_attachments/*"},
                {"check": "source", "artifact": "app.json", "path": "/_attachments/*/data/*/:bind/@calculate"},
            ],
        ),
        _entry(
            "validation-counts-moved",
            ["form-node"],
            [{"check": "source", "artifact": "app.json", "path": "/_attachments/*/data/*/:bind/@constraint"}],
        ),
        _entry(
            "validation-messages-composed",
            ["form-node"],
            [{"check": "source", "artifact": "app.json", "path": "/_attachments/*/data/*/:bind/@constraint"}],
        ),
    ]
)


# The form builder's shadow every first publish drops, which the change that stands everywhere holds.
SHADOW = _part(
    "/_attachments/form:0.0.xml/data/age/:bind/@vellum:nodeset", "/_attachments/*/data/*/:bind/@vellum:nodeset"
)


def test_a_difference_only_a_row_many_entries_share_matches_is_reported_once_by_its_check_and_never_unsaid():
    # hq-plain's: the version every source holds, matched by fifteen entries none of which apply, was fifteen
    # unsaid differences; the stored-app comparison reports it, once.
    document = _document(RESIDUE, ("case-names-checked", [f"{FORM}/xform/data/name"]))
    version = _part("/_attachments/form:0.0.xml/data/@version", "/_attachments/*/data/@version")
    assert changes.naming(version, SHAPE, changes.placed(document, SHAPE)) is None
    assert changes.undeclared(document, "source", [version, SHADOW], register=SHAPE) == [version]
    found = changes.differences(document, {"source": [version, SHADOW]}, readers=frozenset(), register=SHAPE)
    assert _paths(found) == ["/case-names-checked/unseen"]


def test_a_difference_a_row_of_one_entry_alone_names_is_unsaid_of_that_entry_once():
    calculated = _part("/_attachments/form:0.0.xml/data/age/:bind/@calculate")
    other = _part("/_attachments/form:0.1.xml/data/age/:bind/@calculate")
    checked = {"source": [calculated, other, SHADOW]}
    found = changes.differences(_document(RESIDUE), checked, readers=frozenset(), register=SHAPE)
    assert [(d.path, d.at) for d in found] == [
        ("/row-predicate-current/unsaid", "/row-predicate-current/unsaid/source/app.json" + calculated.at),
        ("/row-predicate-current/unsaid", "/row-predicate-current/unsaid/source/app.json" + other.at),
    ]


def test_a_difference_an_applying_entry_s_own_row_names_off_its_places_is_no_one_s_unsaid():
    # The change applies and its place misses the node: the difference is that change's at a place its producer
    # does not give, which the check that reports it says; no other change is named for it.
    document = _document(RESIDUE, ("row-predicate-current", [f"{FORM}/xform/data/visits"]))
    elsewhere = _part("/_attachments/form:0.0.xml/data/age/:bind/@calculate")
    assert changes.undeclared(document, "source", [elsewhere, SHADOW], register=SHAPE) == [elsewhere]
    assert changes.naming(elsewhere, SHAPE, changes.placed(document, SHAPE)) is None
    found = changes.differences(document, {"source": [elsewhere, SHADOW]}, readers=frozenset(), register=SHAPE)
    assert _paths(found) == ["/row-predicate-current/unseen"]


def test_a_class_two_entries_name_alike_names_neither():
    constraint = _part(
        "/_attachments/form:0.0.xml/data/age/:bind/@constraint", "/_attachments/*/data/*/:bind/@constraint"
    )
    assert changes.naming(constraint, SHAPE, {RESIDUE: ("",)}) is None
    checked = {"source": [constraint, SHADOW]}
    assert changes.differences(_document(RESIDUE), checked, readers=frozenset(), register=SHAPE) == []


# The changes check's evidence, and the judgment made again from it ----------------------------------------------


def _judged_document():
    """A document, its checked differences, claims and sites as the changes check holds them: one difference the
    inert allowance holds, one a change holds at its place, one unsaid, and one undeclared."""
    document = _document(RESIDUE, ("case-names-checked", ["/menu/0"]))
    checked = {
        "source": [
            _source("/profile/properties/x"),
            _source("/modules/0/name"),
            _part("/_attachments/form:0.0.xml/data/age/:bind/@calculate"),
            _part("/_attachments/form:0.0.xml/data/@version", "/_attachments/*/data/@version"),
        ],
        "proof3": [_trace("/runs/4/trace/1/title", "/runs/*/trace/*/title")],
    }
    places = changes.ClaimPlaces(inert=frozenset({"/profile/properties"}))
    return document, checked, places


def _shape_with_menus():
    raw = [
        *[
            {**one, "rows": [*one["rows"]]}
            for one in (
                _entry(RESIDUE, ["app-wide"], [{"check": "source", "artifact": "app.json", "path": "/x"}]),
                _entry(
                    "case-names-checked",
                    ["menu"],
                    [{"check": "source", "artifact": "app.json", "path": "/modules/*"}],
                ),
                _entry(
                    "row-predicate-current",
                    ["form-node"],
                    [{"check": "source", "artifact": "app.json", "path": "/_attachments/*/data/*/:bind/@calculate"}],
                ),
            )
        ]
    ]
    return changes.parse(raw)


def test_the_judgment_is_made_again_from_the_evidence_alone(tmp_path):
    register = _shape_with_menus()
    document, checked, places = _judged_document()
    found = changes.differences(
        document, checked, places=places, sites=TWO_FORMS, readers=frozenset(), register=register
    )
    applying = changes.placed(document, register)
    record = {
        "check": "changes",
        "document": document.id,
        "kind": "corpus",
        **changes.evidence(applying, checked, places=places, sites=TWO_FORMS, readers=frozenset({"formplayer"})),
        "differences": [difference.as_json() for difference in found],
    }
    record = json.loads(json.dumps(record))
    assert changes.replay(record, register) == changes.judged(
        document.id,
        applying,
        checked,
        places=places,
        sites=TWO_FORMS,
        readers=frozenset({"formplayer"}),
        register=register,
    )
    assert [d.path for d in changes.replay(record, register)] == ["/row-predicate-current/unsaid"]
    assert changes.replayed(record, register) == {
        "document": "hq-planted",
        "held": 2,
        "undeclared": 3,
        "unsaid": 1,
        "unseen": [],
    }
    # The rows command reads the same evidence, in a sharded run's directory: the inert claim holds the profile's
    # key, so only what no change holds gets a row.
    shard = tmp_path / "proof-out-1-3" / "blocks" / "b0" / "checks" / "changes"
    shard.mkdir(parents=True)
    (shard / "corpus-hq-planted.json").write_text(json.dumps(record), encoding="utf-8")
    assert [one["row"]["path"] for one in changes.rows(tmp_path, "hq-planted", register=register)] == [
        "/_attachments/*/data/*/:bind/@calculate",
        "/_attachments/*/data/@version",
        "/runs/*/trace/*/title",
    ]
    assert changes.main(["replay", str(tmp_path), "hq-planted"]) == 0


def test_evidence_written_before_it_held_the_checked_differences_is_refused_by_the_replay(tmp_path):
    old = {"check": "changes", "document": "hq-planted", "applying": ["case-names-checked"], "differences": []}
    with pytest.raises(changes.ChangesError, match="holds no checked differences"):
        changes.replay(old)
    directory = tmp_path / "blocks" / "b0" / "checks" / "changes"
    directory.mkdir(parents=True)
    (directory / "corpus-hq-planted.json").write_text(json.dumps(old), encoding="utf-8")
    assert changes.main(["replay", str(tmp_path), "hq-planted"]) == 2


def test_the_form_titles_rows_hold_a_forms_title_and_never_a_case_lists():
    """Planted control for ``form-titles-written``'s ``proof3`` rows in the repository's register: a first publish
    that wrote a form's title shows it as the form step's title (``/runs/*/trace/*/title/form``), which the rows hold
    on a base the change applies to, while a case list's title that changed on the same base is no form's title and
    is left for the other holds. Failure it catches: rows written at the step's ``title`` alone, which a case list
    and a search share with a form, so a renamed case list would pass as a written form title."""
    from proof.checks.compare.trace import compare_traces

    def trace(form_title, list_title):
        steps = [{"screen": "case-list", "title": list_title, "rows": []}, {"screen": "form", "title": form_title}]
        return {"runs": [{"end": "submitted", "script": [], "trace": steps}]}

    found = compare_traces(
        trace(None, "Patients"),
        trace("Followup Form", "Clients"),
        check="proof3",
        document="hq-planted",
        rules=(),
        artifact="trace@B",
    )
    assert _paths(found) == ["/runs/*/trace/*/title/case-list", "/runs/*/trace/*/title/form"]
    # Both steps stand at form 0.0, so the change's place stands at both titles: only its rows tell them apart.
    document = _document(RESIDUE, ("form-titles-written", [f"{FORM}/xform/title"]))
    sites = _run_at_form(0, "0.0", steps=2)
    held, ids = changes.declared(document, "proof3", found, sites=sites)
    assert [difference.at for difference in held] == ["/runs/0/trace/1/title/form"]
    assert ids == {"form-titles-written"}


def test_a_native_blank_label_is_filled_only_from_the_first_language_of_that_same_question():
    from dataclasses import replace
    from pathlib import Path

    from proof.checks import proof3, xform_parts

    # A's form has a deliberately empty French label. Its Hindi label and its sibling question have their own text.
    app = json.loads((Path(__file__).parents[1] / "hq-apps" / "hq-languages" / "app.json").read_text())
    form = app["modules"][1]["forms"][0]
    parts = xform_parts.parts(app["_attachments"][f"{form['unique_id']}.xml"])

    def read(position):
        return parts if position == "1.0" else {}

    place = ("form", "1.0", "xform", "data", "crop", ":itext", "label", "fra", "default")
    difference = Difference(
        "proof3",
        "hq-languages",
        "formplayer@B",
        "/runs/*/steps/*/tree/*/caption",
        "/runs/3/steps/4/tree/1/caption",
        "changed",
        "",
        "Crop grown",
    )
    assert proof3.first_language_fill(difference, place, app, read)
    for altered in (replace(difference, before="Cultures"), replace(difference, after="Next crop")):
        assert not proof3.first_language_fill(altered, place, app, read)
    for altered in ((), (*place[:-2], "hin", "default"), (*place[:4], "unrelated", *place[5:])):
        assert not proof3.first_language_fill(difference, altered, app, read)


def test_legacy_related_case_text_requires_its_exact_column_and_unchanged_text():
    change = changes.LEGACY_RELATED_CASE_TEXT
    register = changes.load()
    place = "/menu/0/case_details/short/columns/1"
    header_path = "/m*.*.*_*_*.header"
    before = replace(
        _built("app_strings:en", header_path, "/m0.case_short.case_parent~1zone_2.header", "removed"),
        before="Parent area",
        after=None,
    )
    after = replace(
        _built("app_strings:en", header_path, "/m0.case_short.case_calculated_property_2.header", "added"),
        before=None,
        after="Parent area",
    )
    applying = {change: (place,)}
    assert changes.holders(after, register, applying, siblings=(before, after)) == [change]
    changed = replace(after, after="A different title")
    assert changes.holders(changed, register, applying, siblings=(before, changed)) == []
    assert changes.holders(after, register, applying, siblings=(before, after, after)) == []
    assert changes.holders(after, register, {change: (place[:-1] + "0",)}, siblings=(before, after)) == []

    header = replace(
        _built(
            "suite.xml", "/suite/detail[@id=*]/field[*]/header[*]/text[*]/locale[*]/@id",
            "/suite/detail[@id=m0_case_short]/field[2]/header[1]/text[1]/locale[1]/@id",
        ),
        before="m0.case_short.case_parent/zone_2.header",
        after="m0.case_short.case_calculated_property_2.header",
    )
    assert changes.holders(header, register, applying) == [change]
    assert changes.holders(header, register, {change: (place[:-1] + "0",)}) == []


def test_legacy_related_case_text_allows_only_the_same_stored_projection():
    from proof.checks import source

    change = changes.LEGACY_RELATED_CASE_TEXT
    place = "/menu/0/case_details/short/columns/0"
    apply = {change: (place,)}
    register = changes.load()
    before = {
        "model": "case", "format": "translatable-enum", "field": "parent/village", "useXpathExpression": False,
        "enum": [{"key": "north", "value": {"en": "North village", "es": "Pueblo del norte"}}],
    }
    after = {
        **before,
        "field": "instance('casedb')/casedb/case[@case_id = current()/index/parent]/village",
        "useXpathExpression": True,
        "enum": [{**before["enum"][0], "key": "case_text_9ab95772fa3351eabc620be9ec96300b"}],
    }

    def stored(column):
        return {"modules": [{"case_details": {"short": {"columns": [column]}}}]}

    compared = source.compare_sources("legacy", stored(before), stored(after))
    assert {d.at.rsplit("/", 1)[-1] for d in compared} == {"field", "key", "useXpathExpression"}
    assert all(changes.holders(d, register, apply, siblings=compared) == [change] for d in compared)
    assert all(changes.holders(d, register, {change: (place[:-1] + "1",)}, siblings=compared) == []
               for d in compared)
    for damaged in (
        {**after, "field": after["field"].replace("/parent]", "/uncle]")},
        {**after, "field": after["field"].replace("/village", "/town")},
        {**after, "enum": [{**after["enum"][0], "value": {"en": "Changed words"}}]},
    ):
        differences = source.compare_sources("legacy", stored(before), stored(damaged))
        assert any(changes.held(d) for d in differences)
        assert all(not changes.holders(d, register, apply, siblings=differences) for d in differences)
