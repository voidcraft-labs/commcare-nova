"""The native proofs read in a CI shard exactly what the producers wrote where Nova's node_modules are.

Contract: ``python3 -m proof.native.produce`` runs every product, records
each one's outcome without one failure stopping the others, and a
``NativeSession`` whose corpus carries those products
(``$PROOF_CORPUS/native``) gives each family what its producer wrote and
fails a family whose producer failed with that producer's reason and output,
never running a producer itself. The plausible failures: a shard that reads
a family from somewhere else (an empty or stale directory), one that treats
a failed or silent producer's leftovers as its corpus, and one producer's
failure taking every family down with it.

The products here are made by controlled commands under real family names,
so the session's own lookup and copy run on them; the real producers' output
is what the rest of ``proof/native`` reads in the lane.
"""

import json

import pytest

from proof.native import produce
from proof.native.families import Family
from proof.native.session import NativeSession, ProducerFailed

# Controlled producers under real family names; not named FAMILIES, which the native conftest prefetches.
# Each writes into the directory produce_family appends as its last argument ($0 of sh -c).
CONTROLLED = {
    "xml": Family("xml", ("sh", "-c", 'mkdir -p "$0/nested" && printf one > "$0/a.txt" && printf two > "$0/nested/b"')),
    "case": Family("case", ("sh", "-c", "echo 'the case producer broke here'; exit 3")),
    "tile": Family("tile", ("sh", "-c", "echo 'nothing to write'")),
}


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "index.json").write_text('{"documents": []}\n')
    produced = produce.produce_all(corpus / produce.CORPUS_DIRECTORY, families=CONTROLLED, captures=False, jobs=3)
    monkeypatch.setenv("PROOF_CORPUS", str(corpus))
    return corpus, produced


def test_every_product_is_recorded_and_one_failure_stops_no_other(corpus):
    root, produced = corpus
    products = root / produce.CORPUS_DIRECTORY
    assert produced == json.loads((products / produce.PRODUCED).read_text())
    assert produced["xml"] == {"status": 0, "error": None}
    assert produced["case"]["status"] == 3 and "exited with status 3" in produced["case"]["error"]
    assert produced["tile"] == {"status": 0, "error": "exited cleanly but wrote nothing"}
    assert "the case producer broke here" in (products / "logs" / "case.log").read_text()
    # A reason reads the same wherever it was produced: it names no path of the run's.
    assert str(products) not in produced["case"]["error"]
    with pytest.raises(FileExistsError):
        produce.produce_all(products, families=CONTROLLED, captures=False)


def test_a_shard_reads_each_family_as_produced_and_fails_one_whose_producer_failed(corpus, tmp_path):
    root, _ = corpus
    assert produce.produced_directory() == root / produce.CORPUS_DIRECTORY
    session = NativeSession(tmp_path / "out" / "native", core_runner=None)
    try:
        xml = session.family("xml")
        assert xml == session.out / "xml"
        assert sorted(str(path.relative_to(xml)) for path in xml.rglob("*")) == ["a.txt", "nested", "nested/b"]
        assert (xml / "a.txt").read_text() == "one" and (xml / "nested" / "b").read_text() == "two"
        assert "read:xml" in session.timings and "producer:xml" not in session.timings

        with pytest.raises(ProducerFailed) as broken:
            session.family("case")
        assert "exited with status 3" in str(broken.value)
        assert "where the corpus was produced" in str(broken.value)
        assert "the case producer broke here" in str(broken.value)
        assert not (session.out / "case").exists() or not any((session.out / "case").iterdir())

        with pytest.raises(ProducerFailed, match="wrote nothing"):
            session.family("tile")
        # A family the products do not record is refused, not produced.
        with pytest.raises(ProducerFailed, match="has no record in the corpus's products"):
            session.family("lookup")
    finally:
        session.close()
