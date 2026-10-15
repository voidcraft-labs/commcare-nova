"""Finding 65: the project-space list a publish reads answers whether the project space holds the empty-list text.

Contract: every publish reads ``USH_EMPTY_CASE_LIST_TEXT`` for its target
through HQ's project-space list filtered by the flag's slug
(``lib/commcare/client.ts::probeHqProjectSpaceCompatibility`` with
``readEmptyCaseListText``), and stores the answer with the deployment, so a
``.ccz`` made for that project space writes the empty-list text exactly where
HQ's build there does (``app_strings.py::_create_module_details_app_strings``,
under ``feature_support.py::supports_empty_case_list_text``). Nova reads the
target held in the filtered list as the project space's own flag. The
plausible failures: a filtered list that holds the space for a flag stored
for the publisher alone (Nova's archive would then write a text HQ's build
there does not), a filtered list that leaves the space out with the flag on
for it, and a flag HQ would store for another namespace than the project
space.

In a state with no flag, for the state's web user with an API key, through
HQ's own ``api/resources/v0_5.py::UserDomainsResource`` and HQ's toggle
storage, with no seam: the unfiltered list, read first, is the state's
project space; the list filtered by ``feature_flag=empty_case_list_text`` is
empty with the flag off, empty again with it stored for that user alone
(the user namespace, which ``StaticToggle.set`` stores unnamespaced), the
project space with it on for the space (``NAMESPACE_DOMAIN``), and empty once
it is off for the space again; and the toggle names the project space as its
only namespace.
"""

from __future__ import annotations

import json

from proof.hq import operations
from proof.hq.configuration import Configuration
from proof.hq.seams import api_rate_limits
from proof.hq.state import WEB_USER_USERNAME, hq_state

LIST = "/api/user_domains/v1/"


def _listed(state, credential, query=""):
    answer = operations.api_request(state, "GET", f"{LIST}?limit=100{query}", credential=credential)
    assert answer.status == 200, answer
    return [entry["domain_name"] for entry in json.loads(answer.body)["objects"]]


def test_the_filtered_project_space_list_holds_the_space_only_with_its_own_empty_list_text_flag(hq):
    from corehq import toggles
    from corehq.toggles import NAMESPACE_DOMAIN
    from corehq.toggles.shortcuts import set_toggle

    flag = toggles.USH_EMPTY_CASE_LIST_TEXT
    assert flag.slug == "empty_case_list_text"
    assert flag.namespaces == [NAMESPACE_DOMAIN]
    filtered = f"&feature_flag={flag.slug}"
    with hq_state(Configuration()) as state, api_rate_limits(state):
        credential = operations.seed_api_key(state, WEB_USER_USERNAME)
        assert _listed(state, credential) == [state.domain]
        assert _listed(state, credential, filtered) == []

        # The user namespace is the unnamespaced item (StaticToggle.set maps NAMESPACE_USER to None), which the
        # toggle's own set refuses for a flag of the project space alone, so the storage is written directly.
        set_toggle(flag.slug, WEB_USER_USERNAME, True, namespace=None)
        assert _listed(state, credential, filtered) == []
        set_toggle(flag.slug, WEB_USER_USERNAME, False, namespace=None)

        assert flag.set(state.domain, True, NAMESPACE_DOMAIN)
        assert _listed(state, credential, filtered) == [state.domain]
        assert flag.set(state.domain, False, NAMESPACE_DOMAIN)
        assert _listed(state, credential, filtered) == []
