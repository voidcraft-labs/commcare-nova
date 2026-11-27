"""Pinned HQ receipt for when a literal default order changes the capped result set."""

from lxml import etree
import pytest

from proof.editors import pages
from proof.editors.conftest import publish_hq_app, save_section, write_evidence
from proof.hq import operations, redis as hq_redis
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration


def test_the_case_list_save_keeps_literal_sort_terms_the_receiver_interprets(hq, editor_driver):
    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.app_manager.models import CaseSearch, DefaultCaseSearchProperty
    from corehq.apps.app_manager.tests.util import patch_get_xform_resource_overrides
    from corehq.apps.case_search.utils import CaseSearchQueryBuilder, _get_helper
    from corehq.apps.es.exceptions import ESError
    from corehq.apps.hqcase.utils import submit_case_blocks

    with hq_check(Configuration(case_search_enabled=True, privileges={"CLOUDCARE"})) as (state, _):
        app_id = publish_hq_app(state)
        original_module = operations.held_app(state, app_id).modules[0]
        case_type = original_module.case_type
        assert case_type
        records = [
            ("a", "2", "2025-01-01"),
            ("b", "2", "2024-01-01"),
            ("c", "10", "2026-01-01"),
        ]
        with hq_redis.shared(None), state.committing(), state.operation("sort-probe:cases", b"cases"):
            blocks = [CaseBlock(case_id=case_id, create=True, case_name=case_id, case_type=case_type,
                                owner_id="worker", update={"priority": priority, "visit": visit}).as_text()
                      for case_id, priority, visit in records]
            submit_case_blocks(blocks, state.domain, user_id="worker", device_id="proof")

        def saved_query(terms):
            app = operations.held_app(state, app_id)
            module = app.get_module(0)
            module.search_config = CaseSearch(default_properties=[
                DefaultCaseSearchProperty(property="commcare_sort", defaultValue=f"'{term}'") for term in terms
            ])
            app.save()
            run = save_section(editor_driver, state, pages.CASE_SEARCH, app_id, module.unique_id)
            assert run.save and run.save.status == 200 and not run.refused, (run.save, run.unsent)
            held = operations.held_app(state, app_id)
            saved = [row.defaultValue for row in held.get_module(0).search_config.default_properties]
            assert saved == [f"'{term}'" for term in terms], saved
            with patch_get_xform_resource_overrides():
                suite = etree.fromstring(held.create_suite())
            query, = suite.xpath("//query[data[@key='commcare_sort']]")
            values = query.xpath("data[@key='commcare_sort']/@ref")
            assert values == saved, values
            config = operations.search_request_config(
                state, app_id, [("case_type", case_type), *(("commcare_sort", value[1:-1]) for value in values)]
            )
            helper = _get_helper(None, state.domain, config.case_types, None)
            built = CaseSearchQueryBuilder(helper, config.case_types).build_query(config.criteria, config.commcare_sort)
            return saved, built.size(2)

        saved, canonical = saved_query(["-visit:date", "+priority:exact"])
        canonical_ids = [hit["_id"] for hit in canonical.run().raw_hits]
        suffix_saved, suffix = saved_query(["-visit:date:discarded", "+priority:exact:obsolete"])
        suffix_ids = [hit["_id"] for hit in suffix.run().raw_hits]
        assert suffix_ids == canonical_ids == ["c", "a"]
        assert suffix.es_query["sort"] == canonical.es_query["sort"]

        reset_saved, reset = saved_query(["-visit:date", "+priority::ignored", "-visit:date"])
        reset_ids = [hit["_id"] for hit in reset.run().raw_hits]
        assert reset_ids == ["a", "b"]
        reset_columns = [next(iter(term)) for term in reset.es_query["sort"]]
        assert [column.rsplit(".", 1)[-1] for column in reset_columns] == ["numeric", "date", "exact", "date"]

        single_saved, single = saved_query(["++priority:exact"])
        single_ids = [hit["_id"] for hit in single.run().raw_hits]
        assert len(single_ids) == 2 and single_ids[0] == "c" and single_ids[1] in {"a", "b"}

        invalid_saved, invalid = saved_query(["++priority:unknown"])
        with pytest.raises(ESError, match=r"(?i)No mapping found.+value\.unknown") as refused:
            invalid.run()

        masked_saved, masked = saved_query(["++priority:unknown", "+priority::ignored", "-visit:date"])
        masked_ids = [hit["_id"] for hit in masked.run().raw_hits]
        assert masked.es_query["sort"] == reset.es_query["sort"]
        assert masked_ids == reset_ids

    write_evidence("search-default-control-probe", {
        "canonical": {"saved": saved, "caseIds": canonical_ids},
        "ignoredSuffix": {"saved": suffix_saved, "caseIds": suffix_ids},
        "reset": {"saved": reset_saved, "caseIds": reset_ids, "sortColumns": reset_columns},
        "validSingle": {"saved": single_saved, "caseIds": single_ids},
        "invalid": {"saved": invalid_saved, "response": str(refused.value)},
        "maskedByReset": {"saved": masked_saved, "caseIds": masked_ids},
    })
