"""Every request Nova's publish sends for a lookup table that travels as JSON, answered again by HQ's own resources.

Contract: ``lib/deployment/__tests__/publishSequence.postgres.test.ts`` ("keeps every request of a JSON table's
lifecycle") publishes a table tagged ``types`` through the production publish (``publishAppToHq``: preflight, the
per-request admission ``store.ts::admitLookupJsonWrite``, the journal and ledger in Postgres, and the executor
``lib/deployment/lookupJsonExecutor.ts`` over Nova's own HTTP client) to a peer that answers as HQ's lookup
resources do, and keeps every request, every answer the peer gave, and each edit a person makes in HQ between two
requests (``fixtures/lookup-json-publish.json``). The lifecycle is: a first publish that makes the table and its
rows; a publish of the same table that writes nothing; an append, a change, a reorder and a removal, each its own
publish; a row create whose answer is lost, which the table waits on until a person removes the row it made in HQ
and its hold passes, and which is then sent once more; a change whose request never reached HQ, sent once after
its hold; a change whose answer is lost, read and never sent again; and a person's edit of a row in HQ between two
of Nova's requests, after which the request that would write over it is never sent.

This test sends the same requests, in the same order, with Nova's API key, to HQ's ``LookupTableResource``,
``v0_6.LookupTableItemResource``, ``LookupTableItemResource`` and ``FixtureResource``
(``operations.api_request``), makes each person's edit with HQ's own models where the case made it, and holds
every answer Nova's publish read to HQ's: its status, and each field of its body the peer answered (HQ's tastypie
pages carry more metadata than Nova reads; a field the peer answers that HQ does not is a difference). HQ mints
its own ids, so each id the peer minted is read as the one HQ minted for the same request: a table's by its tag in
the next list, a row's from its create's answer. A request whose answer never reached Nova is sent and its answer
not compared (the publish never read it); one that never reached HQ is not sent. At the end HQ holds the table
the peer holds, row for row, rank for rank.

The plausible failures: the peer answering a status, a rank or a value HQ would not (a PUT's status, a create's
rank, a value HQ trims), so that Nova's executor decided over answers HQ never gives; a request whose effect in HQ
differs from the peer's model; and HQ ending in another table than the one Nova's ledger then holds.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

# The lookup resources answer only a project space whose plan grants API access (`HqBaseResource`).
CONFIGURATION = Configuration(privileges={"LOOKUP_TABLES", "API_ACCESS"})
RECORDED = json.loads(
    (Path(__file__).parent / "fixtures" / "lookup-json-publish.json").read_text(encoding="utf-8")
)
REMOTE_ID = re.compile(r"[0-9a-f]{32}")


class Ids:
    """The id HQ minted for each id the peer minted, read off the answers to the same requests."""

    def __init__(self):
        self.hq = {}

    def learn(self, peer_id, hq_id):
        known = self.hq.get(peer_id)
        assert known in (None, hq_id), f"The peer's id {peer_id} stands for {known} and {hq_id} in HQ."
        self.hq[peer_id] = hq_id

    def to_hq(self, value):
        """``value`` with every id the peer minted written as HQ's."""
        if isinstance(value, str):
            return REMOTE_ID.sub(lambda match: self.hq.get(match.group(0), match.group(0)), value)
        if isinstance(value, list):
            return [self.to_hq(item) for item in value]
        if isinstance(value, dict):
            return {key: self.to_hq(item) for key, item in value.items()}
        return value


def _held(peer, hq, where):
    """Each field the peer answered, as HQ answers it: the peer's answer is HQ's, field for field, where it
    answers one at all."""
    if isinstance(peer, dict):
        assert isinstance(hq, dict), f"{where}: the peer answered an object, HQ {json.dumps(hq)}"
        for key, value in peer.items():
            assert key in hq, f"{where}: the peer answered {key}, which HQ does not ({sorted(hq)})"
            _held(value, hq[key], f"{where}/{key}")
    elif isinstance(peer, list):
        assert isinstance(hq, list) and len(hq) == len(peer), (
            f"{where}: the peer answered {json.dumps(peer)}, HQ {json.dumps(hq)}"
        )
        for index, (one, other) in enumerate(zip(peer, hq, strict=True)):
            _held(one, other, f"{where}/{index}")
    else:
        assert peer == hq, f"{where}: the peer answered {json.dumps(peer)}, HQ {json.dumps(hq)}"


def _learn(ids, exchange, answer):
    """The ids HQ minted for the request, read off its answer beside the peer's."""
    path = exchange["path"]
    peer = exchange["answer"]
    if answer is None or peer is None:
        return
    if path.endswith("/lookup_table_item/v2/") and exchange["method"] == "POST":
        ids.learn(peer["id"], answer["id"])
    if "/lookup_table/v1/" in path and exchange["method"] == "GET" and "objects" in peer:
        held = {table["tag"]: table["id"] for table in answer["objects"]}
        for table in peer["objects"]:
            if table["tag"] in held:
                ids.learn(table["id"], held[table["tag"]])


def _edit(state, ids, exchange):
    """A person's edit of one row in HQ, made with HQ's own model as its table page saves one."""
    from corehq.apps.fixtures.models import Field, LookupTableRow

    row = LookupTableRow.objects.get(domain=state.domain, id=ids.to_hq(exchange["rowId"]))
    if exchange["kind"] == "delete-row":
        row.delete()
        return
    row.fields = {
        name: [Field(value=value["field_value"], properties=value["properties"]) for value in values]
        for name, values in exchange["fields"].items()
    }
    row.save()


def test_hq_answers_every_request_of_novas_json_publish_as_the_peer_did(hq):
    from corehq.apps.fixtures.models import LookupTableRow

    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits

    with hq_check(CONFIGURATION) as (state, _), hq_redis.shared(None), state.committing(), api_rate_limits(state):
        publisher = operations.seed_api_user(state, "lookup-json-publish@example.org", edit_data=True)
        ids = Ids()
        compared = 0
        for index, exchange in enumerate(RECORDED["exchanges"]):
            if exchange["kind"] != "request":
                _edit(state, ids, exchange)
                continue
            if exchange.get("lost") == "request":
                continue
            path = ids.to_hq(exchange["path"]).replace(f"/a/{RECORDED['domain']}/", f"/a/{state.domain}/", 1)
            body = exchange["body"]
            answer = operations.api_request(
                state,
                exchange["method"],
                path,
                credential=publisher,
                body=b"" if body is None else json.dumps(ids.to_hq(body)).encode("utf-8"),
            )
            parsed = json.loads(answer.body) if answer.body else None
            _learn(ids, exchange, parsed)
            if exchange.get("lost") == "answer":
                continue
            where = f"exchange {index} ({exchange['method']} {exchange['path']})"
            assert answer.status == exchange["status"], f"{where}: the peer answered {exchange['status']}, HQ {answer.retained()}"
            if exchange["answer"] is not None:
                _held(ids.to_hq(exchange["answer"]), parsed, where)
            compared += 1
        assert compared > 100, "The recorded publish compared too few answers to hold the peer to HQ."

        # HQ ends holding the table the peer holds: the same rows, at the same ranks, with the same values.
        held = [
            {
                "id": row.id.hex,
                "sortKey": row.sort_key,
                "fields": {
                    name: [{"field_value": value.value, "properties": dict(value.properties)} for value in values]
                    for name, values in row.fields.items()
                },
                "itemAttributes": dict(row.item_attributes),
            }
            for row in LookupTableRow.objects.filter(
                domain=state.domain, table_id=ids.to_hq(RECORDED["table"])
            ).order_by("sort_key", "id")
        ]
        assert held == ids.to_hq(RECORDED["final"])
