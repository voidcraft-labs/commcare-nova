"""What an advanced action of CommCare HQ can express, held to HQ's own models, validator and build.

Contract: Nova places a case change on an advanced action (a load or an open
action) only where the action means what the change means, and gives the
change a Save to Case block otherwise (``lib/commcare/advancedPlacement.ts``).
Each eligibility clause is a pair of
forms in an advanced menu that differ in that clause alone
(``proof/hq/fixtures/advanced-rule-shapes.json``, which
``lib/commcare/__tests__/advancedPlacement.test.ts`` writes from the
production predicates): ``refused`` holds the shape Nova keeps from an
advanced action, ``accepted`` the twin it places on one, whose action's tag
the fixture names. Nova's export of each twin
(``proof/native/producers/emit-advanced-rule-evidence.ts``) is imported into
HQ and validated by HQ's own ``validate_app``, which reports no error for
either; the refused twin's change is the Save to Case block the fixture
names in the form's source, and the accepted twin's is the action it names.
Then the shape Nova avoids is built with HQ's own models, from the accepted
export with the clause changed on that action, and HQ treats it as the
clause's row says:

- ``validator``: ``validate_app`` reports the row's error for the form
  (``helpers/validators.py``: ``path error`` from ``check_paths``,
  ``update_case word illegal`` and ``update_case uses reserved word`` from
  ``check_case_properties``, ``missing parent tag`` and ``subcase repeat
  context`` from ``AdvancedFormValidator.check_actions``);
- ``build``: HQ's case builder raises building the form
  (``xform.py::XForm._create_casexml_advanced``, ``check_case_type``);
- ``shared-block``: HQ's build writes two open actions' blocks at one path
  (``xform.py::get_action_path``, which nests a block under ``case_<tag>``
  only where two indexed open actions share the repeat);
- ``renamed-datum``: in a child menu HQ's entry gives the load another datum
  id (``suite_xml/sections/entries.py::EntriesHelper.add_parent_datums``)
  than the ``case_id_<tag>`` the open action's index reads;
- ``no-slot``: HQ's model holds no property the change would need, so no
  advanced action states it (the model's own property list);
- ``editor``: only HQ's advanced Case Management page refuses it, which the
  manifest check holds by the value class the row names
  (``proof/checks/manifest_value_classes.py::VALUE_CLASSES``);
- ``runtime``: HQ builds it, and what it does wrong is what a runtime does
  with the form; a document that held it would show it in proof 3, so only
  Nova's two exports are held here.

The plausible failures: a clause Nova keeps that HQ's action expresses, which
the accepted twin's HQ export shows as an error or a missing action; a clause
Nova drops that HQ refuses, which the avoided shape shows passing HQ's
validator and build; and a row whose HQ side no longer holds at the pin.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from lxml import etree

from proof.hq.conftest import timed
from proof.native import produce
from proof.native.families import FAMILIES

FAMILY = "advanced-rules"
SHAPES = Path(__file__).resolve().parent / "fixtures" / "advanced-rule-shapes.json"
DOMAIN = "nova-advanced-rules"
# A Save to Case block needs the save_to_case plan privilege, a child case child_cases and the worker's record
# user_case (helpers/validators.py::ApplicationValidator._check_subscription).
PRIVILEGES = {"VELLUM_SAVE_TO_CASE", "CHILD_CASES", "USERCASE"}
FORM_NAME = "Under test"
XFORMS = "http://www.w3.org/2002/xforms"
# A path no question of the fixture's form holds, as HQ's actions name a question by its path.
NOT_A_QUESTION = "/data/nova_not_a_question"


def _set_path(action, path):
    """Every question path an action names, set to ``path``: its case properties and, on an open action, its
    name."""
    for update in (action.get("case_properties") or {}).values():
        update["question_path"] = path
    if isinstance(action.get("name_update"), dict):
        action["name_update"]["question_path"] = path


def _add_property(key):
    def change(app, action):
        action.setdefault("case_properties", {})[key] = {
            "doc_type": "ConditionalCaseUpdate",
            "question_path": "/data/age",
        }

    return change


def _owner_not_a_question(app, action):
    action.setdefault("case_properties", {})["owner_id"] = {
        "doc_type": "ConditionalCaseUpdate",
        "question_path": "/data/meta/userID",
    }


def _value_not_a_question(app, action):
    _set_path(action, NOT_A_QUESTION)


def _missing_parent(app, action):
    if "case_indices" in action:
        action["case_indices"] = [{**index, "tag": "nova_no_such_action"} for index in action["case_indices"]]
    else:
        action["case_index"] = {
            **(action.get("case_index") or {}),
            "doc_type": "CaseIndex",
            "tag": "nova_no_such_action",
        }


def _unknown_type(app, action):
    action["case_type"] = "pet"


def _unindexed_in_repeat(app, action):
    for other in _form(app)["actions"]["open_cases"]:
        if other.get("repeat_context") == action.get("repeat_context"):
            other["case_indices"] = []


def _nested(app, action):
    """The form's menu made a child of the first menu, as the refused twin's is."""
    form_module = next(module for module in app["modules"] if _form(app) in module.get("forms", []))
    form_module["root_module_id"] = app["modules"][0]["unique_id"]


# Each row's HQ side, by (action, clause): its kind and, where HQ's models build the avoided shape, the change of
# the accepted twin's action and what HQ answers.
HQ_SIDE = {
    ("load", "scope"): ("no-slot", "LoadUpdateAction", "repeat_context"),
    ("load", "value-not-a-question"): ("validator", _value_not_a_question, "path error"),
    ("load", "write-condition"): ("no-slot", "ConditionalCaseUpdate", "condition"),
    ("load", "condition-not-stateable"): ("runtime", "xform.py::XForm.action_relevance"),
    ("load", "owner"): ("validator", _owner_not_a_question, "path error"),
    ("load", "retype"): ("validator", _add_property("case_type"), "update_case uses reserved word"),
    ("load", "link-target"): ("validator", _missing_parent, "missing parent tag"),
    ("open", "keyed"): ("no-slot", "AdvancedOpenCaseAction", "case_id"),
    ("open", "value-not-a-question"): ("validator", _value_not_a_question, "path error"),
    ("open", "name-repeat"): (
        "editor",
        "forms-and-case-writes/advancedopencaseaction-repeat-context-other-than-the-name",
    ),
    ("open", "write-condition"): ("no-slot", "ConditionalCaseUpdate", "condition"),
    ("open", "condition-not-stateable"): ("runtime", "xform.py::XForm.action_relevance"),
    ("open", "owner"): ("validator", _owner_not_a_question, "path error"),
    ("open", "link-target"): ("validator", _missing_parent, "missing parent tag"),
    ("open", "link-renamed-load"): ("renamed-datum", _nested),
    ("open", "repeat-shared"): ("shared-block", _unindexed_in_repeat),
    ("open", "type-not-a-menu"): ("build", _unknown_type),
    ("open", "case-changed-before-create"): ("no-slot", "LoadUpdateAction", "case_id"),
}


def _rows():
    return json.loads(SHAPES.read_text(encoding="utf-8"))["rows"]


def _row_id(index_row):
    index, row = index_row
    return f"{index}-{row['action']}-{row['clause']}"


ROWS = list(enumerate(_rows()))


def test_every_hq_side_is_a_clause_the_fixture_holds():
    """An HQ side names a clause the fixture writes a pair of twins for. A clause the gate refuses outright has
    no accepted twin, so the fixture lists it under ``unreachable`` with the finding that refuses it, and it has
    no HQ side here: the gate's own tests hold that refusal. The plausible failure: a clause dropped from Nova's
    predicates whose HQ side stays here, read as evidence for a rule Nova no longer has."""
    clauses = {(row["action"], row["clause"]) for _, row in ROWS}
    unreachable = {
        (entry["action"], entry["clause"]) for entry in json.loads(SHAPES.read_text(encoding="utf-8"))["unreachable"]
    }
    assert set(HQ_SIDE) == clauses, (sorted(set(HQ_SIDE) - clauses), sorted(clauses - set(HQ_SIDE)))
    assert not clauses & unreachable, sorted(clauses & unreachable)


@pytest.fixture(scope="module")
def exports(tmp_path_factory):
    """Nova's export of each twin, ``<row>-refused.json`` and ``<row>-accepted.json``, read from the products the
    lane's corpus carries, or produced here when it carries none."""
    root = tmp_path_factory.mktemp(FAMILY)
    log = root.parent / f"{FAMILY}.log"
    products = produce.produced_directory()
    with timed("advanced_rule_exports"):
        if products is not None:
            failure = produce.read_product(products, FAMILY, root, log)
        else:
            _, failure = produce.produce_family(FAMILIES[FAMILY], root, log)
    output = log.read_text(errors="replace")[-4000:] if log.is_file() else ""
    assert failure is None, (
        f"Nova's exports of the advanced rule shapes {failure}. Their output ({log}) ends:\n{output}"
    )
    assert (root / "shapes.json").read_text(encoding="utf-8") == SHAPES.read_text(encoding="utf-8"), (
        "The advanced rule exports were made from another advanced-rule-shapes.json than this checkout's."
    )
    return root


def _form(app):
    """The form under test: the one form whose name is the fixture's."""
    (form,) = [
        form for module in app["modules"] for form in module.get("forms", []) if form["name"].get("en") == FORM_NAME
    ]
    return form


def _actions(app):
    actions = _form(app).get("actions") or {}
    return [*(actions.get("load_update_cases") or []), *(actions.get("open_cases") or [])]


def _action(app, tag):
    found = [action for action in _actions(app) if action.get("case_tag") == tag]
    assert len(found) == 1, (tag, [action.get("case_tag") for action in _actions(app)])
    return found[0]


def _source(app):
    """The form under test's XForm source, as Nova's import body carries it."""
    return etree.fromstring(app["_attachments"][f"{_form(app)['unique_id']}.xml"].encode())


def _holds_block(app, path):
    """Whether the form's source holds the Save to Case block at ``path`` (its steps below the data node, at any
    depth, as a block in a repeat sits inside the repeat)."""
    (data,) = _source(app).xpath("//x:model/x:instance[not(@src)]/*", namespaces={"x": XFORMS})
    for start in data.iter():
        node = start
        for step in path:
            node = next((child for child in node if etree.QName(child).localname == step), None)
            if node is None:
                break
        if node is not None:
            return True
    return False


def _imported(app):
    from proof.native.hq_support import import_source

    imported = import_source(json.dumps(app).encode(), DOMAIN)
    imported._id = f"{DOMAIN}-app"
    return imported


def _validation(app):
    """HQ's ``validate_app`` errors for an app body."""
    from proof.hq.seams import build_seams

    with build_seams():
        return list(_imported(app).validate_app())


def _hq_form(imported):
    (form,) = [
        form for module in imported.get_modules() for form in module.get_forms() if form.name.get("en") == FORM_NAME
    ]
    return form


def _check():
    from proof.native.hq_support import native_check

    return native_check(DOMAIN, privileges=PRIVILEGES)


@pytest.mark.parametrize("index_row", ROWS, ids=_row_id)
def test_nova_exports_each_twin_as_hq_builds_it_and_hq_refuses_the_shape_nova_avoids(
    hq, core_runner, exports, index_row
):
    index, row = index_row
    key = (row["action"], row["clause"])
    assert key in HQ_SIDE, f"The advanced rule {key} has no HQ side here; add it to HQ_SIDE with its source."
    refused = json.loads((exports / f"{index}-refused.json").read_text())
    accepted = json.loads((exports / f"{index}-accepted.json").read_text())
    tag = row["accepted"]["placement"]["tag"]
    block = row["refused"]["placement"]
    assert row["accepted"]["placement"]["kind"] == "advanced" and block["kind"] == "save-to-case", row
    # The refused twin's change is its Save to Case block; the accepted twin's, its advanced action.
    assert _holds_block(refused, block["path"]), (key, block["path"])
    assert not _holds_block(accepted, block["path"]), (key, block["path"])
    _action(accepted, tag)
    kind, *side = HQ_SIDE[key]
    with _check():
        assert _validation(refused) == [], key
        assert _validation(accepted) == [], key
        if kind == "no-slot":
            cls, slot = side
            from corehq.apps.app_manager.models import form_actions

            assert slot not in getattr(form_actions, cls).properties(), (key, cls, slot)
        elif kind == "editor":
            from proof.checks.manifest_value_classes import VALUE_CLASSES

            assert side[0] in VALUE_CLASSES, (key, side[0])
        elif kind == "runtime":
            pass
        else:
            avoided = copy.deepcopy(accepted)
            change = side[0]
            change(avoided, _action(avoided, tag))
            _holds_avoided(kind, side, avoided, tag, key)


def _holds_avoided(kind, side, avoided, tag, key):
    if kind == "validator":
        types = [error.get("type") for error in _validation(avoided)]
        assert side[1] in types, (key, types)
        return
    imported = _imported(avoided)
    form = _hq_form(imported)
    if kind == "build":
        from corehq.apps.app_manager.exceptions import CaseError
        from corehq.apps.app_manager.xform import XForm

        with pytest.raises(CaseError):
            XForm(form.source, domain=DOMAIN).add_case_and_meta_advanced(form)
    elif kind == "shared-block":
        from corehq.apps.app_manager.xform import XForm

        xform = XForm(form.source, domain=DOMAIN)
        xform.add_case_and_meta_advanced(form)
        tree = etree.fromstring(etree.tostring(xform.xml))
        sharing = [
            action
            for action in form.actions.open_cases
            if action.repeat_context == _action(avoided, tag)["repeat_context"]
        ]
        names = {
            bind.get("nodeset")
            for bind in tree.xpath("//x:model/x:bind", namespaces={"x": XFORMS})
            if bind.get("nodeset", "").endswith("/case/create/case_name")
            and bind.get("nodeset", "").startswith(sharing[0].repeat_context + "/")
        }
        assert len(sharing) > 1 and len(names) < len(sharing), (key, names)
    elif kind == "renamed-datum":
        from corehq.apps.app_manager.suite_xml.sections.entries import EntriesHelper

        module = form.get_module()
        datums, _ = EntriesHelper(imported).get_datum_meta_assertions_advanced(module, form)
        indexed = {index.tag for action in form.actions.open_cases for index in action.case_indices}
        loads = [action for action in form.actions.load_update_cases if action.case_tag in indexed]
        ids = {meta.action.case_tag: meta.datum.id for meta in datums if meta.action is not None}
        assert loads and any(ids.get(load.case_tag) != load.case_session_var for load in loads), (key, ids)
    else:
        raise AssertionError(f"{key} names the HQ side {kind}, which this test does not build.")
