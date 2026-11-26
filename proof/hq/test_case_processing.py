"""HQ's case processing refuses what HQ refuses a submission for.

Contract: ``operations.process_case_blocks`` runs HQ's own reading of a
submission and HQ's per-form case step (``get_cases_from_forms`` then
``_validate_indices``, as ``casexml/apps/case/xform.py::_get_or_update_cases``
runs them) up to the case database, and returns as a refusal exactly the
errors ``SubmissionPost.run`` answers as a refused submission. The plausible
failures:

- extracting case blocks without HQ's case database, which accepts an empty
  id (``extract_case_blocks`` keeps a block whose ``case_id`` is ``""``)
  where ``AbstractCaseDbCache.get`` refuses it;
- stopping at ``get_cases_from_forms``, which accepts an index to a case that
  exists nowhere where ``_validate_indices`` refuses it;
- a refusal HQ answers as a refused submission (a ``date_modified`` that is
  not a date) escaping as an exception, or an index to a case the same
  submission creates refused.

It also holds what HQ does with an ``owner_id`` in an update block, which
``lib/commcare/constants.ts::RESERVED_CASE_PROPERTIES`` states: HQ's wire
accepts it and moves the case to the new owner (``CaseUpdateAction`` reads
``owner_id`` as a known property, ``casexml/apps/case/xml/parser.py``, and
``form_processor/backends/sql/update_strategy.py::SqlCaseUpdateStrategy._update_known_properties``
writes it onto the case), so Nova reserves it by its own rule. The plausible
failure: an update HQ reads as a dynamic property, which would leave the
owner as it was.
"""

from __future__ import annotations

from pathlib import Path

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration()
DATE_MODIFIED = "2026-09-30T10:00:00.000000Z"


def _case(case_id, body, date_modified=DATE_MODIFIED):
    return f"""<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="{case_id}"
        date_modified="{date_modified}" user_id="u-1">{body}</case>"""


def _create(case_type, name):
    return f"<create><case_type>{case_type}</case_type><case_name>{name}</case_name><owner_id>u-1</owner_id></create>"


def _submission(*groups) -> bytes:
    body = "\n".join(f"<group{i}>{case}</group{i}>" for i, case in enumerate(groups))
    return f"""<?xml version='1.0' ?>
<data xmlns="http://example.com/proof/case-processing" name="Visit">
  {body}
  <meta xmlns="http://openrosa.org/jr/xforms">
    <instanceID>form-1</instanceID><userID>u-1</userID>
    <timeStart>2026-09-30T10:00:00Z</timeStart><timeEnd>2026-09-30T10:00:01Z</timeEnd>
  </meta>
</data>""".encode()


def _person(case_id="c-new", date_modified=DATE_MODIFIED):
    return _case(case_id, _create("person", "A") + "<update><visits>1</visits></update>", date_modified)


def _visit(case_id, parent_id=None):
    index = f'<index><parent case_type="person">{parent_id}</parent></index>' if parent_id else ""
    return _case(case_id, _create("visit", "B") + index)


def test_an_empty_case_id_is_refused_as_hq_refuses_it(hq, core_runner):
    from casexml.apps.case.exceptions import IllegalCaseId

    with hq_check(CONFIGURATION) as (state, _):
        accepted = operations.process_case_blocks(state, _submission(_person(), _visit("c-visit")))
        refused = operations.process_case_blocks(state, _submission(_person(), _visit("")))

    assert accepted.refusal is None
    assert {case_id: (meta.is_creation, meta.case.type) for case_id, meta in accepted.touched.items()} == {
        "c-new": (True, "person"),
        "c-visit": (True, "visit"),
    }
    assert [block.get("@case_id") for block in refused.case_blocks] == ["c-new", ""]
    assert isinstance(refused.refusal, IllegalCaseId)
    assert str(refused.refusal) == "case_id must not be empty"


def test_an_index_to_a_case_that_exists_nowhere_is_refused(hq, core_runner):
    from casexml.apps.case.exceptions import InvalidCaseIndex

    with hq_check(CONFIGURATION) as (state, _):
        # The parent is created by the same submission: HQ accepts the index.
        accepted = operations.process_case_blocks(
            state, _submission(_person("c-parent"), _visit("c-child", "c-parent"))
        )
        refused = operations.process_case_blocks(state, _submission(_visit("c-child", "no-such-parent")))

    assert accepted.refusal is None
    assert [index.referenced_id for index in accepted.touched["c-child"].case.indices] == ["c-parent"]
    assert isinstance(refused.refusal, InvalidCaseIndex)
    assert str(refused.refusal) == "Case 'c-child' references non-existent case 'no-such-parent'"


def test_unicode_index_identifiers_keep_their_exact_case_target(hq, core_runner):
    from corehq.apps.hqcase.utils import submit_case_blocks
    from corehq.form_processor.models import CommCareCase

    from proof.hq import redis as hq_redis

    identifiers = ("parént", "parént", "亲属", "par.ent", "par-ent")
    index = "<index>" + "".join(
        f'<{name} case_type="person" relationship="child">c-parent</{name}>' for name in identifiers
    ) + "</index>"
    with hq_check(CONFIGURATION) as (state, _):
        with hq_redis.shared(None), state.committing():
            with state.operation("unicode-case-indices", "parént".encode()):
                submit_case_blocks(
                    [_person("c-parent"), _case("c-child", _create("visit", "B") + index)],
                    state.domain,
                    user_id="u-1",
                    device_id="proof",
                )
                child = CommCareCase.objects.get_case("c-child", state.domain)
                assert {(index.identifier, index.referenced_type, index.referenced_id)
                        for index in child.indices} == {(name, "person", "c-parent") for name in identifiers}


def test_a_date_modified_that_is_not_a_date_is_refused(hq, core_runner):
    from casexml.apps.case.exceptions import PhoneDateValueError

    with hq_check(CONFIGURATION) as (state, _):
        refused = operations.process_case_blocks(state, _submission(_person(date_modified="not a date")))

    assert isinstance(refused.refusal, PhoneDateValueError)
    assert str(refused.refusal) == "'not a date'"
    assert refused.touched == {}


def test_an_owner_id_in_an_update_block_moves_the_case_to_the_new_owner(hq, core_runner):
    with hq_check(CONFIGURATION) as (state, _):
        created = operations.process_case_blocks(state, _submission(_person()))
        case = created.touched["c-new"].case
        assert created.refusal is None and case.owner_id == "u-1"
        moved = operations.process_case_blocks(
            state,
            _submission(_case("c-new", "<update><owner_id>u-2</owner_id><visits>2</visits></update>")),
            cases=[case],
        )

    assert moved.refusal is None
    updated = moved.touched["c-new"]
    assert not updated.is_creation
    assert updated.case.owner_id == "u-2"
    # Read as the case's owner, not as a property the case carries beside it.
    assert "owner_id" not in updated.case.case_json
    assert updated.case.case_json["visits"] == "2"


def test_case_updates_keep_location_on_the_case_but_search_indexes_only_the_worker_property(hq, core_runner):
    from corehq.pillows.case_search import _get_case_properties

    changes = (
        "<update><external_id>authored-id</external_id>"
        "<location_id>district-7</location_id>"
        "<hq_user_id>linked-worker</hq_user_id></update>"
    )
    with hq_check(CONFIGURATION) as (state, _):
        accepted = operations.process_case_blocks(
            state, _submission(_case("c-new", _create("person", "A") + changes))
        )
        assert accepted.refusal is None
        case = accepted.touched["c-new"].case
        assert case.location_id == "district-7"
        assert "location_id" not in case.case_json
        assert case.case_json["hq_user_id"] == "linked-worker"
        assert case.external_id == "linked-worker"
        indexed = {prop["key"]: prop["value"] for prop in _get_case_properties(case.to_json())}
        assert indexed["hq_user_id"] == "linked-worker"
        assert "location_id" not in indexed


def test_search_follows_a_worker_property_but_does_not_follow_a_case_location(hq, core_runner):
    from corehq.apps.case_search import utils
    from corehq.apps.es.case_search import case_search_adapter

    related_key = "x_commcare_custom_related_case_property"
    changes = "<update><location_id>from-location</location_id><hq_user_id>from-worker</hq_user_id></update>"
    with hq_check(CONFIGURATION) as (state, _):
        accepted = operations.process_case_blocks(
            state,
            _submission(
                _case("primary", _create("person", "A") + changes),
                _case("from-location", _create("person", "B")),
                _case("from-worker", _create("person", "C")),
            ),
        )
        assert accepted.refusal is None
        cases = {record_id: meta.case for record_id, meta in accepted.touched.items()}
        case_search_adapter.bulk_index(list(cases.values()), refresh=True)
        helper = utils.QueryHelper(state.domain)
        hits = helper.get_base_queryset().case_ids(set(cases)).run().hits
        searchable = {case.case_id: case for case in map(helper.wrap_case, hits)}
        assert set(searchable) == set(cases)
        primary_hit = searchable["primary"]
        for property_name, expected in (("hq_user_id", ["from-worker"]), ("location_id", [])):
            request = operations.search_request_config(
                state, "proof-app", [("case_type", "person"), (related_key, property_name)]
            )
            assert request.custom_related_case_property == property_name
            found = utils.get_expanded_case_results(helper, request.custom_related_case_property, [primary_hit])
            assert [case.case_id for case in found] == expected


def test_hq_create_first_changes_an_existing_alias_and_keeps_independent_effects(hq, core_runner):
    """Read the same two rows as Core's case-operation proof, including the cases it already holds."""
    prefix = "nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:"
    conflict, commuting, distinct = prefix + "conflict", prefix + "commuting", "distinct-existing"
    fresh = prefix + "fresh"
    submission = Path(__file__).resolve().parents[1] / "native/core/resources/case-order/update-before-create.xml"
    with hq_check(CONFIGURATION) as (state, _):
        opened = operations.process_case_blocks(
            state, _submission(*(_person(case_id) for case_id in [conflict, commuting, distinct]))
        )
        assert opened.refusal is None
        result = operations.process_case_blocks(
            state, submission.read_bytes(), cases=[meta.case for meta in opened.touched.values()]
        )

    assert result.refusal is None
    assert [block["@case_id"] for block in result.case_blocks] == [
        conflict, commuting, distinct, conflict, commuting, fresh,
    ]
    assert {case_id: meta.case.name for case_id, meta in result.touched.items()} == {
        conflict: "Updated first",
        commuting: "Kept commuting",
        distinct: "Different target",
        fresh: "Fresh independent",
    }
    assert result.touched[commuting].case.case_json["visits"] == "2"


def test_hq_records_childless_and_empty_update_blocks_as_form_history(hq, core_runner):
    from corehq.form_processor.models import CaseTransaction

    template = Path(__file__).resolve().parents[1] / "native/core/resources/case-order/optional-case-action.xml"
    source = template.read_text()
    with hq_check(CONFIGURATION) as (state, _):
        for label, body in (("close", "<close/>"), ("childless", ""), ("update", "<update/>"), ("absent", None)):
            base = operations.process_case_blocks(
                state, _submission(_person("c-known", date_modified="2025-09-30T10:00:00.000000Z"))
            )
            assert base.refusal is None
            known = base.touched["c-known"].case
            prior_modified_on = known.modified_on
            form_id = f"form-effect-{label}"
            content = source.replace("<!--case-block-->", _case("c-known", body) if body is not None else "")
            content = content.replace("form-effect", form_id)
            observed = operations.process_case_blocks(state, content.encode(), cases=[known])

            assert observed.refusal is None
            if body is None:
                assert not observed.case_blocks and not observed.touched
                continue
            assert [block["@case_id"] for block in observed.case_blocks] == ["c-known"]
            current = observed.touched["c-known"].case
            assert current.modified_on > prior_modified_on
            assert current.closed is (label == "close")
            transactions = [
                tx for tx in current.get_tracked_models_to_create(CaseTransaction) if tx.form_id == form_id
            ]
            assert len(transactions) == 1
            assert transactions[0].client_date == current.modified_on


        unseen = source.replace("<!--case-block-->", _case("unseen-case", ""))
        unseen = unseen.replace("form-effect", "form-effect-unseen")
        observed = operations.process_case_blocks(state, unseen.encode())
        assert observed.refusal is None
        untyped = observed.touched["unseen-case"]
        assert untyped.is_creation
        assert untyped.case.type == ""
