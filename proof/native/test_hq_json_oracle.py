"""Nova's private HQ-JSON oracle agrees with HQ's own model on which probes HQ cannot load.

Contract: for each partial wire probe ``hqJsonOracle.test.ts`` writes
(``NOVA_HQ_ORACLE_EVIDENCE_DIR``, at least 40), HQ's own ``Application.wrap``
with its lazy action, condition, update-mode, relationship and display
properties fails exactly when Nova's oracle reports a fatal code; a case list
form probe fails exactly when its post-form workflow is outside HQ's choices;
and a probe Nova flags for its top-level ``doc_type`` dispatches, in HQ's
``get_correct_app_class``, to ``RemoteApp``, which HQ knows and Nova's
generator never emits. The plausible failures: an enum or dispatch HQ widens
or narrows, so Nova's oracle refuses what HQ loads or passes what HQ cannot.
HQ builds these probes at CommCare 2.60.0, the check's default build: a
probe carries no build configuration of its own.
"""

import json
import traceback

from proof.native.hq_support import hq_commit, native_check, write_evidence

FAMILIES = ("hq-oracle",)
DOMAIN = "nova-hq-oracle"
FATAL_CODES = {
    "HQJSON_BAD_MODULE_DOC_TYPE",
    "HQJSON_BAD_FORM_REQUIRES",
    "HQJSON_BAD_POST_FORM_WORKFLOW",
    "HQJSON_BAD_CONDITION_TYPE",
    "HQJSON_BAD_CONDITION_OPERATOR",
    "HQJSON_BAD_UPDATE_MODE",
    "HQJSON_BAD_SUBCASE_RELATIONSHIP",
    "HQJSON_BAD_DETAIL_DISPLAY",
}
ACTIONS = [
    "open_case",
    "update_case",
    "close_case",
    "case_preload",
    "usercase_preload",
    "usercase_update",
    "load_from_form",
]


def _load(app_json):
    from corehq.apps.app_manager.models import Application

    app = Application.wrap(app_json)
    app.to_json()
    for module in app.get_modules():
        module.to_json()
        for form in module.get_forms():
            form.to_json()
            actions = form.actions
            for name in ACTIONS:
                condition = getattr(actions, name).condition
                _ = condition.type, condition.operator
            for update in actions.update_case.update.values():
                _ = update.update_mode
            for subcase in actions.subcases:
                _ = subcase.relationship, subcase.name_update.update_mode, subcase.condition.type
                _ = subcase.close_condition.type
                for update in subcase.case_properties.values():
                    _ = update.update_mode
        _ = module.case_details.short.display, module.case_details.long.display


def test_hq_loads_exactly_the_probes_novas_oracle_admits(native):
    records = json.loads((native.family("hq-oracle") / "hq-oracle-probes.json").read_text())
    assert len(records) >= 40
    results = []
    with native_check(DOMAIN, validate=native.validate_form, commcare_version="2.60.0"):
        from corehq.apps.app_manager.util import get_correct_app_class

        for record in records:
            expected = bool(FATAL_CODES.intersection(record["codes"]))
            if "HQJSON_BAD_CASE_LIST_FORM" in record["codes"]:
                expected = any(
                    module["case_list_form"].get("post_form_workflow") not in {None, "default", "case_list"}
                    for module in record["app"]["modules"]
                )
            # Top-level dispatch is its own HQ boundary: HQ knows RemoteApp,
            # though Nova's generator always emits Application.
            if "HQJSON_BAD_DOC_TYPE" in record["codes"]:
                dispatched = get_correct_app_class(record["app"]).__name__
                assert dispatched == "RemoteApp", dispatched
                results.append(
                    {"test": record["test"], "codes": record["codes"], "nativeApplicationDispatch": dispatched}
                )
                continue
            failure = None
            try:
                _load(record["app"])
            except Exception as error:
                failure = f"{type(error).__name__}: {error}"
                if not expected:
                    traceback.print_exc()
            assert bool(failure) == expected, (record["test"], record["codes"], expected, failure)
            results.append({"test": record["test"], "codes": record["codes"], "nativeWrapFailure": failure})
    write_evidence(native.family("hq-oracle"), "hq-json-oracle", {"nativeHqSha": hq_commit(), "results": results})
