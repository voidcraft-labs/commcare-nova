"""HQ's Elasticsearch: HQ's own version, written by HQ's own code, held to a unit's marks.

Contract (``proof.hq.elasticsearch``): the server is the version and plugin
HQ's own image of it holds; a case HQ's receiver saves reaches the case
search index through the case search pillow's own processor, and HQ's own
case search query finds it by what its filter asks; a restore puts every
index back to what the mark held, so a fork reads what a fresh run to the
same point reads; and HQ's client is refused outside a unit and on an index
the lane keeps nothing in. The plausible failures: an index left holding a
document a rolled-back fork wrote (the next run of a walk would find a case
its own HQ never saved), or one HQ wrote after the index's last refresh,
which a delete by query does not find (the next unit would find a user it
never saved); a search answered from documents no filter was
applied to; a pillow change indexed with no refresh, so whether a search sees
it depends on Elasticsearch's own timer; an image whose server is not HQ's
version; and a path answered from an index nothing fills.
"""

from __future__ import annotations

import hashlib
import socket
import threading
from contextlib import nullcontext
from http.client import IncompleteRead
from http.server import BaseHTTPRequestHandler, HTTPServer
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


def test_hqs_clients_keep_the_normal_request_allowance_and_the_longer_export_allowance(hq):
    """HQ's testsettings cuts ordinary requests to five seconds. The lane starts actual services beside every
    reader, so that unit-test shortcut must not reject an indexing request the ordinary deployment allows.
    Inspect the constructed connection pools as well as settings: memoized clients can predate an override."""
    from django.conf import settings
    from settings import ES_SEARCH_TIMEOUT

    assert ES_SEARCH_TIMEOUT == 30  # The pinned HQ's ordinary default, not its testsettings override.
    assert settings.ES_SEARCH_TIMEOUT == ES_SEARCH_TIMEOUT
    with hq_check(CONFIGURATION):
        normal, export = elasticsearch._hq_clients()
        assert [connection.timeout for connection in normal.transport.connection_pool.connections] == [30]
        assert [connection.timeout for connection in export.transport.connection_pool.connections] == [300]
        # Both actual clients reach the live server; the extended export policy is still HQ's own.
        assert normal.info()["version"]["number"] == export.info()["version"]["number"]


@pytest.mark.parametrize("caller", ["hq", "index-setup", "harness"])
def test_a_stalled_elasticsearch_request_fails_and_keeps_the_servers_logs(hq, tmp_path, monkeypatch, caller):
    """A real TCP peer accepts a connection but sends no response. A transport timeout must still fail the
    request and retain the real server's logs outside its disposable directory, whichever client sent it."""
    from elasticsearch6.exceptions import ConnectionTimeout

    from proof.hq.boot import GUARD

    monkeypatch.setenv("PROOF_OUT", str(tmp_path))
    with hq_check(CONFIGURATION), socket.socket() as peer:
        peer.bind(("127.0.0.1", 0))
        peer.listen()
        peer.settimeout(1)
        host, port = peer.getsockname()
        GUARD.admit(host, port)
        client, _ = elasticsearch._hq_clients()
        address = elasticsearch.address()
        try:
            if caller != "harness":
                client.transport.set_connections([{"host": host, "port": port}])
                # Index creation uses HQ's client too, before a unit owns the indexes. Its native request
                # bypasses the unit guard, but must retain diagnostics before failed startup removes them.
                guard = elasticsearch._unwatched() if caller == "index-setup" else nullcontext()
                with guard, pytest.raises(ConnectionTimeout) as raised:
                    client.info(request_timeout=0.01)
            else:
                with monkeypatch.context() as short_request:
                    short_request.setattr(elasticsearch, "HTTP_PORT", port)
                    short_request.setattr(elasticsearch, "REQUEST_SECONDS", 0.01)
                    with pytest.raises(TimeoutError) as raised:
                        elasticsearch._call("GET", "/", address=host)
            # The connection reached the native peer and sent a real HTTP request before timing out.
            connection, _ = peer.accept()
            with connection:
                connection.settimeout(1)
                assert connection.recv(4096).startswith(b"GET / HTTP/1.1")
            assert any("server logs are retained" in note for note in raised.value.__notes__)
            kept = tmp_path / "elasticsearch-failures" / elasticsearch._STATE["directory"].name
            assert list(kept.glob("try-*/elasticsearch.out"))
            assert any(path.read_bytes() for path in kept.glob("try-*/logs/*") if path.is_file())
            assert not list(kept.glob("try-*/data")), "Only diagnostics, never index data, belong in the artifact."
        finally:
            if caller != "harness":
                client.transport.close()
                elasticsearch._point_hq_at(address)


@pytest.mark.parametrize("status", [200, 503])
def test_incomplete_success_and_error_bodies_keep_elasticsearch_logs(hq, tmp_path, monkeypatch, status):
    """A peer closes before its advertised body ends. Both urlopen's ordinary response and HTTPError's body
    must retain diagnostics and propagate the native protocol failure, not interpret partial bytes as evidence."""
    from proof.hq.boot import GUARD

    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(status)
            self.send_header("Content-Length", "50")
            self.end_headers()
            self.wfile.write(b"{}")
            self.close_connection = True

        def log_message(self, *args):
            pass

    monkeypatch.setenv("PROOF_OUT", str(tmp_path))
    with hq_check(CONFIGURATION), HTTPServer(("127.0.0.1", 0), Handler) as server:
        server.timeout = 1
        GUARD.admit("127.0.0.1", server.server_port)
        thread = threading.Thread(target=server.handle_request)
        thread.start()
        try:
            with monkeypatch.context() as peer:
                peer.setattr(elasticsearch, "HTTP_PORT", server.server_port)
                with pytest.raises(IncompleteRead) as raised:
                    elasticsearch._call("GET", "/", address="127.0.0.1")
            assert raised.value.partial == b"{}" and raised.value.expected == 48
            assert requests == ["/"]
            assert any("server logs are retained" in note for note in raised.value.__notes__)
            assert list(tmp_path.glob("elasticsearch-failures/*/try-*/elasticsearch.out"))
        finally:
            thread.join()


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


def test_a_fork_reads_what_a_fresh_run_to_the_same_point_reads(hq, monkeypatch):
    from proof.hq import determinism

    # Compare the branch mechanism with identical inputs, including HQ's timestamps and minted form ids.
    # The weekly unseeded lane still observes its documents with the real clock outside this test.
    monkeypatch.setattr(determinism, "ENABLED", True)

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


def _searchable(name) -> int:
    """How many documents the index's last refresh made searchable, asked of the server beside HQ's client."""
    return elasticsearch._call("GET", f"/{name}/_count")["count"]


def test_a_write_nothing_settled_is_gone_after_a_restore_and_after_the_unit(hq):
    from proof.hq import operations
    from proof.hq import redis as hq_redis

    with hq_check(CONFIGURATION) as (state, _), hq_redis.shared(None), state.committing():
        empty = state.mark()
        # A web user's save writes the users index from HQ's own signal (users/signals.py::_update_user_in_es),
        # with no refresh; here outside every operation, which hq_check allows, so nothing settles it.
        operations.seed_api_user(state, "unsettled-first@example.org")
        written = sorted(name for name, generation in state.indexes.generation.items() if generation)
        assert written and state.indexes.unsettled()
        # The write is in the index and not yet searchable, which is what a delete by query alone misses.
        assert [_searchable(name) for name in written] == [0] * len(written)
        state.restore(empty)
        assert all(state.indexes.documents(name) == [] for name in state.indexes.generation)
        operations.seed_api_user(state, "unsettled-second@example.org")
        assert state.indexes.unsettled()
    # The unit ended with that second write unsettled, and the next unit starts with every index empty.
    with hq_check(CONFIGURATION) as (state, _):
        assert all(state.indexes.documents(name) == [] for name in state.indexes.generation)


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
