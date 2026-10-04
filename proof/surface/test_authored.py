"""The surface's authored items: keys Nova's exports use whose facts no upstream checkout the image holds can give.

Contracts and the failures they catch:
- Each authored item says it is authored and names where each of its facts was
  settled, and the authored keys are exactly those the authored family holds:
  a generated family that started producing one would fail the extraction
  (two items share a key), and an authored item that lost its provenance
  fails here.
- The facts hold where the image can check them: HQ's CSQL tables hold no
  ``search-value-mixes-quote-marks`` and HQ's search refuses the query with
  the message the item quotes; HQ's settings and HQ's profile template write
  none of the local profile properties as their own, so the ``setting`` and
  ``profile`` families hold no item for them.
"""

from __future__ import annotations

import pytest

from proof.surface.families.authored import AUTHORED


def test_each_authored_item_says_so_and_where_it_was_settled(items):
    authored = {key for key, facts in items.items() if facts.get("authored")}
    assert authored == set(AUTHORED)
    for key in authored:
        assert items[key]["source"], key


def test_hqs_search_has_no_function_of_the_quote_cascades_name(items, hq):
    from corehq.apps.case_search.exceptions import XPathFunctionException
    from corehq.apps.case_search.filter_dsl import build_filter_from_xpath
    from corehq.apps.case_search.xpath_functions import XPATH_QUERY_FUNCTIONS, XPATH_VALUE_FUNCTIONS

    name = "search-value-mixes-quote-marks"
    assert name not in XPATH_QUERY_FUNCTIONS and name not in XPATH_VALUE_FUNCTIONS
    with pytest.raises(XPathFunctionException, match=f"'{name}' is not a valid standalone function"):
        build_filter_from_xpath(f"{name}()", domain="nova-proof")
    assert f"'{name}' is not a valid standalone function" in items[f"csql-fn:{name}"]["hq"]


def test_hq_writes_none_of_the_local_profile_properties_as_its_own(items):
    for key in AUTHORED:
        if not key.startswith("profile-property:"):
            continue
        name = key.split(":", 1)[1]
        assert f"setting:properties.{name}" not in items, key
        assert not items[key].get("written"), key  # the profile family's fact, for a property HQ writes
