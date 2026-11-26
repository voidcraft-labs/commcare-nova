"""Parity's join sees what it must, over planted uses and claim logs, with no HQ.

Contract (``proof.checks.parity.join``, ``unseen``): a claim naming an allowing
entry whose keys lack the use's key is one ``entry`` difference; a ``held``
claim on a use the lane calls refused is one ``standing``; a use with no record
at its place is one ``unclaimed``; a record with no use at its place is one
``unseen``; an agreeing pair is none; and a variant's added use the lane calls
refused whose claim names another refused entry of its key is one ``entry``.
A variant is judged by its row's own uses (``row_uses``): a use refused under
the row's entry with no record fails, a use the lane holds where the reader
refuses the row's class fails, and a held use beneath a thing the reader
refuses whole is not judged, nor is a held use whose record names only a class
the lane leaves to the bar beside the classes it reads. A session read is decided against the suite HQ
built of the app, as the manifest check decides it (``source_uses``).
The plausible failures: a join that reports nothing, which would pass every
base and every variant whatever the two classifiers say; and a variant judge
that holds every structural use beneath a refusal to the log, which fails a
reader for refusing a thing whole. The join's manifest
is planted too, so a join control names the class it plants and no live entry;
the session read is decided by the live class of the session's data that the
manifest check reads it with. A third plausible failure: parity over a base
with no suite beside the app, where a read no entry supplies stays undecided.
"""

from __future__ import annotations

import copy
import hashlib
import json

import pytest
from pathlib import Path

from lxml import etree

from proof.checks import lookup_parity, manifest_usage, observations, parity
from proof.checks.manifest_usage import HELD, REFUSED, Entry, Manifest, Use

KEY = "schema:Module.case_type"
OTHER_KEY = "schema:Module.name"
HELD_ENTRY = Entry("planted/held-case-type", "HELD")
OTHER_HELD = Entry("planted/held-name", "HELD")
REFUSED_ENTRY = Entry("planted/refused-case-type", "REFUSED", "planted-class", ("hq-refuses",))
OTHER_REFUSED = Entry("planted/other-refused-case-type", "REFUSED", "other-class", ("hq-refuses",))
# Refused only because HQ's build refuses its state: beside the others of KEY, the lane leaves its class to the bar.
BAR_ENTRY = Entry("planted/bar-case-type", "REFUSED", "bar-class", ("not-hq-buildable",))
# A key every entry naming is the bar's, which the lane reads as the bar's.
BAR_KEY = "schema:Module.module_filter"
ONLY_BAR = Entry("planted/bar-filter", "REFUSED", None, ("not-hq-buildable",))
MANIFEST = Manifest(
    items={},
    gated=frozenset(),
    entries={
        KEY: (HELD_ENTRY, OTHER_REFUSED, REFUSED_ENTRY, BAR_ENTRY),
        OTHER_KEY: (OTHER_HELD,),
        BAR_KEY: (ONLY_BAR,),
    },
    readers={},
)
WHERE = "/modules/0/case_type"


def test_lookup_resource_claims_compare_referenced_sources_to_hq_definitions():
    manifest = parity.manifest()
    field = {"field_name": "code", "properties": []}
    rows = {"status": 200, "body": json.dumps({"objects": [{"fields": {"code": "west"}}]})}
    tags = ["locations", "search_selected_cases", "casedb", "selected_cases_casedb", "ledgerdb", "regions",
            "input", "LedgerDB", "groups", "results", "registry", "__proto__", "hasOwnProperty", "HasOwnProperty"]
    tables = {tag: {"tag": tag, "fields": [field], "is_global": True} for tag in tags}
    tables["groups"]["is_global"] = False
    tables["results"]["fields"] = []
    reads = {"projectData": {
        "lookupTables": {"status": 200, "body": json.dumps({"objects": list(tables.values())})},
        "fixtureRows": {**dict.fromkeys(tags, rows), "registry": {"status": 500, "body": ""}},
    }}
    asked = {*tags, "missing"} - {"search_selected_cases"}

    def claim(tag):
        return parity.Record("lookup-tables", f"/{tag}/tag", None, lookup_parity.ALIAS_ENTRY, "held")

    # __proto__ is no runtime instance name, so no alias claim holds it: a form's read of it is refused
    # (lib/lookup/pathNames.ts), and the table itself names no held alias class.
    assert lookup_parity.differences("sample", manifest, asked, reads, [claim(tag) for tag in ("input", "LedgerDB", "locations")]) == []
    assert [one.at for one in lookup_parity.differences("sample", manifest, asked, reads, [claim(tag) for tag in ("input", "LedgerDB", "locations", "__proto__")])] == [
        "/lookup-model:LookupTable.tag/unseen@lookup-tables/__proto__/tag",
    ]
    drift = lookup_parity.differences("sample", manifest, asked, reads, [claim(tag) for tag in ("input", "LedgerDB", "groups", "search_selected_cases")])
    assert [one.at for one in drift] == [
        "/lookup-model:LookupTable.tag/unseen@lookup-tables/groups/tag",
        "/lookup-model:LookupTable.tag/unclaimed@lookup-tables/locations/tag",
        "/lookup-model:LookupTable.tag/unseen@lookup-tables/search_selected_cases/tag",
    ]
    reads["projectData"]["fixtureRows"]["registry"] = {"status": 403, "body": ""}
    assert lookup_parity.differences("sample", manifest, asked, reads, []) == []
    reads["projectData"]["lookupTables"] = {"status": 403, "body": ""}
    assert lookup_parity.differences("sample", manifest, asked, reads, []) == []
    assert lookup_parity.differences("sample", manifest, asked, reads, [claim("locations")])[0].path.endswith("/unseen")
    del reads["projectData"]["lookupTables"]
    with pytest.raises(observations.RecordIncomplete, match="lookup definition list"):
        lookup_parity.differences("sample", manifest, asked, reads, [])


def test_lookup_names_claim_their_actual_fields_on_the_referenced_table():
    manifest = parity.manifest()
    objects = [
        {"tag": "meeting.sites", "is_global": True, "fields": [{"field_name": n} for n in ("site.id", "label", "名前")]},
        {"tag": "unused", "is_global": True, "fields": [{"field_name": "site.id"}]},
    ]
    reads = {"projectData": {
        "lookupTables": {"status": 200, "body": json.dumps({"objects": objects})},
        "fixtureRows": {"meeting.sites": {"status": 200, "body": json.dumps({"objects": []})}},
    }}
    asked = {"meeting.sites"}
    claims = [
        parity.Record("lookup-tables", "/meeting.sites/tag", None, lookup_parity.DOTTED_ENTRY, "held"),
        parity.Record("lookup-tables", "/meeting.sites/fields/0/field_name", None, lookup_parity.DOTTED_ENTRY, "held"),
        parity.Record("lookup-tables", "/meeting.sites/fields/2/field_name", None, lookup_parity.UNICODE_ENTRY, "held"),
    ]
    assert lookup_parity.differences("names", manifest, asked, reads, claims) == []
    borrowed = parity.Record("lookup-tables", "/unused/fields/0/field_name", None, lookup_parity.DOTTED_ENTRY, "held")
    found = lookup_parity.differences("names", manifest, asked, reads, [claims[0], claims[2], borrowed])
    assert [one.at for one in found] == [
        "/lookup-model:TypeField.name/unclaimed@lookup-tables/meeting.sites/fields/0/field_name",
        "/lookup-model:TypeField.name/unseen@lookup-tables/unused/fields/0/field_name",
    ]


def _use(standing=HELD, entries=()):
    return parity.Decided(Use(KEY, "app.json", WHERE), standing, tuple(entries))


def _log(*records):
    return "".join(
        json.dumps({"artifact": "app.json", "where": WHERE, "key": KEY, "entry": entry, "standing": standing}) + "\n"
        for entry, standing in records
    )


def _whats(found):
    return [difference.path.rpartition("/")[2] for difference in found]


def test_an_agreeing_pair_is_no_difference():
    assert parity.join([_use()], _log((HELD_ENTRY.id, "held")), held=MANIFEST) == []
    assert parity.unseen([_use().use], _log((HELD_ENTRY.id, "held"))) == []


def test_a_claim_naming_an_allowing_entry_whose_keys_lack_the_use_s_key_is_entry():
    assert _whats(parity.join([_use()], _log((OTHER_HELD.id, "held")), held=MANIFEST)) == ["entry"]


def test_a_held_claim_on_a_use_the_lane_refuses_is_standing():
    use = _use(REFUSED, (REFUSED_ENTRY,))
    assert _whats(parity.join([use], _log((REFUSED_ENTRY.id, "held")), held=MANIFEST)) == ["standing"]


def test_a_use_with_no_record_at_its_place_is_unclaimed():
    found = parity.join([_use()], "", held=MANIFEST)
    assert [(d.artifact, d.path) for d in found] == [("claims@A", f"/{KEY}/unclaimed")]


def test_a_record_with_no_use_at_its_place_is_unseen():
    found = parity.unseen([], _log((HELD_ENTRY.id, "held")))
    assert [(d.artifact, d.path) for d in found] == [("claims@A", f"/{KEY}/unseen")]


PARENT = "/modules/0"
CHILD_KEY = "schema:Module.case_details"


def _record(entry, standing, where=WHERE, key=KEY):
    return json.dumps({"artifact": "app.json", "where": where, "key": key, "entry": entry, "standing": standing})


def _judged(uses, log, entries):
    """A variant judged as the lane judges one: its row's own uses (``row_uses``) joined to its claim log."""
    return parity.join(parity.row_uses(uses, log, entries, held=MANIFEST), log, held=MANIFEST)


def test_a_variant_s_use_refused_under_its_row_s_entry_with_no_record_fails():
    use = _use(REFUSED, (REFUSED_ENTRY,))
    assert parity.row_uses([use], "", [REFUSED_ENTRY.id]) == [use]
    assert _whats(_judged([use], "", [REFUSED_ENTRY.id])) == ["unclaimed"]
    # A composed finding's entry is the row's too.
    assert _whats(_judged([use], "", ["planted/first-finding", REFUSED_ENTRY.id])) == ["unclaimed"]
    assert _judged([use], _record(REFUSED_ENTRY.id, "fix-in-hq") + "\n", [REFUSED_ENTRY.id]) == []


def test_a_held_use_beneath_a_thing_the_reader_refuses_whole_is_not_judged_on_a_variant():
    # The refusal stands at the thing; the held structural use beneath it has no record of its own.
    beneath = parity.Decided(Use(CHILD_KEY, "app.json", f"{PARENT}/case_details"), HELD, ())
    log = _record(REFUSED_ENTRY.id, "fix-in-hq", where=PARENT) + "\n"
    assert parity.row_uses([beneath], log, [REFUSED_ENTRY.id]) == []
    assert _judged([beneath], log, [REFUSED_ENTRY.id]) == []
    # Joined as a base's use is, it would be unclaimed: that is what a variant leaves out.
    assert _whats(parity.join([beneath], log, held=MANIFEST)) == ["unclaimed"]


def test_a_use_the_lane_holds_where_the_reader_refuses_the_row_s_class_is_judged():
    use = _use()
    log = _record(REFUSED_ENTRY.id, "fix-in-hq") + "\n"
    assert parity.row_uses([use], log, [REFUSED_ENTRY.id]) == [use]
    assert _whats(_judged([use], log, [REFUSED_ENTRY.id])) == ["standing"]
    # A use refused under another row's entry is that row's to judge.
    other = _use(REFUSED, (OTHER_REFUSED,))
    assert parity.row_uses([other], "", [REFUSED_ENTRY.id]) == []


def test_a_held_use_whose_record_names_a_class_the_lane_leaves_to_the_bar_is_not_judged():
    # The lane's held is no verdict on a class it never reads; the row's own finding holds the variant.
    use = _use()
    log = _record(BAR_ENTRY.id, "fix-in-hq") + "\n"
    assert parity.left_to_the_bar(MANIFEST, BAR_ENTRY.id, KEY)
    assert parity.row_uses([use], log, [BAR_ENTRY.id], held=MANIFEST) == []
    # A class the lane reads is judged there, and a key every entry naming is the bar's is the bar's own.
    assert not parity.left_to_the_bar(MANIFEST, REFUSED_ENTRY.id, KEY)
    assert not parity.left_to_the_bar(MANIFEST, ONLY_BAR.id, BAR_KEY)
    bar_use = parity.Decided(Use(BAR_KEY, "app.json", "/modules/0/module_filter"), manifest_usage.BAR, (ONLY_BAR,))
    assert parity.row_uses([bar_use], "", [ONLY_BAR.id], held=MANIFEST) == [bar_use]


def test_a_variant_s_refused_use_claimed_under_another_entry_is_entry():
    use = _use(REFUSED, (REFUSED_ENTRY,))
    assert _whats(parity.join([use], _log((OTHER_REFUSED.id, "fix-in-hq")), held=MANIFEST)) == ["entry"]
    # Claimed under the entry the lane's standing rests on, it agrees.
    assert parity.join([use], _log((REFUSED_ENTRY.id, "fix-in-hq")), held=MANIFEST) == []


def test_a_use_every_read_class_rules_out_beside_the_bar_s_class_is_judged_as_the_bar_s():
    # The lane's standing is the bar's, resting on the bar's entry (manifest_usage.standing): a variant whose
    # reader refuses it there agrees, and one whose reader holds it does not.
    use = _use(manifest_usage.BAR, (BAR_ENTRY,))
    assert parity.row_uses([use], "", [BAR_ENTRY.id], held=MANIFEST) == [use]
    assert _judged([use], _record(BAR_ENTRY.id, "fix-in-hq") + "\n", [BAR_ENTRY.id]) == []
    assert _whats(_judged([use], _record(HELD_ENTRY.id, "held") + "\n", [BAR_ENTRY.id])) == ["standing"]


SESSION_READ = "instance('commcaresession')/session/data/case_id != ''"
FORM_XML = (
    '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><h:title>F</h:title>'
    '<model><instance><data xmlns="http://openrosa.org/formdesigner/F"/></instance></model></h:head><h:body/></h:html>'
)
LINKING_APP = {
    "doc_type": "Application",
    "langs": ["en"],
    "_attachments": {"f.xml": FORM_XML},
    "modules": [
        {
            "doc_type": "Module",
            "unique_id": "m",
            "case_type": "patient",
            "forms": [
                {
                    "doc_type": "Form",
                    "unique_id": "f",
                    "form_links": [{"doc_type": "FormLink", "xpath": SESSION_READ, "form_id": "f"}],
                }
            ],
        }
    ],
}
SESSION_PARSE = {
    "functions": [],
    "custom": [],
    "roots": ["instance"],
    "instancePaths": [{"instance": "commcaresession", "steps": ["session", "data", "case_id"]}],
    "expressions": [],
    "axes": [],
    "tests": [],
    "tokens": [],
}


def _built(datum_id):
    """A suite HQ built of the app: the form's entry, writing ``datum_id`` before it opens the form."""
    return etree.fromstring(
        '<suite><entry><form>http://openrosa.org/formdesigner/F</form><command id="m0-f0"/><session>'
        f'<datum id="{datum_id}" nodeset="x" value="./@case_id"/></session></entry></suite>'
    )


def _session_read(entry_suites):
    readings = manifest_usage.Readings(
        questions={hashlib.sha256(FORM_XML.encode("utf-8")).hexdigest(): {"questions": []}},
        expressions={SESSION_READ: SESSION_PARSE},
        strings={},
        csql={},
        trees={},
        conditions={},
        media={},
    )
    found = parity.source_uses(LINKING_APP, readings=readings, entry_suites=entry_suites)
    where = "/modules/0/forms/0/form_links/0/xpath"
    [use] = [use for use in found.uses if use.where == where and use.key.startswith("session-path:")]
    standing, entries = manifest_usage.standing(parity.manifest(), use)
    decided, _ = parity.decided_uses(found)
    return standing, {entry.id for entry in entries}, any(one.use is use for one in decided)


def test_a_session_read_is_decided_against_the_suite_hq_built_as_the_manifest_check_decides_it():
    """Contract: parity reads a form link's session read with the suite HQ built of A beside the app's forms
    (``source_uses``' ``entry_suites``), as the manifest check reads A (``manifest_usage.export_uses``): a read the
    form's entry does not supply is refused and judged, one it supplies is held, and only with no suite beside the
    app is the read undecided. A held read stays unjudged, since a HELD-NEW class of its key has no reader
    (``parity.decides``). The plausible failure: parity over a base with no suite beside the app, where
    ``datum_not_supplied`` cannot say, so a read no entry supplies is never held to the reader's record of it."""
    assert _session_read(())[0] == manifest_usage.UNDECIDED
    assert _session_read((_built("case_id"),))[0] == HELD
    standing, entries, decided = _session_read((_built("other_id"),))
    assert (standing, decided) == (REFUSED, True)
    assert "expressions-and-data/session-data-datum-the-entry-does-not-supply" in entries


def _hq_plain_source():
    """The retained source answer of the base ``hq-plain`` (``proof/hq-apps/hq-plain/app-source.json``), parsed."""
    answer = Path(__file__).resolve().parents[1] / "hq-apps" / "hq-plain" / "app-source.json"
    return json.loads(json.loads(answer.read_text(encoding="utf-8"))["body"])


def test_a_variant_s_added_uses_are_the_one_its_change_makes_and_none_for_its_base_again():
    """Contract: ``parity.added_uses`` gives the uses the lane decides in a variant's source that its base's source
    does not decide alike: exactly the decided use of the one value a row sets (a badge on a form, which the manifest
    holds as not yet held, ``forms-and-case-writes/custom-icons-0``), and none for the base's source over itself.
    The plausible failure: an identity or an extraction that reads a variant's use as already seen in its base, so
    every row's judged uses come back empty and the join judges nothing (``proof/matrix/parity-decided.json`` then
    fails by name in the lane; this holds the function without HQ)."""
    base = _hq_plain_source()
    assert parity.added_uses(base, copy.deepcopy(base)) == []
    variant = copy.deepcopy(base)
    variant["modules"][0]["forms"][1]["custom_icons"] = [
        {"doc_type": "CustomIcon", "form": "badge", "text": {"en": "New"}, "xpath": ""}
    ]
    [added] = parity.added_uses(base, variant)
    assert added.use == Use("schema:Form.custom_icons", "app.json", "/modules/0/forms/1/custom_icons")
    assert (added.standing, [entry.id for entry in added.entries]) == (
        manifest_usage.HELD_NEW,
        ["forms-and-case-writes/custom-icons-0"],
    )


def test_each_private_language_and_alias_needs_a_claim_at_its_own_position():
    from proof.checks.manifest_usage import app_json_uses, Uses

    manifest = parity.manifest()
    key = "schema:Application.langs"
    source = {"doc_type": "Application", "langs": ["eng", "en", "qaa", "qtz", "fra", "qua"]}
    found = Uses()
    app_json_uses(source, manifest, "app.json", found, authored=True)
    uses = [one for one in parity.decided_uses(found, manifest)[0] if one.at]
    assert [one.at for one in uses] == ["/langs/0", "/langs/2", "/langs/3"]
    claims = [parity.Record("app.json", "/langs", key, parity.PROJECT_LANGUAGE, "held", one.at) for one in uses]
    assert parity.join(uses, claims) == []
    # Moving the alias's own claim onto the registered English sibling cannot witness the alias.
    moved = parity.Record("app.json", "/langs", key, parity.PROJECT_LANGUAGE, "held", "/langs/1")
    assert _whats(parity.join(uses, [moved, *claims[1:]])) == ["entry"]
    assert _whats(parity.join(uses, claims[1:])) == ["entry"]
