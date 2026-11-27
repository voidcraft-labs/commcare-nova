"""Parity: Nova's reader and the lane's manifest check, two classifiers written apart over one manifest, held to
each other on every app made in CommCare HQ, wherever the lane's check decides.

For each configuration of an ``hq-authored`` document:

1. **The lane's uses.** One call of ``manifest_usage.app_json_uses`` over the
   parsed body of HQ's source answer to the unit's ``authored`` read of part
   ``a`` (``proof.checks.observations.api_reads``), as artifact ``app.json``
   (which reads each form's XForm under ``form:<m>.<f>``), with the
   expressions, CSQL and questions it collects read through the readings the
   manifest observation made of the document's ``authored/app.json``, whose
   forms and expressions are the same text (``manifest_usage.read_observed``),
   and each form opened by the entries of the suite HQ built of A under the
   configuration (``manifest_usage.built_suites``), as the manifest check reads
   A, so a session read is decided against what those entries write.
   Each use has its ``(key, artifact, where)`` and its standing
   (``manifest_usage.standing``).
2. **The reader's claims.** One request to the reader bundle in mode
   ``claims`` over the same read (``proof.checks.readerbundle``), which answers
   the claim log ``serializeClaimLog`` writes, one JSON object a line:
   ``artifact``, ``where``, ``key``, ``entry``, ``standing``, the claims a
   first reading's media plan gives at each hand-off joined in.
3. **The join** (``join``), on ``(artifact, where)``: each use the lane decides
   needs some record at that place naming an entry that names the use's key,
   with a standing that projects to the lane's (``PROJECTS``). An appearance is one value the inventory sorts
   into one row by the whole of it, while the lane makes a use of the attribute's key and one of each token a
   runtime reads in it: parity joins each appearance attribute once, on the row the lane's own classifier puts
   the value in (``proof.checks.appearance_rows``, written from the inventory and the upstream readers apart
   from Nova's reader), and needs the reader's record there under that row; the per-token uses stay the
   manifest and sensitivity checks' evidence. An appearance the classifier does not decide is reported by place
   (``undecided_appearances``).
4. **The other way**: every record whose ``key`` is not null is a use the lane
   extracted at that ``(artifact, where)`` with that key.

The lane does not decide a use it calls ``undecided``, a ``held`` use of a key a
HELD-NEW entry shares with no value-class reader, a use of a ``parser:`` key,
or a use of standing ``source``; ``undecided`` counts them by key, and the
check's evidence holds the counts.

A place is where a key's value sits: the lane's use of a schema key sits at
the key's own pointer, and so must the reader's record of it. Nothing here
loosens the join: a record that sits elsewhere is ``unclaimed`` at the use and
``unseen`` at the record, and the side that is wrong is corrected
(``proof/checks/fixtures/place-vectors.json`` holds the two vocabularies alike).

Differences are ``Difference(check="parity", artifact="claims@A",
path="/<key>/<what>")``, ``what`` one of ``unclaimed``, ``entry``, ``standing``
and ``unseen``, the place in ``at``; no register entry may name one.

``join``, ``added_uses`` and ``row_uses`` are pure and read no records:
``proof/matrix/test_retained.py`` joins each variant's added uses that its row's
own entries decide to its claim log with them (``variant_differences``). On a
variant no other use is judged, and no record the other way (``unseen``): a
reader that refuses a thing whole claims nothing inside it, so a use beneath
it is ``unclaimed`` and the refusal's record ``unseen`` only because the
thing is refused. On a base, where nothing is refused, ``differences`` judges
every use and every record.
"""

from __future__ import annotations

import functools
import json
import re
from dataclasses import dataclass

from proof.checks import appearance_rows, changes, lookup_parity, manifest_usage, observations, proof6, readerbundle
from proof.checks.differences import Difference, pointer_token
from proof.checks.manifest_value_classes import (
    _guarded_lookup_count,
    bare_fingerprint_query_without_supplier,
    HQ_CASE_RESERVED_WORDS,
    case_itemset_survey_readiness,
    direct_parent_text_prompt_key,
    extended_open_index_to_first_choice,
    itemset_literal_row_index,
    long_itext_role,
    save_to_case_before_optional_own_update,
    save_to_case_retype_property_types,
    worker_record_save_to_case_shape,
    guarded_owner_after_fresh_create,
    two_parent_links_text_prompt_key,
)
from proof.observe.manifest import expression_tree

CHECK = "parity"
ARTIFACT = "claims@A"
ALLOWING = frozenset({"HELD", "TARGET-OWNED", "INERT"})
HQ_BUILD_REASON = "not-hq-buildable"
DIRECT_PARENT_PROMPT = "case-search/prompt-key-matching-a-direct-parent-property"
LATER_OWNER_ON_FRESH_CREATE = "questions/savetocase-guarded-owner-after-fresh-create"
PARENT_USER_WRITE = "forms-and-case-writes/update-key-through-a-typed-user-index"
CONDITIONAL_WORKER_UPDATE = "questions/savetocase-update-case-id-xpath"
REPEATED_WORKER_UPDATE = "questions/savetocase-inside-a-repeat"
HELD_REPEATED_WORKER_UPDATE = "questions/a-savetocase-update-of-commcare-user-under-a-condition-or-inside-a-repeat"
TWO_PARENT_LINKS_PROMPT = "case-search/prompt-key-matching-two-parent-links"
PARENT_PROMPT_SHAPES = {
    DIRECT_PARENT_PROMPT: direct_parent_text_prompt_key,
    TWO_PARENT_LINKS_PROMPT: two_parent_links_text_prompt_key,
}
UNCLAIMED, ENTRY, STANDING, UNSEEN = "unclaimed", "entry", "standing", "unseen"


@dataclass(frozen=True)
class Decided:
    """One use the lane's check decides: the use, its standing and the entries that standing rests on."""

    use: manifest_usage.Use
    standing: str
    entries: tuple
    # A selected member of an otherwise held collection that has its own exact class.
    at: str | None = None

    @property
    def place(self):
        return (self.use.artifact, self.use.where)


@dataclass(frozen=True)
class Record:
    """One line of the reader's claim log."""

    artifact: str
    where: str
    key: str | None
    entry: str
    standing: str
    # Where the value the claim reads sits, where it is not ``where`` (a key of a map whose claim names the map's
    # schema key, ``ClaimRecord.at``): the place the first-publish judge's inert allowance reads.
    at: str | None = None


@functools.cache
def manifest():
    return manifest_usage.load_manifest()


@functools.cache
def _entries_by_id(held):
    return {entry.id: entry for entries in held.entries.values() for entry in entries}


def records_of(claims) -> list[Record]:
    """The claim log as records: ``claims`` is the text ``serializeClaimLog`` writes, or records already read."""
    if not isinstance(claims, str):
        return [claim if isinstance(claim, Record) else Record(**claim) for claim in claims]
    found = []
    for line in claims.splitlines():
        if line.strip():
            value = json.loads(line)
            found.append(
                Record(
                    value["artifact"],
                    value["where"],
                    value.get("key"),
                    value["entry"],
                    value["standing"],
                    value.get("at"),
                )
            )
    return found


def _new_without_reader(held, key) -> bool:
    """Whether some HELD-NEW entry naming ``key`` has a value class and no reader (``Manifest.readers``)."""
    return any(
        entry.disposition == "HELD-NEW" and entry.value_class is not None and held.readers.get(entry.id) is None
        for entry in held.entries.get(key, ())
    )


def decides(held, use, standing, entries=()) -> bool:
    """Whether the lane's check decides a use of this standing (the module's docstring)."""
    if use.key.startswith("parser:") or standing in (manifest_usage.UNDECIDED, manifest_usage.SOURCE):
        return False
    if standing == manifest_usage.HELD and not entries and _new_without_reader(held, use.key):
        return False
    if use.key == "itext-form:core/long" and standing == manifest_usage.HELD:
        return bool(entries)
    return True


PROJECT_LANGUAGE = "application-and-settings/langs-code-nova-s-language-registry-cannot-name"


def _project_languages(use, held):
    """Independently recognizable Project codes on the app's Languages page. The ISO 639-2
    local-use range qaa through qtz has no registered individual language. Where both en
    and eng occur and the app gives neither a display name identifying a particular
    script/region, en is canonical registered English and eng has independent custody.
    Other bindings still undergo whole-document read-back and native wording checks."""
    if use.key != "schema:Application.langs" or use.at is None:
        return
    codes = use.at.value
    if not isinstance(codes, list) or not all(isinstance(code, str) for code in codes):
        return
    entry = next((one for one in held.entries[use.key] if one.id == PROJECT_LANGUAGE), None)
    if entry is None:
        return
    translations = use.at.owner.get("translations") or {}
    distinct_names = any(
        texts.get("en") or texts.get("eng")
        for texts in translations.values() if isinstance(texts, dict)
    ) if isinstance(translations, dict) else True
    english_alias = "en" in codes and "eng" in codes and not distinct_names
    for index, code in enumerate(codes):
        private = len(code) == 3 and code.isascii() and code.isalpha() and code.islower() and "qaa" <= code <= "qtz"
        if private or (english_alias and code == "eng"):
            yield Decided(use, manifest_usage.HELD, (entry,), f"{use.where}/{index}")


def _generated_case_title(use, held):
    """HQ's id_strings registers a literal Case in every language. A changed
    nonempty title in a case app belongs to the named language at this exact
    key. Ask only about plain text, whose locale spelling needs no recovery."""
    if use.key != "schema:Application.translations" or use.at is None:
        return
    translations = use.at.value
    langs = use.at.owner.get("langs")
    menus = use.at.owner.get("modules")
    if not (isinstance(translations, dict) and isinstance(langs, list) and isinstance(menus, list)
            and any(isinstance(menu, dict) and menu.get("case_type") for menu in menus)):
        return
    entry = next((entry for entry in held.entries[use.key]
                  if entry.id == "application-and-settings/translations-generated-wording"), None)
    if entry is None:
        return
    for code in langs:
        if not isinstance(code, str) or not isinstance(translations.get(code), dict):
            continue
        title = translations[code].get("cchq.case")
        if not isinstance(title, str) or not title or title == "Case":
            continue
        if title.isascii() and title.isprintable() and title.strip() == title and "\\" not in title:
            yield Decided(use, manifest_usage.HELD, (entry,), f"{use.where}/{pointer_token(code)}/cchq.case")


def _generated_detail_tab_title(use, held):
    """A case detail's visible tabs receive one native locale key apiece. Decide plain
    overrides on an actual tab. Unbuilt positions and separate Search variants need
    other source evidence before this check can judge them."""
    if use.key != "schema:Application.translations" or use.at is None:
        return
    translations = use.at.value
    langs = use.at.owner.get("langs")
    menus = use.at.owner.get("modules")
    if not isinstance(translations, dict) or not isinstance(langs, list) or not isinstance(menus, list):
        return
    entry = next((entry for entry in held.entries[use.key]
                  if entry.id == "application-and-settings/translations-generated-wording"), None)
    if entry is None:
        return
    for code in langs:
        if not isinstance(code, str) or not isinstance(translations.get(code), dict):
            continue
        for key, title in translations[code].items():
            match = re.fullmatch(r"m(0|[1-9][0-9]*)\.case_long\.tab\.([1-9][0-9]*)\.title", key)
            if match is None or not isinstance(title, str) or not title.isascii() or not title.isprintable():
                continue
            if title.strip() != title or "\\" in title:
                continue
            menu_index, tab_index = map(int, match.groups())
            if menu_index >= len(menus) or not isinstance(menus[menu_index], dict):
                continue
            pair = menus[menu_index].get("case_details")
            detail = pair.get("long") if isinstance(pair, dict) else None
            tabs = detail.get("tabs") if isinstance(detail, dict) else None
            if not isinstance(tabs, list) or tab_index > len(tabs) or not isinstance(tabs[tab_index - 1], dict):
                continue
            headers = tabs[tab_index - 1].get("header")
            if isinstance(headers, dict) and isinstance(headers.get(code), str) and headers[code] != title:
                yield Decided(use, manifest_usage.HELD, (entry,), f"{use.where}/{pointer_token(code)}/{key}")


def _generated_badge(use, held):
    """HQ's first ordinary text badge supplies a menu or stored form's own locale."""
    if use.key != "schema:Application.translations" or use.at is None:
        return
    translations = use.at.value
    langs = use.at.owner.get("langs")
    menus = use.at.owner.get("modules")
    if not isinstance(translations, dict) or not isinstance(langs, list) or not isinstance(menus, list):
        return
    entry = next((entry for entry in held.entries[use.key]
                  if entry.id == "application-and-settings/translations-generated-wording"), None)
    if entry is None:
        return
    for module_index, menu in enumerate(menus):
        if not isinstance(menu, dict):
            continue
        carriers = [(f"modules.m{module_index}.badge", menu)]
        forms = menu.get("forms")
        if isinstance(forms, list):
            carriers.extend((f"forms.m{module_index}f{form_index}.badge", form)
                            for form_index, form in enumerate(forms) if isinstance(form, dict))
        for key, carrier in carriers:
            icons = carrier.get("custom_icons")
            if not isinstance(icons, list) or not icons or not isinstance(icons[0], dict):
                continue
            icon = icons[0]
            text = icon.get("text")
            if icon.get("form") != "badge" or icon.get("xpath") or not isinstance(text, dict):
                continue
            for code in langs:
                if not isinstance(code, str) or not isinstance(translations.get(code), dict):
                    continue
                base = text.get(code)
                badge = translations[code].get(key)
                if not isinstance(base, str) or not base or not isinstance(badge, str) or badge == base:
                    continue
                if badge and badge.isascii() and badge.isprintable() and badge.strip() == badge and "\\" not in badge:
                    yield Decided(use, manifest_usage.HELD, (entry,), f"{use.where}/{pointer_token(code)}/{key}")


def _generated_lookup_heading(use, held):
    """A row-layout case-ID lookup uses its own short-detail heading locale."""
    if use.key != "schema:Application.translations" or use.at is None:
        return
    translations = use.at.value
    langs = use.at.owner.get("langs")
    menus = use.at.owner.get("modules")
    if not isinstance(translations, dict) or not isinstance(langs, list) or not isinstance(menus, list):
        return
    entry = next((entry for entry in held.entries[use.key]
                  if entry.id == "application-and-settings/translations-generated-wording"), None)
    if entry is None:
        return
    for module_index, menu in enumerate(menus):
        pair = menu.get("case_details") if isinstance(menu, dict) else None
        detail = pair.get("short") if isinstance(pair, dict) else None
        if not isinstance(detail, dict) or not detail.get("columns") or detail.get("case_tile_template"):
            continue
        if not (detail.get("lookup_enabled") is True and detail.get("lookup_display_results") is True
                and detail.get("lookup_action") and detail.get("lookup_field_template") == "@case_id"):
            continue
        headers = detail.get("lookup_field_header")
        if not isinstance(headers, dict):
            continue
        key = f"case_lists.m{module_index}.callout.header"
        for code in langs:
            if not isinstance(code, str) or not isinstance(translations.get(code), dict):
                continue
            base = headers.get(code)
            label = translations[code].get(key)
            if not isinstance(base, str) or not base or not isinstance(label, str) or label == base:
                continue
            if label and label.isascii() and label.isprintable() and label.strip() == label and "\\" not in label:
                yield Decided(use, manifest_usage.HELD, (entry,), f"{use.where}/{pointer_token(code)}/{key}")


def _generated_search_group_heading(use, held):
    """The literal group row and its ordered members own this generated wording."""
    if use.key != "schema:Application.translations" or use.at is None:
        return
    translations = use.at.value
    langs, menus = use.at.owner.get("langs"), use.at.owner.get("modules")
    if not isinstance(translations, dict) or not isinstance(langs, list) or not isinstance(menus, list):
        return
    entry = next((item for item in held.entries[use.key]
                  if item.id == "application-and-settings/translations-generated-wording"), None)
    if entry is None:
        return
    for module_index, menu in enumerate(menus):
        if not isinstance(menu, dict) or menu.get("doc_type") not in {"Module", "AdvancedModule", "ShadowModule"}:
            continue
        config = menu.get("search_config")
        rows = config.get("properties") if isinstance(config, dict) else None
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            continue
        headings, members, names = {}, set(), set()
        current = None
        for index, row in enumerate(rows):
            name = row.get("name")
            if not isinstance(name, str) or not name or name in names:
                break
            names.add(name)
            if row.get("is_group") is True:
                current = name
                labels = row.get("label")
                if (row.get("group_key") != current or not isinstance(labels, dict)
                        or not any(isinstance(text, str) and text.strip() for text in labels.values())):
                    break
                headings[current] = labels, f"group_header_{index}"
            elif current is None or row.get("group_key") != current:
                break
            else:
                members.add(current)
        else:
            for group_key, (labels, current_group) in headings.items():
                if group_key not in members:
                    continue
                key = f"search_property.m{module_index}.{group_key}"
                if group_key != current_group:
                    target = f"search_property.m{module_index}.{current_group}"
                    if (not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", group_key)
                            or re.fullmatch(r"group_header_[0-9]+", group_key)
                            or any(isinstance(values, dict) and target in values for values in translations.values())
                            or any(not isinstance(labels.get(code), str) or not labels[code].strip()
                                   or labels[code] != labels[code].strip() for code in langs if isinstance(code, str))):
                        continue
                for code in langs:
                    if not isinstance(code, str) or not isinstance(translations.get(code), dict):
                        continue
                    base, wording = labels.get(code), translations[code].get(key)
                    if not isinstance(base, str) or not base.strip() or not isinstance(wording, str) or wording == base:
                        continue
                    if wording and wording.isascii() and wording.isprintable() and wording.strip() == wording and "\\" not in wording:
                        yield Decided(use, manifest_usage.HELD, (entry,), f"{use.where}/{pointer_token(code)}/{key}")


def decided_uses(found, held=None) -> tuple[list[Decided], dict[str, int]]:
    """Each use of ``found`` (``manifest_usage.Uses``) the lane decides, with its standing, and the count of the
    others by key."""
    held = held or manifest()
    decided, unjudged = [], {}
    for use in found.uses:
        standing, entries = manifest_usage.standing(held, use)
        if use.key == "itext-form:core/long" and standing == manifest_usage.HELD:
            text_entry = LONG_TEXT_ENTRIES.get(long_itext_role(use))
            entries = (_entries_by_id(held)[text_entry],) if text_entry is not None else ()
        decided.extend(_generated_case_title(use, held))
        decided.extend(_generated_detail_tab_title(use, held))
        decided.extend(_generated_badge(use, held))
        decided.extend(_generated_lookup_heading(use, held))
        decided.extend(_generated_search_group_heading(use, held))
        if decides(held, use, standing, entries):
            decided.append(Decided(use, standing, tuple(entries)))
            if standing == manifest_usage.HELD:
                decided.extend(_project_languages(use, held))
        else:
            unjudged[use.key] = unjudged.get(use.key, 0) + 1
    return decided, dict(sorted(unjudged.items()))


LONG_TEXT_ENTRIES = {
    "caption": "questions/long-form-on-a-repeat-action-caption",
    "container": "questions/long-form-on-a-group-or-repeat-label",
    "other": "questions/long-form-on-a-hint-help-text-validation-message-or-choice",
    "question": "questions/long-form",
}


def source_uses(
    source: dict, held=None, *, readings=None, case_types=None, entry_suites=(), keep_expressions=False
):
    """The uses one app source answer holds (``manifest_usage.app_json_uses`` as artifact ``app.json``), its
    expressions, CSQL and questions read through ``readings`` where given, and each form opened by the entries of
    ``entry_suites`` (``Form.entry_suites``: the suites HQ built of the app, parsed), which the value classes that
    read what an entry writes into the session read, as the manifest check reads them over the same app
    (``manifest_usage.export_uses``). The source is an app HQ made, so its multimedia map names the files HQ holds
    for it (``App.authored``)."""
    held = held or manifest()
    found = manifest_usage.Uses()
    manifest_usage.app_json_uses(source, held, "app.json", found, authored=True)
    for exported in found.documents:
        if hasattr(exported, "case_types"):
            exported.case_types = case_types
        if isinstance(exported, manifest_usage.Form):
            exported.entry_suites = tuple(entry_suites)
    if readings is not None:
        manifest_usage.read_observed(found, held, readings)
    else:
        if not keep_expressions:
            found.expressions = []
        found.csql, found.questions = [], []
    return found


AUTOMATIC_MULTI = "menus-and-case-lists/detail-auto-select-multi-select"
LOCATION_WRITE = "forms-and-case-writes/update-keys-location-id-hq-user-id"
LOCATION_UPDATE_KEY = "schema:UpdateCaseAction.update"
PASSIVE_LABEL_WRITE = "forms-and-case-writes/an-advanced-follow-up-update-from-its-root-passive-label"
OTHER_ADVANCED_LABEL = "forms-and-case-writes/an-advanced-load-s-update-or-preload-or-an-open-action-s-name-or"
LABEL_WRITE_PATH = "schema:ConditionalCaseUpdate.question_path"
HYPHEN_TAG = "forms-and-case-writes/case-tag-holding-a-hyphen"
EXTENDED_OPEN_INDEX = "forms-and-case-writes/advancedopencaseaction-case-indices-child-extension-one-or-many"
UNICODE_OPEN_INDEX = "forms-and-case-writes/advanced-open-connection-unicode-name"
SHADOW_LOAD = "forms-and-case-writes/a-parent-load-tag-not-repeated-in-extra-actions-where-the-parent"
LOOKUP_COUNT = "expressions-and-data/companion-lookup-count"
BARE_LOOKUP_COUNT = "expressions-and-data/bare-fingerprint-query-without-a-supplier"
SUPPLY_POINT = "expressions-and-data/session-data-supply-point-id-in-an-advanced-form-whose-computed"
PARENT_FOLLOW_UP = "menus-and-case-lists/case-list-form-pointing-at-a-follow-up-form-of-the-parent-case"
CHILD_REGISTRATION = (
    "menus-and-case-lists/case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case"
)
ADVANCED_REGISTRATION = "menus-and-case-lists/case-list-form-on-an-advanced-module-or-naming-an-advanced-form"
ITEMSET_FILTER = "questions/itemset-filter-outside-predicate"
ITEMSET_PREDICATE = "questions/itemset-filter-lifting-into-predicate"
ADVANCED_CASE_ITEMSET = "questions/itemset-over-casedb-or-another-instance-advanced-data-source"
ITEMSET_NODESETS = frozenset({"xform:select1/itemset@nodeset", "xform:select/itemset@nodeset"})
OWN_CASE_BESIDE = "questions/a-savetocase-change-of-the-form-s-own-case-beside-the-form-s-own-change-of-it"
DATE_TO_TEXT = "questions/a-savetocase-retype-that-keeps-a-date-as-text"
RETYPE_CONVERTS = "questions/a-savetocase-change-of-a-case-s-type-to-a-type-that-holds-one-of-its-properties-as-another-type"
RETYPE_ENTRIES = {DATE_TO_TEXT, RETYPE_CONVERTS}
REGISTRATION_ENTRIES = {PARENT_FOLLOW_UP, CHILD_REGISTRATION, ADVANCED_REGISTRATION}
REGISTRATION_KEYS = {"schema:Module.case_list_form", "schema:AdvancedModule.case_list_form"}
ADVANCED_TAG_KEYS = frozenset({"schema:AdvancedOpenCaseAction.case_tag", "schema:LoadUpdateAction.case_tag"})
CASE_TAG = re.compile(r"[A-Za-z][A-Za-z0-9_-]*")
SUPPLY_POINT_STEPS = [["child", step, 0] for step in ("session", "data", "supply_point_id")]


def _location_write_uses(use, entry):
    """The ordinary case's direct location and HQ-worker columns, at the update member the reader holds."""
    at = use.at
    if not isinstance(at, manifest_usage.JsonAt) or not isinstance(at.value, dict):
        return
    form = at.nearest("Form")
    condition = at.owner.get("condition")
    if form is None or form.get("requires") != "case" or not isinstance(condition, dict):
        return
    if condition.get("type") != "always":
        return
    for name in ("location_id", "hq_user_id"):
        write = at.value.get(name)
        if (isinstance(write, dict) and write.get("update_mode") == "always"
                and isinstance(write.get("question_path"), str) and write["question_path"].strip()):
            yield Decided(use, manifest_usage.HELD, (entry,), f"{use.where}/{name}")


def _parent_user_write_uses(use, entry):
    """A basic one-case follow-up with a unique ordinary type at both literal hops."""
    at = use.at
    form = at.nearest("Form")
    if form is None or form.get("requires") != "case" or not isinstance(at.value, dict):
        return
    module = at.app.module_of(form)
    actions = form.get("actions") or {}
    if (
        module is None
        or module.get("doc_type") != "Module"
        or ((module.get("case_details") or {}).get("short") or {}).get("multi_select")
        or (actions.get("close_case") or {}).get("condition", {}).get("type") not in (None, "never")
        or actions.get("subcases")
        or (actions.get("usercase_update") or {}).get("update")
        or any("/" in key and key.split("/")[:-1] != ["parent", "user"] for key in at.value)
    ):
        return
    edges = {}
    for menu in at.app.modules:
        for item in menu.get("forms") or ():
            authored = item.get("actions") or {}
            for subcase in authored.get("subcases") or ():
                if (subcase.get("condition") or {}).get("type") != "never":
                    edge = (subcase.get("case_type"), subcase.get("reference_id") or "parent")
                    edges.setdefault(edge, set()).add(menu.get("case_type"))
            loads = {
                load.get("case_tag"): load.get("case_type")
                for load in (*tuple(authored.get("load_update_cases") or ()), *tuple(authored.get("open_cases") or ()))
            }
            for op in authored.get("open_cases") or ():
                for index in op.get("case_indices") or ():
                    edge = (op.get("case_type"), index.get("reference_id") or "parent")
                    edges.setdefault(edge, set()).add(loads.get(index.get("tag")))
    origin = module.get("case_type")
    parents = edges.get((origin, "parent")) or ()
    if len(parents) != 1:
        return
    parent, = parents
    targets = edges.get((parent, "user")) or ()
    if len(targets) != 1:
        return
    terminal, = targets
    types = {origin, parent, terminal}
    if (
        len(types) != 3 or None in types
        or types.intersection({"commcare-user", "commcare-case-claim", "user-owner-mapping-case"})
    ):
        return
    for name, write in at.value.items():
        if name.split("/")[:-1] == ["parent", "user"] and isinstance(write, dict) and write.get("question_path"):
            yield Decided(use, manifest_usage.HELD, (entry,), f"{use.where}/{pointer_token(name)}")


def _shadow_default_extra_actions(use, held, entry, places):
    """An omitted or default-shaped extra-actions slot can still drop a datum needed by the visible source."""
    where = f"{use.where}/extra_actions"
    key = "schema:ShadowForm.extra_actions"
    if (use.artifact, where, key) in places:
        return
    at = use.at
    extra = manifest_usage.Use(key, use.artifact, where, manifest_usage.JsonAt(at.app, at.scope, "extra_actions"))
    standing, reasons = manifest_usage.standing(held, extra)
    if standing == manifest_usage.REFUSED and entry in reasons:
        yield Decided(extra, standing, reasons)


def _supply_point_path(tree, instances, held):
    if not isinstance(tree, list) or not tree:
        return False
    if tree[0] == "path" and tree[4] == SUPPLY_POINT_STEPS and tree[1].startswith("instance:"):
        instance = tree[1].removeprefix("instance:")
        src = instances.get(instance, manifest_usage.preset_source(held, instance))
        return src is not None and manifest_usage.instance_source(held, src) == "instance-source:session"
    return any(_supply_point_path(node, instances, held) for node in tree)


def _supplied_point_uses(found, held, entry):
    """An advanced form's computed supply point read, through the actual session instance and a plain child path."""
    for expression in found.expressions:
        if "supply_point_id" not in expression.text or not isinstance(expression.at, manifest_usage.XmlAt):
            continue
        form = expression.at.document
        if not isinstance(form, manifest_usage.Form) or form.app_form is None:
            continue
        _, source = form.app_form
        if source.get("doc_type") != "AdvancedForm":
            continue
        supplies = [
            datum for datum in source.get("arbitrary_datums") or ()
            if isinstance(datum, dict) and datum.get("datum_id") == "supply_point_id"
        ]
        if len(supplies) != 1 or not supplies[0].get("datum_function"):
            continue
        if _supply_point_path(expression_tree(expression.text), dict(expression.instances), held):
            use = manifest_usage.Use("session-path:session/data/*", expression.artifact, expression.where, expression.at)
            yield Decided(use, manifest_usage.HELD, (entry,))


def _bare_lookup_count_uses(found, held, entry):
    """Read the retained raw bind with the same source facts the manifest classifier requires."""
    for expression in found.expressions:
        if "fingerprintquery" not in expression.text:
            continue
        use = manifest_usage.Use(
            "session-path:session/data/fingerprintquery", expression.artifact, expression.where, expression.at
        )
        if bare_fingerprint_query_without_supplier(use, held):
            yield Decided(use, manifest_usage.REFUSED, (entry,))


def _companion_count_uses(found, entry):
    """Find the numeric singleton guard on a retained direct basic lookup form."""
    guards = (_guarded_lookup_count(), _guarded_lookup_count(indexed=False))
    for expression in found.expressions:
        if "fingerprintquery" not in expression.text or not isinstance(expression.at, manifest_usage.XmlAt):
            continue
        form = expression.at.document
        if not isinstance(form, manifest_usage.Form) or form.app_form is None:
            continue
        app, source = form.app_form
        menu = app.module_of(source)
        if (
            menu is None or menu.get("doc_type") != "Module" or menu.get("root_module_id")
            or not menu.get("case_type") or app.doc.get("cloudcare_enabled") is not False
            or source.get("doc_type") != "Form" or source.get("requires") != "case"
        ):
            continue
        short = (menu.get("case_details") or {}).get("short") or {}
        if short.get("lookup_enabled") is not True or short.get("multi_select"):
            continue
        if (tree := expression_tree(expression.text)) is not None and tree in guards:
            use = manifest_usage.Use(
                "session-path:session/data/fingerprintquery", expression.artifact, expression.where, expression.at
            )
            yield Decided(use, manifest_usage.HELD, (entry,))


def _registration_target(use):
    """A basic form reached from a list, with the particular selection or creation that supplies its case."""
    at = use.at
    listed = at.value
    form_id = listed.get("form_id") if isinstance(listed, dict) else None
    if not isinstance(form_id, str):
        return
    target = at.app.forms_by_id.get(form_id)
    if target is None or target.get("doc_type") != "Form":
        return
    menu = at.owner
    target_menu = at.app.module_of(target)
    case_type = menu.get("case_type")
    if not case_type or target_menu is None or not target_menu.get("case_type"):
        return
    actions = target.get("actions") or {}
    open_case = ((actions.get("open_case") or {}).get("condition") or {}).get("type")
    if use.key == "schema:AdvancedModule.case_list_form":
        if target_menu.get("case_type") == case_type and target.get("requires") == "none" and open_case == "always":
            return ADVANCED_REGISTRATION
        return
    if target_menu.get("case_type") == case_type:
        return
    parent = menu.get("parent_select") or {}
    if (
        parent.get("active") is True and parent.get("relationship") == "parent"
        and parent.get("module_id") == target_menu.get("unique_id")
        and target.get("requires") == "case"
        and open_case == "never"
    ):
        return PARENT_FOLLOW_UP
    if target.get("requires") not in {"case", "none"}:
        return
    children = [
        subcase for subcase in actions.get("subcases") or ()
        if isinstance(subcase, dict) and subcase.get("case_type") == case_type
        and (subcase.get("condition") or {}).get("type") in {"if", "always"}
    ]
    if len(children) == 1 and not children[0].get("repeat_context") and children[0].get("relationship") == "child":
        return CHILD_REGISTRATION


def _automatic_multiple_case_selection(use):
    at = use.at
    if not isinstance(at, manifest_usage.JsonAt):
        return False
    menu = at.nearest("Module")
    pair = at.nearest("DetailPair")
    return (menu is not None and bool(menu.get("case_type")) and pair is not None
            and pair.get("short") is at.owner and at.owner.get("multi_select") is True and at.value is True)


def _advanced_own_label_write(use):
    """Judge the direct root trigger on the form's own ordinary chosen case."""
    at = use.at
    if not isinstance(at, manifest_usage.JsonAt):
        return
    menu = at.nearest("AdvancedModule")
    form = at.nearest("AdvancedForm")
    load = at.nearest("LoadUpdateAction")
    if menu is None or form is None or load is None:
        return
    case_type = menu.get("case_type")
    if not case_type or case_type == "commcare-user" or load.get("case_type") != case_type:
        return
    actions = form.get("actions") or {}
    choices = [
        row for row in actions.get("load_update_cases") or ()
        if isinstance(row, dict) and not row.get("auto_select")
    ]
    if not choices or choices[-1] is not load or actions.get("open_cases"):
        return
    prop = next((key for key, value in (load.get("case_properties") or {}).items() if value is at.owner), None)
    if (prop is None or "/" in prop or prop in HQ_CASE_RESERVED_WORDS
            or prop in {"name", "owner_id", "case_name", "external_id", "location_id", "hq_user_id"}):
        return
    if at.owner.get("update_mode") != "always" or not isinstance(at.value, str):
        return
    form_source = at.app.xform(form)
    if form_source is None:
        return
    source = form_source.node(at.value)
    controls = form_source.controls.get(at.value, ())
    if len(controls) != 1 or source is None or isinstance(source, tuple) or source.getparent() is not form_source.data_root:
        return
    (control,) = controls
    if not control.tag.endswith("}trigger") or not control.getparent().tag.endswith("}body"):
        return
    if (source.text or "").strip() or any(
        element.tag.endswith("}setvalue") and element.get("ref") == at.value
        for element in form_source.model.iter()
    ):
        return
    if (load.get("close_condition") or {}).get("type") in {"if", "always"}:
        return OTHER_ADVANCED_LABEL
    if any(
        source is form_source.node(path)
        for row in actions.get("load_update_cases") or ()
        if isinstance(row, dict) and isinstance(row.get("preload"), dict)
        for path in row["preload"]
    ):
        return OTHER_ADVANCED_LABEL
    return PASSIVE_LABEL_WRITE if control.get("appearance") in {"minimal", "selectable"} else OTHER_ADVANCED_LABEL


def _forms_variant_uses(found, held, entries):
    """Source facts retained variants can decide without the full corpus's runtime observations."""
    wanted = {
        AUTOMATIC_MULTI, LOCATION_WRITE, HYPHEN_TAG, EXTENDED_OPEN_INDEX, UNICODE_OPEN_INDEX, SHADOW_LOAD, SUPPLY_POINT,
        OWN_CASE_BESIDE, LOOKUP_COUNT, BARE_LOOKUP_COUNT, ITEMSET_FILTER, ITEMSET_PREDICATE, ADVANCED_CASE_ITEMSET,
        PARENT_USER_WRITE,
        *REGISTRATION_ENTRIES, *RETYPE_ENTRIES,
        CONDITIONAL_WORKER_UPDATE, REPEATED_WORKER_UPDATE, HELD_REPEATED_WORKER_UPDATE, LATER_OWNER_ON_FRESH_CREATE,
        PASSIVE_LABEL_WRITE, OTHER_ADVANCED_LABEL,
    }.intersection(entries)
    if not wanted:
        return
    by_id = _entries_by_id(held)
    places = {(use.artifact, use.where, use.key) for use in found.uses}
    for use in found.uses:
        at = use.at
        if wanted.intersection((PASSIVE_LABEL_WRITE, OTHER_ADVANCED_LABEL)) and use.key == LABEL_WRITE_PATH:
            if (entry := _advanced_own_label_write(use)) in wanted:
                status = manifest_usage.HELD if entry == PASSIVE_LABEL_WRITE else manifest_usage.HELD_NEW
                yield Decided(use, status, (by_id[entry],))
        if (LATER_OWNER_ON_FRESH_CREATE in wanted and use.key == "xform:model/bind@relevant"
                and guarded_owner_after_fresh_create(use)):
            yield Decided(use, manifest_usage.HELD, (by_id[LATER_OWNER_ON_FRESH_CREATE],))
        if (AUTOMATIC_MULTI in wanted and use.key == "schema:Detail.auto_select"
                and _automatic_multiple_case_selection(use)):
            yield Decided(use, manifest_usage.HELD, (by_id[AUTOMATIC_MULTI],))
        if wanted.intersection(RETYPE_ENTRIES) and use.key == "vellum-markup:model/instance//*@vellum:role":
            types = save_to_case_retype_property_types(use)
            block = manifest_usage.Use("mug:SaveToCase", use.artifact, use.where.rsplit("/", 1)[0], at)
            if types == ("date", "string") and DATE_TO_TEXT in wanted:
                yield Decided(block, manifest_usage.HELD, (by_id[DATE_TO_TEXT],))
            elif types == ("string", "date") and RETYPE_CONVERTS in wanted:
                yield Decided(block, manifest_usage.HELD_NEW, (by_id[RETYPE_CONVERTS],))
        if (OWN_CASE_BESIDE in wanted and use.key == "vellum-markup:model/instance//*@vellum:role"
                and save_to_case_before_optional_own_update(use)):
            block = manifest_usage.Use("mug:SaveToCase", use.artifact, use.where.rsplit("/", 1)[0], at)
            yield Decided(block, manifest_usage.HELD_NEW, (by_id[OWN_CASE_BESIDE],))
        if (wanted.intersection((CONDITIONAL_WORKER_UPDATE, REPEATED_WORKER_UPDATE, HELD_REPEATED_WORKER_UPDATE))
                and use.key == "vellum-markup:model/instance//*@vellum:role"):
            shape = worker_record_save_to_case_shape(use)
            block = manifest_usage.Use("mug:SaveToCase", use.artifact, use.where.rsplit("/", 1)[0], at)
            if shape == "condition" and CONDITIONAL_WORKER_UPDATE in wanted:
                yield Decided(block, manifest_usage.HELD, (by_id[CONDITIONAL_WORKER_UPDATE],))
            elif shape == "repeat" and REPEATED_WORKER_UPDATE in wanted:
                yield Decided(block, manifest_usage.HELD, (by_id[REPEATED_WORKER_UPDATE],))
            elif shape == "repeat-held" and HELD_REPEATED_WORKER_UPDATE in wanted:
                yield Decided(block, manifest_usage.HELD_NEW, (by_id[HELD_REPEATED_WORKER_UPDATE],))
        if wanted.intersection((ITEMSET_FILTER, ITEMSET_PREDICATE)) and use.key in ITEMSET_NODESETS:
            shape = itemset_literal_row_index(use)
            if shape == "ordinal" and ITEMSET_PREDICATE in wanted:
                yield Decided(use, manifest_usage.HELD, (by_id[ITEMSET_PREDICATE],))
            elif shape == "other-number" and ITEMSET_FILTER in wanted:
                yield Decided(use, manifest_usage.HELD_NEW, (by_id[ITEMSET_FILTER],))
        if (ADVANCED_CASE_ITEMSET in wanted and use.key == "xform:select1/itemset"
                and case_itemset_survey_readiness(use)):
            yield Decided(use, manifest_usage.HELD_NEW, (by_id[ADVANCED_CASE_ITEMSET],))
        if PARENT_USER_WRITE in wanted and use.key == "schema:UpdateCaseAction.update":
            yield from _parent_user_write_uses(use, by_id[PARENT_USER_WRITE])
        if LOCATION_WRITE in wanted and use.key == LOCATION_UPDATE_KEY:
            yield from _location_write_uses(use, by_id[LOCATION_WRITE])
        if HYPHEN_TAG in wanted and use.key in ADVANCED_TAG_KEYS:
            tag = at.value
            if (isinstance(tag, str) and "-" in tag and CASE_TAG.fullmatch(tag)
                    and manifest_usage.standing(held, use)[0] == manifest_usage.HELD):
                yield Decided(use, manifest_usage.HELD, (by_id[HYPHEN_TAG],))
        if (wanted.intersection((EXTENDED_OPEN_INDEX, UNICODE_OPEN_INDEX))
                and use.key == "schema:CaseIndex.reference_id"
                and extended_open_index_to_first_choice(use, held)):
            name = at.value
            entry = UNICODE_OPEN_INDEX if isinstance(name, str) and not name.isascii() else EXTENDED_OPEN_INDEX
            if entry in wanted:
                yield Decided(use, manifest_usage.HELD, (by_id[entry],))
        if SHADOW_LOAD in wanted and use.key == "schema:ShadowForm":
            yield from _shadow_default_extra_actions(use, held, by_id[SHADOW_LOAD], places)
        if wanted.intersection(REGISTRATION_ENTRIES) and use.key in REGISTRATION_KEYS:
            if (entry := _registration_target(use)) in wanted:
                yield Decided(use, manifest_usage.HELD, (by_id[entry],))
    if SUPPLY_POINT in wanted:
        yield from _supplied_point_uses(found, held, by_id[SUPPLY_POINT])
    if LOOKUP_COUNT in wanted:
        yield from _companion_count_uses(found, by_id[LOOKUP_COUNT])
    if BARE_LOOKUP_COUNT in wanted:
        yield from _bare_lookup_count_uses(found, held, by_id[BARE_LOOKUP_COUNT])


SEARCH_CHECK_NO_MESSAGE = "case-search/a-required-or-validation-test-with-no-message-in-any-language"


def _empty_search_check_messages(found, held):
    """Decide a deliberately empty message map even though there is no text value to extract."""
    from proof.checks.xpath_tree import tree

    entry = _entries_by_id(held)[SEARCH_CHECK_NO_MESSAGE]
    for use in found.uses:
        if use.key != "schema:Assertion.test" or use.at is None:
            continue
        prompt = use.at.nearest("CaseSearchProperty")
        assertion = use.at.nearest("Assertion")
        if (
            prompt is None or assertion is None or assertion.get("text") != {}
            or len(prompt.get("validations") or []) != 1
            or prompt["validations"][0] is not assertion or prompt.get("hidden")
            or not isinstance(use.at.value, str)
        ):
            continue
        answer = changes.lowercase_search_answer(tree(use.at.value))
        if answer is not None and answer[1] == prompt.get("name"):
            yield Decided(
                manifest_usage.Use("schema:Assertion.text", use.artifact, use.where.removesuffix("/test") + "/text"),
                manifest_usage.HELD,
                (entry,),
            )


def added_uses(base_source: dict, variant_source: dict, *, entries=()) -> list[Decided]:
    """The uses the lane decides in a variant's source answer that it does not decide alike in its base's: each use
    whose key, place, standing and entries the base's source holds none of."""
    held = manifest()

    def decisions(source):
        found = source_uses(source, held, keep_expressions=bool({SUPPLY_POINT, LOOKUP_COUNT, BARE_LOOKUP_COUNT}.intersection(entries)))
        decided, _ = decided_uses(found, held)
        decided.extend(_forms_variant_uses(found, held, entries))
        if SEARCH_CHECK_NO_MESSAGE in entries:
            decided.extend(_empty_search_check_messages(found, held))

        for entry_id in PARENT_PROMPT_SHAPES.keys() & set(entries):
            entry = _entries_by_id(held)[entry_id]
            classifier = PARENT_PROMPT_SHAPES[entry_id]
            # Ordinary HELD classes share the same standing. Record this
            # affirmative stored shape, not an allowance for the whole key.
            decided.extend(
                Decided(use, manifest_usage.HELD, (entry,))
                for use in found.uses
                if use.key == "schema:CaseSearchProperty.name" and classifier(use, held)
            )
        return decided

    base, variant = decisions(base_source), decisions(variant_source)
    seen = {_identity(one) for one in base}
    return [one for one in variant if _identity(one) not in seen]


def left_to_the_bar(held, entry_id, key) -> bool:
    """Whether the lane's standing of a use of ``key`` leaves the class of the entry ``entry_id`` to the bar: a
    REFUSED entry naming the key, refused only because HQ's build refuses its state, beside an entry naming the key
    that is not such an entry (``manifest_usage.standing``, which reads no such class there), so the lane's check
    neither takes a use into that class nor rules one out of it."""
    entry = _entries_by_id(held).get(entry_id)
    naming = held.entries.get(key, ())

    def bar(one):
        return one.disposition == "REFUSED" and one.refused_by_hq_build()

    return entry is not None and entry in naming and bar(entry) and not all(bar(one) for one in naming)


def row_uses(uses, claims, entries, held=None) -> list[Decided]:
    """The uses a variant's row is judged by, of a variant's added uses (``added_uses``): each the lane decides under
    one of the row's own entries (``entries``: its entry, its second's and each of its also's), its standing resting
    on one of them, and each decided use at whose place the claim log names one of them for the use's key, so a use
    the lane holds where the reader refuses the row's class is judged too, but for a record of an entry whose class
    the lane leaves to the bar there (``left_to_the_bar``): the lane's check never read that class, so its standing
    is no verdict on it, and the row's own finding holds it. No other use of a variant is judged: a reader that
    refuses a thing whole claims nothing inside it, so a structural use beneath that thing has no record of its own
    at its place, and the refusal's record stands where the lane decides nothing under the row."""
    held = held or manifest()
    entries = frozenset(entries)
    named = {
        (record.artifact, record.where, record.key)
        for record in records_of(claims)
        if record.entry in entries and not left_to_the_bar(held, record.entry, record.key)
    }
    return [
        decided
        for decided in uses
        if any(entry.id in entries for entry in decided.entries)
        or (decided.use.artifact, decided.use.where, decided.use.key) in named
    ]


def variant_differences(base_source: dict, variant_source: dict, claims, entries, *, document: str = ""):
    """A variant's parity, as the lane judges one (the row's own uses, ``row_uses``, joined to its claim log): the
    uses judged, and the differences. A row whose judged uses are none is one the lane's check does not decide."""
    uses = row_uses(added_uses(base_source, variant_source, entries=entries), claims, entries)
    if lookup_parity.CONDITION_ENTRIES.intersection(entries):
        by_id = _entries_by_id(manifest())
        for key, where, entry in lookup_parity.changed_form_condition_refusals(base_source, variant_source):
            uses.append(Decided(manifest_usage.Use(key, "app.json", where), manifest_usage.REFUSED, (by_id[entry],)))
    return uses, join(uses, claims, document=document)


def _identity(decided: Decided):
    return (
        decided.use.key,
        decided.use.artifact,
        decided.use.where,
        decided.standing,
        tuple(entry.id for entry in decided.entries),
        decided.at,
    )


def _projects(decided: Decided, record: Record, held) -> tuple[bool, bool]:
    """Whether the reader's record projects to the lane's standing, and whether its entry is one the lane's standing
    allows: ``(standing agrees, entry agrees)``."""
    resting = {entry.id for entry in decided.entries}
    entry = _entries_by_id(held).get(record.entry)
    standing = decided.standing
    if standing == manifest_usage.REFUSED:
        return record.standing in ("never", "fix-in-hq"), record.entry in resting
    if standing == manifest_usage.BAR:
        refused = (
            entry is not None
            and entry.disposition == "REFUSED"
            and (HQ_BUILD_REASON in entry.reasons or entry.refused_by_hq_build())
        )
        return record.standing == "fix-in-hq", refused
    if standing == manifest_usage.HELD_NEW:
        return record.standing == "not-yet", record.entry in resting
    if standing == manifest_usage.HELD and len(resting) == 1 and resting <= PARENT_PROMPT_SHAPES.keys():
        return record.standing == "held", record.entry in resting
    if standing == manifest_usage.HELD and decided.at is not None:
        return record.standing == "held", record.entry in resting and record.at == decided.at
    if standing == manifest_usage.HELD:
        return record.standing in ("held", "kept", "inert"), entry is not None and entry.disposition in ALLOWING
    # UNNAMED and UNHELD: no entry the reader may claim it under names the key.
    return False, False


def _difference(document, decided_or_record, what, before, after):
    key, artifact, where = decided_or_record
    path = f"/{pointer_token(key)}/{what}"
    return Difference(CHECK, document, ARTIFACT, path, f"{path}@{artifact}{where}", "changed", before, after)


def _record_json(record: Record):
    return {
        "artifact": record.artifact,
        "where": record.where,
        "key": record.key,
        "entry": record.entry,
        "standing": record.standing,
        **({"at": record.at} if record.at is not None else {}),
    }


def _lane_json(decided: Decided):
    return {"standing": decided.standing, "entries": [entry.id for entry in decided.entries],
            **({"at": decided.at} if decided.at is not None else {})}


def _appearance_place(use) -> bool:
    """Whether a use sits at a form control's ``appearance`` attribute (``manifest_usage._appearance_uses`` and the
    XForm vocabulary's ``xform:<control>@appearance``)."""
    return use.artifact.startswith("form:") and use.where.endswith("/@appearance")


def appearance_row(use, held=None):
    """The inventory row the lane puts an appearance use's value in (``proof.checks.appearance_rows.row_of``), or
    None where it does not decide it or the use carries no element."""
    at = getattr(use, "at", None)
    element = getattr(at, "element", None)
    if element is None or element.get("appearance") is None:
        return None
    return appearance_rows.row_of(manifest(), at.document, element)


def _appearance_places(uses, row_of) -> dict:
    """Each appearance attribute a use stands at (``Decided`` or ``manifest_usage.Use``), by place: the row its
    value is in (``row_of``, None where the lane does not decide it), the attribute's key the difference is named
    by, and a use there."""
    found = {}
    for one in uses:
        use = getattr(one, "use", one)
        place = (use.artifact, use.where)
        if _appearance_place(use) and place not in found:
            key = f"xform:{use.where.rsplit('/', 2)[-2].split('[', 1)[0]}@appearance"
            found[place] = (row_of(use), key, use)
    return found


ROW_STANDINGS = {
    "HELD": ("held", "kept", "inert"),
    "INERT": ("held", "kept", "inert"),
    "TARGET-OWNED": ("held", "kept", "inert"),
    "REFUSED": ("never", "fix-in-hq"),
    "HELD-NEW": ("not-yet",),
}


def _join_appearance(document, place, row, key, records, held):
    """One appearance attribute joined on its row: a record there under that row whose standing is the row's."""
    entry = _entries_by_id(held).get(row)
    lane = {"standing": entry.disposition if entry else None, "entries": [row]}
    named = (key, *place)
    under = [record for record in records if record.entry == row]
    if not under:
        what = UNCLAIMED if not records else ENTRY
        return [_difference(document, named, what, lane, [_record_json(r) for r in records])]
    allowed = ROW_STANDINGS.get(entry.disposition if entry else "", ())
    if any(record.standing in allowed for record in under):
        return []
    return [_difference(document, named, STANDING, lane, [_record_json(r) for r in under])]


def join(
    uses, claims, *, document: str = "", held=None, row_of=appearance_row, undecided=None, extracted=None
) -> list[Difference]:
    """The lane's decided uses (``Decided``) joined to the reader's claim log on ``(artifact, where)``: one
    difference a use whose place holds no record naming an entry of its key (``unclaimed``), whose records name
    only entries outside what its standing allows (``entry``), or whose records' standings do not project to it
    (``standing``). An appearance attribute is joined once, on the inventory row the lane puts its value in
    (``row_of``, ``proof.checks.appearance_rows``): a record there under that row with the row's standing; the
    uses of each token a runtime reads in it are the manifest check's evidence and are not joined one by one. An
    appearance whose row the lane does not decide is not joined, and its place is added to ``undecided`` where one
    is given. ``extracted`` is every use the lane made (``manifest_usage.Uses.uses``), so an appearance none of
    whose token uses the lane decides is joined too; by default the decided uses' appearances. ``held`` is the
    manifest the uses were decided over (the lane's, by default)."""
    held = held or manifest()
    at_place = {}
    for record in records_of(claims):
        at_place.setdefault((record.artifact, record.where), []).append(record)
    appearances = _appearance_places(uses if extracted is None else extracted, row_of)
    found = []
    for place, (row, key, use) in appearances.items():
        if row is None:
            if undecided is not None:
                element = getattr(getattr(use, "at", None), "element", None)
                value = element.get("appearance") if element is not None else ""
                undecided.append(f"{use.artifact}{use.where}={value}")
            continue
        found += _join_appearance(document, place, row, key, at_place.get(place, []), held)
    for decided in uses:
        use = decided.use
        if decided.place in appearances:
            continue
        keys = (use.key,)
        naming_ids = {entry.id for key in keys for entry in held.entries.get(key, ())}
        records = at_place.get(decided.place, [])
        naming = [record for record in records if record.entry in naming_ids]
        place = (use.key, use.artifact, use.where)
        lane = _lane_json(decided)
        if decided.standing in (manifest_usage.UNNAMED, manifest_usage.UNHELD):
            # No entry the reader may claim the use under names its key: the reading's own account says
            # ``unrecognized`` there, which the claim log does not carry. A record of the key there is the drift.
            wrong = [record for record in records if record.key == use.key]
            if wrong:
                found.append(_difference(document, place, ENTRY, lane, [_record_json(r) for r in wrong]))
            continue
        if not naming:
            mismatched = [record for record in records if record.key == use.key]
            what = ENTRY if mismatched else UNCLAIMED
            found.append(_difference(document, place, what, lane, [_record_json(r) for r in mismatched]))
            continue
        verdicts = [(record, *_projects(decided, record, held)) for record in naming]
        if any(standing and entry for _, standing, entry in verdicts):
            continue
        what = ENTRY if any(standing for _, standing, _ in verdicts) else STANDING
        found.append(_difference(document, place, what, lane, [_record_json(r) for r in naming]))
    return found


def claim_places(claims) -> changes.ClaimPlaces:
    """Each place of the app's own JSON a record of the claim log reads, those under an entry of standing inert apart
    from the rest: what the first-publish judge's inert allowance reads (``proof.checks.changes.inert_holds``). A
    record's place is the value it reads (``at``), where that is not where its key's value sits: a key of a
    language's strings is claimed under ``schema:Application.translations`` and recorded at ``/translations``, the
    map's own key, where the join reads it, while the key itself is the value a first publish keeps or drops."""
    records = [record for record in records_of(claims) if record.artifact == "app.json"]
    return changes.ClaimPlaces(
        inert=frozenset(record.at or record.where for record in records if record.standing == "inert"),
        other=frozenset(record.at or record.where for record in records if record.standing != "inert"),
    )


def unseen(found_uses, claims, *, document: str = "") -> list[Difference]:
    """Each record of the claim log whose key is not null at a place where the lane extracted no use of that key."""
    extracted = {(use.key, use.artifact, use.where) for use in found_uses}
    differences = []
    for record in records_of(claims):
        if record.key is None or (record.key, record.artifact, record.where) in extracted:
            continue
        differences.append(
            _difference(document, (record.key, record.artifact, record.where), UNSEEN, None, _record_json(record))
        )
    return differences


def _readings(document, records):
    observed = manifest_usage.observed_exports(document, records)
    return manifest_usage.Readings.of(records.blobs.get_json(observed["readings"]))


def _authored_reads(document, records, name):
    reads = observations.api_reads(records, name, "a", "authored")
    if reads is None and (records.configurations[name].a or {}).get("state"):
        raise observations.RecordIncomplete(
            f"{document.id}'s {name}/a record holds no authored read (apiReads.authored), which parity reads"
            " (proof/observe/unit.py::_Unit.api_reads)."
        )
    return reads


# The claim logs of the document whose checks run now: parity and the first-publish judge read the same logs, and
# a document's checks run together (``sharding.order_by_group``), so the bundle reads them once.
_CLAIMS: dict = {}


def claims_logs(document, records) -> dict:
    """The reader's claim log over each configuration's ``authored`` read, by configuration: one bundle run for the
    document, mode ``claims``, kept while the document's checks run."""
    owner = (document.kind, document.id)
    if _CLAIMS.get("owner") == owner:
        return _CLAIMS["logs"]
    _CLAIMS.clear()
    requests, names = [], []
    for name in sorted(document.exports):
        reads = _authored_reads(document, records, name)
        if reads is None:
            continue
        lane_input, _ = proof6.first_read_input(document, reads, claims="full")
        requests.append({"id": f"{document.id}@{name}@claims", "mode": "claims", "input": lane_input})
        names.append(name)
    logs = {}
    if requests:
        answers = readerbundle.run_reader(requests, log_name=f"claims-{document.id}")
        logs = {name: answer.get("claims") or "" for name, answer in zip(names, answers, strict=True)}
    _CLAIMS.update(owner=owner, logs=logs)
    return logs


def claim_places_of(document, records) -> changes.ClaimPlaces:
    """The places of every configuration's claim log together (``claim_places``)."""
    found = [claim_places(log) for log in claims_logs(document, records).values()]
    return changes.ClaimPlaces(
        inert=frozenset().union(*(places.inert for places in found)),
        other=frozenset().union(*(places.other for places in found)),
    )


def _lane_uses(document, records, name, readings, reads):
    if reads is None:
        return None
    source = observations.answer_json(reads["source"])
    if not isinstance(source, dict):
        raise observations.RecordIncomplete(
            f"{document.id}'s authored read of {name} holds no app source HQ served as JSON, which parity reads."
        )
    # The suite HQ built of A under this configuration, as the manifest check reads it beside A's forms
    # (``manifest_usage.export_uses``): a display condition's, a form link's and a form's read of the session's
    # ``data/<id>`` is decided against what the entries there write (``datum_not_supplied``), never left undecided.
    built = manifest_usage.built_suites(document, records, [(name, "a")])
    return source_uses(source, readings=readings, case_types=document.case_types(), entry_suites=built)


def differences(document, records, *, claims=None) -> list[Difference]:
    """Parity's differences on one document made in HQ (the module's docstring). ``claims`` is the claim log by
    configuration where a caller already read it (``claims_logs``)."""
    claims = claims_logs(document, records) if claims is None else claims
    readings = _readings(document, records)
    found = []
    for name in sorted(claims):
        reads = _authored_reads(document, records, name)
        uses = _lane_uses(document, records, name, readings, reads)
        if uses is None:
            continue
        decided, _ = decided_uses(uses)
        found += join(decided, claims[name], document=document.id, extracted=uses.uses)
        found += unseen(uses.uses, claims[name], document=document.id)
        found += lookup_parity.differences(document.id, manifest(), uses.lookup_tags, reads, records_of(claims[name]))
    return found


def undecided_appearances(document, records, *, claims=None) -> list[str]:
    """Each appearance of the document's A whose inventory row the lane does not decide
    (``appearance_rows.row_of``), as ``<artifact><where>=<value>``, over every configuration."""
    claims = claims_logs(document, records) if claims is None else claims
    readings = _readings(document, records)
    found = []
    for name in sorted(claims):
        reads = _authored_reads(document, records, name)
        uses = _lane_uses(document, records, name, readings, reads)
        if uses is None:
            continue
        join([], "", document=document.id, undecided=found, extracted=uses.uses)
    return sorted(set(found))


def undecided(document, records) -> dict[str, int]:
    """The uses the lane's check does not decide on the document's A, counted by key, over every configuration."""
    readings = _readings(document, records)
    counts = {}
    for name in sorted(document.exports):
        reads = _authored_reads(document, records, name)
        uses = _lane_uses(document, records, name, readings, reads)
        if uses is None:
            continue
        _, unjudged = decided_uses(uses)
        for key, count in unjudged.items():
            counts[key] = counts.get(key, 0) + count
    return dict(sorted(counts.items()))


def disagreement(document_id, difference: Difference) -> str:
    """The message for one parity difference: the key, where it sits, both standings, and where to look."""
    key = difference.path.split("/")[1].replace("~1", "/").replace("~0", "~")
    _, _, place = difference.at.partition("@")
    artifact, slash, where = place.partition("/")
    lane = difference.before or {}
    claimed = difference.after
    records = claimed if isinstance(claimed, list) else [claimed] if isinstance(claimed, dict) else []
    entry = ", ".join(record["entry"] for record in records) or "no entry"
    reader_standing = ", ".join(record["standing"] for record in records) or "no claim"
    lane_standing = lane.get("standing", "no use") if isinstance(lane, dict) else "no use"
    return (
        f"Nova's reader and the lane's manifest check disagree about {key} at {slash}{where} in {artifact} of"
        f" {document_id}: the reader claimed it under {entry} ({reader_standing}), and the lane reads it as"
        f" {lane_standing}. One of the two is wrong about this value. Look at the entry's row in"
        " lib/commcare/surface/entries/ and at the value itself."
    )
