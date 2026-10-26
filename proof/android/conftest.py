"""Fixtures for the Android reader's tests that read the corpus (``test_form_reads.py``, ``test_case_blocks.py``,
``test_case_name_guard.py``, ``test_case_lists.py``, ``test_navigation.py``).

``DOCUMENTS`` names every corpus document these tests read, which is what a
stored outcome of this package is keyed by (``proof.store.queue.PACKAGE_DATA``),
as the spelling rules' and Formplayer's tests name theirs. The test modules
take documents from ``android_documents`` and import no corpus reader
themselves.
"""

from __future__ import annotations

import pytest

# Every corpus document a test of this package reads, by id, and no other.
DOCUMENTS = (
    "case-operation-conditional",
    "case-operation-key",
    "case-operation-query",
    "case-operation-repeat",
    "case-operation-retype",
    "case-operation-sequence",
    "container-query-conditional",
    "expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0",
    "localization-bilingual",
    "navigation-base",
    "targeted-form-link-hidden-target",
    "targeted-hidden-column",
    "targeted-hidden-from-menu",
    "targeted-multi-select-destinations",
    "targeted-preview-android-renders",
    "targeted-tile-hidden-order",
)


class _Named(dict):
    def __missing__(self, document_id):
        pytest.fail(
            f"An Android test read the corpus document {document_id}, which proof/android/conftest.py::DOCUMENTS"
            " does not name, so a change to it would not invalidate the package's stored outcome. Add it to"
            " DOCUMENTS."
        )


@pytest.fixture(scope="session")
def android_documents():
    """The corpus documents ``DOCUMENTS`` names, by id; a test of a document the corpus lacks fails."""
    from proof.checks import corpus

    found = {document.id: document for document in corpus.load(corpus.corpus_root()).emitted}
    missing = sorted(set(DOCUMENTS) - set(found))
    if missing:
        pytest.fail(
            f"The corpus holds no {missing}, which proof/android/conftest.py::DOCUMENTS names as the documents"
            " the Android reader's own tests read. Name documents the corpus holds."
        )
    return _Named({document_id: found[document_id] for document_id in DOCUMENTS})
