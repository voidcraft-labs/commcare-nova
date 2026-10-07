"""HQ's Redis, for the paths that cannot run without one: a real ``redis-server`` of this process's own.

HQ's caches live in local memory (``proof.hq.boot``), and every path the
checks ran before Formplayer needed nothing more of Redis. HQ's receiver,
its user saves and its case claims do: each takes a lock in Redis
(``dimagi/utils/couch/__init__.py::get_redis_lock``, through
``cache_core.get_redis_client``) around the form, the cases or the user it
writes, to serialize concurrent requests. So where HQ answers Formplayer
with its own views (``proof.formplayer.hq``), HQ has the lock service it
has in production: a real ``redis-server`` (the image installs it for
Formplayer), reached through the same cache backend HQ's settings name for
Redis (``django_redis.cache.RedisCache``), at a loopback address of this
process's own. The boot's network guard admits that one address beside the
lane's Postgres, and nothing else.

In production HQ and Formplayer share one Redis, and HQ relies on it:
Formplayer marks each request it makes of HQ with a token it first writes
there (``RestoreFactory.getOriginTokenHeader``), and HQ admits a mobile
endpoint's request by finding that token (``ota/decorators.py::
validate_origin_token``). So where a Formplayer runner serves the session,
HQ's Redis is that runner's (``adopt``); ``start`` runs one of HQ's own
where no Formplayer does.

``client()`` is what HQ's ``get_redis_client`` returns while the service
runs; while it does not, the boot refuses the helper as it always did, so a
path that reaches for Redis without having asked for the service still
fails loudly. Only raw clients go there: HQ's Django caches stay in local
memory, where a unit's restore empties them.

Nothing a unit's key names lives in it: a lock is taken and released inside
one request, and a token is read by the request it came with. ``flush()``
empties a server of HQ's own; a Formplayer runner's Redis also holds what
Formplayer keeps there, and is left to Formplayer.

The server is started once per process, on first use, and stopped when the
process ends; a forked lane worker starts its own (``_OWNER`` is the process
that started it).
"""

from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from proof import processes

REDIS_PORT = 6379
READY = b"Ready to accept connections"
START_SECONDS = 30.0
# Loopback addresses tried, in order from the one this process's id names: 127.1.<a>.<b>, apart from the
# addresses a Formplayer runner's Redis takes (127.0.<a>.<b>, proof.formplayer.client).
ADDRESSES = 200

_STATE: dict = {"owner": None, "group": None, "address": None, "cache": None, "directory": None}


class HqRedisError(RuntimeError):
    """HQ's Redis did not come up."""


def _stop():
    if _STATE["owner"] != os.getpid():
        return
    cache, group, directory = _STATE["cache"], _STATE["group"], _STATE["directory"]
    _STATE.update(owner=None, group=None, address=None, cache=None, directory=None)
    if cache is not None:
        try:
            cache.close()
        except Exception:  # noqa: BLE001 - the server is about to stop anyway
            pass
    if group is not None:
        group.stop()
    if directory is not None:
        shutil.rmtree(directory, ignore_errors=True)


def adopt(address: str) -> str:
    """HQ's Redis is the one at ``address`` from here on: the Redis a Formplayer runner of this process started,
    which HQ and Formplayer share as they do in production."""
    if _STATE["owner"] == os.getpid() and _STATE["address"] == address:
        return address
    _stop()
    from proof.hq.boot import GUARD

    GUARD.admit(address, REDIS_PORT)
    _STATE.update(owner=os.getpid(), group=None, address=address, cache=None, directory=None)
    return address


@contextmanager
def shared(address: str | None):
    """HQ's Redis for the block: the one at ``address`` (a Formplayer runner's, ``adopt``), or one of HQ's own
    where there is none; and, where HQ had no Redis before the block, none after it, so a path that reaches for
    Redis outside a served state is refused as it always was."""
    had = _STATE["owner"] == os.getpid() and _STATE["address"] is not None
    if address is not None:
        adopt(address)
    else:
        start()
    try:
        yield
    finally:
        if not had:
            _stop()


def start() -> str:
    """Start this process's Redis if it has none, admit its address past the network guard, and return it."""
    if _STATE["owner"] == os.getpid() and _STATE["address"] is not None:
        return _STATE["address"]
    # A forked worker inherits its parent's record of a server it does not own.
    _STATE.update(owner=None, group=None, address=None, cache=None, directory=None)
    from proof.hq.boot import GUARD

    directory = Path(tempfile.mkdtemp(prefix="proof-hq-redis-"))
    log = directory / "redis.log"
    tried = []
    for offset in range(ADDRESSES):
        slot = (os.getpid() + offset) % (ADDRESSES * 200)
        address = f"127.1.{slot // 200 + 1}.{slot % 200 + 2}"
        with log.open("wb") as output:
            group = processes.ProcessGroup(
                [
                    "redis-server",
                    "--bind",
                    address,
                    "--port",
                    str(REDIS_PORT),
                    "--protected-mode",
                    "yes",
                    "--save",
                    "",
                    "--appendonly",
                    "no",
                    "--dir",
                    str(directory),
                ],
                stdout=output,
                stderr=subprocess.STDOUT,
            )
        waited = time.perf_counter()
        ready = False
        while time.perf_counter() - waited < START_SECONDS:
            if READY in log.read_bytes():
                ready = True
                break
            if group.wait(0.05):
                break
        if ready:
            GUARD.admit(address, REDIS_PORT)
            _STATE.update(owner=os.getpid(), group=group, address=address, directory=directory)
            atexit.register(_stop)
            return address
        group.stop()
        tried.append(f"{address}: {log.read_text(encoding='utf-8', errors='replace')[-400:]}")
        if b"Address already in use" not in log.read_bytes():
            break
    shutil.rmtree(directory, ignore_errors=True)
    raise HqRedisError(
        "The harness could not start a redis-server for HQ's locks. What each try wrote:\n"
        + "\n".join(tried)
        + "\nThe proof image installs redis-server; check that this image has it."
    )


def client():
    """HQ's Redis cache backend over this process's server (what ``get_redis_client`` returns), or None while
    the service is not running here."""
    if _STATE["owner"] != os.getpid() or _STATE["address"] is None:
        return None
    if _STATE["cache"] is None:
        from django_redis.cache import RedisCache

        _STATE["cache"] = RedisCache(f"redis://{_STATE['address']}:{REDIS_PORT}/0", {})
    return _STATE["cache"]


def flush() -> None:
    """Empty a server of HQ's own: no lock or key of an earlier state is left. A Formplayer runner's Redis is
    left as it is, since Formplayer's own state lives there too."""
    held = client()
    if held is not None and _STATE["group"] is not None:
        held.client.get_client().flushall()


def stop() -> None:
    """Stop this process's Redis (a test's own; the process's is stopped as it ends)."""
    _stop()
