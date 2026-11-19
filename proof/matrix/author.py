"""Authoring one base in HQ: its project space, its builder, its form builder saves, what is retained of it, and
its variants.

``authored(base, ...)`` opens one HQ check under the base's configuration
(``proof.hq.check.hq_check``), with HQ's API access granted beside it
(``seams.also_granted(privileges.API_ACCESS)``: every resource Nova reads an
app through requires it, and no app's content does) and HQ's API rate
limiter held within its limits (``seams.api_rate_limits``, which
``operations.api_request`` asks of every caller), and runs, each step in a
determinism operation of its own labelled ``matrix:<base>:<step>``:

1. ``api-user``: the web user Nova reads the app as, with its key
   (``operations.seed_api_user``), a member whose role edits apps and
   places and reads HQ's API;
2. ``build:<what>``: the base's ``build`` (``proof/matrix/bases/``), which
   reaches HQ through its own views, models and form writer only, one
   operation a step of it;
3. ``vellum:<m>.<f>``: each form ``Base.vellum`` names opened and saved once
   in HQ's form builder (``proof.matrix.ops.builder_save``);
4. ``retain``: the files of ``proof/hq-apps/<base>/`` written to
   ``$PROOF_OUT/hq-apps/<base>/`` (``proof.matrix.retain.retain``);
5. ``variants``: each row of ``variants.json`` over the base made in a fork
   of the base's state, read by the reader bundle, and held to its row
   (``proof.matrix.retain.read_variant``); nothing of a variant is
   retained.

``Authoring`` is what a base's builder and a variant's change are handed.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field

# The web user every base's reads are made as.
READER = "matrix-reader@example.org"


@dataclass(frozen=True)
class Authoring:
    """What a base's builder and a variant's change are handed."""

    # The open HQ check's state, as every operation takes it.
    state: object
    # The corpus documents ``proof/matrix/conftest.py::DOCUMENTS`` names, by id.
    documents: Mapping[str, object]
    # The base's id, which names each operation the builder opens.
    base: str = ""
    # The editor driver HQ's form builder and pages run in.
    driver: object = None
    # Opens one determinism operation labelled ``matrix:<base>:<step>``, keyed by ``digest``.
    operation: Callable = field(default=None, repr=False)

    def step(self, name: str, digest: bytes | None = None):
        """An operation of the unit labelled ``matrix:<base>:<name>``, keyed by ``digest`` (the name's bytes where
        none is given)."""
        return self.operation(name, digest if digest is not None else name.encode())


@dataclass
class Authored:
    """What one base's authoring left: the app HQ holds, what was retained, and each variant's outcome."""

    app_id: str
    retained: object
    variants: list = field(default_factory=list)


def digest(value: bytes | str) -> bytes:
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode("utf-8")).digest()


@contextmanager
def _services(state):
    """HQ's own Redis, where a user's save takes its lock (``proof.hq.redis``), and the commit callbacks HQ's saves
    register, run where production's commit runs them."""
    from proof.hq import redis as hq_redis

    with hq_redis.shared(None), state.committing():
        yield


def authored(base, *, documents, driver, core_runner, variants=()) -> Authored:
    """Author ``base`` in a check of its own and retain it; then make, read and hold each of ``variants`` (rows of
    ``variants.json`` over the base) in a fork of its state. Returns what was made."""
    from corehq import privileges

    from proof.hq import operations
    from proof.hq.check import hq_check
    from proof.hq.seams import also_granted, api_rate_limits
    from proof.matrix import ops, retain

    with hq_check(base.configuration) as (state, _record), _services(state):
        with also_granted(privileges.API_ACCESS), api_rate_limits(state):

            @contextmanager
            def operation(name, key):
                with state.operation(f"matrix:{base.id}:{name}", key):
                    yield

            authoring = Authoring(state=state, documents=documents, base=base.id, driver=driver, operation=operation)
            with authoring.step("api-user"):
                credential = operations.seed_api_user(state, READER, edit_locations=True)
            # The builder opens each of its steps' operations itself (``build:<what>``): a form builder save it
            # makes runs between operations, each of the builder's requests its own (``ops.builder_save``).
            app_id = base.build(authoring)
            for menu, form in base.vellum:
                ops.builder_save(authoring, app_id, menu, form)
            kept = retain.retain(authoring, base, app_id, credential, core_runner)
            outcomes = []
            for variant in variants:
                with state.fork():
                    outcomes.append(retain.read_variant(authoring, base, app_id, credential, variant, kept))
    return Authored(app_id, kept, outcomes)
