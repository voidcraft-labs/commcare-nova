"""The Elasticsearch reads on the checks' paths, each answered as an empty index.

HQ's state has no Elasticsearch. The paths the checks run reach it in these
places, recorded here with the reason an empty answer is faithful:

- ``reports/analytics/esaccessors.py::get_case_types_for_domain_es``, from
  the data dictionary refresh every app save starts
  (``app_manager/tasks.py::refresh_data_dictionary_from_app`` ->
  ``data_cleaning/utils/cases.py::clear_caches_case_data_cleaning`` ->
  ``get_case_types_for_domain``). Its result only chooses which cached
  entries to clear, after the refresh has written the data dictionary rows,
  and a new project space's case index holds no cases.
- ``app_manager/views/utils.py::form_has_submissions``, which Vellum's options
  read (``views/formdesigner.py::_get_vellum_core_context``, its
  ``hasSubmissions``) and Vellum asks again through
  ``views/forms.py::FormHasSubmissionsView``. It counts the form's
  submissions in the form index, and a check's app has never received one.
- ``users/dbaccessors.py::get_practice_mode_mobile_workers``, which the app
  manager's page contexts read under the ``PRACTICE_MOBILE_WORKERS``
  privilege (``views/apps.py::get_apps_base_context`` and
  ``get_app_view_context``, for the practice user select). It lists the
  project space's mobile workers in practice mode from the user index; a
  check's project space has no mobile worker but the lane's own, made where
  Formplayer is served (``proof.formplayer.hq``), who is in no practice mode.

Every other Elasticsearch request is refused at the client's transport
(``elasticsearch6.transport.Transport.perform_request``) and recorded, so a
path that grows a new read fails the check that reaches it.
"""

from contextlib import ExitStack, contextmanager
from unittest import mock

from proof.hq.seams import SeamRecord, SeamRefused, rebound


@contextmanager
def elasticsearch(record: SeamRecord):
    from corehq.apps.app_manager.views import utils as app_manager_view_utils
    from corehq.apps.reports.analytics import esaccessors
    from corehq.apps.users import dbaccessors as user_dbaccessors
    from elasticsearch6.transport import Transport

    def get_case_types_for_domain_es(domain, use_case_search=False):
        record.elasticsearch_reads.append(("get_case_types_for_domain_es", domain, use_case_search))
        return set()

    def form_has_submissions(domain, app_id, xmlns):
        record.elasticsearch_reads.append(("form_has_submissions", domain, app_id, xmlns))
        return False

    def get_practice_mode_mobile_workers(domain):
        record.elasticsearch_reads.append(("get_practice_mode_mobile_workers", domain))
        return []

    # Two of HQ's functions are quickcaches, and HQ asks each what it holds and clears it: a mobile worker's
    # save the practice workers (``users/models.py::CommCareUser.clear_quickcache_for_user``), and every case
    # HQ saves the case types (``reports/signals.py::clear_case_type_cache``). A stand-in keeps nothing, so it
    # holds nothing (quickcache's own answer for a value it does not hold) and has nothing to clear.
    for uncached in (get_practice_mode_mobile_workers, get_case_types_for_domain_es):
        uncached.get_cached_value = lambda *args, **kwargs: Ellipsis
        uncached.clear = lambda *args, **kwargs: None

    def perform_request(self, method, url, headers=None, params=None, body=None):
        record.elasticsearch_refusals.append((method, url))
        raise SeamRefused(
            f"HQ sent Elasticsearch {method} {url}. The harness has no "
            "Elasticsearch; answer this read in proof/hq/elasticsearch.py if a path needs it."
        )

    with ExitStack() as stack:
        stack.enter_context(rebound(esaccessors.get_case_types_for_domain_es, get_case_types_for_domain_es))
        stack.enter_context(rebound(app_manager_view_utils.form_has_submissions, form_has_submissions))
        stack.enter_context(
            rebound(user_dbaccessors.get_practice_mode_mobile_workers, get_practice_mode_mobile_workers)
        )
        stack.enter_context(mock.patch.object(Transport, "perform_request", perform_request))
        yield record
