"""HQ validates the retained case-list column shapes on the build path."""

from copy import deepcopy

from proof.hq.seams import build_seams
from proof.matrix.registry import load_variants
from proof.rules.conftest import edited, published


def test_native_case_list_validation_refuses_the_exact_retained_column_variants(hq, documents):
    ids = {
        "hq-case-lists/clickable-icon-without-endpoint",
        "hq-case-lists/two-address-columns",
    }
    variants = {variant.id: variant.change for variant in load_variants() if variant.id in ids}
    assert variants.keys() == ids

    def check(app, change, error_type, reason, repair):
        assert change["pointer"] == "/modules/0/case_details/short/columns"
        for repaired in (False, True):
            def configure(body):
                menu = body["modules"][0]
                columns = deepcopy(change["value"])
                if repaired:
                    repair(menu, columns)
                menu["case_details"]["short"]["columns"] = columns

            with app.unit.fork(), build_seams():
                app._write(edited(configure))
                errors = [str(error.get("reason", "")) for error in app._app().validate_app()
                          if error["type"] == error_type]
                if repaired:
                    assert errors == []
                else:
                    assert len(errors) == 1 and reason in errors[0]

    def set_icon_endpoint(menu, columns):
        menu["forms"][0]["session_endpoint_id"] = "visit_from_list"
        columns[-1]["endpoint_action_id"] = "visit_from_list"

    def keep_one_address(_menu, columns):
        columns[-1]["format"] = "plain"

    with published(documents["case-list-inline"], None, configuration="maximum") as app:
        check(
            app, variants["hq-case-lists/clickable-icon-without-endpoint"],
            "invalid clickable icon configuration", "Clickable Icons require a form", set_icon_endpoint,
        )
        check(
            app, variants["hq-case-lists/two-address-columns"],
            "invalid tile configuration", 'multiple properties: "address", "work_address"', keep_one_address,
        )
