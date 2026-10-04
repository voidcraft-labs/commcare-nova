"""The HQ views and resources Nova calls.

Contracts and the failures they catch:
- Every view and resource Nova calls is an item, and every route recorded for
  a view is one Django's resolver sends a concrete request path to that view
  (an extractor that recorded another view's pattern, or a stale one, fails).
- The case search probe's decisive facts are recorded as HQ holds them:
  ``search`` refuses with a plain 404 under ``SYNC_SEARCH_CASE_CLAIM`` (no
  ``plain_message``) and hands the request to ``app_aware_search``, which
  answers ``CASE_SEARCH_DISABLED_MSG`` (its text equal to the constant HQ
  imports) with a 404 unless ``case_search_enabled_for_domain(domain)``;
  ``mobile_auth``'s ``require_mobile_access`` checks
  ``HqPermissions.access_mobile_endpoints``, a permission HQ declares, whose
  role editor control sits under the heading Nova's copy names.
- The case fixture view a stack ``<query>`` requests (HQ's build points the
  one that reloads a search's chosen case there) reads ``case_id`` and
  ``case_type`` through a local bound to the request's ``GET`` or ``POST``
  (``request_dict = request.GET if ... else request.POST``): a pass that read
  only ``request.GET`` itself would record no parameter, and one that took any
  local for a request part would record a parameter of another dictionary.
- ``UserDomainsResource`` refuses a ``feature_flag`` outside
  ``toggles.all_toggle_slugs()`` and keeps a domain only when the flag is in
  ``toggles.toggles_dict(...)``.
- The passes read the checkout they are given: in temporary copies, removing
  the case search check, planting a decorator argument, a module constant and
  a request parameter, and disabling the feature-flag refusal each change the
  recorded item; the unplanted sources do not have the planted facts.
"""

from __future__ import annotations

import dataclasses

import pytest

from proof.surface.families import hq_api
from proof.surface.families.hq_api import RESOURCES, VIEWS

# The request path each endpoint answers when Nova calls it (lib/commcare/client.ts, lib/commcare/hq/*.ts),
# with example ids; LookupTableItemResource is the plan's, for reading a table's rows.
NOVA_PATHS = {
    "import_app_api": "/a/demo/apps/api/import_app/",
    "upload_multimedia_api": "/a/demo/apps/api/app1/multimedia/",
    "multimedia_status_api": "/a/demo/apps/api/app1/multimedia/status/p1/",
    "list_apps": "/a/demo/apps/api/list_apps/",
    "app_source": "/a/demo/apps/source/app1/",
    "current_app_version": "/a/demo/apps/view/app1/current_version/",
    "download_file": "/a/demo/apps/download/build1/suite.xml",
    "search": "/a/demo/phone/search/",
    "app_aware_search": "/a/demo/phone/search/app1/",
    "case_fixture": "/a/demo/phone/case_fixture/app1/",
    "upload_fixture_api": "/a/demo/fixtures/fixapi/",
    "UserDomainsResource": "/api/user_domains/v1/",
    "ApplicationResource": "/a/demo/api/application/v1/app1/",
    "LookupTableResource": "/a/demo/api/lookup_table/v1/",
    "LookupTableItemResource": "/a/demo/api/lookup_table_item/v2/",
    "LocationTypeResource": "/a/demo/api/location_type/v1/",
    "LocationResource": "/a/demo/api/location/v2/",
    "CommCareUserResource": "/a/demo/api/user/v1/",
    "BulkUserResource": "/a/demo/api/bulk-user/v1/",
}
SEARCH_CHECK = (
    "    if not case_search_enabled_for_domain(domain):\n"
    "        return HttpResponse(CASE_SEARCH_DISABLED_MSG, status=404)\n"
)
DISABLED_404 = {
    "exit": "return HttpResponse(CASE_SEARCH_DISABLED_MSG, status=404)",
    "when": ["not case_search_enabled_for_domain(domain)"],
}
# Request reads planted in place of the case search check: a parameter, a membership test, and a read of
# something that is not the request.
PLANTED_READS = (
    "    planted = request.GET.get('planted_param')\n"
    "    if 'planted_flag' in request.POST:\n"
    "        planted = unrelated.GET.get('not_a_request_read')\n"
)
OTA_VIEWS = "corehq/apps/ota/views.py"
USER_RESOURCES = "corehq/apps/api/resources/v0_5.py"


def test_every_called_endpoint_is_an_item(items):
    assert {name for _, name in (*VIEWS, *RESOURCES)} == set(NOVA_PATHS)
    for name in NOVA_PATHS:
        assert items[f"hq-api:{name}"]["routes"], name


def test_the_paths_nova_calls_resolve_to_a_recorded_route(items, hq):
    import importlib

    from django.urls import resolve

    views = {name: getattr(importlib.import_module(module), name) for module, name in VIEWS}
    for name, path in NOVA_PATHS.items():
        match = resolve(path)
        assert match.route in {route["pattern"] for route in items[f"hq-api:{name}"]["routes"]}, (name, match.route)
        if name in views:
            assert match.func is views[name], name


def test_the_case_search_probe_facts(items, hq):
    from corehq.apps.ota import views
    from corehq.apps.users.models import HqPermissions

    search = items["hq-api:search"]
    aware = items["hq-api:app_aware_search"]
    assert "toggles.SYNC_SEARCH_CASE_CLAIM.required_decorator()" in [d["decorator"] for d in search["decorators"]]
    assert "toggles.SYNC_SEARCH_CASE_CLAIM.required_decorator(plain_message=CASE_SEARCH_DISABLED_MSG)" in [
        d["decorator"] for d in aware["decorators"]
    ]
    assert "mobile_auth" in [d["decorator"] for d in search["decorators"]]
    assert aware["constants"] == {"CASE_SEARCH_DISABLED_MSG": views.CASE_SEARCH_DISABLED_MSG}
    assert search["delegates"] == ["corehq.apps.ota.views.app_aware_search"]
    for item in (search, aware):
        assert DISABLED_404 in item["bodies"]["corehq.apps.ota.views.app_aware_search"]["exits"]
    permission_calls = items["hq-api-decorator:corehq.apps.ota.decorators.require_mobile_access"]["calls"]
    assert "require_permission(HqPermissions.access_mobile_endpoints, login_decorator=None)" in permission_calls
    assert "access_mobile_endpoints" in HqPermissions._properties_by_key
    (control,) = items["hq-api-permission:access_mobile_endpoints"]["roleEditor"]
    assert control["headings"] == ["Mobile App Access"]
    assert items["hq-api:import_app_api"]["requestReads"] == ["FILES.app_file", "POST.app_id", "POST.app_name"]


def test_the_case_fixture_view_reads_its_parameters_through_a_request_alias(items, hq):
    from corehq.apps.case_search.models import CASE_SEARCH_REGISTRY_ID_KEY

    reads = set(items["hq-api:case_fixture"]["requestReads"])
    # The registry key is named by the constant ota/views.py imports, read as its value.
    assert reads == {
        f"{part}.{key}" for part in ("GET", "POST") for key in ("case_id", "case_type", CASE_SEARCH_REGISTRY_ID_KEY)
    }
    assert "mobile_auth" in [d["decorator"] for d in items["hq-api:case_fixture"]["decorators"]]


def test_only_a_local_bound_to_request_parts_alone_is_read_as_one():
    import ast

    tree = ast.parse(
        "def view(request):\n"
        "    both = request.GET if request.method == 'GET' else request.POST\n"
        "    mixed = request.GET\n"
        "    mixed = {}\n"
        "    both.getlist('kept')\n"
        "    mixed.get('dropped')\n"
    )
    function = tree.body[0]
    aliases = hq_api._request_aliases(function, "request")
    assert aliases == {"both": ["GET", "POST"]}
    reads = {read for node in ast.walk(function) for read in hq_api._request_read(node, "request", aliases)}
    assert {"GET.kept", "POST.kept"} <= reads and not any("dropped" in read for read in reads)


def test_the_feature_flag_filter_facts(items, hq):
    from corehq import toggles

    resource = items["hq-api:UserDomainsResource"]
    assert resource["meta"]["paginator_class"].endswith("DoesNothingPaginator")
    body = resource["methods"]["get_object_list"]
    assert body["in"] == "UserDomainsResource"
    assert {
        "exit": "raise BadRequest(f'{feature_flag!r} is not a valid feature flag')",
        "when": ["feature_flag and feature_flag not in toggles.all_toggle_slugs()"],
    } in body["exits"]
    assert {
        "exit": "continue",
        "when": [
            "for domain in domains",
            "feature_flag and feature_flag not in toggles.toggles_dict(username=username, domain=domain)",
        ],
    } in body["exits"]
    assert callable(toggles.all_toggle_slugs) and callable(toggles.toggles_dict)


@pytest.fixture(scope="module")
def routes(hq):
    return hq_api._routes()


def _view(sources, name, routes):
    return hq_api._view(hq_api._Reader(sources), "corehq.apps.ota.views", name, routes, {}).facts


def test_the_view_pass_reads_a_changed_copy(plant, sources, routes):
    root = plant(
        sources.hq,
        [OTA_VIEWS],
        {
            OTA_VIEWS: (
                "@toggles.SYNC_SEARCH_CASE_CLAIM.required_decorator()\ndef search(request, domain):",
                "@toggles.SYNC_SEARCH_CASE_CLAIM.required_decorator(plain_message=PLANTED_MSG)\n"
                "def search(request, domain):",
            ),
        },
    )
    views = root / OTA_VIEWS
    text = views.read_text(encoding="utf-8")
    assert text.count(SEARCH_CHECK) == 1
    anchor = 'CASE_SEARCH_DISABLED_MSG = "Case search is not enabled for this project"\n'
    views.write_text(
        text.replace(SEARCH_CHECK, PLANTED_READS).replace(anchor, anchor + 'PLANTED_MSG = "planted message"\n'),
        encoding="utf-8",
    )
    planted = dataclasses.replace(sources, hq=root)
    search = _view(planted, "search", routes)
    aware = _view(planted, "app_aware_search", routes)
    assert "toggles.SYNC_SEARCH_CASE_CLAIM.required_decorator(plain_message=PLANTED_MSG)" in [
        d["decorator"] for d in search["decorators"]
    ]
    assert search["constants"]["PLANTED_MSG"] == "planted message"
    assert {"GET.planted_param", "POST.planted_flag"} <= set(aware["requestReads"])
    assert not [read for read in aware["requestReads"] if "not_a_request_read" in read]
    assert DISABLED_404 not in aware["bodies"]["corehq.apps.ota.views.app_aware_search"]["exits"]

    unplanted = _view(sources, "app_aware_search", routes)
    assert DISABLED_404 in unplanted["bodies"]["corehq.apps.ota.views.app_aware_search"]["exits"]
    assert "GET.planted_param" not in unplanted["requestReads"]
    assert "PLANTED_MSG" not in _view(sources, "search", routes)["constants"]


def test_the_resource_pass_reads_a_changed_copy(plant, sources, routes):
    root = plant(
        sources.hq,
        [USER_RESOURCES],
        {
            USER_RESOURCES: (
                "        if feature_flag and feature_flag not in toggles.all_toggle_slugs():",
                "        if False:",
            )
        },
    )
    planted = dataclasses.replace(sources, hq=root)

    def exits(of):
        facts = hq_api._resource(
            hq_api._Reader(of), "corehq.apps.api.resources.v0_5", "UserDomainsResource", routes, {}
        )
        return facts.facts["methods"]["get_object_list"]["exits"]

    refusal = "raise BadRequest(f'{feature_flag!r} is not a valid feature flag')"
    assert {"exit": refusal, "when": ["False"]} in exits(planted)
    assert {"exit": refusal, "when": ["feature_flag and feature_flag not in toggles.all_toggle_slugs()"]} in exits(
        sources
    )
