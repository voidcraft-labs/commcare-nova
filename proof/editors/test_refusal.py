"""A save HQ's view refuses is reported as HQ's refusal, and a page left unsaved; so is a save the page refuses.

Contract: when HQ's save view refuses what the page sends, the run returns
HQ's answer and the page's own verdict (its Save button offers "Try Again"),
and HQ's state keeps what it had. The plausible failures: a refusal read as
a success (the run only waiting for a response, whatever it said), and a
refusal the harness itself causes read as HQ's.

``views/modules.py::_gather_and_update_search_properties`` checks the case
search's display condition with HQ's XPath validator
(``xpath_validator/wrapper.py::validate_xpath``, node and js-xpath) and
answers 400 when it does not parse. The same module with a condition that
parses saves.
"""

from __future__ import annotations

import pytest

from proof.editors import pages
from proof.editors.conftest import publish_hq_app, record_timing, save_section
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})


@pytest.mark.parametrize(
    ("condition", "refused"),
    [
        pytest.param("count(instance('casedb')/casedb/case) > 0", False, id="a condition that parses saves"),
        pytest.param("count(", True, id="a condition that does not parse is refused"),
    ],
)
def test_a_save_hqs_view_refuses_is_reported_as_refused(hq, core_runner, editor_driver, condition, refused):
    with hq_check(CONFIGURATION) as (state, _):
        from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty
        from corehq.apps.case_search.models import CaseSearchConfig

        CaseSearchConfig.objects.create(domain=state.domain, enabled=True)
        app_id = publish_hq_app(state)
        app = operations.held_app(state, app_id)
        app.modules[0].search_config = CaseSearch(
            properties=[CaseSearchProperty(name="name", label={"en": "Name"})],
            search_button_display_condition=condition,
        )
        app.save()
        module = operations.held_app(state, app_id).modules[0]
        version = operations.held_app(state, app_id).version

        saved = save_section(editor_driver, state, pages.CASE_SEARCH, app_id, module.unique_id)
        record_timing("page_save:case search", saved.seconds)
        held = operations.held_app(state, app_id)

    assert saved.save.url_name == "edit_module_detail_screens"
    if refused:
        assert saved.refused and saved.save.status == 400
        assert b"Please fix the errors in xpath expression 'count('" in saved.save.response
        assert saved.bar_state == "savebtn-bar-retry"
        assert held.version == version  # HQ saved nothing
    else:
        assert not saved.refused and saved.save.status == 200
        assert saved.bar_state == "savebtn-bar-saved"
        assert held.version > version
    assert held.modules[0].search_config.search_button_display_condition == condition


@pytest.mark.parametrize(
    ("default", "unsent"),
    [
        pytest.param("owner_id", False, id="a default filter on another property saves"),
        pytest.param("region", True, id="a default filter on a search property is refused by the page"),
    ],
)
def test_a_save_the_page_refuses_with_a_dialog_is_reported_unsent(hq, core_runner, editor_driver, default, unsent):
    """A page may answer Save with a dialog and send nothing: HQ's Case List page refuses a search property that
    shares a default filter's name (``details/case_claim.js::commonProperties``) with an alert from its save
    (``details/bootstrap3/screen.js::save``). The run reports that dialog as the section's refusal, never a save
    it waits for until its deadline, from the view's one load and from a fresh page alike, and HQ keeps what it had.
    The same search with its default filter on another property saves."""
    with hq_check(CONFIGURATION) as (state, _):
        from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty, DefaultCaseSearchProperty
        from corehq.apps.case_search.models import CaseSearchConfig

        CaseSearchConfig.objects.create(domain=state.domain, enabled=True)
        app_id = publish_hq_app(state)
        app = operations.held_app(state, app_id)
        app.modules[0].search_config = CaseSearch(
            properties=[CaseSearchProperty(name="region", label={"en": "Region"})],
            default_properties=[DefaultCaseSearchProperty(property=default, defaultValue="'north'")],
        )
        app.save()
        module = operations.held_app(state, app_id).modules[0]
        version = operations.held_app(state, app_id).version

        held = save_section(editor_driver, state, pages.CASE_SEARCH, app_id, module.unique_id)
        record_timing("page_save:case search", held.seconds)
        fresh = pages.fresh_section_save(editor_driver, state, pages.CASE_SEARCH, app_id, module.unique_id)
        saved_version = operations.held_app(state, app_id).version

    for saved in (held, fresh):
        if unsent:
            assert saved.save is None and saved.unsent["type"] == "alert", saved.unsent
            assert "can't have common properties" in saved.unsent["message"], saved.unsent
            assert saved.bar_state == "savebtn-bar-save"
        else:
            assert saved.unsent is None and saved.save.status == 200
    if unsent:
        # Neither page sent anything, so both saved over the same state.
        assert pages.section_differences(held, fresh) == []
    assert (saved_version == version) == unsent
