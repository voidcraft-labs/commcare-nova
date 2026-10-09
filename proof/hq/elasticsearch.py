"""HQ's Elasticsearch: the version HQ runs, one server a process, its indexes held to each unit's state.

HQ reads Elasticsearch on the lane's paths: the case search a worker's
search sends (``case_search/utils.py::get_case_search_results``), the
related-case lookups HQ's search compiler runs while it compiles
(``xpath_functions/ancestor_functions.py``), whether a form has
submissions, which Vellum's options read
(``app_manager/views/utils.py::form_has_submissions``), the project space's
practice mobile workers, which the app manager's page contexts read
(``users/dbaccessors.py::get_practice_mode_mobile_workers``), and the case
types the data dictionary refresh clears cached entries for
(``reports/analytics/esaccessors.py::get_case_types_for_domain_es``). Each
of those runs here against a real Elasticsearch of HQ's own version
(``docker/files/Dockerfile.es.6``: 6.8.23 with the phonetic analysis
plugin, held to the image by ``test_elasticsearch.py``), which the process
starts on first use on a loopback address of its own and stops when it ends
(``start``), as each worker has its own Postgres clone and Redis.

**The indexes** are the four those reads read (``KEPT``), each created as
HQ's own test suite creates the index a test needs
(``es/tests/utils.py::es_test``: HQ's ``CreateIndex`` operation over the
adapter's own mapping, analysis and settings key, and HQ's own tuning
settings for tests, one shard and no replica), primary and secondary where
HQ multiplexes. A request HQ sends to any other index, or to none (but the
server's own version, which HQ's adapters ask for), is refused and
recorded: no change reaches another index here, so an answer from it would
be the harness's, not HQ's. HQ's client reaches the process's server
(``_point_hq_at``), and only while a unit with seams is open
(``proof.hq.state.open_unit``): a request outside one is refused, so
nothing writes to an index that no unit's state accounts for.

**What writes to them** is HQ's own code: a user's save writes the user
(``users/signals.py::update_user_in_es``), and every change HQ publishes for
its pillows (``ChangeProducer.send_change``, which the unit records in
place of Kafka) is read as HQ's change feed reads a Kafka message
(``change_feed/consumer/feed.py::change_from_kafka_message``) and handed to
the Elasticsearch processors of the pillows that read its topic, as HQ
constructs them (``pillows/case.py::get_case_pillow``: the cases index and
the case search index; ``pillows/xform.py::get_xform_pillow``: the forms
index). Their other processors (configurable reports, messaging, the form
metadata tracker) write SQL and Couch, not an index, and are not run. A
pillow runs behind production's requests; here it has caught up before the
next request: the changes a unit's operation or request published are
indexed as it ends, under its own key and clock (``Unit._scoped``).

**What is held to the unit's state**, so each fork of a unit reads exactly
what a fresh run to the same point reads (``UnitIndexes``):

- each unit starts with every kept index empty, as a new project space's
  indexes hold none of its documents;
- a mark keeps what each index holds (its documents in the order the index
  holds them, read once per state), and a restore puts back each index a
  write touched since: every document removed, the marked ones written
  again in their order;
- Elasticsearch's own refresh timer (HQ's ``index.refresh_interval`` of 5 s)
  is held, as the pages' repeating timers are: a write is searchable once HQ
  asks for a refresh itself (``refresh=True``) or once its operation or
  request ends, where the harness refreshes each index it wrote. There each
  index is also merged to one segment, so what a search scores against
  (Lucene's term statistics, which count a replaced document until a merge
  drops it) and the order it gives documents that score alike (HQ's case
  search sorts by score, then by ``_doc``) never depend on when
  Elasticsearch's own merges happened to run.

The harness's own requests to the server (creating, emptying, reading and
refilling an index, refreshing and merging it) go over the standard
library's HTTP client, beside HQ's client and never through it, so they are
not HQ's requests and are never recorded as HQ's.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

from proof import processes
from proof.hq.seams import SeamRecord, SeamRefused

HTTP_PORT = 9200
TRANSPORT_PORT = 9300
START_SECONDS = 120.0
# Loopback addresses tried, in order from the one this process's id names: 127.2.<a>.<b>, apart from HQ's Redis
# (127.1.<a>.<b>, proof.hq.redis) and a Formplayer runner's (127.0.<a>.<b>, proof.formplayer.client).
ADDRESSES = 200
# Heap enough for a document's indexes, which hold a few dozen documents each.
HEAP = "-Xms256m -Xmx256m"
# Elasticsearch's own refresh timer, held (the module's "What is held").
REFRESH_HELD = {"index.refresh_interval": "-1"}

# The adapters whose indexes the lane's paths read (by HQ's canonical name for each).
KEPT_CANONICAL = ("cases", "case_search", "forms", "users")

_STATE: dict = {
    "owner": None,
    "group": None,
    "address": None,
    "directory": None,
    # Each kept index's name -> the documents it was created empty with ([]), set as the server starts.
    "indexes": None,
    # The unit whose indexes HQ's client may read and write now, or None.
    "unit": None,
    "installed": False,
    # Inside the harness's own creation of the indexes, which runs HQ's operation through HQ's client.
    "unwatched": False,
    # Whether every kept index is known empty (as created, or as the last unit left them).
    "clean": False,
}


class ElasticsearchFailed(RuntimeError):
    """HQ's Elasticsearch did not come up, or refused one of the harness's own requests."""


# The server -----------------------------------------------------------------------------------------


def _home() -> Path:
    home = os.environ.get("PROOF_ELASTICSEARCH")
    if not home or not (Path(home) / "bin" / "elasticsearch").exists():
        raise ElasticsearchFailed(
            "HQ's Elasticsearch is not in this image (PROOF_ELASTICSEARCH names no installation). The proof "
            "image installs it at /opt/elasticsearch (proof/image/Dockerfile, the elasticsearch stage); run the "
            "image proof/image.lock records, or a local build of the recipe."
        )
    return Path(home)


def _stop():
    if _STATE["owner"] != os.getpid():
        return
    group, directory = _STATE["group"], _STATE["directory"]
    _STATE.update(owner=None, group=None, address=None, directory=None, indexes=None, unit=None, clean=False)
    if group is not None:
        group.stop()
    if directory is not None:
        shutil.rmtree(directory, ignore_errors=True)


def _as_runtime_user() -> list[str]:
    """Elasticsearch refuses to run as root, which the lane's container is; the image's ``elasticsearch``
    user runs it there."""
    return ["setpriv", "--reuid=elasticsearch", "--regid=elasticsearch", "--init-groups"] if os.geteuid() == 0 else []


def _chown(path: Path):
    if os.geteuid() == 0:
        shutil.chown(path, "elasticsearch", "elasticsearch")
        for child in path.rglob("*"):
            shutil.chown(child, "elasticsearch", "elasticsearch")


def _call(method: str, path: str, body=None, *, address=None, ndjson=False, expect=(200, 201)):
    """One of the harness's own requests to the server, its JSON answer."""
    address = address or _STATE["address"]
    if ndjson:
        data = "".join(json.dumps(line, sort_keys=True) + "\n" for line in body).encode()
        content_type = "application/x-ndjson"
    else:
        data = None if body is None else json.dumps(body, sort_keys=True).encode()
        content_type = "application/json"
    request = urllib.request.Request(
        f"http://{address}:{HTTP_PORT}{path}", data=data, method=method, headers={"Content-Type": content_type}
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as answer:
            status, text = answer.status, answer.read()
    except urllib.error.HTTPError as error:
        status, text = error.code, error.read()
    if status not in expect:
        raise ElasticsearchFailed(
            f"HQ's Elasticsearch answered the harness's {method} {path} with {status}: "
            f"{text.decode('utf-8', errors='replace')[:2000]}"
        )
    return json.loads(text) if text else {}


def start() -> str:
    """Start this process's server if it has none, create the kept indexes, point HQ's client at it, and return
    its address."""
    if _STATE["owner"] == os.getpid() and _STATE["address"] is not None:
        return _STATE["address"]
    # A forked worker inherits its parent's record of a server it does not own.
    _STATE.update(owner=None, group=None, address=None, directory=None, indexes=None, unit=None)
    from proof.hq.boot import GUARD

    home = _home()
    directory = Path(tempfile.mkdtemp(prefix="proof-hq-elasticsearch-"))
    directory.chmod(0o755)
    tried = []
    for offset in range(ADDRESSES):
        slot = (os.getpid() + offset) % (ADDRESSES * 200)
        address = f"127.2.{slot // 200 + 1}.{slot % 200 + 2}"
        run = directory / f"try-{offset}"
        run.mkdir()
        # Elasticsearch writes its keystore into its configuration directory, so each server has a copy.
        shutil.copytree(home / "config", run / "config")
        (run / "data").mkdir()
        (run / "logs").mkdir()
        _chown(run)
        log = run / "elasticsearch.out"
        environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LANG": "C.UTF-8",
            "ES_PATH_CONF": str(run / "config"),
            "ES_JAVA_OPTS": HEAP,
            "ES_TMPDIR": str(run / "data"),
        }
        with log.open("wb") as output:
            group = processes.ProcessGroup(
                [
                    *_as_runtime_user(),
                    str(home / "bin" / "elasticsearch"),
                    "-E",
                    "cluster.name=proof",
                    "-E",
                    "node.name=proof",
                    "-E",
                    "discovery.type=single-node",
                    "-E",
                    f"network.host={address}",
                    "-E",
                    f"http.port={HTTP_PORT}",
                    "-E",
                    f"transport.port={TRANSPORT_PORT}",
                    "-E",
                    f"path.data={run / 'data'}",
                    "-E",
                    f"path.logs={run / 'logs'}",
                    # HQ's own configuration of its server (docker/files/elasticsearch_6.yml).
                    "-E",
                    "action.auto_create_index=.watches,.triggered_watches,.watcher-history-*",
                ],
                cwd=str(run),
                env=environment,
                stdout=output,
                stderr=subprocess.STDOUT,
            )
        waited = time.perf_counter()
        ready = False
        GUARD.admit(address, HTTP_PORT)
        while time.perf_counter() - waited < START_SECONDS:
            if group.wait(0.1):
                break
            try:
                health = _call("GET", "/_cluster/health?wait_for_status=green&timeout=1s", address=address)
            except (OSError, ElasticsearchFailed):
                continue
            if health.get("status") == "green":
                ready = True
                break
        if ready:
            _STATE.update(owner=os.getpid(), group=group, address=address, directory=directory)
            atexit.register(_stop)
            try:
                _point_hq_at(address)
                _create_indexes()
            except BaseException:
                _stop()
                raise
            return address
        group.stop()
        output = log.read_text(encoding="utf-8", errors="replace")
        tried.append(f"{address}: {output[-1500:]}")
        if "BindException" not in output and "Address already in use" not in output:
            break
    shutil.rmtree(directory, ignore_errors=True)
    raise ElasticsearchFailed(
        "The harness could not start HQ's Elasticsearch. What each try wrote:\n" + "\n".join(tried)
    )


def stop() -> None:
    """Stop this process's server (a test's own; the process's is stopped as it ends)."""
    _stop()


def address() -> str | None:
    """The process's server's address, or None while it runs nowhere here."""
    return _STATE["address"] if _STATE["owner"] == os.getpid() else None


def version() -> str:
    """The version the process's server reports."""
    return _call("GET", "/")["version"]["number"]


def _adapters():
    """Each kept index's adapter, primary and secondary where HQ multiplexes (``es_test``'s own iteration)."""
    from corehq.apps.es.client import ElasticMultiplexAdapter
    from corehq.apps.es.transient_util import doc_adapter_from_cname

    for canonical in KEPT_CANONICAL:
        adapter = doc_adapter_from_cname(canonical)
        if isinstance(adapter, ElasticMultiplexAdapter):
            yield adapter.primary
            yield adapter.secondary
        else:
            yield adapter


def _create_indexes():
    """Each kept index, as HQ's test suite creates one (``es_test``'s ``CreateIndex``), with its refresh timer
    held. HQ's operation sends its requests through HQ's client, already pointed at the new server."""
    from corehq.apps.es.migration_operations import CreateIndex

    names = {}
    with _unwatched():
        for adapter in _adapters():
            CreateIndex(adapter.index_name, adapter.type, adapter.mapping, adapter.analysis, adapter.settings_key).run()
            names[adapter.index_name] = adapter.type
    for name in names:
        _call("PUT", f"/{name}/_settings", REFRESH_HELD)
    _call("GET", "/_cluster/health?wait_for_status=green&timeout=60s")
    _STATE["indexes"] = names
    _STATE["clean"] = True


def _hq_clients():
    from corehq.apps.es.client import _client_default, _client_for_export

    return (_client_default(), _client_for_export())


def _point_hq_at(address):
    """HQ's own clients (``es/client.py::get_client``, memoized as HQ's module imports) reach the process's
    server, as its settings name it (``ELASTICSEARCH_HOST`` and ``ELASTICSEARCH_PORT``)."""
    from django.conf import settings

    settings.ELASTICSEARCH_HOST = address
    settings.ELASTICSEARCH_PORT = HTTP_PORT
    settings.ELASTICSEARCH_HOSTS = []
    for client in _hq_clients():
        client.transport.set_connections([{"host": address, "port": HTTP_PORT}])


# What HQ asks of it ---------------------------------------------------------------------------------------

# The endpoints that read: a request to one of these changes no index.
_READS = frozenset({"_search", "_count", "_mget", "_msearch", "_validate", "_explain", "_analyze", "scroll"})
# Requests that keep an index's documents as they are while changing when they are visible or stored.
_MAINTENANCE = frozenset({"_refresh", "_flush", "_forcemerge"})


def _segments(url) -> list[str]:
    return [part for part in str(url).split("?")[0].split("/") if part]


def _bulk_indexes(body) -> set[str]:
    """Every index a bulk request's actions name (each action line of its newline-delimited JSON)."""
    if isinstance(body, bytes):
        body = body.decode("utf-8")
    lines = body.splitlines() if isinstance(body, str) else list(body or [])
    named = set()
    for line in lines:
        action = json.loads(line) if isinstance(line, str) else line
        if not isinstance(action, dict):
            continue
        for verb in ("index", "create", "update", "delete"):
            if verb in action and isinstance(action[verb], dict) and "_index" in action[verb]:
                named.add(action[verb]["_index"])
    return named


def _mget_indexes(body) -> set[str]:
    if isinstance(body, (bytes, str)):
        body = json.loads(body)
    return {doc["_index"] for doc in (body or {}).get("docs", []) if isinstance(doc, dict) and "_index" in doc}


def classify(method: str, url, body) -> tuple[set[str], bool]:
    """``(indexes, writes)``: the indexes an HQ request names and whether it may change what one holds."""
    parts = _segments(url)
    endpoint = next((part for part in parts if part.startswith("_")), None)
    indexes = set(parts[0].split(",")) if parts and not parts[0].startswith("_") else set()
    if endpoint == "_bulk":
        indexes |= _bulk_indexes(body)
    elif endpoint == "_mget":
        indexes |= _mget_indexes(body)
    if method in ("GET", "HEAD") or endpoint in _READS or endpoint in _MAINTENANCE:
        return indexes, False
    return indexes, True


def _refuse(record, method, url, why):
    if record is not None:
        record.elasticsearch_refusals.append((method, str(url)))
    raise SeamRefused(f"HQ sent Elasticsearch {method} {url}, {why}")


def install() -> None:
    """Watch every request HQ's Elasticsearch client sends (``Transport.perform_request``), for the process's
    life: refused outside a unit that holds the indexes, and to any index the lane does not keep; recorded in
    the unit's seams' record; and each write noted in the unit's state."""
    if _STATE["installed"]:
        return
    from elasticsearch6.transport import Transport

    held = Transport.perform_request

    def perform_request(self, method, url, headers=None, params=None, body=None):
        if _STATE.get("unwatched"):
            return held(self, method, url, headers=headers, params=params, body=body)
        indexes_of_unit = _STATE["unit"]
        unit = None if indexes_of_unit is None else indexes_of_unit.unit
        record = None if unit is None else unit.record
        if indexes_of_unit is None or _STATE["owner"] != os.getpid():
            _refuse(
                record,
                method,
                url,
                "outside every HQ unit that holds the indexes (one opened with its seams, proof.hq.state.open_unit"
                "). An index written there would hold what no unit's state accounts for; run the step inside a "
                "unit.",
            )
        indexes, writes = classify(method, url, body)
        parts = _segments(url)
        # The server's own version (``/``, which HQ's adapters read) and the scroll of a search HQ opened (which
        # reads the index that search named) name no index.
        if not indexes and parts and parts[:2] != ["_search", "scroll"]:
            _refuse(record, method, url, "which names no index the lane keeps.")
        unkept = indexes - set(_STATE["indexes"] or {})
        if unkept:
            _refuse(
                record,
                method,
                url,
                f"an index the lane does not keep ({', '.join(sorted(unkept))}). No change reaches it here, so an "
                "answer from it would be the harness's; proof/hq/elasticsearch.py keeps the indexes the lane's "
                "paths read (KEPT_CANONICAL), and a path that reads another needs it kept there, with the "
                "pillow that fills it.",
            )
        if record is not None:
            endpoint = next((part for part in parts if part.startswith("_")), "")
            record.elasticsearch_reads.append((method, endpoint, tuple(sorted(indexes))))
        if writes:
            indexes_of_unit.wrote(indexes)
        return held(self, method, url, headers=headers, params=params, body=body)

    Transport.perform_request = perform_request
    _STATE["installed"] = True


@contextmanager
def _unwatched():
    held = _STATE.get("unwatched", False)
    _STATE["unwatched"] = True
    try:
        yield
    finally:
        _STATE["unwatched"] = held


# A unit's indexes -----------------------------------------------------------------------------------------


class UnitIndexes:
    """The kept indexes as one unit's state holds them (the module's "What is held").

    ``generation`` names what each index holds now: 0 for empty, and a new
    number for each write, which a restore puts back to the marked one;
    ``_held`` keeps the documents of each generation a mark read.
    ``indexed`` is how many of the unit's published changes the pillows
    have taken.
    """

    def __init__(self, unit):
        self.unit = unit
        self.indexed = 0
        self.generation: dict[str, int] = {}
        self._held: dict[tuple[str, int], list] = {}
        self._next = 1
        self._dirty: set[str] = set()

    # Lifetime ---------------------------------------------------------------------------------------------

    @contextmanager
    def held(self):
        """The unit's lifetime: every kept index empty at its start and at its end, HQ's client answered only
        inside it."""
        start()
        if _STATE["unit"] is not None:
            raise ElasticsearchFailed("A unit's indexes were opened while another unit held them in this process.")
        self.generation = {name: 0 for name in _STATE["indexes"]}
        self._held = {(name, 0): [] for name in _STATE["indexes"]}
        if not _STATE["clean"]:
            _empty_all()
        _STATE["clean"] = False
        _STATE["unit"] = self
        try:
            yield self
        finally:
            _STATE["unit"] = None
            if any(generation for generation in self.generation.values()):
                _empty_all()
            _STATE["clean"] = True

    # Writes -----------------------------------------------------------------------------------------------

    def wrote(self, indexes):
        for name in indexes:
            if name in self.generation:
                self.generation[name] = self._next
                self._next += 1
                self._dirty.add(name)
        self.unit._wrote("an Elasticsearch write")

    def settle(self):
        """Index the changes the unit published since the last settle, then refresh and merge each index
        written since (the module's "What writes to them" and "What is held")."""
        pending = self.unit.changes[self.indexed :]
        self.indexed = len(self.unit.changes)
        if pending:
            _index_changes(pending, start=self.indexed - len(pending))
        for name in sorted(self._dirty):
            _call("POST", f"/{name}/_refresh")
            _call("POST", f"/{name}/_forcemerge?max_num_segments=1")
            _call("POST", f"/{name}/_refresh")
        self._dirty.clear()

    # Marks ------------------------------------------------------------------------------------------------

    def unsettled(self) -> bool:
        """Whether a change the unit published, or a write to an index, waits for ``settle``."""
        return bool(self._dirty) or self.indexed != len(self.unit.changes)

    def mark(self) -> tuple[dict, int]:
        """What each index holds now, kept for a restore: its documents read once per generation."""
        if self.unsettled():
            raise ElasticsearchFailed(
                "A unit was asked for a mark with Elasticsearch writes not yet settled; marks are taken between "
                "operations, after each has settled what it wrote (proof.hq.branch.Unit._scoped)."
            )
        for name, generation in self.generation.items():
            if (name, generation) not in self._held:
                self._held[(name, generation)] = _documents(name)
        return dict(self.generation), self.indexed

    def restore(self, marked: tuple[dict, int]) -> None:
        """Put each index a write touched since the mark back to what it held then."""
        generations, indexed = marked
        for name, generation in sorted(generations.items()):
            if self.generation[name] != generation:
                _replace(name, _STATE["indexes"][name], self._held[(name, generation)])
                self.generation[name] = generation
        self._dirty.clear()
        self.indexed = indexed

    def documents(self, name) -> list:
        """What the index holds now, in its order (for the harness's own tests)."""
        return _documents(name)


def _empty_all():
    for name, type_ in sorted((_STATE["indexes"] or {}).items()):
        _replace(name, type_, [])


def _documents(name) -> list:
    """Every document the index holds, in the order it holds them (``_doc``), each with its id and source."""
    count = _call("GET", f"/{name}/_count")["count"]
    if not count:
        return []
    found = _call("POST", f"/{name}/_search", {"query": {"match_all": {}}, "sort": ["_doc"], "size": count})
    hits = found["hits"]["hits"]
    if len(hits) != count:
        raise ElasticsearchFailed(f"The harness read {len(hits)} of the {count} documents the {name} index holds.")
    return [(hit["_type"], hit["_id"], hit.get("_routing"), hit["_source"]) for hit in hits]


def _replace(name, type_, documents):
    """The index holds exactly ``documents``, in their order, in one segment."""
    _call("POST", f"/{name}/_delete_by_query?refresh=true&conflicts=proceed", {"query": {"match_all": {}}})
    if documents:
        lines = []
        for doc_type, doc_id, routing, source in documents:
            action = {"_index": name, "_type": doc_type, "_id": doc_id}
            if routing is not None:
                action["_routing"] = routing
            lines.append({"index": action})
            lines.append(source)
        answer = _call("POST", "/_bulk?refresh=true", lines, ndjson=True)
        if answer.get("errors"):
            raise ElasticsearchFailed(f"The harness could not write back the {name} index: {json.dumps(answer)[:2000]}")
    _call("POST", f"/{name}/_forcemerge?max_num_segments=1")
    _call("POST", f"/{name}/_refresh")


# The pillows ----------------------------------------------------------------------------------------------

_PILLOWS: dict = {}


def _processors():
    """``{topic: [processor]}``: the Elasticsearch processors of the pillows that read each topic, as HQ
    constructs them (``skip_ucr``, HQ's own option for a pillow without its configurable reports).

    A pillow's checkpoint records how far its Kafka consumer has read, and
    making one asks Kafka for each topic's first offset
    (``pillowtop/models.py::KafkaCheckpoint.get_or_create_for_checkpoint_id``).
    No consumer reads here, so the checkpoint is made empty; nothing reads it.
    """
    if "processors" not in _PILLOWS:
        from unittest import mock

        from corehq.pillows.case import get_case_pillow
        from corehq.pillows.xform import get_xform_pillow
        from pillowtop.checkpoints.manager import KafkaPillowCheckpoint
        from pillowtop.processors.elastic import ElasticProcessor

        by_topic: dict[str, list] = {}
        with mock.patch.object(KafkaPillowCheckpoint, "_get_checkpoints", lambda self: []):
            pillows = (get_case_pillow(skip_ucr=True), get_xform_pillow(skip_ucr=True))
        for pillow in pillows:
            elastic = [processor for processor in pillow.processors if isinstance(processor, ElasticProcessor)]
            for topic in pillow.get_change_feed().topics:
                by_topic.setdefault(topic, []).extend(elastic)
        _PILLOWS["processors"] = by_topic
    return _PILLOWS["processors"]


class _Message:
    """A change as Kafka hands it to HQ's change feed: its topic, partition, offset and value."""

    def __init__(self, topic, offset, value):
        self.topic = topic
        self.partition = 0
        self.offset = offset
        self.value = value


def _index_changes(changes, *, start):
    from corehq.apps.change_feed.consumer.feed import change_from_kafka_message

    processors = _processors()
    for offset, (topic, change_meta) in enumerate(changes, start=start):
        readers = processors.get(topic, ())
        if not readers:
            continue
        change = change_from_kafka_message(_Message(topic, offset, json.dumps(change_meta).encode("utf-8")))
        for processor in readers:
            processor.process_change(change)


# The seam -------------------------------------------------------------------------------------------------


@contextmanager
def elasticsearch(record: SeamRecord):
    """HQ's Elasticsearch for a block of seams: the process's server, its client watched. The unit's indexes
    themselves are held by the unit (``UnitIndexes.held``)."""
    install()
    yield record
