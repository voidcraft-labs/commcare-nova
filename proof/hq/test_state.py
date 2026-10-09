"""HQ's state is complete by construction.

Contract: a path that reads state the harness does not provide fails the
check that runs it; it never reads an empty answer, and what it reads is
what is stored. Each unit's database is a clone of the one HQ's migrations
create, so no table is missing unless the image's dump lacks it, and then
Postgres refuses the query. The plausible failures: the in-memory Couch
answering an unknown view with no rows (what HQ's own ``fakecouch`` does),
handing out stored data by reference so an object HQ changes without saving
changes what is stored (``fakecouch`` does that too, for view rows' values
and for the documents ``include_docs`` adds, which HQ wraps and its wrappers
change), and a missing table going unnoticed because the query ran inside a
Celery task whose exception HQ's settings swallow, or because HQ's own
cleanup after it fails differently inside the unit's transaction than in
production's autocommit.
"""

from __future__ import annotations

import json
import traceback

import pytest

from proof.hq import operations
from proof.hq.branch import AbortedTransaction
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.hq.couch import CollationUnsupported, UnansweredView, collate

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})


def test_an_unanswered_couch_view_raises(hq, core_runner):
    with hq_check(CONFIGURATION) as (state, _):
        from corehq.apps.app_manager.dbaccessors import get_brief_apps_in_domain
        from corehq.apps.domain.models import Domain

        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite")])

        # Answered: computed from the stored documents by the views' own maps.
        assert Domain.get_by_name(state.domain).name == state.domain
        assert [app.get_id for app in get_brief_apps_in_domain(state.domain)] == [app_id]

        # Unanswered: reportconfig/configs_by_domain (a person's saved reports) is not a view any path reads.
        from corehq.apps.saved_reports.models import ReportConfig

        with pytest.raises(UnansweredView, match="reportconfig/configs_by_domain"):
            ReportConfig.by_domain_and_owner(state.domain, "proof-owner", stale=False)


def test_a_view_row_is_a_copy_of_what_is_stored(hq, core_runner):
    """HQ wraps objects from view rows (``get_brief_apps_in_domain`` reads
    ``applications_brief``, whose values the map takes from the stored app).
    Changing one without saving leaves the stored app as it was, as CouchDB's
    wire copy does; a saved change is what the next read sees."""
    with hq_check(CONFIGURATION) as (state, _):
        from corehq.apps.app_manager.dbaccessors import get_app, get_brief_apps_in_domain

        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite")])
        stored_langs = list(state.couch.mock_docs[app_id]["langs"])

        (brief,) = get_brief_apps_in_domain(state.domain)
        brief.build_spec.version = "9.9.9"
        brief.langs.append("xx")
        (unchanged,) = get_brief_apps_in_domain(state.domain)
        assert unchanged.build_spec.version == CONFIGURATION.commcare_version
        assert unchanged.langs == stored_langs == state.couch.mock_docs[app_id]["langs"]

        app = get_app(state.domain, app_id)
        app.name = "Suite, renamed"
        app.save()
        (saved,) = get_brief_apps_in_domain(state.domain)
        assert saved.name == "Suite, renamed"


def test_a_view_rows_document_is_a_copy_of_what_is_stored(hq, core_runner):
    """``get_apps_in_domain`` reads ``applications`` with ``include_docs`` and
    wraps each row's document: the wrapper holds the dictionary it wrapped
    and writes through to it. Changing the wrapped app without saving leaves
    the stored app as it was; saving it is what the next read sees."""
    with hq_check(CONFIGURATION) as (state, _):
        from corehq.apps.app_manager.dbaccessors import get_apps_in_domain

        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite")])
        stored = json.dumps(state.couch.mock_docs[app_id], sort_keys=True)

        (app,) = get_apps_in_domain(state.domain)
        assert app.get_id == app_id and app.name == "Suite"
        app.name = "Changed, not saved"
        app.langs.append("xx")
        app.modules[0].case_type = "changed"
        assert json.dumps(state.couch.mock_docs[app_id], sort_keys=True) == stored
        (again,) = get_apps_in_domain(state.domain)
        assert again.name == "Suite" and "xx" not in again.langs

        rows = state.couch.raw_view(
            "app_manager/applications",
            {"startkey": [state.domain, None], "endkey": [state.domain, None, {}], "include_docs": True},
        )
        (row,) = [row for row in rows["rows"] if row["id"] == app_id]
        row["doc"]["name"] = "Changed in the row"
        assert state.couch.mock_docs[app_id]["name"] == "Suite"

        app.save()
        (saved,) = get_apps_in_domain(state.domain)
        assert saved.name == "Changed, not saved" and saved.modules[0].case_type == "changed"


def _chain(error):
    """The error and every error it was raised while handling, outermost first."""
    found = []
    while error is not None and error not in found:
        found.append(error)
        error = error.__cause__ or error.__context__
    return found


def test_a_missing_table_fails_loudly_inside_the_data_dictionary_task(hq, core_runner):
    """A path that reaches a table the harness's database lacks fails the
    check, even where the query runs inside a Celery task HQ's save starts:
    the same publish writes the data dictionary on a whole clone, and raises
    once the unit's database loses the table the refresh writes.

    Inside the unit's transaction the failed statement aborts it, so HQ's own
    cleanup after the error (``blobs/mixin.py::atomic_blobs_context`` deleting
    the blobs it put) fails too, where production's autocommit lets it run:
    the error HQ raised is the one the cleanup was handling, and the unit
    refuses to end as if nothing happened (``AbortedTransaction``)."""
    upload = nova_shaped_upload(hq_test_app(), "Suite")

    with hq_check(CONFIGURATION) as (state, _):
        from corehq.apps.data_dictionary.models import CaseProperty

        operations.publish(state, [upload])
        assert CaseProperty.objects.filter(case_type__domain=state.domain).exists()

    from django.db.utils import ProgrammingError

    with pytest.raises(AbortedTransaction, match="connection (marked for rollback|in an aborted transaction)"):
        with hq_check(CONFIGURATION) as (state, _):
            from django.db import connection

            with connection.cursor() as cursor:
                # CASCADE drops only the foreign keys other tables hold to it.
                cursor.execute("DROP TABLE data_dictionary_caseproperty CASCADE")
            with pytest.raises(Exception) as raised:
                operations.publish(state, [upload])

    missing = [
        error
        for error in _chain(raised.value)
        if isinstance(error, ProgrammingError)
        and 'relation "data_dictionary_caseproperty" does not exist' in str(error)
    ]
    assert len(missing) == 1, _chain(raised.value)
    # The query ran in the refresh task Application.save starts, and still
    # reached the caller.
    frames = [frame.name for frame in traceback.extract_tb(missing[0].__traceback__)]
    assert "_refresh_data_dictionary_from_app" in frames

    # The table is back for the next unit: the drop was rolled back with it.
    with hq_check(CONFIGURATION) as (state, _):
        operations.publish(state, [upload])
        assert CaseProperty.objects.filter(case_type__domain=state.domain).exists()


def test_views_order_keys_by_couchdb_collation():
    # CouchDB's documented order: null, false, true, numbers, strings (ICU,
    # lowercase before uppercase), arrays element by element, objects.
    ordered = [None, False, True, 1, 2.5, "a", "A", "aa", "b", "B", "ba", "bb", ["a"], ["a", "b"], ["a", {}], {}]
    shuffled = list(reversed(ordered))
    from functools import cmp_to_key

    assert sorted(shuffled, key=cmp_to_key(collate)) == ordered
    # Punctuation sorts before digits, and digits before letters, unlike code points.
    assert sorted(["b", "1", "_", "A"], key=cmp_to_key(collate)) == ["_", "1", "A", "b"]
    # The harness orders printable ASCII only; other text it refuses to order.
    assert collate("\u00e9", "e\u0301") == 0  # canonically equivalent: equal under ICU
    with pytest.raises(CollationUnsupported):
        collate("\u00e9", "e")
