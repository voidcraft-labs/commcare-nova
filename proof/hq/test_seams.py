"""A seam changes only what it names, and only while its test holds it open.

Contract: the flag seam answers each read from the configuration and records
it, the configuration's flags change only those flags' answers, and nothing
of a seam outlives its context. The plausible failures: a patch left in place
after a check (so the next check builds under the last one's flags), a flag
answered on outside the configuration, and a read the recorder misses because
HQ answers it before ``toggle_enabled`` (a namespace the toggle does not
carry).
"""

from __future__ import annotations

import pytest

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.hq.seams import build_seams

PLAIN = Configuration(privileges={"CLOUDCARE"})
WITH_ENDPOINTS = Configuration(privileges={"CLOUDCARE"}, flags={"SESSION_ENDPOINTS"})


def _build_reads(configuration, core_runner):
    with hq_check(configuration, validate=core_runner.validate_form) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
        start = len(record.flags)
        with build_seams():
            operations.build(operations.held_app(state, app_id), record)
    return [(r.symbol, r.item, r.namespace, r.via, r.verdict) for r in record.flags[start:]]


def _originals():
    import corehq.toggles as toggles
    import corehq.toggles.shortcuts as shortcuts
    from corehq.apps.accounting import utils as accounting_utils
    from corehq.apps.app_manager.models import ApplicationBase

    return {
        "StaticToggle.enabled": toggles.StaticToggle.__dict__["enabled"],
        "StaticToggle.enabled_for_request": toggles.StaticToggle.__dict__["enabled_for_request"],
        "PredictablyRandomToggle.enabled": toggles.PredictablyRandomToggle.__dict__["enabled"],
        "toggles.toggle_enabled": toggles.toggle_enabled,
        "shortcuts.toggle_enabled": shortcuts.toggle_enabled,
        "domain_has_privilege": accounting_utils.domain_has_privilege,
        "_get_version_comparison_build": ApplicationBase.__dict__["_get_version_comparison_build"],
    }


def test_two_checks_in_sequence_differ_only_in_the_flag_the_configuration_names(hq, core_runner):
    originals = _originals()

    plain = _build_reads(PLAIN, core_runner)
    with_endpoints = _build_reads(WITH_ENDPOINTS, core_runner)
    plain_again = _build_reads(PLAIN, core_runner)

    assert plain, "HQ's build read no flags, so the comparison proves nothing"
    assert plain_again == plain  # nothing of the second check leaked into the third
    assert not any(verdict for *_, verdict in plain)
    named = [read for read in with_endpoints if read[0] == "SESSION_ENDPOINTS"]
    assert named and all(verdict for *_, verdict in named)
    assert not any(verdict for symbol, *_, verdict in with_endpoints if symbol != "SESSION_ENDPOINTS")

    assert _originals() == originals  # every patch is gone once its check ends


def test_a_read_hq_answers_before_toggle_enabled_is_recorded(hq, core_runner):
    import corehq.toggles as toggles

    configuration = Configuration(flags={"SESSION_ENDPOINTS"})
    with hq_check(configuration, validate=core_runner.validate_form) as (_, record):
        # SESSION_ENDPOINTS is a domain flag: HQ answers a read in the user
        # namespace False before it reaches toggle_enabled.
        assert toggles.SESSION_ENDPOINTS.enabled(configuration.domain, toggles.NAMESPACE_DOMAIN) is True
        assert toggles.SESSION_ENDPOINTS.enabled("someone@example.com", toggles.NAMESPACE_USER) is False
    assert [(r.symbol, r.namespace, r.verdict) for r in record.flags] == [
        ("SESSION_ENDPOINTS", "domain", True),
        ("SESSION_ENDPOINTS", "user", False),
    ]


def test_the_project_space_seams_reach_every_reader_hq_consults(hq, core_runner):
    """CommTrack is read from the app (``Application.commtrack_enabled``, which
    HQ answers False under tests) and from the project itself
    (``util.py::get_settings_values`` reads ``Domain.commtrack_enabled``);
    sync-on-form-entry is read by the suite's entries. Each reader follows
    its own setting, whatever the other is."""
    from corehq.apps.app_manager.suite_xml.sections import entries
    from corehq.apps.domain.models import Domain

    settings = [(False, False), (True, False), (False, True), (True, True)]
    seen = {}
    for commtrack, sync in settings:
        configuration = Configuration(commtrack=commtrack, sync_cases_on_form_entry=sync, case_search_enabled=sync)
        with hq_check(configuration, validate=core_runner.validate_form) as (state, _):
            app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
            seen[commtrack, sync] = (
                operations.held_app(state, app_id).commtrack_enabled,
                Domain.get_by_name(state.domain).commtrack_enabled,
                entries.case_search_sync_cases_on_form_entry_enabled_for_domain(state.domain),
            )
    assert seen == {(commtrack, sync): (commtrack, commtrack, sync) for commtrack, sync in settings}


def test_a_flag_seam_opened_inside_another_refuses_toggle_enabled_and_reads_no_module_again(
    hq, core_runner, monkeypatch
):
    """A sensitivity flip opens the flag seam inside the unit's: ``toggle_enabled`` stays refused throughout, the
    inner seam reads only the modules imported since HQ's function was last scanned for (on entering, and those
    imported inside it again on leaving), and once both close every binding is HQ's own again. Rebinding the
    outer seam's refusal instead would scan every module afresh for a function no module bound at import."""
    import corehq.toggles.shortcuts as shortcuts

    from proof.hq import seams
    from proof.hq.seams import _BINDINGS, _MODULES, SeamRecord, SeamRefused, flags

    read = []
    real_scan = seams._Bindings.scan

    def scan(self, *values, start=None):
        namespaces = real_scan(self, *values, start=start)
        read.append(len(namespaces))
        return namespaces

    monkeypatch.setattr(seams._Bindings, "scan", scan)
    hq_function = shortcuts.toggle_enabled
    with hq_check(PLAIN, validate=core_runner.validate_form):
        outer = shortcuts.toggle_enabled
        assert outer is not hq_function
        _MODULES.sync()
        scanned = _BINDINGS[hq_function].read
        read.clear()
        with flags(WITH_ENDPOINTS, SeamRecord()):
            assert shortcuts.toggle_enabled is outer
            with pytest.raises(SeamRefused, match="through toggle_enabled"):
                shortcuts.toggle_enabled("session-endpoints", "x")
        imported = len(_MODULES.seen) - scanned
        # Each of the inner seam's two scans read at most the modules imported since the last scan: none of the
        # thousands HQ had imported before.
        assert read and sum(read) <= 2 * imported < len(_MODULES.seen) // 2
        assert outer not in _BINDINGS
        assert shortcuts.toggle_enabled is outer
    assert shortcuts.toggle_enabled is hq_function
