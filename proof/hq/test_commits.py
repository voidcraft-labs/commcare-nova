"""What HQ's receiver needs of a rollback unit: its commit callbacks run where a commit would, and its locks.

Contracts (``proof.hq.branch.Unit.committing``, ``proof.hq.redis``,
``proof.hq.localcache``):

- **A commit callback runs where production's commit runs it.** Inside
  ``committing()``, a function HQ registers in an atomic block runs when
  HQ's outermost block closes and not before; one registered in a block
  that rolls back never runs; one registered outside every block of HQ's
  runs at once. Outside ``committing()`` the unit refuses it, as it always
  did. Plausible failures: a callback run at registration (before the rows
  it reads are written), run after a rollback, or silently dropped.
- **HQ's raw Redis client is refused until the harness's Redis runs, and is
  that server while it does.** A lock taken through HQ's own helper is held
  and released there; the network guard admits that one loopback address
  and still refuses any other. Plausible failures: a lock answered by a
  stand-in, or a guard that admits more than the one address.
- **The local Redis-alias caches answer the two django-redis calls HQ's
  rate counters make as Redis does.** Plausible failure: a counter that
  raises on its first count (Django's ``incr`` refuses a key it does not
  hold), which HQ's receiver would log and pass over.
"""

from __future__ import annotations

import pytest

from proof.hq.branch import OnCommitRefused
from proof.hq.configuration import Configuration
from proof.hq.state import hq_unit

ROOT = bytes(range(32))


def _unit():
    return hq_unit(Configuration(), root_key=ROOT, validate=None)


def test_a_commit_callback_runs_when_hqs_outermost_block_closes_and_never_after_a_rollback(hq):
    from django.db import transaction

    ran = []
    with _unit() as unit, unit.committing(), unit.operation("commits", b""):
        with transaction.atomic():
            transaction.on_commit(lambda: ran.append("outer"))
            with transaction.atomic():
                transaction.on_commit(lambda: ran.append("inner"))
            assert ran == []
        assert ran == ["outer", "inner"]
        with pytest.raises(ZeroDivisionError), transaction.atomic():
            transaction.on_commit(lambda: ran.append("rolled back"))
            raise ZeroDivisionError
        # Outside every block of HQ's own, production is in autocommit and Django runs it at once.
        transaction.on_commit(lambda: ran.append("at once"))
        assert ran == ["outer", "inner", "at once"]


def test_a_commit_callback_is_refused_outside_committing(hq):
    from django.db import transaction

    with _unit() as unit, unit.operation("commits", b""):
        with pytest.raises(OnCommitRefused):
            transaction.on_commit(lambda: None)
        with unit.committing():
            transaction.on_commit(lambda: None)


def test_hqs_redis_client_is_refused_until_the_harness_runs_one_and_is_that_server_while_it_does(hq, network):
    import socket

    from dimagi.utils.couch import get_redis_lock
    from dimagi.utils.couch.cache.cache_core import get_redis_client

    from proof.hq import redis as hq_redis
    from proof.hq.boot import GUARD, NetworkRefused

    hq_redis.stop()
    with pytest.raises(NetworkRefused):
        get_redis_client()
    network.expect(GUARD.attempts[-1])
    address = hq_redis.start()
    try:
        client = get_redis_client().client.get_client()
        assert client.ping()
        lock = get_redis_lock("proof-lock", timeout=5, name="proof")
        assert lock.acquire(blocking=False)
        # django-redis writes the key with the cache's own prefix.
        assert len(client.keys("*proof-lock*")) == 1
        lock.release()
        assert client.keys("*proof-lock*") == []
        # The guard admits the server's own address and no other loopback address.
        other = ".".join([*address.split(".")[:3], str(int(address.split(".")[3]) % 250 + 1)])
        with pytest.raises(NetworkRefused), socket.create_connection((other, hq_redis.REDIS_PORT), timeout=1):
            pass
        network.expect(GUARD.attempts[-1])
    finally:
        hq_redis.stop()


def test_a_redis_alias_counts_a_key_it_does_not_hold_from_zero_and_takes_an_expiry(hq):
    from django.core.cache import caches

    from proof.hq.localcache import RedisShaped

    cache = caches["default"]
    assert isinstance(cache, RedisShaped)
    cache.delete("proof-counter")
    with pytest.raises(ValueError):
        cache.incr("proof-counter")
    assert cache.incr("proof-counter", 2, ignore_key_check=True) == 2
    assert cache.incr("proof-counter", 3, ignore_key_check=True) == 5
    assert cache.expire("proof-counter", timeout=60) is True
    assert cache.get("proof-counter") == 5
    cache.delete("proof-counter")
