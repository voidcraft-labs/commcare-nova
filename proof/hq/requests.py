"""Requests HQ's views receive, carrying what HQ's middleware would attach.

A request built here passes HQ's view decorators as a signed-in editor's
request does (``domain/decorators.py::login_and_domain_required``,
``users/decorators.py::require_permission_raw``):

- ``request.user``: an active Django user for the acting web user;
- ``request.couch_user``: that ``WebUser``, active and a domain admin of the
  check's project space, so it may edit apps;
- ``request.domain`` and ``request.project`` (the ``Domain``), which HQ's
  ``UsersMiddleware`` and ``load_domain`` set, and what ``UsersMiddleware``
  sets for the user: the couch user's ``current_domain`` (HQ's templates ask
  ``request.couch_user.can_edit_apps`` with no domain, and
  ``users/models.py::_get_perm_check_fn`` answers for ``current_domain``) and
  ``request.analytics_enabled``, off as the web user's own setting is;
- a cache-backed session and message storage (HQ's views call
  ``messages.warning``, and the import API returns those messages as its
  warnings);
- optionally the ``lang`` cookie HQ's app manager reads.

``held_get`` also holds its request as HQ's server holds the one it is
answering, where ``get_request()`` reads it.
"""

from contextlib import contextmanager


def _factory():
    from django.test import RequestFactory

    return RequestFactory()


def _attach(request, state, lang=None):
    from corehq.apps.domain.models import Domain
    from django.contrib.auth.models import User
    from django.contrib.messages.storage.fallback import FallbackStorage
    from django.contrib.sessions.backends.cache import SessionStore

    request.session = SessionStore()
    request._messages = FallbackStorage(request)
    request.user = User.objects.get(username=state.web_user.username)
    request.couch_user = state.web_user
    request.couch_user.current_domain = state.domain
    request.analytics_enabled = state.web_user.analytics_enabled
    request.domain = state.domain
    request.project = Domain.get_by_name(state.domain)
    if lang is not None:
        request.COOKIES["lang"] = lang
    return request


def get(state, path, data=None, *, lang=None):
    return _attach(_factory().get(path, data or {}), state, lang)


@contextmanager
def held_get(state, path, data=None, *, lang=None):
    """A GET request held for the block as HQ's server holds the request it is answering.

    ``corehq/util/global_request/middleware.py::GlobalRequestMiddleware`` sets
    the request (``process_request``) before ``UsersMiddleware`` looks up the
    user and the project space, and sets None once the response comes back
    (``process_response``), its templates rendered and the bootstrap version
    ``ThreadLocalCleanupMiddleware`` clears already cleared. So the request is
    set here the moment it exists, before ``_attach``'s lookups, and the block
    holds the view and its rendering. HQ reads it through ``get_request()``:
    quickcache keeps its per-request memo with it
    (``corehq/util/quickcache.py::get_session_key``, which
    ``Domain.get_by_name`` uses), and the superuser check, the request's time
    zone and a form's rendering context read it too.
    """
    from corehq.util.global_request.api import set_request

    request = _factory().get(path, data or {})
    set_request(request)
    try:
        yield _attach(request, state, lang)
    finally:
        set_request(None)


def form_post(state, path, pairs, *, lang=None):
    """A form-encoded POST of ``(name, value)`` pairs, a name repeated as often as it is sent.

    Formplayer sends a case search this way (``WebClient.postFormData``).
    """
    from urllib.parse import urlencode

    body = urlencode(list(pairs))
    return _attach(
        _factory().generic("POST", path, data=body, content_type="application/x-www-form-urlencoded"), state, lang
    )


def raw_post(state, path, body: bytes, content_type: str, *, lang=None):
    """A POST of exact bytes, such as a captured multipart upload."""
    return raw(state, "POST", path, body, content_type, lang=lang)


def raw(state, method, path, body: bytes, content_type: str, *, lang=None):
    """A request of any method with exact bytes as its body, such as the PUT HQ's lookup table editor sends."""
    return _attach(_factory().generic(method, path, data=body, content_type=content_type), state, lang)


def messages(request):
    """The messages HQ's view left on the request, as text."""
    from django.contrib.messages import get_messages

    return [str(message) for message in get_messages(request)]
