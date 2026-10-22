"""Proof 5, locality: an edit batch changes nothing Nova emits outside the batch's footprint.

Contract (plan work item 11, proof 5, over the footprint the corpus writes
beside the batch): after an edit batch, every entity outside its footprint
(the app's own state, each
module, each form, named by Nova id) keeps its canonical digest: its JSON
and XForm source in Nova's publish of D' against Nova's next publish of D,
and its XForm in the local archives of D and D', with D''s minted ids
mapped to D's. The plausible failures: an emitter that rewrites an entity
the batch never reached (a value derived from another entity, a position,
an id), and a footprint that misses an entity the batch changed, which
would hide such a rewrite.

The controls are real batches from the corpus. The footprint the corpus
wrote passes, and the same footprint with one changed entity dropped fails
at exactly that entity, for an app, a module and a form; and with one entity
the footprint reached only by a derivation (``proof/corpus/footprint.ts``:
a module's settings its forms' wire carries, a menu's form list its child
menus' form entries are computed from) dropped, on every wire such an
entity's change shows on, the local suite and app strings included (a
parent menu's new form reorders the datums of its child menu's form
entry's stack frame). The local suite's positional ids are mapped through
Core's parse: an entity the edit moves compares equal there, which it does
not with the ids left as they are, and a stack step's value is read as Core
reads it, as XPath, but a query step's, which Core reads as a URL. A suite
element no runtime reads is compared too: its entity's where the other
archive reads it, and otherwise unowned, compared with its own names read
out and inside the footprint only when the footprint reaches the app or
holds every module, so a change to one of a module outside a footprint
that does neither is reported. An entity the edit moved is compared with
itself, never with what took its place. A form's
link that D' points at a form only D' holds is reported: no id D' minted
for its own entity reads as an id of D's
(an id is derived from its own entity's UUID alone,
``lib/commcare/wireIdentity.ts``). The digest reads
exactly what the comparators read, so it neither misses a change they
report nor reports a spelling they do not read. An input the corpus
lost (D''s publish under a configuration Nova's would send it to, one side's
local archive) is refused rather than skipped, while a configuration where
Nova's publish refuses D' (decision 19) is left out. A local form is compared
without its data node's ``version``, the sequence every local form carries
and D''s archive raises (the version clause): two forms that differ in it
alone read alike, and one more difference on such a form is still reported.

Every difference must fall in a class of ``proof/known-defects.json``.
"""

from __future__ import annotations

import base64
import json
import shutil
import zipfile
from types import SimpleNamespace

import pytest

from proof.checks import cases, corpus, observations, proof5
from proof.checks.compare.json_tree import compare_json
from proof.checks.compare.xml_tree import compare_xml_trees, parse_xml


def _edited(params):
    return [param for param in params if param.values[0].edit is not None]


@pytest.mark.parametrize("document", _edited(cases.document_params()) + cases.control_params("proof5"))
def test_entities_outside_the_footprint_keep_their_digest(document, core_runner):
    local = observations.local_records_for(document, core_runner).local
    found, compared = proof5.locality(document, local=local)
    cases.hold("proof5", document, found, cases.load_register(), **compared)


# The wires a derived entity's change can show on, as their artifacts' families.
DERIVED_WIRES = frozenset({"app.json", "form", "local:form", "local:suite.xml", "local:app_strings"})


def _family(artifact):
    head, _, rest = artifact.partition(":")
    return f"{head}:{rest.partition(':')[0]}" if head == "local" else head


def test_a_footprint_missing_a_derived_entity_fails_on_every_wire_it_changes(core_runner):
    """Each entity the written footprint holds only by a derivation (not one the batch touched), whose wire the
    batch changed, is reported exactly when it is dropped from the footprint, until every wire it can change on
    has been shown, the local suite and app strings with Core's parse."""
    covered = {}
    for document in cases.load_corpus().emitted:
        if document.edit is None or document.local_ccz is None:
            continue
        local = observations.local_records_for(document, core_runner).local
        footprint = proof5.footprint_of(document)
        compared = proof5.comparisons(document, local=local)
        if proof5.by_entity(document.id, compared, footprint):
            continue  # the written footprint must pass the whole document for the control to mean anything
        touched = set(document.edit.batch.get("touched") or [])
        for entity, found in sorted(proof5.by_entity(document.id, compared, None).items(), key=str):
            families = {_family(d.artifact) for d in found} - set(covered)
            if entity[0] not in ("module", "form") or entity[1] in touched or not families:
                continue
            dropped = proof5.by_entity(document.id, compared, footprint.without(entity))
            assert set(dropped) == {entity}, (
                f"{document.id}: with the derived {entity} dropped from the footprint its batch wrote, proof 5"
                f" should report that entity and no other; it reported {sorted(dropped, key=str)}."
            )
            for family in families & {_family(d.artifact) for d in dropped[entity]}:
                covered[family] = (document.id, entity)
        if DERIVED_WIRES <= set(covered):
            return
    raise AssertionError(
        f"The corpus holds no batch whose derived entities change on {sorted(DERIVED_WIRES - set(covered))}"
        f" (shown: {covered}), so nothing shows proof 5 catching a footprint that misses such an entity there."
    )


def test_a_parent_menus_new_form_reorders_its_child_menus_frame_inside_the_footprint(core_runner):
    """A form added to a parent menu moves the datums of its child menu's form entry's stack frame, which only
    the local suite shows, and the written footprint holds that form (a menu's form list reaches its child
    menus' forms)."""
    for document_id in ("targeted-parent-form-selection-frame", "targeted-parent-form-previous-frame"):
        document = cases.load_corpus().document(document_id)
        local = observations.local_records_for(document, core_runner).local
        compared = proof5.comparisons(document, local=local)
        footprint = proof5.footprint_of(document)
        assert proof5.by_entity(document.id, compared, footprint) == {}
        reordered = {
            entity
            for entity, found in proof5.by_entity(document.id, compared, None).items()
            if any(d.artifact == proof5.SUITE and d.path.endswith("/stack[*]/create[*]/order()") for d in found)
        }
        assert reordered and all(footprint.holds(entity) for entity in reordered), (document_id, reordered)


def test_an_entity_the_edit_moves_keeps_its_local_suite_once_its_positional_ids_are_mapped(core_runner):
    """A form or module the batch moved and left as it was compares equal in the local suite with D''s ids
    mapped through Core's parse, and differs with them left as they are (its entry's command id, its menu's)."""
    for document in cases.load_corpus().emitted:
        if document.edit is None or document.local_ccz is None:
            continue
        local = observations.local_records_for(document, core_runner).local
        mapped = [c for c in proof5.comparisons(document, local=local) if c.name == "local-suite"]
        footprint = proof5.footprint_of(document)
        for comparison in mapped:
            before, after = comparison.before, comparison.after
            for entity in sorted(set(before.records) & set(after.records), key=str):
                if (
                    entity[0] == proof5.APP
                    or footprint.holds(entity)
                    or before.positions[entity] == after.positions[entity]
                ):
                    continue
                if before.records[entity]["suite"].digest != after.records[entity]["suite"].digest:
                    continue
                # Moved, unchanged once mapped: with D''s ids left as they are, its positional ids differ.
                unmapped = [
                    c for c in proof5.comparisons(document, local=local, map_suite_ids=False) if c.name == "local-suite"
                ][0]
                assert unmapped.before.records[entity]["suite"].digest != unmapped.after.records[entity]["suite"].digest
                assert entity not in proof5.by_entity(document.id, mapped, footprint)
                return
    raise AssertionError(
        "No edit batch in the corpus moves a module or form outside its footprint and leaves it as it was, so"
        " nothing shows the local suite's positional ids mapped through Core's parse."
    )


SUITE_XML = """<suite>
<detail id="read"><title><text><locale id="read.title"/></text></title></detail>
<detail id="dead"><action><stack><push><command value="'search'"/></push></stack></action></detail>
<remote-request><command id="search"/></remote-request>
<entry><command id="open"/><session><datum id="case" detail-select="read"/></session></entry>
<menu id="home"><command id="open"/></menu>
</suite>"""
CORE = {"suites": [{"menus": [{"id": "home", "root": None, "commands": ["open"]}], "entries": [{"command": "open"}]}]}


def test_core_reads_each_stack_step_value_as_an_expression_but_a_query_steps_url():
    """The local record reads each stack step's value as Core does (``unit.stack_values``): a step's ``value`` is
    an expression (``StackFrameStepParser.parseValue``), but a ``query`` step's is a URL (``parseQuery``), so
    only the others are read as XPath. Shown on the corpus documents whose endpoints push a query."""
    import zipfile

    from proof.observe.unit import stack_values

    shown = 0
    for document in cases.load_corpus().emitted:
        if document.local_ccz is None:
            continue
        with zipfile.ZipFile(document.local_ccz) as archive:
            root = parse_xml(archive.read("suite.xml"))
        steps = [step for stack in root.iter("stack") for frame in stack for step in frame]
        queries = {step.get("value") for step in steps if step.tag == "query"}
        if not queries:
            continue
        shown += 1
        read = set(stack_values(document.local_ccz))
        assert read.isdisjoint(queries), f"{document.id}: a query step's URL is read as an expression"
        assert {step.get("value") for step in steps if step.tag == "command"} <= read
    assert shown, "No corpus document's endpoints push a query, so nothing shows its URL left unread as XPath."


def test_a_suite_element_no_runtime_reaches_is_found_unread_and_one_a_datum_names_is_not():
    """A runtime reaches a suite element from a menu or endpoint: a menu's commands, the details a datum names,
    the command a stack step opens. A case list's detail no datum names is read by nothing, nor is the search its
    action opens; named, both are."""
    readings = {"'search'": {"strings": ["search"], "truncated": False}}
    suite = proof5.suite_of(parse_xml(SUITE_XML), {}, CORE, readings, "?")
    assert proof5.unread(suite) == [("detail", "dead"), ("remote-request", "search")]
    named = parse_xml(SUITE_XML.replace('detail-select="read"', 'detail-select="read" detail-confirm="dead"'))
    assert proof5.unread(proof5.suite_of(named, {}, CORE, readings, "?")) == []
    # A step Core reads as no single string opens nothing.
    unknown = {"'search'": {"strings": ["?"], "truncated": False}}
    assert proof5.unread(proof5.suite_of(named, {}, CORE, unknown, "?")) == [("remote-request", "search")]


TWO_MODULES = """<suite>
<detail id="m0_case_short"><title><text><locale id="m0.short.title"/></text></title></detail>
<detail id="m0_case_long"><title><text><locale id="m0.long.title"/></text></title></detail>
<detail id="m1_case_short"><title><text><locale id="m1.short.title"/></text></title></detail>
<entry><form>urn:f0</form><command id="m0-f0"/><session><datum id="case_id" detail-select="m0_case_short"
 detail-confirm="m0_case_long"/></session></entry>
<entry><form>urn:f1</form><command id="m1-f0"/></entry>
<menu id="m0"><command id="m0-f0"/></menu>
<menu id="m1"><command id="m1-f0"/></menu>
</suite>"""
TWO_MODULES_CORE = {
    "suites": [
        {
            "menus": [{"id": "m0", "commands": ["m0-f0"]}, {"id": "m1", "commands": ["m1-f0"]}],
            "entries": [{"command": "m0-f0", "xmlns": "urn:f0"}, {"command": "m1-f0", "xmlns": "urn:f1"}],
        }
    ]
}
TWO_MODULES_PLACED = ({"M0": 0, "M1": 1}, {"F0": (0, 0), "F1": (1, 0)})
STRINGS = {"default": {"m0.short.title": "Cases", "m0.long.title": "Case", "m1.short.title": "Visits"}}


def _side(xml, placed=TWO_MODULES_PLACED):
    """One archive's suite as ``proof5.suite_comparison`` reads it: parsed, with Core's parse, and owned."""
    suite = proof5.suite_of(parse_xml(xml), STRINGS, TWO_MODULES_CORE, {}, "?")
    xmlns_of = {"F0": "urn:f0", "F1": "urn:f1"}
    owned, ids = proof5._owned(suite, placed, xmlns_of)
    return suite, placed, owned, ids, xmlns_of


def _keys(elements):
    return [proof5._key(element) for element in elements]


def _compare_suites(
    tmp_path,
    before,
    after,
    *,
    core_after=TWO_MODULES_CORE,
    placed_after=TWO_MODULES_PLACED,
    strings_after=STRINGS,
):
    """Compare real suite archives with a controlled Core admission at the reader boundary."""
    paths = [tmp_path / name for name in ("before.ccz", "after.ccz")]
    for path, xml, strings in zip(paths, (before, after), (STRINGS, strings_after), strict=True):
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("suite.xml", xml)
            for language, values in strings.items():
                archive.writestr(
                    f"{language}/app_strings.txt", "\n".join(f"{key}={value}" for key, value in values.items())
                )
    namespaces = {("form", "F0"): {"xmlns": "urn:f0"}, ("form", "F1"): {"xmlns": "urn:f1"}}
    return proof5.suite_comparison(
        SimpleNamespace(local_ccz=paths[0], edit=SimpleNamespace(local_ccz=paths[1])),
        {"admissions": {"local.ccz": TWO_MODULES_CORE, "edit/local.ccz": core_after}},
        (TWO_MODULES_PLACED, placed_after),
        (namespaces, namespaces),
    )


NESTED_SELECTION = TWO_MODULES.replace(
    '<entry><form>urn:f1</form><command id="m1-f0"/></entry>',
    '<entry><form>urn:f1</form><command id="m1-f0"/><session>'
    '<datum id="parent_id" detail-select="m0_case_short"/>'
    '<datum id="case_id" detail-select="m1_case_short"/></session></entry>',
)


def test_a_reused_session_datum_id_does_not_rename_an_unchanged_parents_detail(tmp_path):
    """Nesting aligns the parent's datum to case_id and renames the child's former case_id.

    The parent still owns and reads the same detail. Neither its definition nor its form's reference may
    acquire the child's detail identity through that reused session name.
    """
    after = NESTED_SELECTION.replace(
        '<datum id="parent_id" detail-select="m0_case_short"/><datum id="case_id" detail-select="m1_case_short"/>',
        '<datum id="case_id" detail-select="m0_case_short"/><datum id="case_id_visit" detail-select="m1_case_short"/>',
    ).replace('<menu id="m1">', '<menu id="m1" root="m0">')
    compared = _compare_suites(tmp_path, NESTED_SELECTION, after)
    footprint = proof5.Footprint(frozenset({"M1", "F1"}), True, False)
    assert proof5.by_entity("nested-selection", [compared], footprint) == {}
    for entity in (("module", "M0"), ("form", "F0")):
        assert compared.before.records[entity]["suite"].digest == compared.after.records[entity]["suite"].digest

    changed = after.replace('<locale id="m0.short.title"/>', '<locale id="m0.long.title"/>', 1)
    found = proof5.by_entity("nested-selection", [_compare_suites(tmp_path, NESTED_SELECTION, changed)], footprint)
    assert set(found) == {("module", "M0")}


def _swap_module_names(value):
    return value.replace("m0", "swapping").replace("m1", "m0").replace("swapping", "m1")


SWAPPED_CORE = {
    "suites": [
        {
            "menus": [{"id": "m1", "commands": ["m1-f0"]}, {"id": "m0", "commands": ["m0-f0"]}],
            "entries": [{"command": "m1-f0", "xmlns": "urn:f0"}, {"command": "m0-f0", "xmlns": "urn:f1"}],
        }
    ]
}
SWAPPED_PLACED = ({"M0": 1, "M1": 0}, {"F0": (1, 0), "F1": (0, 0)})
SWAPPED_STRINGS = {
    language: {_swap_module_names(key): value for key, value in held.items()} for language, held in STRINGS.items()
}


@pytest.mark.parametrize("child_selects", [False, True])
@pytest.mark.parametrize("target", ["case", "search"])
def test_a_detail_follows_its_module_when_the_other_modules_detail_is_read_or_unread(tmp_path, child_selects, target):
    before = NESTED_SELECTION if child_selects else TWO_MODULES
    before = before.replace("_case_", f"_{target}_")
    compared = _compare_suites(
        tmp_path,
        before,
        _swap_module_names(before),
        core_after=SWAPPED_CORE,
        placed_after=SWAPPED_PLACED,
        strings_after=SWAPPED_STRINGS,
    )
    assert proof5.by_entity("swapped-modules", [compared], None) == {}


@pytest.mark.parametrize("moved", [False, True])
@pytest.mark.parametrize("opaque", [False, True])
def test_a_real_detail_retarget_stays_visible_when_the_old_and_new_details_are_retained(tmp_path, moved, opaque):
    """A formerly unread detail becoming the selection is a changed form reference, including during a move.

    The module is inside the footprint, so changes to its detail definitions cannot stand in for the form's
    own change. Opaque names have no declared positional spelling and must never acquire one from datums.
    """
    before = TWO_MODULES.replace(' detail-confirm="m0_case_long"', "")
    if opaque:
        before = before.replace("m0_case_short", "first-detail").replace("m0_case_long", "other-detail")
    old, new = ("first-detail", "other-detail") if opaque else ("m0_case_short", "m0_case_long")
    after = before.replace(f'detail-select="{old}"', f'detail-select="{new}"')
    compared = _compare_suites(
        tmp_path,
        before,
        _swap_module_names(after) if moved else after,
        core_after=SWAPPED_CORE if moved else TWO_MODULES_CORE,
        placed_after=SWAPPED_PLACED if moved else TWO_MODULES_PLACED,
        strings_after=SWAPPED_STRINGS if moved else STRINGS,
    )
    found = proof5.by_entity("retargeted-detail", [compared], proof5.Footprint(frozenset({"M0"}), False, False))
    assert ("form", "F0") in found
    assert [(difference.artifact, difference.path, difference.kind) for difference in found[("form", "F0")]] == [
        (proof5.SUITE, "/suite/entry[*]/session[*]/datum[@id=*]/@detail-select", "changed")
    ]


def test_opaque_detail_names_have_no_inferred_positional_spelling(tmp_path):
    before = TWO_MODULES.replace("m0_case_short", "opaque-before")
    assert proof5.by_entity("opaque-detail", [_compare_suites(tmp_path, before, before)], None) == {}
    after = before.replace("opaque-before", "opaque-after")
    found = proof5.by_entity(
        "opaque-detail",
        [_compare_suites(tmp_path, before, after)],
        proof5.Footprint(frozenset({"M0"}), False, False),
    )
    assert ("form", "F0") in found


def test_removing_a_detail_does_not_pair_its_locales_with_a_retained_detail(tmp_path):
    after = TWO_MODULES.replace(' detail-confirm="m0_case_long"', "").replace(
        '<detail id="m0_case_long"><title><text><locale id="m0.long.title"/></text></title></detail>\n', ""
    )
    compared = _compare_suites(tmp_path, TWO_MODULES, after)
    before_record = compared.before.records[("module", "M0")]["suite"]
    after_record = compared.after.records[("module", "M0")]["suite"]
    root, strings = after_record.value
    assert root.xpath('./detail[@id="m0_case_short"]/title/text/locale/@id') == ["m0.short.title"]
    assert strings == {"default": {"m0.short.title": "Cases"}}
    assert [
        (difference.artifact, difference.kind)
        for difference in proof5._suite_differences("removed-detail", before_record, after_record)
    ] == [
        (proof5.SUITE, "removed"),
        (f"{proof5.STRINGS}:default", "removed"),
    ]


@pytest.mark.parametrize("menus", [[], [{"id": "m0"}, {"id": "other"}]])
@pytest.mark.parametrize("side", ["before", "after"])
def test_detail_identity_requires_one_independently_placed_menu_per_module(menus, side):
    before = proof5.suite_of(parse_xml(TWO_MODULES), STRINGS, TWO_MODULES_CORE, {}, "?")
    after = proof5.suite_of(parse_xml(_swap_module_names(TWO_MODULES)), SWAPPED_STRINGS, SWAPPED_CORE, {}, "?")
    assert (
        proof5._detail_pairs(
            before,
            after,
            {("module", "M0"): {"menus": menus if side == "before" else [{"id": "m0"}]}},
            {("module", "M0"): {"menus": menus if side == "after" else [{"id": "m1"}]}},
        )
        == {}
    )


@pytest.mark.parametrize("side", ["before", "after"])
def test_ambiguous_menu_identity_cannot_make_two_details_alias_one(side):
    suite = proof5.suite_of(parse_xml(TWO_MODULES), STRINGS, TWO_MODULES_CORE, {}, "?")
    separate = {("module", f"M{index}"): {"menus": [{"id": f"m{index}"}]} for index in (0, 1)}
    shared = {("module", f"M{index}"): {"menus": [{"id": "m0"}]} for index in (0, 1)}
    found = proof5._detail_pairs(
        suite,
        suite,
        shared if side == "before" else separate,
        shared if side == "after" else separate,
    )
    assert "m0_case_short" not in found and "m1_case_short" not in found


def test_an_unread_element_is_its_entitys_where_the_other_archive_reads_it_and_unowned_otherwise():
    """A detail the edit stopped naming (unread in D', read in D by a module at the same place) is that module's;
    a detail no datum names on either side has no owner in Core's parse, and is unowned."""
    after = TWO_MODULES.replace(' detail-confirm="m0_case_long"', "")
    (before_placed, before_unowned), (after_placed, after_unowned) = proof5._place_unread(
        [_side(TWO_MODULES), _side(after)], {}
    )
    assert before_placed == {} and _keys(before_unowned) == [("detail", "m1_case_short")]
    assert {entity: _keys(elements) for entity, elements in after_placed.items()} == {
        ("module", "M0"): [("detail", "m0_case_long")]
    }
    assert _keys(after_unowned) == [("detail", "m1_case_short")]

    # Where the module that reads it on the other side sits elsewhere there, its positional name may be another
    # module's: it is unowned.
    moved = ({"M0": 1, "M1": 0}, {"F0": (1, 0), "F1": (0, 0)})
    _, (after_placed, after_unowned) = proof5._place_unread([_side(TWO_MODULES), _side(after, moved)], {})
    assert after_placed == {}
    assert set(_keys(after_unowned)) == {("detail", "m0_case_long"), ("detail", "m1_case_short")}


def test_an_unread_element_of_a_removed_module_is_that_modules():
    """Removing the last module removes its details with it: one no datum names (unread in D, absent from D')
    is that module's, so a footprint holding the removed module holds it. With two modules gone, or one the
    other archive still holds, the element is unowned."""
    detail = '<detail id="m1_case_short"><title><text><locale id="m1.short.title"/></text></title></detail>'
    after = (
        TWO_MODULES.replace(detail, "")
        .replace('<entry><form>urn:f1</form><command id="m1-f0"/></entry>', "")
        .replace('<menu id="m1"><command id="m1-f0"/></menu>', "")
    )
    removed = ({"M0": 0}, {"F0": (0, 0)})
    (before_placed, before_unowned), (after_placed, after_unowned) = proof5._place_unread(
        [_side(TWO_MODULES), _side(after, removed)], {}
    )
    assert {entity: _keys(elements) for entity, elements in before_placed.items()} == {
        ("module", "M1"): [("detail", "m1_case_short")]
    }
    assert before_unowned == [] and after_placed == {} and after_unowned == []

    # Kept in D', the same detail is no removed module's.
    kept = TWO_MODULES.replace('<entry><form>urn:f1</form><command id="m1-f0"/></entry>', "").replace(
        '<menu id="m1"><command id="m1-f0"/></menu>', ""
    )
    (before_placed, before_unowned), _ = proof5._place_unread([_side(TWO_MODULES), _side(kept, removed)], {})
    assert before_placed == {} and _keys(before_unowned) == [("detail", "m1_case_short")]

    # With no module or two modules in D alone, which one it was is unknown.
    (before_placed, before_unowned), _ = proof5._place_unread([_side(TWO_MODULES), _side(after)], {})
    assert before_placed == {} and _keys(before_unowned) == [("detail", "m1_case_short")]
    (before_placed, before_unowned), _ = proof5._place_unread([_side(TWO_MODULES), _side("<suite/>", ({}, {}))], {})
    assert before_placed == {} and _keys(before_unowned) == [("detail", "m1_case_short")]


def _unowned(xml, strings, key):
    suite = proof5.suite_of(parse_xml(xml), strings, TWO_MODULES_CORE, {}, "?")
    return proof5._unowned_record([suite.elements[("detail", key)]], suite, {})


def test_an_unowned_element_compares_by_what_it_shows_whatever_its_positional_names():
    """An unowned element is compared with its own id and its app strings keys read out (the strings they name):
    the same detail under another module's positional names is equal, and a string it shows changed is a
    difference the comparator finds, at the detail."""
    moved = TWO_MODULES.replace("m1_case_short", "m2_case_short").replace("m1.short.title", "m2.short.title")
    moved_strings = {"default": {**STRINGS["default"], "m2.short.title": "Visits"}}
    before = _unowned(TWO_MODULES, STRINGS, "m1_case_short")
    assert _unowned(moved, moved_strings, "m2_case_short").digest == before.digest

    changed = _unowned(TWO_MODULES, {"default": {**STRINGS["default"], "m1.short.title": "Calls"}}, "m1_case_short")
    assert changed.digest != before.digest
    found = proof5._suite_differences("doc", before, changed)
    assert {(d.artifact, d.path, d.kind) for d in found} == {
        (proof5.SUITE, "/suite/detail[@id=*]", "removed"),
        (proof5.SUITE, "/suite/detail[@id=*]", "added"),
    }


def test_the_unowned_elements_are_inside_a_footprint_reaching_the_app_or_holding_every_module():
    unowned = (proof5.UNOWNED, ("M0", "M1"))
    assert not proof5.Footprint(frozenset({"M0"}), False, False).holds(unowned)
    assert proof5.Footprint(frozenset({"M0", "M1"}), False, False).holds(unowned)
    assert proof5.Footprint(frozenset({"M0"}), True, False).holds(unowned)
    assert proof5.Footprint(frozenset(), False, True).holds(unowned)


def _rewritten(archive, name, change):
    """``archive`` with its entry ``name`` replaced by ``change(bytes)``, every other entry as it was."""
    import zipfile

    with zipfile.ZipFile(archive) as held:
        entries = {info.filename: held.read(info) for info in held.infolist()}
    entries[name] = change(entries[name])
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as written:
        for entry, content in entries.items():
            written.writestr(entry, content)


def test_a_no_matches_return_guard_keeps_its_menu_identity_and_a_changed_target_is_reported(core_runner, tmp_path):
    """Moving the sibling menu renumbers a guard, but leaves its target unchanged. Core reads both guards
    against their actual session instances; retaining the old command after the move is a real changed target
    and must remain a locality failure, not disappear through identity alignment.
    """
    from lxml import etree

    from proof.observe.unit import observe_local

    document = cases.load_corpus().document("targeted-no-matches-return-identity")
    local = observations.local_records_for(document, core_runner).local
    assert proof5.locality(document, local=local)[0] == []
    guards = []
    for archive_path, module_index in ((document.local_ccz, 0), (document.edit.local_ccz, 1)):
        with zipfile.ZipFile(archive_path) as archive:
            root = parse_xml(archive.read("suite.xml"))
            (frame,) = root.xpath("./entry/stack/create[@if]")
            guard = frame.get("if")
            guards.append(guard)
            # The registration form declares the actual session instance read by its return guard.
            source = archive.read("modules-2/forms-0.xml")
        for target, expected in ((f"m{module_index}", "true"), (f"m{1 - module_index}", "false")):
            result = core_runner.evaluate(
                formBase64=base64.b64encode(source).decode(),
                restoreBase64=base64.b64encode((document.root / "restore.xml").read_bytes()).decode(),
                session={
                    "data": {
                        "return_to": target,
                        "case_id_new_patient_0": "new-patient",
                        "parent_id": "household",
                    }
                },
                expressions=[guard],
            )
            assert [value["value"] for value in result["values"]] == [expected]
    assert guards[0] != guards[1]
    assert proof5._return_menu_identity(guards[1], {"m1": "m0"}) == guards[0]

    root = tmp_path / document.id
    shutil.copytree(document.root, root)
    changed = corpus.Document(id=document.id, source=document.source, root=root)

    def stale_target(content):
        parsed = parse_xml(content)
        (frame,) = parsed.xpath("./entry/stack/create[@if]")
        frame.set("if", guards[0])
        return etree.tostring(parsed, xml_declaration=True, encoding="utf-8")

    _rewritten(changed.edit.local_ccz, "suite.xml", stale_target)
    changed = _reread(changed)
    local, _, _ = observe_local(changed, core_runner=core_runner)
    found, _ = proof5.locality(changed, local=local)
    assert {(d.artifact, d.path, d.kind) for d in found} == {
        (proof5.SUITE, "/suite/entry[*]/stack[*]/create[*]/@if", "changed")
    }


@pytest.mark.parametrize(
    "value",
    [
        "'m1'",
        "/data/return_to = 'm1'",
        "count(instance('commcaresession')/session/data/other) = 1 and "
        "instance('commcaresession')/session/data/other = 'm1'",
        "count(instance('commcaresession')/session/data/return_to) = 2 and "
        "instance('commcaresession')/session/data/return_to = 'm1'",
        "count(instance('commcaresession')/session/data/return_to) = 1 or "
        "instance('commcaresession')/session/data/return_to = 'm1'",
        "count(instance('commcaresession')/session/data/return_to) = 1 and "
        "instance('commcaresession')/session/data/return_to = 'unmapped'",
    ],
)
def test_return_menu_alignment_leaves_other_literals_and_conditions_unchanged(value):
    assert proof5._return_menu_identity(value, {"m1": "m0"}) == value


def test_a_change_to_an_unowned_element_is_reported_unless_the_footprint_reaches_it(core_runner, tmp_path):
    """A detail no runtime reads, of a module outside the footprint, changed in D''s archive: proof 5 reports it
    (as unowned), and holds it once the footprint reaches the app; the written footprint passed before it."""
    from lxml import etree

    from proof.observe.unit import observe_local

    for document in cases.load_corpus().emitted:
        if document.edit is None or document.local_ccz is None:
            continue
        local = observations.local_records_for(document, core_runner).local
        footprint = proof5.footprint_of(document)
        compared = proof5.comparisons(document, local=local)
        suite = next(c for c in compared if c.name == "local-suite")
        unowned = [row for row in suite.notes["unreadSuiteElements"]["edit/local.ccz"] if row[2] == proof5.UNOWNED]
        entity = next((e for e in suite.after.records if e[0] == proof5.UNOWNED), None)
        details = [row[1] for row in unowned if row[0] == "detail"]
        if not details or footprint.holds(entity) or proof5.by_entity(document.id, compared, footprint):
            continue
        root = tmp_path / document.id
        shutil.copytree(document.root, root)
        copy = corpus.Document(id=document.id, source=document.source, root=root)

        def changed(content, detail=details[0]):
            parsed = etree.fromstring(content)
            (element,) = [element for element in parsed.iter("detail") if element.get("id") == detail]
            element.set("probe", "changed")
            return etree.tostring(parsed, xml_declaration=True, encoding="utf-8")

        _rewritten(copy.edit.local_ccz, "suite.xml", changed)
        copy = _reread(copy)
        local, _, _ = observe_local(copy, core_runner=core_runner)
        found, _ = proof5.locality(copy, local=local)
        assert {(d.artifact, d.path, d.kind) for d in found} >= {(proof5.SUITE, "/suite/detail[@id=*]", "added")}
        assert set(proof5.by_entity(copy.id, proof5.comparisons(copy, local=local), footprint)) == {entity}
        reaching = proof5.Footprint(footprint.entities, True, footprint.app_wide)
        assert proof5.locality(copy, reaching, local=local)[0] == []
        return
    raise AssertionError(
        "The corpus holds no edited document whose D' archive carries a detail no runtime reads and no entity owns,"
        " under a footprint that neither reaches the app nor holds every module, so nothing shows proof 5 comparing"
        " such a detail."
    )


def _written_and_compared():
    """Each edited corpus document with its written footprint and its compared wire, in corpus order."""
    for document in cases.load_corpus().emitted:
        if document.edit is not None:
            yield document, proof5.footprint_of(document), proof5.comparisons(document)


def test_a_footprint_missing_a_changed_entity_fails_and_the_written_one_passes():
    covered = {}
    for document, footprint, compared in _written_and_compared():
        if proof5.by_entity(document.id, compared, footprint):
            continue  # the written footprint must pass the whole document for the control to mean anything
        for entity in sorted(proof5.entity_changes(document.id, compared), key=str):
            if entity[0] in covered:
                continue
            dropped = proof5.by_entity(document.id, compared, footprint.without(entity))
            assert set(dropped) == {entity}, (
                f"{document.id}: with {entity} dropped from the footprint its batch wrote, proof 5 should report"
                f" that entity and no other; it reported {sorted(dropped, key=str)}."
            )
            assert all(d.check == "proof5" and d.document == document.id for d in dropped[entity])
            covered[entity[0]] = (document.id, entity, len(dropped[entity]))
        if len(covered) == 3:
            break
    assert set(covered) == {proof5.APP, "module", "form"}, (
        f"The corpus holds no batch that changes, inside its written footprint, each of an app, a module and a"
        f" form (covered: {covered}), so the control cannot show proof 5 catching a footprint that misses one."
    )


def test_an_entity_the_edit_moves_is_compared_with_itself():
    for document, footprint, compared in _written_and_compared():
        written = proof5.by_entity(document.id, compared, footprint)
        for comparison in compared:
            before, after = comparison.before, comparison.after
            for entity in sorted(set(before.records) & set(after.records), key=str):
                if entity[0] == proof5.APP or footprint.holds(entity):
                    continue
                old = before.positions[entity]
                if old == after.positions[entity] or any(
                    before.records[entity][name].digest != after.records[entity][name].digest
                    for name in before.records[entity]
                ):
                    continue
                # The batch moved the entity and left its wire as it was, and D' holds another entity, or
                # none, where it was: pairing by position would report a change the batch never made.
                occupant = next((e for e, at in after.positions.items() if at == old), None)
                if occupant is not None and all(
                    after.records[occupant][name].digest == before.records[entity][name].digest
                    for name in before.records[entity]
                ):
                    continue
                assert entity not in written, (
                    f"{document.id}: the batch moved {entity} from {old} to {after.positions[entity]} without"
                    f" changing it, and proof 5 reported it: {written[entity][:3]}."
                )
                return
    raise AssertionError(
        "proof 5 saw no batch move an entity outside its footprint without changing it: either the corpus holds"
        " none, or proof 5 placed D''s entities by position rather than by Nova id (a moved entity then never"
        " shows a new position). Nothing shows proof 5 pairs each entity with itself."
    )


def _retarget_subject():
    """An edited document whose D' adds a form ahead of one D holds, with the forms the control links.

    The added form sits ahead of a form D holds on the wire, and its id is
    derived from its own UUID (``lib/commcare/wireIdentity.ts``), so it is no
    form's of D, wherever the form sits. Returns
    the document, a configuration both publish under, the form that links
    (one D and D' hold), the form its link names in D, and the added form.
    The form the link names is, in the first such publish where there is
    one, the form whose id an added form carries in D''s publish, and
    otherwise another form D holds.
    """
    subjects = []
    for document in cases.load_corpus().emitted:
        if document.edit is None or not document.edit.exports:
            continue
        before = [form for module in document.wire_modules for form in module["forms"]]
        after = [form for module in document.edit_wire_modules for form in module["forms"]]
        kept = [form for form in after if form in before]
        added = [form for at, form in enumerate(after) if form not in before and any(f in before for f in after[at:])]
        if len(kept) < 2 or not added:
            continue
        for name in sorted(document.edit.exports):
            if document.exports[name].republish is None:
                continue  # Nova stopped this republish before it sent anything.
            republished = _form_ids(document.exports[name].republish, document.wire_modules)
            updated = _form_ids(document.edit.exports[name].update, document.edit_wire_modules)
            for form in added:
                carried = [kept_form for kept_form in kept if republished[kept_form] == updated[form]]
                if carried:
                    source = next(kept_form for kept_form in kept if kept_form != carried[0])
                    return document, name, source, carried[0], form
        subjects.append((document, sorted(document.edit.exports)[0], kept[0], kept[1], added[0]))
    if subjects:
        return subjects[0]
    raise AssertionError(
        "The corpus holds no edit batch that adds a form ahead of one D holds, beside two forms D' keeps, so nothing"
        " shows proof 5 telling an id D' minted for a form only D' holds from the ids of D's forms."
    )


def _form_ids(captured, layout):
    """Each form's ``unique_id`` in a captured publish, by Nova id."""
    app = proof5._app_file(captured)
    return {
        form: app["modules"][m]["forms"][f]["unique_id"]
        for m, module in enumerate(layout)
        for f, form in enumerate(module["forms"])
    }


def _with_app_file(captured, app_json):
    """The captured upload's bytes with its ``app_file`` field holding ``app_json``, every other byte as captured."""
    from proof.hq.operations import _boundary, _form_parts, _part_name

    boundary = _boundary(captured.content_type)
    preamble, parts, epilogue = _form_parts(captured.body_path.read_bytes(), boundary)
    rebuilt = [preamble]
    for head, content in parts:
        if _part_name(head) == "app_file":
            content = json.dumps(app_json).encode("utf-8")
        rebuilt.append(b"\r\n" + head + b"\r\n\r\n" + content + b"\r\n")
    rebuilt.append(epilogue)
    return (b"--" + boundary).join(rebuilt)


def _link(captured, layout, source, target):
    """The captured publish with ``source``'s only form link naming ``target`` (both by Nova id), as it sends them."""
    app = proof5._app_file(captured)
    place = {form: (m, f) for m, module in enumerate(layout) for f, form in enumerate(module["forms"])}
    target_id = app["modules"][place[target][0]]["forms"][place[target][1]]["unique_id"]
    app["modules"][place[source][0]]["forms"][place[source][1]]["form_links"] = [
        {"xpath": "true()", "form_id": target_id}
    ]
    captured.body_path.write_bytes(_with_app_file(captured, app))


def _link_differences(document, form):
    found = proof5.by_entity(document.id, proof5.comparisons(document), None).get(("form", form), [])
    return [d for d in found if "/form_links/" in d.as_json()["path"]]


def test_a_link_pointed_at_a_form_only_d_prime_holds_is_reported(tmp_path):
    document, name, source, linked, added = _retarget_subject()
    root = tmp_path / document.id
    shutil.copytree(document.root, root)
    copy = corpus.Document(id=document.id, source=document.source, root=root)
    republish, update = copy.exports[name].republish, copy.edit.exports[name].update

    # The same form, linked on both sides, compares equal once D''s ids are mapped to D's.
    _link(republish, copy.wire_modules, source, linked)
    _link(update, copy.edit_wire_modules, source, linked)
    assert _link_differences(_reread(copy), source) == []

    # The emitter's mistake this stands for: an untouched form's link now names the form the batch added.
    _link(update, copy.edit_wire_modules, source, added)
    retargeted = _link_differences(_reread(copy), source)
    assert any(d.as_json()["path"].endswith("/form_links/*/form_id") for d in retargeted), (
        f"{document.id} under {name!r}: {source}'s link names {linked} in D and the form D' added in D', and proof 5"
        f" reported no difference in it ({retargeted}): an id D' minted for its own form read as one of D's."
    )


XML = '<a:root xmlns:a="urn:proof" x="1"><a:child y="2" w="3">text</a:child>tail<a:other/></a:root>'


def _xml_reading(before, after):
    """Whether the digest changed, and the comparator's differences, for two XML documents."""
    a, b = parse_xml(before), parse_xml(after)
    changed = proof5.digest(proof5.canonical_xml(a)) != proof5.digest(proof5.canonical_xml(b))
    return changed, compare_xml_trees(a, b, check="proof5", document="xml", artifact="form:0.0", blank_text="exact")


@pytest.mark.parametrize(
    "after",
    [
        pytest.param(XML.replace('x="1"', 'x="3"'), id="attribute value"),
        pytest.param(XML.replace('x="1"', 'x="1" z="1"'), id="attribute added"),
        pytest.param(XML.replace(">text<", ">other<"), id="text"),
        pytest.param(XML.replace("tail", ""), id="tail"),
        pytest.param(XML.replace(">text<", "> <"), id="whitespace text"),
        pytest.param(XML.replace("<a:other/>", "<a:other/> "), id="whitespace-only tail"),
        pytest.param(XML.replace("<a:other/>", "<a:other> </a:other>"), id="whitespace-only text"),
        pytest.param(XML.replace('xmlns:a="urn:proof"', 'xmlns:a="urn:moved"'), id="namespace"),
        pytest.param(XML.replace("<a:other/>", "<a:other/><a:more/>"), id="child added"),
        pytest.param(
            '<a:root xmlns:a="urn:proof" x="1"><a:other/><a:child y="2" w="3">text</a:child>tail</a:root>', id="order"
        ),
    ],
)
def test_the_digest_changes_with_everything_the_comparator_reads(after):
    changed, differences = _xml_reading(XML, after)
    assert changed and differences


@pytest.mark.parametrize(
    "after",
    [
        pytest.param(XML.replace("a:", "b:").replace("xmlns:a", "xmlns:b"), id="prefix"),
        pytest.param(XML.replace("<a:other/>", "<!-- note --><a:other/>"), id="comment"),
        pytest.param(XML.replace("<a:other/>", "<?proof note?><a:other/>"), id="processing instruction"),
        pytest.param(XML.replace('y="2" w="3"', 'w="3" y="2"'), id="attribute order"),
    ],
)
def test_the_digest_keeps_what_the_comparator_does_not_read(after):
    assert _xml_reading(XML, after) == (False, [])


def test_the_json_digest_reads_values_as_the_comparator_does():
    def reading(before, after):
        a, b = proof5.Record.of_json(before), proof5.Record.of_json(after)
        found = compare_json(a.value, b.value, check="proof5", document="json", artifact="app.json")
        return a.digest != b.digest, bool(found)

    assert reading({"a": 1, "b": [1, 2]}, {"b": [1, 2], "a": 1.0}) == (False, False)
    assert reading({"a": 1}, {"a": True}) == (True, True)
    assert reading({"a": [1, 2]}, {"a": [2, 1]}) == (True, True)
    assert reading({"a": None}, {}) == (True, True)


def _copied(tmp_path):
    """A copy of the first edited corpus document published under a configuration with a flag ``minimum`` lacks.

    Returns the copy (read as a document) and that flag.
    """
    for document in cases.load_corpus().emitted:
        if document.edit is None or document.local_ccz is None:
            continue
        configurations = document.exports
        extra = sorted(
            set(configurations["maximum"].configuration.flags) - set(configurations["minimum"].configuration.flags)
        )
        if extra and set(document.edit.exports) == set(configurations):
            root = tmp_path / document.id
            shutil.copytree(document.root, root)
            return corpus.Document(id=document.id, source=document.source, root=root), extra[0]
    raise AssertionError(
        "The corpus holds no edited document with local archives and a maximum configuration holding a flag its"
        " minimum lacks, so nothing can show how proof 5 reads a lost or refused input."
    )


def _require_for_edit(document, flags):
    """D''s verdict made to require ``flags``, as Nova's verdict for a D' that needs them would."""
    path = document.root / "edit" / "verdict.json"
    verdict = json.loads(path.read_text(encoding="utf-8"))
    verdict["minimumConfiguration"]["flags"] = sorted(set(verdict["minimumConfiguration"]["flags"]) | set(flags))
    path.write_text(json.dumps(verdict), encoding="utf-8")


def _remove_edit_exports(document, keep):
    """D''s publish removed under every configuration of D's that ``keep`` refuses."""
    for name, export in document.exports.items():
        if not keep(export.configuration):
            shutil.rmtree(document.root / "edit" / "export" / name)


def _reread(document):
    return corpus.Document(id=document.id, source=document.source, root=document.root)


@pytest.mark.parametrize("lost", ["an update", "D's local archive", "D''s local archive"])
def test_a_lost_input_is_refused_rather_than_compared_as_nothing(tmp_path, lost):
    document, _ = _copied(tmp_path)
    names = [comparison.name for comparison in proof5.comparisons(document)]
    assert names == [*sorted(document.exports), "local"]

    if lost == "an update":
        shutil.rmtree(document.root / "edit" / "export" / "minimum")
    else:
        (document.root if lost == "D's local archive" else document.root / "edit").joinpath("local.ccz").unlink()
    with pytest.raises(
        corpus.CorpusLayoutError, match="holds no update" if lost == "an update" else "cannot be compared"
    ):
        proof5.locality(_reread(document))


def test_a_configuration_novas_publish_refuses_for_the_edit_is_left_out(tmp_path):
    document, flag = _copied(tmp_path)
    _remove_edit_exports(document, keep=lambda configuration: flag in configuration.flags)
    _require_for_edit(document, [flag])
    document = _reread(document)
    lacking = {name for name, export in document.exports.items() if flag not in export.configuration.flags}

    _, summary = proof5.locality(document)
    assert "minimum" in lacking and summary["refused"] == {name: [flag] for name in sorted(lacking)}
    assert summary["configurations"] == sorted(set(document.exports) - lacking) and summary["local"]

    # With every configuration refused and no local archives, nothing is left to compare, which is refused too.
    _remove_edit_exports(document, keep=lambda configuration: flag not in configuration.flags)
    _require_for_edit(document, ["PROOF_NO_CONFIGURATION_HOLDS_THIS"])
    for root in (document.root, document.root / "edit"):
        root.joinpath("local.ccz").unlink()
    with pytest.raises(corpus.CorpusLayoutError, match="compare nothing"):
        proof5.locality(_reread(document))


LOCAL_FORM = (
    '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><h:title>F</h:title>'
    '<model><instance><data xmlns="urn:form" version="{version}"{extra}><q>{answer}</q></data></instance>'
    "</model></h:head><h:body/></h:html>"
)


def _local_form(version, extra="", answer=""):
    return LOCAL_FORM.format(version=version, extra=extra, answer=answer).encode()


def test_a_local_forms_version_is_the_intent_checks_and_every_other_change_is_compared():
    artifact = "local:form:0.0"
    before = proof5.Record.of_local_form(artifact, _local_form("4"))
    assert proof5.Record.of_local_form(artifact, _local_form("5")).digest == before.digest
    for changed in (_local_form("5", extra=' uiVersion="2"'), _local_form("5", answer="seen")):
        after = proof5.Record.of_local_form(artifact, changed)
        assert after.digest != before.digest
        found = compare_xml_trees(
            before.value, after.value, check="proof5", document="xml", artifact=artifact, blank_text="exact"
        )
        assert found and not any("@version" in difference.path for difference in found), found
    # A form HQ reads from Nova's publish keeps its version in what is compared.
    assert proof5.Record.of_xml("form:0.0", _local_form("4")).digest != (
        proof5.Record.of_xml("form:0.0", _local_form("5")).digest
    )
