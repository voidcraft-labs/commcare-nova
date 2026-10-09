"""Fixtures for the Web Apps driver's own tests (the session's services are ``proof/conftest.py``'s).

``DOCUMENTS`` names every corpus document these tests read, which is what a
stored outcome of this package is keyed by (``proof.store.queue.PACKAGE_DATA``),
as the Formplayer runner's tests name theirs.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

# Every corpus document a test of this package reads, by id, and no other.
DOCUMENTS = (
    "case-list-browse",
    "case-list-inline",
    "media-only",
    "search-browse",
    "targeted-custom-tile",
    "targeted-empty-list-no-english",
    "targeted-form-link-hidden-target",
    "targeted-hidden-column",
    "targeted-media-slots",
    "targeted-survey-menu",
)


class _Named(dict):
    def __missing__(self, document_id):
        pytest.fail(
            f"A Web Apps test read the corpus document {document_id}, which proof/webapps/conftest.py::DOCUMENTS"
            " does not name, so a change to it would not invalidate the package's stored outcome. Add it to"
            " DOCUMENTS."
        )


@pytest.fixture(scope="session")
def webapps_documents():
    """The corpus documents ``DOCUMENTS`` names, by id; a test of a document the corpus lacks fails."""
    from proof.checks import corpus

    found = {document.id: document for document in corpus.load(corpus.corpus_root()).emitted}
    missing = sorted(set(DOCUMENTS) - set(found))
    if missing:
        pytest.fail(
            f"The corpus holds no {missing}, which proof/webapps/conftest.py::DOCUMENTS names as the documents"
            " the Web Apps tests read. Name documents the corpus holds."
        )
    return _Named({document_id: found[document_id] for document_id in DOCUMENTS})


@pytest.fixture
def evidence(request):
    """Writes what a test observed into the run's output (``webapps/<test>/<name>.json``), for a person to read."""

    def write(name, value):
        directory = Path(os.environ.get("PROOF_OUT") or "/tmp") / "webapps" / request.node.name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{name}.json").write_text(
            json.dumps(value, indent=1, sort_keys=True, ensure_ascii=False), encoding="utf-8"
        )

    return write
