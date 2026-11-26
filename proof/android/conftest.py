"""Fixtures for the Android reader's tests that read the corpus (``test_form_reads.py``, ``test_case_blocks.py``,
``test_case_name_guard.py``, ``test_case_lists.py``, ``test_navigation.py``, ``test_missing_media.py``).

``DOCUMENTS`` names every corpus document these tests read, which is what a
stored outcome of this package is keyed by (``proof.store.queue.PACKAGE_DATA``),
as the spelling rules' and Formplayer's tests name theirs. The test modules
take documents from ``android_documents`` and import no corpus reader
themselves.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

# Every corpus document a test of this package reads, by id, and no other.
DOCUMENTS = (
    "hq-question-display",
    "media-language-files",
    "case-list-action-advanced",
    "case-list-action-basic",
    "prompt-periods",
    "prompt-period-spellings",
    "prompt-period-fallback",
    "targeted-receiving-answers",
    "targeted-receiving-answers-android",

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
    "targeted-menu-badges",
    "targeted-media-slots",
    "prompt-checkboxes",
    "targeted-worker-messages",
    "targeted-repeat-invitations",
    "targeted-capture-widgets",
    "targeted-face-photo",
    "search-named-parent",
    "targeted-form-link-hidden-target",
    "targeted-forms-in-menu-above-one-case",
    "targeted-case-choice-values",
    "targeted-sorted-case-choices",
    "targeted-case-choice-reopen",
    "targeted-case-map",
    "targeted-case-list-icon-action",
    "targeted-reached-choice-columns",
    "targeted-relative-case-dates",
    "targeted-hidden-column",
    "targeted-independent-case-order",
    "targeted-nearest-clinics",
    "targeted-hidden-from-menu",
    "targeted-listed-forms",
    "targeted-menu-layouts",
    "targeted-independent-form-choices",
    "targeted-missing-media",
    "targeted-multi-select-destinations",
    "targeted-number-keypad",
    "targeted-question-calendar",
    "targeted-android-app-answers",
    "targeted-plain-help",
    "targeted-plain-labels",
    "targeted-named-answer-root",
    "targeted-preview-android-renders",
    "targeted-search-workflow",
    "targeted-search-workflow-android",
    "targeted-shared-visit-entries",
    "targeted-styled-value",
    "targeted-submitted-groups",
    "targeted-tile-hidden-order",
    "tile-detail-layout",
    "tile-detail-tabs",
    "tile-named-layout",
    "tile-persistent-external",
    "tile-persistent-inline",
    "tile-persistent-line",
    "targeted-connect-recipient-repeat",
    "targeted-connect-section-order",
    "targeted-validated-barcode-secret",
    "targeted-saved-form-descriptor",
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

@pytest.fixture
def android_walk_evidence(request):
    """The unchanged device walk, including its stopping screen or native exception."""
    def write(walk):
        directory = Path(os.environ.get("PROOF_OUT") or "/tmp") / "android" / request.node.name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "walk.json").write_text(json.dumps(walk, ensure_ascii=False, indent=1), encoding="utf-8")

    return write
