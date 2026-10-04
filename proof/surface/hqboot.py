"""HQ booted for the surface extractor, which reads HQ's code and never its data.

The extractor boots HQ with the harness's one boot (``proof.hq.boot``) so HQ's
own registries load as HQ loads them. It reads no database: when no lane
Postgres is named, the boot is given a host name that resolves nowhere, and
while a family reads HQ, any attempt to open a database connection fails the
extraction instead of reading whatever that database holds.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

# A host name the boot's network guard allows and that resolves nowhere, used
# only when the process has no lane Postgres (``python -m proof.surface``).
NO_DATABASE_HOST = "surface-extractor-reads-no-database.invalid"

HQ_ROOTS = ("corehq", "custom", "dimagi", "casexml", "couchforms", "couchexport", "soil", "phonelog", "toggle")


class DatabaseRead(BaseException):
    """HQ opened a database connection while the extractor read its code."""


def boot() -> None:
    os.environ.setdefault("PROOF_POSTGRES_HOST", NO_DATABASE_HOST)
    from proof.hq.boot import boot as boot_hq

    boot_hq()


@contextmanager
def reading_code() -> Iterator[None]:
    """HQ booted, with every database connection refused until the block ends."""
    boot()
    from django.db.backends.base.base import BaseDatabaseWrapper

    original = BaseDatabaseWrapper.ensure_connection

    def ensure_connection(self):
        raise DatabaseRead(
            f"HQ tried to open its {self.alias!r} database while the surface extractor read its code. "
            "The surface is read from HQ's code alone, so a family that reaches a database read "
            "must be changed to read the code that decides it."
        )

    BaseDatabaseWrapper.ensure_connection = ensure_connection
    try:
        yield
    finally:
        BaseDatabaseWrapper.ensure_connection = original
