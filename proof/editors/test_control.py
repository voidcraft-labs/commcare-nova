"""The control: a page is rendered with HQ's own template gates, so its save is HQ's.

Contract: an editor page is HQ's page, gated in HQ's templates by the check's
flags, and its save is what that page's JavaScript sends. The plausible
failure is a page rendered without HQ's template gates (partials with a
hand-assembled context, a shimmed template), whose save keeps what HQ's page
would have dropped.

HQ gates the case search "Format" choice of a date at
``partials/modules/bootstrap3/case_search_property.html``: the ``date``
option is rendered only under ``CASE_SEARCH_ADVANCED``. The input is bound to
its select by Knockout's ``value`` binding (``details/case_claim.js``, whose
``_getAppearance`` maps the stored ``input_`` of ``date`` to the appearance
``date``); without the option, Knockout writes the select's own first value
back, the Case List save posts an empty appearance, and
``views/modules.py::edit_module_detail_screens`` rebuilds the search
properties without ``input_``. With the flag, the saved input stays a date.
"""

from __future__ import annotations

import pytest

from proof.editors import pages
from proof.editors.conftest import publish_hq_app, record_timing, save_section
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration


def _date_input_after_case_list_save(configuration, core_runner, editor_driver):
    with hq_check(configuration) as (state, _):
        from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty
        from corehq.apps.case_search.models import CaseSearchConfig

        # Case search on for the project space, and one module searching by a
        # single date, both through HQ's own models.
        CaseSearchConfig.objects.create(domain=state.domain, enabled=True)
        app_id = publish_hq_app(state)
        app = operations.held_app(state, app_id)
        app.modules[0].search_config = CaseSearch(
            properties=[CaseSearchProperty(name="dob", label={"en": "Date of birth"}, input_="date")]
        )
        app.save()
        module = operations.held_app(state, app_id).modules[0]
        assert module.search_config.properties[0].input_ == "date"

        saved = save_section(editor_driver, state, pages.CASE_SEARCH, app_id, module.unique_id)
        record_timing("page_save:case search", saved.seconds)
        assert saved.save.status == 200 and not saved.refused and saved.bar_state == "savebtn-bar-saved"
        (search_property,) = operations.held_app(state, app_id).modules[0].search_config.properties
        return search_property.name, search_property.input_


@pytest.mark.parametrize(
    ("flags", "kept"),
    [
        pytest.param({"CASE_SEARCH_ADVANCED"}, "date", id="CASE_SEARCH_ADVANCED on: the date input is kept"),
        pytest.param(set(), None, id="CASE_SEARCH_ADVANCED off: the date input is dropped"),
    ],
)
def test_a_case_list_save_keeps_a_date_search_input_only_under_case_search_advanced(
    hq, core_runner, editor_driver, flags, kept
):
    configuration = Configuration(privileges={"CLOUDCARE"}, flags=flags)
    assert _date_input_after_case_list_save(configuration, core_runner, editor_driver) == ("dob", kept)
