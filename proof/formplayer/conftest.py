"""Fixtures for the Formplayer runner's own tests (the session's runner itself is ``proof/conftest.py``'s).

``DOCUMENTS`` names every corpus document these tests read, which is what a
stored outcome of this package is keyed by (``proof.store.queue.PACKAGE_DATA``),
as the spelling rules' tests name theirs.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

# Every corpus document a test of this package reads, by id, and no other.
DOCUMENTS = (
    "case-capture-multiple",
    "case-capture-repeat",
    "case-extension-registration",
    "case-operation-conditional",
    "case-operation-key",
    "case-operation-query",
    "case-operation-sequence",
    "media-rich",
    "navigation-base",
    "prompt-widgets",
    "search-hidden-link",
    "search-remote-defaults",
    "targeted-form-link-hidden-target",
    "targeted-hidden-from-menu",
    "targeted-invalid-question-ids",
    "targeted-lookup-reserved-tags",
    "targeted-media-slots",
    "targeted-multi-select-destinations",
    "targeted-save-to-case-read",
    "targeted-search-hq-compile",
    "targeted-validated-barcode-secret",
)
# Every retained control (``proof/controls/``) a test of this package reads, by id, and no other.
CONTROLS = ("targeted-lookup-reserved-tags",)


class _Named(dict):
    def __missing__(self, document_id):
        pytest.fail(
            f"A Formplayer test read the corpus document {document_id}, which proof/formplayer/conftest.py::DOCUMENTS"
            " does not name, so a change to it would not invalidate the package's stored outcome. Add it to"
            " DOCUMENTS."
        )


@pytest.fixture(scope="session")
def formplayer_documents():
    """The corpus documents ``DOCUMENTS`` names, by id; a test of a document the corpus lacks fails."""
    from proof.checks import corpus

    found = {document.id: document for document in corpus.load(corpus.corpus_root()).emitted}
    missing = sorted(set(DOCUMENTS) - set(found))
    if missing:
        pytest.fail(
            f"The corpus holds no {missing}, which proof/formplayer/conftest.py::DOCUMENTS names as the documents"
            " Formplayer's own tests read. Name documents the corpus holds."
        )
    return _Named({document_id: found[document_id] for document_id in DOCUMENTS})


@pytest.fixture(scope="session")
def formplayer_controls():
    """The retained controls ``CONTROLS`` names, by id; a test of a control ``proof/controls/`` lacks fails."""
    from proof.checks import corpus

    found = {control.id: control for control in corpus.load_controls() if control.id in CONTROLS}
    missing = sorted(set(CONTROLS) - set(found))
    if missing:
        pytest.fail(
            f"proof/controls holds no {missing}, which proof/formplayer/conftest.py::CONTROLS names as the controls"
            " Formplayer's own tests read. Name controls proof/controls holds."
        )
    return found


@pytest.fixture
def evidence(request):
    """Writes what a test observed into the run's output (``formplayer/<test>/<name>.json``), for a person to read."""

    def write(name, value):
        directory = Path(os.environ.get("PROOF_OUT") or "/tmp") / "formplayer" / request.node.name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{name}.json").write_text(
            json.dumps(value, indent=1, sort_keys=True, ensure_ascii=False), encoding="utf-8"
        )

    return write
