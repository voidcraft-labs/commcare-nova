"""Which records CommCare HQ's similar-match search finds, the answers Preview is held to.

A Search field matched as similar (``fuzzy-match`` in a search's
``_xpath_query``, or a property the project space matches fuzzily) reaches
``apps/es/case_search.py::case_property_query(fuzzy=True)``: an analyzed
``match`` of the query's words OR a ``fuzzy`` query of the whole query as one
Python-lowercased term (``es/queries.py::fuzzy``: AUTO fuzziness, a prefix
of two, at most 100 expansions), over the searched property's
``case_properties.value``, which the case search index splits on Java's
whitespace and lowercases (``es/index/analysis.py``). Preview answers the
same search in Postgres (``lib/case-store/sql/certifiedFuzzyMatch.ts``) and
is held to these answers by
``lib/case-store/postgres/__tests__/similarMatch.postgres.test.ts``.

Contract, over each group of ``fixtures/similar-match-vectors.json`` in its
own unit, every record written through HQ's own case processing into HQ's
own index and the property set fuzzy for the case type: each record stores
its value as written, and each search finds exactly the records the vectors
name. The groups hold punctuation, hyphens, apostrophes and digits inside a
word, precomposed and decomposed accents, non-Latin scripts, case mappings
Java and Python differ on (U+0130, final sigma, a titlecase digraph, ß),
characters outside the Basic Multilingual Plane, Java's whitespace and the
no-break spaces it excludes, edit distance by query length, the two-letter
prefix, a transposition, a whole query of two words, and the expansion
limit at 100 and at 101 words within reach.

Plausible failures: a matcher that splits on punctuation (``mary`` finds
"Mary-Jane"), folds accents (``nandu`` finds "Ñandú"), counts a
transposition as one edit (``smiht`` finds "Smith"), or keeps every word
past the limit (the 101 group's last word in byte order found); and a
harness whose values changed on the way in (the stored values would
differ).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "similar-match-vectors.json").read_text(encoding="utf-8"))
GROUPS = VECTORS["groups"]


def _search(state, prop, case_type, query):
    """The case ids HQ's case search finds for one Search answer, read as HQ's view reads Formplayer's post."""
    from corehq.apps.case_search.utils import CaseSearchQueryBuilder, _get_helper

    config = operations.search_request_config(state, "search-app", [("case_type", case_type), (prop, query)])
    helper = _get_helper(None, state.domain, config.case_types, None)
    builder = CaseSearchQueryBuilder(helper, config.case_types)
    built = builder.build_query(config.criteria, commcare_sort=config.commcare_sort)
    return sorted(hit["_id"] for hit in built.run().raw_hits)


@pytest.mark.parametrize("group", GROUPS, ids=[group["id"] for group in GROUPS])
def test_hq_finds_the_similar_matches_preview_is_held_to(hq, group):
    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.case_search.models import CaseSearchConfig
    from corehq.apps.hqcase.utils import submit_case_blocks
    from corehq.form_processor.models import CommCareCase

    from proof.hq import redis as hq_redis

    prop, case_type = VECTORS["property"], VECTORS["caseType"]
    written = {record["id"]: record["value"] for record in group["records"]}
    with hq_check(Configuration(case_search_enabled=True)) as (state, _):
        operation = f"similar match {group['id']}"
        with hq_redis.shared(None), state.committing():
            with state.operation(operation, hashlib.sha256(operation.encode()).digest()):
                blocks = [
                    CaseBlock(case_id=case_id, create=True, case_name=case_id, case_type=case_type,
                              owner_id="worker", update={prop: value}).as_text()
                    for case_id, value in written.items()
                ]
                submit_case_blocks(blocks, state.domain, user_id="worker", device_id="proof")
        stored = {
            case.case_id: case.get_case_property(prop)
            for case in CommCareCase.objects.get_cases(list(written), state.domain)
        }
        assert stored == written

        config = CaseSearchConfig.objects.get(domain=state.domain)
        config.fuzzy_properties.create(domain=state.domain, case_type=case_type, properties=[prop])
        found = {search["query"]: _search(state, prop, case_type, search["query"]) for search in group["searches"]}

    expected = {search["query"]: sorted(search["matches"]) for search in group["searches"]}
    differing = {query: {"hq": found[query], "vectors": expected[query]} for query in expected
                 if found[query] != expected[query]}
    assert not differing, json.dumps(differing, ensure_ascii=False, indent=1)
