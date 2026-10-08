"""What this package's tests share: the corpus documents they read, a request to HQ as a client sends it, and
a page read for what it offers.

``DOCUMENTS`` names every corpus document these tests read, which is what a
stored outcome of the package is keyed by (``proof.store.queue.PACKAGE_DATA``).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

import pytest

# Every corpus document a test of this package reads, by id, and no other.
DOCUMENTS = (
    "case-list-inline",
    "expander-expanddoc-hq-json-projection-case-search-4d53ba11-0",
    "location-direct",
    "lookup-app",
    "search-multiple",
)


class _Named(dict):
    def __missing__(self, document_id):
        pytest.fail(
            f"A views test read the corpus document {document_id}, which proof/views/conftest.py::DOCUMENTS does"
            " not name, so a change to it would not invalidate the package's stored outcome. Add it to DOCUMENTS."
        )


@pytest.fixture(scope="session")
def view_documents():
    """The corpus documents ``DOCUMENTS`` names, by id; a test of a document the corpus lacks fails."""
    from proof.checks import corpus

    found = {document.id: document for document in corpus.load(corpus.corpus_root()).emitted}
    missing = sorted(set(DOCUMENTS) - set(found))
    if missing:
        pytest.fail(
            f"The corpus holds no {missing}, which proof/views/conftest.py::DOCUMENTS names as the documents the"
            " views tests read. Name documents the corpus holds."
        )
    return _Named({document_id: found[document_id] for document_id in DOCUMENTS})


@dataclass(frozen=True)
class Answer:
    """HQ's answer to one request: its status, its headers by name, and its body."""

    status: int
    headers: dict
    body: bytes

    @property
    def content_type(self) -> str:
        return self.headers.get("Content-Type", "")


def ask(unit, method, path, *, body=b"", headers=(), query="", label="request") -> Answer:
    """HQ's answer to one request as a client outside HQ sends it: resolved by HQ's URLconf and answered by the
    view that URL names, behind HQ's own middleware and that view's own decorators, over the unit's state (the
    handler Formplayer's requests are answered by, ``proof.formplayer.hq``)."""
    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer.client import HqRequest

    digest = hashlib.sha256(f"views|{label}|{method}|{path}|{query}|".encode() + body).digest()
    # HQ's locale middleware leaves the request's language active on the thread; the next page the thread
    # renders (an editor page, answered with no middleware) must not inherit it.
    with unit.committing(), unit.request(digest), formplayer_hq._language_put_back():
        response = formplayer_hq._handler().get_response(
            formplayer_hq.django_request(HqRequest(method, path, query, tuple(headers), body))
        )
        if hasattr(response, "render") and not getattr(response, "is_rendered", True):
            response.render()
        content = b"".join(response.streaming_content) if response.streaming else response.content
    return Answer(response.status_code, dict(response.items()), content)


def api_key(unit) -> str:
    """An API key of the project space's web user, made by HQ's own model, as the ``Authorization`` header Nova's
    client sends with it (``lib/commcare/client.ts``, ``ApiKey <username>:<key>``)."""
    from corehq.apps.users.models import HQApiKey
    from django.contrib.auth.models import User

    user = User.objects.get(username=unit.web_user.username)
    # HQ caches a user's lookup by name and clears it when it saves the user. The unit's web user is a document
    # the harness seeds beside HQ's save, so a lookup HQ cached before the document was there (none: its own
    # signal looks the user up when the Django row is made) is cleared here, by the call HQ's save makes.
    unit.web_user.clear_quickcache_for_user()
    key = HQApiKey.objects.create(user=user, name="nova")
    return f"ApiKey {user.username}:{key.plaintext_key}"


def offered(driver, unit, view, app_id, target, bar, selectors) -> dict:
    """Which controls HQ's page offers a person: the page loaded in Chromium by HQ's own page view, its
    JavaScript run, and each selector counted in the document (``driver/steps/pages/offered.js``).

    ``view`` is the page view's URL name, ``target`` the module's or form's unique id (None for the app's own
    page), ``bar`` the selector of a Save bar the loaded page holds, which says the page is ready.
    """
    from django.urls import reverse

    from proof.editors.hq import HQAnswers, editor_build

    editor_build()
    path = reverse(view, args=[unit.domain, app_id] + ([] if target is None else [target]))
    answers = HQAnswers(unit)
    run = driver.run(
        [
            {"goto": path},
            {"until": "pages/ready", "arg": {"bar": bar}},
            {"settle": True},
            {"call": "pages/offered", "arg": dict(selectors)},
        ],
        answer=answers,
    )
    answers.check()
    return {name: counted["held"] for name, counted in run["outcomes"][-1]["value"].items()}


@pytest.fixture
def published():
    """A corpus document as Nova's first publish leaves it in HQ under one of its configurations (or the
    configuration given in its place): ``open(document, name, configuration=None)`` is a context manager whose
    value is ``(unit, app id, export)``."""
    from contextlib import contextmanager

    from proof.hq.check import hq_check
    from proof.observe import publish

    @contextmanager
    def opened(document, name, core_runner, *, configuration=None, create=True):
        export = document.exports[name]
        with hq_check(configuration or export.configuration.hq(), validate=core_runner.validate_form) as (unit, _):
            app_id = None
            if create:
                app_id, refusal, _ = publish.create(unit, export)
                assert refusal is None, refusal
            yield unit, app_id, export

    return opened
