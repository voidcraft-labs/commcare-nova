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
"""

from __future__ import annotations

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


def test_a_date_modified_that_is_not_a_date_is_refused(hq, core_runner):
    from casexml.apps.case.exceptions import PhoneDateValueError

    with hq_check(CONFIGURATION) as (state, _):
        refused = operations.process_case_blocks(state, _submission(_person(date_modified="not a date")))

    assert isinstance(refused.refusal, PhoneDateValueError)
    assert str(refused.refusal) == "'not a date'"
    assert refused.touched == {}
