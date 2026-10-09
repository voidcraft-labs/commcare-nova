"""HQ's Elasticsearch: HQ's own version, written by HQ's own code, held to a unit's marks.

Contract (``proof.hq.elasticsearch``): the server is the version and plugin
HQ's own image of it holds; a case HQ's receiver saves reaches the case
search index through the case search pillow's own processor, and HQ's own
case search query finds it by what its filter asks; a restore puts every
index back to what the mark held, so a fork reads what a fresh run to the
same point reads; and HQ's client is refused outside a unit and on an index
the lane keeps nothing in. The plausible failures: an index left holding a
document a rolled-back fork wrote (the next run of a walk would find a case
its own HQ never saved); a search answered from documents no filter was
applied to; a pillow change indexed with no refresh, so whether a search sees
it depends on Elasticsearch's own timer; an image whose server is not HQ's
version; and a path answered from an index nothing fills.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from proof.hq import elasticsearch
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.seams import SeamRefused

CONFIGURATION = Configuration(case_search_enabled=True)
OWNER = "proof-owner"


def _image_line(hq_root: Path) -> tuple[str, list[str]]:
    """The version and plugins HQ's own image of its Elasticsearch names (``docker/files/Dockerfile.es.6``)."""
    version, plugins = None, []
    for line in (hq_root / "docker" / "files" / "Dockerfile.es.6").read_text().splitlines():
        words = line.split()
        if words[:1] == ["FROM"]:
            version = words[1].rsplit(":", 1)[1]
        if any(word.endswith("elasticsearch-plugin") for word in words) and "install" in words:
            plugins.append(words[-1])
    return version, plugins


def test_the_server_is_hqs_own_version_with_its_plugin(hq):
    import json
    import urllib.request

    from proof.hq.boot import HQ_ROOT

    version, plugins = _image_line(Path(HQ_ROOT))
    assert version and plugins == ["analysis-phonetic"], (version, plugins)
    with hq_check(CONFIGURATION):
        assert elasticsearch.version() == version
        with urllib.request.urlopen(f"http://{elasticsearch.address()}:9200/_cat/plugins?format=json") as answer:
            installed = sorted(row["component"] for row in json.load(answer))
    assert installed == plugins


def _submit(state, label, *cases):
    """Cases saved through HQ's own receiver, in an operation of the unit."""
    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.hqcase.utils import submit_case_blocks

    from proof.hq import redis as hq_redis

    with hq_redis.shared(None), state.committing():
        with state.operation(label, hashlib.sha256(label.encode()).digest()):
            # Inside the operation, whose clock dates each block.
            blocks = [
                CaseBlock(case_id=case_id, create=True, case_type="person", case_name=name, owner_id=OWNER).as_text()
                for case_id, name in cases
            ]
            submit_case_blocks(blocks, state.domain, user_id=OWNER, device_id="proof")


def _search(state, name=None):
    """HQ's own case search query of the project space's people, by name where given, as its ids in HQ's order."""
    from corehq.apps.es.case_search import CaseSearchES, case_property_query

    query = CaseSearchES().domain(state.domain).case_type("person")
    if name is not None:
        query = query.filter(case_property_query("name", name))
    return [hit["_id"] for hit in query.run().raw_hits]


def test_a_case_hq_saves_is_found_by_its_filter_and_gone_after_a_restore(hq):
    with hq_check(CONFIGURATION) as (state, record):
        empty = state.mark()
        assert _search(state) == []
        _submit(state, "two people", ("case-a", "Asha"), ("case-b", "Bilal"))
        # The pillow's processors wrote the cases, the case search and the forms indexes, and the writes are
        # searchable without waiting on Elasticsearch's own timer.
        assert sorted(_search(state)) == ["case-a", "case-b"]
        assert _search(state, "Bilal") == ["case-b"]
        assert _search(state, "Nobody") == []
        written = {name: state.indexes.documents(name) for name in state.indexes.generation}
        assert sum(1 for docs in written.values() for _, doc_id, _, _ in docs if doc_id in ("case-a", "case-b")) >= 2
        assert any(endpoint == "_search" for _, endpoint, _ in record.elasticsearch_reads)

        two = state.mark()
        _submit(state, "a third", ("case-c", "Chen"))
        assert sorted(_search(state)) == ["case-a", "case-b", "case-c"]

        state.restore(two)
        assert sorted(_search(state)) == ["case-a", "case-b"]
        assert {name: state.indexes.documents(name) for name in state.indexes.generation} == written

        state.restore(empty)
        assert _search(state) == []
        assert all(state.indexes.documents(name) == [] for name in state.indexes.generation)


def test_a_fork_reads_what_a_fresh_run_to_the_same_point_reads(hq):
    def run(detour):
        with hq_check(CONFIGURATION) as (state, _):
            _submit(state, "two people", ("case-a", "Asha"), ("case-b", "Bilal"))
            if detour:
                with state.fork():
                    _submit(state, "a detour", ("case-z", "Zainab"))
                    assert "case-z" in _search(state)
            _submit(state, "a third", ("case-c", "Chen"))
            return _search(state), {name: state.indexes.documents(name) for name in state.indexes.generation}

    assert run(detour=True) == run(detour=False)


def test_hqs_client_is_refused_outside_a_unit_and_on_an_index_the_lane_does_not_keep(hq):
    from corehq.apps.es import AppES, CaseSearchES

    with hq_check(CONFIGURATION) as (state, record):
        # A kept index answers ...
        CaseSearchES().domain(state.domain).count()
        # ... and one no change reaches here is refused, and recorded.
        with pytest.raises(SeamRefused, match="does not keep"):
            AppES().domain(state.domain).count()
        assert record.elasticsearch_refusals
    with pytest.raises(SeamRefused, match="outside every HQ unit"):
        CaseSearchES().domain(state.domain).count()
