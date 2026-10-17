"""The plan privileges Nova's publish asks a person to confirm: HQ's own plan lists, and what HQ does without each.

Contract: no API key reads a project space's plan, so Nova's publish asks the
person to confirm each plan privilege an app needs
(``lib/commcare/planPrivileges.ts::requiredPlanPrivileges``), naming the
current plans that carry it from ``lib/commcare/planPrivilegePlans.json``
under the label HQ's subscription page shows for it. That file is HQ's own
plan lists (``accounting/bootstrap/features.py``), and each label HQ's own
name for the privilege where HQ has one (``privileges.py::Titles``). The
plausible failures: a plan list that moved at a pin (then Nova names the
wrong plans), and a privilege Nova asks about whose absence changes nothing
HQ does (then the question guards nothing).

What HQ does without each privilege this package can run on an app alone,
each beside the same app with the privilege granted, the accepted case:

- ``user_case`` on ``case-worker-followup``, whose form saves to the
  worker's record: HQ's build answers a ``subscription`` error
  (``helpers/validators.py::ApplicationValidator._check_subscription``), and
  HQ makes no record for a worker
  (``callcenter/sync_usercase.py::_iter_sync_usercase_helpers``), so a form
  that only reads the record, as ``worker-district-code``'s do, reads blank;
- ``lookup_tables`` on ``lookup-app``: HQ's build answers that lookup tables
  are not in the subscription
  (``ApplicationBaseValidator._validate_fixtures``), and the workbook Nova
  pushes is answered with HQ's Upgrade Required page, status 200, and makes
  no table (``fixtures/dispatcher.py::require_can_edit_fixtures``);
- ``locations`` on ``location-direct``: HQ sends no flat location list to a
  worker under any setting (``locations/fixtures.py::should_sync_flat_fixture``,
  over ``Domain.uses_locations``), and its locations API answers 403
  (``locations/resources/v0_5.py::BaseLocationsResource.dispatch``).

The privileges whose absence HQ's pages and Vellum show (child cases, form
links, Save to Case, and Vellum's lookup table check) are
``proof/editors/test_plan_features.py``'s. What Core does with a form whose
places are not sent is held by proof 3 on ``location-direct``.
"""

from __future__ import annotations

import dataclasses
import json
from contextlib import contextmanager
from pathlib import Path

from proof.hq import operations
from proof.hq.check import hq_check

PLAN_PRIVILEGE_PLANS = Path(__file__).resolve().parents[2] / "lib" / "commcare" / "planPrivilegePlans.json"
# The label Nova shows for each plan privilege (``lib/publish/planFeatures.ts::PLAN_FEATURES``, through
# ``lib/commcare/planPrivileges.ts::PLAN_FEATURE_FOR_PRIVILEGE``), by HQ's slug. HQ's ``Titles`` names no
# ``user_case``, so Nova's own label stands there.
NOVA_LABELS = {
    "user_case": "Worker records (user cases)",
    "lookup_tables": "Lookup Tables",
    "child_cases": "Child Cases",
    "form_link_workflow": "Link to other forms in End of Form Navigation",
    "save_to_case": "Save to Case",
    "locations": "Locations",
    "data_forwarding": "Data Forwarding",
}


def _plan_lists():
    """Every plan list ``accounting/bootstrap/features.py`` defines, by name, in the file's order: each a list of
    privilege slugs."""
    from corehq.apps.accounting.bootstrap import features

    return {
        name: list(value)
        for name, value in vars(features).items()
        if isinstance(value, list) and not name.startswith("_") and name != "paused_v0"
    }


def test_the_plans_nova_names_are_hqs_own_lists_and_its_labels_hqs_names(hq):
    from corehq.privileges import Titles

    lists = _plan_lists()
    held = json.loads(PLAN_PRIVILEGE_PLANS.read_text(encoding="utf-8"))
    assert held == {slug: [name for name, slugs in lists.items() if slug in slugs] for slug in held}
    assert sorted(held) == sorted(NOVA_LABELS)
    for slug, label in NOVA_LABELS.items():
        named = str(Titles.get_name_from_privilege(slug))
        # HQ answers a privilege it has no name for with its slug.
        assert named == (slug if slug == "user_case" else label), slug


# What every request Nova's client sends with an API key needs of the plan (``api/resources/auth``), which Nova
# observes as the answer to its first read rather than asking about it.
API_ACCESS = "API_ACCESS"


def _without(configuration, privilege):
    return dataclasses.replace(configuration, privileges=frozenset(configuration.privileges - {privilege}))


def _with_api_access(configuration):
    return dataclasses.replace(configuration, privileges=frozenset(configuration.privileges | {API_ACCESS}))


@contextmanager
def _published(document, privilege, granted):
    """``document`` as Nova's first publish leaves it, on a plan with ``privilege`` or without it."""
    from proof.observe import publish

    export = document.exports["minimum"]
    configuration = _with_api_access(export.configuration.hq())
    assert privilege in configuration.privileges, (document.id, sorted(configuration.privileges))
    with hq_check(configuration if granted else _without(configuration, privilege)) as (state, record):
        app_id, refusal, lookups = publish.create(state, export)
        assert refusal is None, refusal
        yield state, record, app_id, export, lookups


def _validation_types(state, app_id):
    from proof.hq.seams import build_seams

    with build_seams():
        return [error["type"] for error in operations.held_app(state, app_id).validate_app()]


def test_a_form_that_saves_to_the_worker_record_builds_and_makes_the_record_only_with_user_case(
    hq, core_runner, documents
):
    from corehq.apps.callcenter.sync_usercase import _iter_sync_usercase_helpers

    found = {}
    for granted in (True, False):
        with _published(documents["case-worker-followup"], "USERCASE", granted) as (state, _, app_id, _, _):
            from corehq.apps.users.models import CommCareUser

            worker = CommCareUser.wrap(operations.seed_mobile_worker(state, "proof-worker", "proof-worker-id"))
            helpers = list(_iter_sync_usercase_helpers(worker, state.domain))
            found[granted] = (_validation_types(state, app_id).count("subscription"), len(helpers))
    assert found == {True: (0, 1), False: (1, 0)}, found


def test_a_form_that_only_reads_the_worker_record_builds_without_user_case(hq, core_runner, documents):
    """HQ's build has no check for a read of the worker's record; the record such a form reads is the one HQ makes
    only under the privilege (the test above)."""
    with _published(documents["worker-district-code"], "USERCASE", False) as (state, _, app_id, _, _):
        assert "subscription" not in _validation_types(state, app_id)


def _fixapi_answer(state, captured):
    """HQ's answer to Nova's lookup workbook push, sent to HQ's own fixapi view with an API key."""
    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits

    with hq_redis.shared(None), state.committing(), api_rate_limits(state):
        with state.operation("lookups-api-user", b"proof-lookups"):
            # A member who may edit data, as HQ's lookup table upload requires (``require_can_edit_fixtures``).
            credential = operations.seed_api_user(state, "proof-lookups@example.com", edit_data=True)
        return operations.api_request(
            state,
            "POST",
            f"/a/{state.domain}/fixtures/fixapi/",
            credential=credential,
            body=captured.upload().body,
            content_type=captured.content_type,
        )


def _validation_messages(state, app_id):
    """HQ's build errors, as its Releases page lists them: each error's message."""
    from proof.hq.seams import build_seams

    with build_seams():
        return [str(error.get("message", "")) for error in operations.held_app(state, app_id).validate_app()]


# What HQ's build answers an app whose forms read a lookup table on a plan without them (``_validate_fixtures``).
LOOKUP_TABLES_REFUSED = "Usage of lookup tables is not supported by your current subscription"


def test_lookup_tables_are_built_and_taken_only_with_the_privilege(hq, core_runner, documents):
    from corehq.apps.fixtures.models import LookupTable

    from proof.observe import publish

    export = documents["lookup-app"].exports["minimum"]
    configuration = _with_api_access(export.configuration.hq())
    assert "LOOKUP_TABLES" in configuration.privileges
    found = {}
    for granted in (True, False):
        held = configuration if granted else _without(configuration, "LOOKUP_TABLES")
        # Nova's push of the workbook, through HQ's own upload API.
        with hq_check(held) as (state, _):
            pushed = _fixapi_answer(state, export.content.lookups)
            tables = LookupTable.objects.filter(domain=state.domain).count()
        # The app's build, its tables pushed as the capture pushes them.
        with hq_check(held) as (state, _):
            app_id, refusal, _ = publish.create(state, export)
            assert refusal is None, refusal
            refused = any(LOOKUP_TABLES_REFUSED in text for text in _validation_messages(state, app_id))
        found[granted] = {
            "push": (pushed.status, pushed.headers.get("Content-Type", "").split(";")[0]),
            "upgradeRequired": "Upgrade Required" in pushed.body,
            "tables": tables > 0,
            "buildRefused": refused,
        }
    assert found == {
        True: {"push": (200, "application/json"), "upgradeRequired": False, "tables": True, "buildRefused": False},
        False: {"push": (200, "text/html"), "upgradeRequired": True, "tables": False, "buildRefused": True},
    }, found


def test_places_reach_a_worker_and_the_locations_api_answers_only_with_the_privilege(hq, core_runner, documents):
    from corehq.apps.domain.models import Domain
    from corehq.apps.locations.fixtures import should_sync_flat_fixture
    from corehq.apps.locations.models import LocationFixtureConfiguration, LocationType

    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits

    found = {}
    for granted in (True, False):
        with _published(documents["location-direct"], "LOCATIONS", granted) as (state, _, app_id, _, _):
            app = operations.held_app(state, app_id)
            assert app.location_fixture_restore == "project_default"
            with state.operation("organization-level", b"district"):
                # A project space that holds places has its organization levels, as Nova's push makes them.
                LocationType.objects.create(domain=state.domain, name="District", code="district")
            synced = []
            for syncs in (True, False):
                with state.committing():
                    LocationFixtureConfiguration.objects.update_or_create(
                        domain=state.domain, defaults={"sync_flat_fixture": syncs}
                    )
                synced.append(bool(should_sync_flat_fixture(Domain.get_by_name(state.domain), app)))
            with hq_redis.shared(None), state.committing(), api_rate_limits(state):
                with state.operation("places-api-user", b"proof-places"):
                    credential = operations.seed_api_user(state, "proof-places@example.com", edit_locations=True)
                read = operations.locations_read(state, credential)
            found[granted] = {"flatListByProjectSetting": synced, "locationsApi": read.status}
    assert found == {
        True: {"flatListByProjectSetting": [True, False], "locationsApi": 200},
        False: {"flatListByProjectSetting": [False, False], "locationsApi": 403},
    }, found
