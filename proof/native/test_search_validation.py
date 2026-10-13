"""HQ's own validators refuse exactly the search shapes Nova's search-first rules refuse.

Contract: over Nova's admitted search exports, each HQ validator method
Nova's four search-first refusals mirror (``helpers/validators.py``) returns
no error for the admitted shape and exactly the named error once the model
is mutated into the paired counterexample: a previous-screen workflow after
inline case loading (``workflow previous inline search``), a submenu or a
parent selection under inline search that duplicates HQ's result instance
name (``non-unique instance name with parent module`` / ``with parent select
module``), and a case list form that is not a registration of the host's
case type or does not exist (``case list form not registration`` / ``case
list form missing``). The plausible failure: HQ relaxing or tightening one of
these rules, so Nova's refusal is stale or missing (``searchFirst.ts``).
"""

from pathlib import Path

from proof.native.hq_support import native_check, sha256, write_evidence

FAMILIES = ("search",)
DOMAIN = "nova-search-validation"
HQ_SOURCES = [
    "corehq/apps/app_manager/helpers/validators.py",
    "corehq/apps/app_manager/views/modules.py",
    "corehq/apps/app_manager/util.py",
    "corehq/apps/app_manager/models/case_search.py",
]


def _codes(errors):
    return [error["type"] for error in errors]


def test_hq_validators_refuse_the_paired_counterexamples(native):
    from proof.hq.boot import HQ_ROOT
    from proof.native.hq_support import import_source

    exports = native.family("search")

    def load(scenario):
        app = import_source((exports / (scenario + ".json")).read_bytes(), DOMAIN)
        app._id = "native-search-validation"
        return app

    results = []
    with native_check(DOMAIN):
        from corehq.apps.app_manager.const import WORKFLOW_PREVIOUS
        from corehq.apps.app_manager.helpers.validators import FormBaseValidator, ModuleBaseValidator

        app = load("inline")
        module = app.get_module(0)
        form = module.get_form(0)
        assert _codes(FormBaseValidator(form).validate_for_module(module)) == []
        form.post_form_workflow = WORKFLOW_PREVIOUS
        assert _codes(FormBaseValidator(form).validate_for_module(module)) == ["workflow previous inline search"]
        module.search_config.inline_search = False
        assert _codes(FormBaseValidator(form).validate_for_module(module)) == []
        results.append("previous workflow rejected only with inline case loading")

        app = load("registration-link")
        parent = app.get_module(0)
        child = app.get_module(1)
        assert _codes(ModuleBaseValidator(child).validate_search_config()) == []
        child.root_module_id = parent.unique_id
        assert _codes(ModuleBaseValidator(child).validate_search_config()) == [
            "non-unique instance name with parent module"
        ]
        parent.search_config.inline_search = False
        assert _codes(ModuleBaseValidator(child).validate_search_config()) == []
        results.append("submenu under inline Search duplicates actual native result-instance names")

        app = load("parent")
        child = app.get_module(0)
        parent = app.get_module(1)
        assert _codes(ModuleBaseValidator(child).validate_parent_select()) == []
        parent.search_config.inline_search = True
        parent.search_config.auto_launch = True
        parent.search_config.properties = child.search_config.properties
        assert _codes(ModuleBaseValidator(child).validate_parent_select()) == [
            "non-unique instance name with parent select module"
        ]
        results.append("parent selection from inline Search duplicates actual native result-instance names")

        # FOLLOWUP_FORMS_AS_CASE_LIST_FORM is off, as every flag the check does not name.
        app = load("registration-link")
        host = app.get_module(0)
        registration = app.get_module(1).get_form(0)
        host.case_list_form.form_id = registration.unique_id
        assert _codes(ModuleBaseValidator(host).validate_case_list_form()) == []
        host.case_list_form.form_id = host.get_form(0).unique_id
        assert _codes(ModuleBaseValidator(host).validate_case_list_form()) == ["case list form not registration"]
        host.case_list_form.form_id = "missing-native-form"
        assert _codes(ModuleBaseValidator(host).validate_case_list_form()) == ["case list form missing"]
        results.append("case-list form must resolve to a registration of the host case type with default capability")

    sources = [Path(HQ_ROOT) / path for path in HQ_SOURCES] + [Path(__file__)]
    write_evidence(
        exports,
        "search-validation",
        {
            "checks": results,
            "sourceSha256": {str(path): sha256(path.read_bytes()) for path in sources},
            "artifacts": {
                name: sha256((exports / (name + ".json")).read_bytes())
                for name in ["inline", "parent", "registration-link"]
            },
            "limits": "Actual HQ Application import and selected validator methods. Native models mutated for paired "
            "wire counterexamples; no whole-build acceptance claim. Every flag off; no network or writes.",
        },
    )
