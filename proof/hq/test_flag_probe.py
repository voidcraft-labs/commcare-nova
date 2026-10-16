"""Defect 12: what each flag Nova's publish asks a project space for decides in HQ, and that the flag it reads is
the project space's own.

Contract: Nova's publish asks HQ's project-space list, through the
publisher's own key, whether each flag its app needs is on for the target
(``lib/commcare/client.ts::probeHqProjectSpaceCompatibility``, the flags of
``lib/commcare/projectSpaceCompatibility.ts::HQ_PRIVATE_FEATURE_FLAG_SYMBOLS``),
and names a capability, never the flag. The plausible failures: a flag
whose absence changes nothing HQ builds or compiles (then Nova asks for a
flag nothing needs), a flag the list reports as on because it is on for the
publisher alone (then a project space without it reads as having it), a
project space the key's user has left read as one without the flag (Nova
then names the wrong cause), and a flag Nova asks for that HQ never reads
for the content (``VIEW_FORM_ATTACHMENT``, which HQ reads only when someone
opens a captured file's link, ``proof/views/test_form_attachment.py``).

- HQ's build writes a Search field's starting value (``<prompt default>``)
  only under ``CASE_SEARCH_ADVANCED``
  (``feature_support.py::enable_default_value_expression``): four prompts of
  ``prompt-widgets`` carry it under the flag and none without it.
- HQ's build writes a search-first menu under a parent selection
  (``search-parent``) with an ``ancestor-exists`` filter of its own
  (``util.py::module_uses_inline_search_with_parent_relationship_parent_select``)
  with or without ``CASE_SEARCH_RELATED_LOOKUPS``, and HQ's case search
  compiler refuses that filter without the flag
  (``case_search/filter_dsl.py::_require_related_lookups_flag``) and compiles
  it with it.
- Each of the eleven toggles stored as on for one user alone is in neither
  ``toggles_enabled_for_user`` nor ``toggles_dict`` for that user and the
  project space (``StaticToggle.enabled`` answers false for a namespace the
  toggle does not declare); stored as on for the project space, all eleven
  are in ``toggles_dict``. Each through HQ's own toggle storage and readers,
  with no seam.
- HQ's project-space list (``api/resources/v0_5.py::UserDomainsResource``)
  lists the project space for a member and not for another account, with
  and without a ``feature_flag`` filter, and for a member lists it under the
  filter only when the flag is on for the space.
- No flag read of ``VIEW_FORM_ATTACHMENT`` is recorded while HQ imports and
  builds ``case-capture-followup``, whose case list shows a captured file's
  link.
"""

from __future__ import annotations

import dataclasses
import json

from lxml import etree

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.seams import api_rate_limits
from proof.hq.state import WEB_USER_USERNAME, hq_state

# The flags Nova's publish asks a project space for, each for a capability
# (``lib/commcare/projectSpaceCompatibility.ts::HQ_PRIVATE_FEATURE_FLAG_SYMBOLS``'s values).
PROBED_FLAGS = (
    "SESSION_ENDPOINTS",
    "SYNC_SEARCH_CASE_CLAIM",
    "CASE_SEARCH_ADVANCED",
    "COMMCARE_CONNECT",
    "MM_CASE_PROPERTIES",
    "VIEW_FORM_ATTACHMENT",
    "FOLLOWUP_FORMS_AS_CASE_LIST_FORM",
    "CUSTOM_PROPERTIES",
    "CASE_SEARCH_RELATED_LOOKUPS",
    "CASE_LIST_TILE",
    "CASE_LIST_TILE_CUSTOM",
)
LIST = "/api/user_domains/v1/"
OTHER = "proof-other@example.com"


def _with_flag(configuration, flag, on):
    flags = configuration.flags | {flag} if on else configuration.flags - {flag}
    return dataclasses.replace(configuration, flags=frozenset(flags))


def _built(state, record, app_id):
    from proof.hq.seams import build_seams

    with build_seams():
        built = operations.build(operations.held_app(state, app_id), record)
    assert built.errors == [], built.errors
    return built


def _published(state, export):
    from proof.observe import publish

    app_id, refusal, _ = publish.create(state, export)
    assert refusal is None, refusal
    return app_id


def test_hqs_build_writes_a_search_fields_starting_value_only_under_case_search_advanced(hq, core_runner, documents):
    export = documents["prompt-widgets"].exports["minimum"]
    configuration = export.configuration.hq()
    assert "CASE_SEARCH_ADVANCED" in configuration.flags
    defaults = {}
    for on in (True, False):
        with hq_check(_with_flag(configuration, "CASE_SEARCH_ADVANCED", on)) as (state, record):
            built = _built(state, record, _published(state, export))
            suite = etree.fromstring(built.files["suite.xml"])
            defaults[on] = sum(1 for prompt in suite.iter("prompt") if prompt.get("default") is not None)
    assert defaults == {True: 4, False: 0}, defaults


def test_hqs_build_writes_the_parent_select_filter_its_compiler_refuses_without_related_lookups(
    hq, core_runner, documents
):
    from corehq.apps.case_search.exceptions import XPathFunctionException

    from proof.observe import sessions

    export = documents["search-parent"].exports["minimum"]
    configuration = export.configuration.hq()
    assert "CASE_SEARCH_RELATED_LOOKUPS" in configuration.flags
    found = {}
    for on in (True, False):
        with hq_check(_with_flag(configuration, "CASE_SEARCH_RELATED_LOOKUPS", on)) as (state, record):
            built = _built(state, record, _published(state, export))
            queries = sessions.literal_queries(core_runner, built.files["suite.xml"])
            compiled = []
            for query, case_types in sorted(queries):
                try:
                    operations.compile_case_search(state, query, list(case_types))
                    compiled.append((query, True))
                except XPathFunctionException as refused:
                    assert "You cannot query related cases here" in str(refused)
                    compiled.append((query, False))
            found[on] = compiled
    # The same filter with and without the flag; compiled only with it.
    assert [query for query, _ in found[True]] == [query for query, _ in found[False]], found
    related = [query for query, _ in found[True] if query.startswith("ancestor-exists(parent,")]
    assert related, found
    assert all(ok for query, ok in found[True] if query in related), found
    assert not any(ok for query, ok in found[False] if query in related), found


def test_a_flag_on_for_one_user_alone_is_not_the_project_spaces(hq):
    from corehq import toggles
    from corehq.toggles import NAMESPACE_DOMAIN, toggles_dict, toggles_enabled_for_user
    from corehq.toggles.shortcuts import set_toggle

    flags = [getattr(toggles, symbol) for symbol in PROBED_FLAGS]
    assert all(flag.namespaces == [NAMESPACE_DOMAIN] for flag in flags)
    with hq_state(Configuration()) as state:
        # The user namespace is the unnamespaced item, which a toggle of the project space alone refuses in its own
        # set, so the storage is written directly.
        for flag in flags:
            set_toggle(flag.slug, WEB_USER_USERNAME, True, namespace=None)
        for_user = toggles_enabled_for_user(WEB_USER_USERNAME)
        for_both = toggles_dict(username=WEB_USER_USERNAME, domain=state.domain)
        assert not set(PROBED_FLAGS) & for_user, sorted(set(PROBED_FLAGS) & for_user)
        assert not {flag.slug for flag in flags} & set(for_both)
        for flag in flags:
            set_toggle(flag.slug, WEB_USER_USERNAME, False, namespace=None)
            assert flag.set(state.domain, True, NAMESPACE_DOMAIN)
        assert {flag.slug for flag in flags} <= set(toggles_dict(domain=state.domain))


def _listed(state, credential, query=""):
    answer = operations.api_request(state, "GET", f"{LIST}?limit=100{query}", credential=credential)
    assert answer.status == 200, answer
    return [entry["domain_name"] for entry in json.loads(answer.body)["objects"]]


def test_the_project_space_list_holds_the_space_only_for_a_member_and_under_a_filter_only_with_its_flag(hq):
    """HQ's own list and filter (``UserDomainsResource``), its flag read through the configuration: the space is
    listed for a member and never for an account outside it, and under the filter only where the flag is on.
    That a flag on for the publisher alone is not on for the space is the toggle readers' test above."""
    from corehq import toggles

    from proof.hq import redis as hq_redis

    filtered = f"&feature_flag={toggles.CASE_SEARCH_ADVANCED.slug}"
    found = {}
    for on in (False, True):
        configuration = Configuration(flags=frozenset({"CASE_SEARCH_ADVANCED"} if on else ()))
        with hq_check(configuration) as (state, _), hq_redis.shared(None), state.committing(), api_rate_limits(state):
            with state.operation("accounts", b"member-and-other"):
                member = operations.seed_api_key(state, WEB_USER_USERNAME)
                other = operations.seed_api_user(state, OTHER, member=False)
            found[on] = {
                "member": (_listed(state, member), _listed(state, member, filtered)),
                "other": (_listed(state, other), _listed(state, other, filtered)),
                "space": state.domain,
            }
    space = found[True]["space"]
    assert found == {
        False: {"member": ([space], []), "other": ([], []), "space": space},
        True: {"member": ([space], [space]), "other": ([], []), "space": space},
    }, found


def test_hq_reads_no_attachment_flag_while_it_imports_and_builds_a_shown_link(hq, core_runner, documents):
    export = documents["case-capture-followup"].exports["minimum"]
    with hq_check(export.configuration.hq()) as (state, record):
        _built(state, record, _published(state, export))
    assert not [read for read in record.flags if read.symbol == "VIEW_FORM_ATTACHMENT"]
