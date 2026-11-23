"""The registry of bases and the loader of ``variants.json`` (``proof/matrix/registry.py``).

The contract: every base has one id and one module; a row of ``variants.json``
names a base the registry holds, a change the lane can make (a ``set-json``
with its pointer and value, or a function of ``proof/matrix/variants/``), and
either a refusal (a standing and a place, beside the findings it composes:
a second, then a list ``also``) or what the reading holds, or, where HQ never
serves the value, neither; no
function there goes unnamed by a row; and ``base.json`` records a base's
configuration as one entry of a document's ``configurations.json``. The
plausible failures: a row naming a change no module defines (the lane would
make nothing and read the base as the variant), a change no row names (made by
nothing, unseen), a refusal with no place to hold the reading to. Standard
library only: it runs with no image.
"""

from __future__ import annotations

import builtins
import contextlib
import copy
import json
import sys
import tempfile
import types
from pathlib import Path

from proof.matrix import registry


def _rows(rows):
    scratch = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    with scratch:
        json.dump(rows, scratch)
    return Path(scratch.name)


def _refused(rows, named, fragment):
    path = _rows(rows)
    try:
        registry.load_variants(path, named=named)
    except registry.VariantsRefused as refusal:
        assert fragment in str(refusal), str(refusal)
    else:
        raise AssertionError(f"load_variants took {rows}")
    finally:
        path.unlink()


ROW = {
    "id": "hq-plain/a-change",
    "base": "hq-plain",
    "entry": "questions/an-entry",
    "standing": "fix-in-hq",
    "place": {"kind": "app"},
    "change": {"op": "named", "name": "made"},
}


def made(authoring, app_id):
    """A change for the loader's tests."""


def test_the_committed_rows_load_and_every_change_is_named():
    variants = registry.load_variants()
    assert {variant.id for variant in variants} >= {"hq-new-app/as-created", "two-refusals-one-pass"}
    composed = next(variant for variant in variants if variant.id == "two-refusals-one-pass")
    assert len(composed.refusals()) == 2 and len(composed.changes()) == 2


def test_a_row_naming_a_change_no_module_defines_is_refused():
    _refused([{**ROW, "change": {"op": "named", "name": "missing"}}], {"made": made}, "no module of")


def test_a_change_no_row_names_is_refused():
    _refused([ROW], {"made": made, "unnamed": made}, "no row of")


def test_a_refusing_row_with_no_place_and_a_row_with_neither_standing_nor_holds_are_refused():
    _refused([{**ROW, "place": None}], {"made": made}, "names the place")
    holding = {key: value for key, value in ROW.items() if key not in ("standing", "place")}
    _refused([holding], {"made": made}, "holding row")


def test_a_row_composes_findings_beside_a_second_and_never_without_one():
    second = {"entry": "questions/b", "standing": "not-yet", "place": {"kind": "app"}, "change": ROW["change"]}
    third = {**second, "entry": "questions/c", "change": {"op": "set-json", "pointer": "/c", "value": 1}}
    path = _rows([{**ROW, "second": second, "also": [third]}])
    try:
        (variant,) = registry.load_variants(path, named={"made": made})
    finally:
        path.unlink()
    assert [refusal.entry for refusal in variant.refusals()] == ["questions/an-entry", "questions/b", "questions/c"]
    assert variant.changes() == (ROW["change"], ROW["change"], third["change"])
    _refused([{**ROW, "also": [third]}], {"made": made}, "beside a second")
    _refused([{**ROW, "second": second, "also": []}], {"made": made}, "beside a second")
    _refused([{**ROW, "second": second, "also": [{**third, "standing": "kept"}]}], {"made": made}, "standing")


def test_a_row_whose_value_hq_never_serves_may_name_no_standing_and_hold_nothing():
    unserved = {
        "id": "hq-plain/unserved",
        "base": "hq-plain",
        "entry": "application-and-settings/an-entry",
        "change": {"op": "set-json", "pointer": "/short_odk_url", "value": "x"},
        "hqNeverServes": {"notServedAt": "/short_odk_url"},
    }
    path = _rows([unserved])
    try:
        (variant,) = registry.load_variants(path, named={})
    finally:
        path.unlink()
    assert not variant.refusing and variant.holds == () and variant.refusals() == ()
    plain = {key: value for key, value in unserved.items() if key != "hqNeverServes"}
    _refused([plain], {}, "holding row")


def test_a_holding_row_names_holds_as_a_list_that_may_be_empty():
    """Contract: a holding row names ``holds``, a list, empty where no fragment of the document changes (an INERT
    entry, a value Nova derives), which the judge holds by the reading being read and its claim log counting the
    entry; a row with no standing and no holds, a holds that is no list, and holds beside a standing are refused. The
    plausible failures: an INERT row refused for holding nothing, and a row whose holds is a lone fragment or text,
    which the judge would read as nothing to hold."""
    holding = {key: item for key, item in ROW.items() if key not in ("standing", "place")}
    path = _rows([{**holding, "holds": []}])
    try:
        (variant,) = registry.load_variants(path, named={"made": made})
    finally:
        path.unlink()
    assert not variant.refusing and variant.holds == ()
    _refused([holding], {"made": made}, "holding row")
    fragment = {"key": "x", "pointer": "/x", "value": 1}
    for wrong in (fragment, "x"):
        _refused([{**holding, "holds": wrong}], {"made": made}, "holds is a list")
    _refused([{**ROW, "holds": []}], {"made": made}, "refuses and holds")


def test_a_row_expecting_the_reading_to_leave_a_key_unclaimed_names_the_key():
    """Contract: a row may expect the circumstance ``unrecognized``, which names a surface key and no entry, with
    its standing and place; it names the key (``key``), which its refusal carries for the judge to compare with the
    finding's name, and no other row names one. The plausible failures: an ``unrecognized`` row met by any key left
    unclaimed at its place, and a key on an entry's row that the judge would never read."""
    unclaimed = {**ROW, "entry": registry.UNRECOGNIZED, "key": "schema:Detail.columns", "standing": "not-yet"}
    path = _rows([unclaimed])
    try:
        (variant,) = registry.load_variants(path, named={"made": made})
    finally:
        path.unlink()
    assert [(refusal.entry, refusal.key) for refusal in variant.refusals()] == [
        (registry.UNRECOGNIZED, "schema:Detail.columns")
    ]
    without = {key: value for key, value in unclaimed.items() if key != "key"}
    _refused([without], {"made": made}, "names the surface key")
    _refused([{**ROW, "key": "schema:Detail.columns"}], {"made": made}, "no other row names a key")
    holding = {key: value for key, value in unclaimed.items() if key not in ("standing", "place")}
    _refused([{**holding, "holds": []}], {"made": made}, "names the surface key")


def test_a_row_may_name_the_declaration_its_change_is_read_under_and_a_question_place_names_its_form():
    """Contract: a row whose change leaves its base's declaration unoffered (an answer only Android keeps) names the
    one it is read under, ``{runsOnlyOn, splitDatetime}``, as a base's is written; a question's place names its
    menuName, formName and path, as ``lib/publish/hqFindings.ts`` writes one. The plausible failures: a variant
    read under its base's declaration, which the reading no longer offers, and a question place the judge compares
    with no finding's, which no reading can meet."""
    holding = {key: item for key, item in ROW.items() if key not in ("standing", "place")}
    declared = {**holding, "holds": [], "declaration": {"runsOnlyOn": "android", "splitDatetime": False}}
    path = _rows([declared])
    try:
        (variant,) = registry.load_variants(path, named={"made": made})
    finally:
        path.unlink()
    assert variant.declaration == registry.Declaration("android", False)
    _refused([{**declared, "declaration": {"runsOnlyOn": "android"}}], {"made": made}, "a declaration is")
    question = {"kind": "question", "menu": 0, "form": 0, "menuName": "Questions", "name": "Survey", "path": "a"}
    _refused([{**ROW, "place": question}], {"made": made}, "names its menuName, its formName")


def test_a_row_over_a_base_the_registry_lacks_is_refused():
    _refused([{**ROW, "base": "hq-unknown", "id": "hq-unknown/x"}], {"made": made}, "BASES lacks")


def test_a_set_json_row_names_its_pointer_and_value():
    _refused([{**ROW, "change": {"op": "set-json", "value": 1}}], {}, "no pointer")
    path = _rows([{**ROW, "change": {"op": "set-json", "pointer": "/name", "value": "x"}}])
    try:
        (variant,) = registry.load_variants(path, named={})
    finally:
        path.unlink()
    assert variant.changes() == ({"op": "set-json", "pointer": "/name", "value": "x"},)


def test_a_row_names_a_menu_or_a_form_by_position_only_where_the_lane_resolves_it():
    """Contract: a row names a menu or form of its base by position (``{"$menu": m}``, ``{"$form": [m, f]}``,
    ``{"$xmlns": [m, f]}``) in a set-json value at any depth and, for a menu or a form's xmlns, in a holds key given as
    a list, and nowhere else. The plausible failures: a misspelled reference stored as data, one in a place no code
    resolves, each read as the literal object where an id was meant, and a form's id in a key, which names no
    entity."""
    form = {"unique_id": {"$form": [0, 1]}, "case_list_form": {"form_id": {"$form": [2, 0]}}}
    value = {"op": "set-json", "pointer": "/modules/0", "value": {"root_module_id": {"$menu": 1}, "forms": [form]}}
    holding = {key: item for key, item in ROW.items() if key not in ("standing", "place")} | {
        "change": value,
        "holds": [
            {"key": ["module", {"$menu": 0}], "pointer": "/name", "value": "Visits"},
            {"key": ["field", {"$xmlns": [0, 0]}, ["age"]], "pointer": "/label", "value": "Age"},
        ],
    }
    path = _rows([{**ROW, "change": value}, {**holding, "id": "hq-plain/held"}])
    try:
        accepted = registry.load_variants(path, named={})
    finally:
        path.unlink()
    assert [variant.id for variant in accepted] == ["hq-plain/a-change", "hq-plain/held"]
    for wrong in (
        {"$form": [1]},
        {"$menu": -1},
        {"$menu": True},
        {"$menu": 1, "name": "x"},
        {"$frm": [0, 0]},
        {"$xmlns": [0]},
        {"$xmlns": [0, 0], "$menu": 0},
    ):
        _refused([{**ROW, "change": {**value, "value": {"x": [wrong]}}}], {}, "by position")
    _refused([{**ROW, "place": {"kind": "menu", "menu": {"$menu": 0}}}], {"made": made}, "a place")
    _refused(
        [{**holding, "change": ROW["change"], "holds": [{"key": ["form", {"$form": [0, 0]}], "pointer": "/x"}]}],
        {"made": made},
        "never by its id",
    )
    _refused(
        [{**holding, "holds": [{"key": "x", "pointer": "/x", "value": {"$menu": 0}}]}],
        {"made": made},
        "a holds value",
    )


def test_a_reference_is_the_id_the_app_holds_at_its_position_when_set_and_the_id_the_read_serves_when_judged():
    """Contract: ``ops.set_json`` writes the id the stored app holds at a reference's position; the lane judges a
    value served where HQ's source read holds, at each reference, the id that read serves for the same menu (whose id
    HQ keeps) or the same form (by its xmlns, since a source read gives every form a new id); a holds key is written
    as the external key's text the bundle reads. The plausible failures: a served form id written into the stored
    app, which names no form there, and a check that calls every value naming a form unserved."""
    from proof.matrix import ops, retain

    stored = {"modules": [{"unique_id": "m0", "forms": [{"unique_id": "f00", "xmlns": "x00"}]}, {"unique_id": "m1"}]}
    value = {"menu": {"$menu": 1}, "forms": [{"$form": [0, 0]}]}
    assert ops.resolve_references(value, ops.ids_at(stored)) == {"menu": "m1", "forms": ["f00"]}
    for unheld in ({"$menu": 2}, {"$form": [1, 0]}):
        try:
            ops.resolve_references(unheld, ops.ids_at(stored))
        except ops.ValueNotSet:
            pass
        else:
            raise AssertionError(f"{unheld} resolved over an app that holds nothing there")

    served = {"modules": [{"unique_id": "m1"}, {"unique_id": "m0", "forms": [{"unique_id": "s00", "xmlns": "x00"}]}]}
    resolve = retain.served_ids(stored, served)
    assert ops.resolve_references(value, resolve) == {"menu": "m1", "forms": ["s00"]}
    assert retain.holds({"menu": "m1", "forms": ["s00"]}, ops.resolve_references(value, resolve))
    # Two forms of one xmlns, or none, say nothing of which form a reference names: the value is not served.
    doubled = {"modules": [{"forms": [{"unique_id": "a", "xmlns": "x00"}, {"unique_id": "b", "xmlns": "x00"}]}]}
    assert not retain.holds("a", ops.resolve_references({"$form": [0, 0]}, retain.served_ids(stored, doubled)))
    assert retain.hold_key(["module", {"$menu": 1}], stored) == '["module","m1"]'
    assert retain.hold_key('["form","x00"]', stored) == '["form","x00"]'
    # A form's xmlns is what the stored app and the read both hold for it, wherever the read moves its id.
    assert ops.resolve_references({"$xmlns": [0, 0]}, ops.ids_at(stored)) == "x00"
    assert ops.resolve_references({"$xmlns": [0, 0]}, resolve) == "x00"
    assert retain.hold_key(["field", {"$xmlns": [0, 0]}, ["age"]], stored) == '["field","x00",["age"]]'


class _ReachesHq(Exception):
    """A change went on into HQ's own code, past which the base's retained source says nothing of its positions."""


class _Authoring:
    state = None
    base = None

    @contextlib.contextmanager
    def step(self, *_args, **_kwargs):
        yield


def _held_app_of(document):
    """``proof.hq.operations`` as a named change reads it, over ``document``: the app's JSON, and nothing else."""

    class Held:
        def to_json(self):
            return copy.deepcopy(document["doc"])

        def __getattr__(self, name):
            raise _ReachesHq(f"the held app's {name}")

    module = types.ModuleType("proof.hq.operations")
    module.held_app = lambda _state, _app_id: Held()
    return module


def _position_problems(variant, base_source, monkeypatch):
    """What ``variant`` names by position that its base, as retained, does not hold where the change is made: each
    change made in order over a copy of the base's source, a set-json's references resolved against the app as it
    stands (``ops.set_json``) and against the base (``retain.served_ids``, ``hold_key``), a named change's
    ``ops.set_json`` and ``ops.set_form_source`` positions against the app as it stands. A named change that goes
    on into HQ's own code ends what the source can say of the row's later positions."""
    from proof.matrix import ops

    document = {"doc": copy.deepcopy(base_source)}
    problems = []

    def place(pointer, value):
        try:
            ops.set_at(document["doc"], pointer, value)
        except (IndexError, ValueError) as error:
            raise ops.ValueNotSet(
                f"the pointer {pointer} names a position the app does not hold ({error!r})"
            ) from error
        except (KeyError, TypeError) as error:
            # A key HQ's source read leaves out of what it serves (``Application.export_json``): no position.
            raise _ReachesHq(f"the pointer {pointer} names a key the served source lacks") from error

    def set_json(_authoring, _app_id, pointer, value):
        place(pointer, ops.resolve_references(value, ops.ids_at(document["doc"])))

    def set_form_source(_authoring, _app_id, menu, form, _edit, **_kwargs):
        # A form's source changes its text alone, so the positions after it are the app's as it stands.
        unique_id = ops.resolve_references({ops.FORM_REFERENCE: [menu, form]}, ops.ids_at(document["doc"]))
        return document["doc"].get("_attachments", {}).get(f"{unique_id}.xml", "")

    def reaches_hq(*_args, **_kwargs):
        raise _ReachesHq("a view of HQ's")

    real_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name.split(".")[0] in ("corehq", "django"):
            raise _ReachesHq(name)
        return real_import(name, *args, **kwargs)

    import proof.hq

    with monkeypatch.context() as patched:
        patched.setattr(ops, "set_json", set_json)
        patched.setattr(ops, "set_form_source", set_form_source)
        patched.setattr(ops, "post", reaches_hq)
        patched.setattr(ops, "builder_save", reaches_hq)
        held = _held_app_of(document)
        patched.setitem(sys.modules, "proof.hq.operations", held)
        patched.setattr(proof.hq, "operations", held, raising=False)
        try:
            for hold in variant.holds:
                if not isinstance(hold["key"], str):
                    ops.resolve_references(hold["key"], ops.ids_at(base_source))
            for change in variant.changes():
                if change["op"] != "set-json":
                    patched.setattr(builtins, "__import__", guarded_import)
                    try:
                        registry.named_change(change["name"])(_Authoring(), "app")
                    finally:
                        patched.setattr(builtins, "__import__", real_import)
                    continue
                now = ops.resolve_references(change["value"], ops.ids_at(document["doc"]))
                judged = ops.resolve_references(change["value"], ops.ids_at(base_source))
                if now != judged:
                    problems.append(
                        f"its change at {change['pointer']} names a menu or form its earlier changes moved: the"
                        " position is set as the app then holds it and judged as the base holds it"
                    )
                place(change["pointer"], now)
        except ops.ValueNotSet as error:
            problems.append(str(error))
        except _ReachesHq:
            pass
    return problems


def test_every_position_a_row_names_is_one_its_base_holds_where_the_change_is_made(monkeypatch):
    """Contract: each menu or form a row names by position (a reference, a set-json pointer's index, a named change's
    form) is one its base's retained source holds where the change is made, and a set-json reference names the same
    entity there as in the base, which is where the lane judges the value served. The plausible failure: a composed
    row whose first change moves or empties a menu its second names by the base's position, which the lane meets only
    as an error at the setup of the base's every check."""
    wrong = {}
    for variant in registry.load_variants():
        source = registry.HQ_APPS / variant.base / "app-source.json"
        if not source.is_file():
            wrong[variant.id] = [f"proof/hq-apps/{variant.base}/ holds no app-source.json to read its positions in"]
            continue
        base_source = json.loads(json.loads(source.read_text(encoding="utf-8"))["body"])
        problems = _position_problems(variant, base_source, monkeypatch)
        if problems:
            wrong[variant.id] = problems
    named = "\n".join(f"{row}: {'; '.join(problems)}" for row, problems in sorted(wrong.items()))
    assert not wrong, (
        f"These rows of proof/matrix/variants.json name a menu or form their base does not hold there:\n{named}"
    )


def _advanced_menus(value, pointer):
    """Each ``AdvancedModule`` a set-json value holds, with its pointer."""
    if isinstance(value, dict):
        if value.get("doc_type") == "AdvancedModule":
            yield pointer, value
        for key, child in value.items():
            yield from _advanced_menus(child, f"{pointer}/{key}")
    elif isinstance(value, list):
        for position, child in enumerate(value):
            yield from _advanced_menus(child, f"{pointer}/{position}")


def test_every_advanced_menu_a_row_writes_holds_its_product_details():
    """Contract: an advanced menu a row writes by hand holds the product list every advanced menu HQ makes holds
    (``models/modules.py::AdvancedModule.new_module``: one ``name`` column of the product). The plausible failure: a
    menu written without one, which HQ wraps with an empty product list, a value no page of HQ's writes, read as
    ``advancedmodule-product-details-differing-from-the-default`` beside the finding the row names."""
    lacking = []
    for variant in registry.load_variants():
        for change in variant.changes():
            if change["op"] != "set-json":
                continue
            for pointer, menu in _advanced_menus(change["value"], change["pointer"]):
                if not isinstance(menu.get("product_details"), dict):
                    lacking.append(f"{variant.id} at {pointer}")
    assert not lacking, "These advanced menus of proof/matrix/variants.json hold no product_details: " + ", ".join(
        lacking
    )


def test_base_json_records_the_configuration_as_configurations_json_does():
    recorded = registry.base("hq-plain").as_json()
    assert recorded["configuration"] == {
        "flags": [],
        "namedPrivileges": ["CLOUDCARE"],
        "commcareVersion": "2.57.0",
        "commtrack": False,
        "syncCasesOnFormEntry": False,
        "caseSearchEnabled": False,
    }
    assert recorded["declaration"] == "preselected"
    assert registry.base("hq-new-app").as_json()["declaration"] == {"runsOnlyOn": None, "splitDatetime": False}


def test_every_base_has_one_id_and_names_known_entries():
    ids = [base.id for base in registry.BASES]
    assert len(ids) == len(set(ids))
    entries = set()
    for path in sorted((registry.MATRIX.parent.parent / "lib" / "commcare" / "surface" / "entries").glob("*.json")):
        if path.name != "gates.json":
            entries.update(entry["id"] for entry in json.loads(path.read_text(encoding="utf-8")))
    unknown = {base.id: sorted(set(base.exhibits) - entries) for base in registry.BASES if set(base.exhibits) - entries}
    assert not unknown, f"These bases name entries the manifest lacks: {unknown}"


def test_bases_json_names_every_base_the_registry_holds():
    # The suites that read proof/hq-apps/ outside the lane (lib/commcare/reader/__tests__/bases.retained.test.ts)
    # hold the tree to this list, so an empty or partial tree fails there rather than passing over nothing.
    named = json.loads(registry.BASES_JSON.read_text(encoding="utf-8"))
    assert named == sorted(named), "proof/matrix/bases.json lists the bases in id order."
    held = sorted(found.id for found in registry.BASES)
    assert named == held, (
        f"proof/matrix/bases.json names {named}, and proof/matrix/registry.py's BASES holds {held}. The two name the"
        " same bases: add or remove the id in bases.json with its base."
    )
