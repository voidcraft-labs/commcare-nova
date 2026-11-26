"""What the matrix's tests share: the corpus documents a base is built from, and the bases and variants to run.

``DOCUMENTS`` names every corpus document a test of this package reads,
which is what a stored outcome of the package is keyed by
(``proof.store.queue.PACKAGE_DATA``): ``targeted-save-to-case-shapes``,
whose captured first publish the base ``hq-nova-then-builder`` applies before
it saves every form in HQ's form builder, and location-direct, whose first publish
the owner-rules base uses. The existing-adoption language witness also reads hq-languages.
"""

from __future__ import annotations

import pytest

# Every corpus document a test of this package reads, by id, and no other.
DOCUMENTS = ("location-direct", "targeted-save-to-case-shapes", "hq-languages")


class _Named(dict):
    def __missing__(self, document_id):
        pytest.fail(
            f"A matrix test read the corpus document {document_id}, which proof/matrix/conftest.py::DOCUMENTS does"
            " not name, so a change to it would not invalidate the package's stored outcome. Add it to DOCUMENTS."
        )


@pytest.fixture(scope="session")
def documents():
    """The corpus documents ``DOCUMENTS`` names, by id; a test of a document the corpus lacks, or one
    ``DOCUMENTS`` does not name, fails."""
    from proof.checks import corpus

    found = {document.id: document for document in corpus.load(corpus.corpus_root()).emitted}
    missing = sorted(set(DOCUMENTS) - set(found))
    if missing:
        pytest.fail(
            f"The corpus holds no {missing}, which proof/matrix/conftest.py::DOCUMENTS names as the documents the"
            " matrix's bases are built from. Name documents the corpus holds."
        )
    return _Named({document_id: found[document_id] for document_id in DOCUMENTS})
