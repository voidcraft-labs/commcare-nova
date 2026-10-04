"""Fixtures for the corpus's HQ-side tests.

- ``hq``: HQ booted once for the session (``proof.hq.boot``).
- ``network``: every test fails if HQ reached for the network during it,
  even where HQ caught the refusal itself.
"""

from __future__ import annotations

import pytest

from proof.hq.boot import GUARD, boot


@pytest.fixture(scope="session")
def hq():
    return boot()


@pytest.fixture(autouse=True)
def network():
    start = len(GUARD.attempts)
    yield
    refused = [attempt for attempt in GUARD.attempts[start:] if not attempt.allowed]
    assert not refused, "HQ reached for the network during this test, which the harness refused:\n" + "\n".join(
        f"  {a.kind} {a.address} from {' <- '.join(reversed(a.where[-4:]))}" for a in refused
    )
