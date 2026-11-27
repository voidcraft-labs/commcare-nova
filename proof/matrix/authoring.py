"""What a base's builder and a variant's change are handed (``proof.matrix.author``).

It stands apart from ``author``, which retains what a base made and so reaches the reader bundle
(``proof.matrix.retain``), so a test that drives HQ's builder alone holds no key of that bundle
(``proof/lane/test_blocks.py``).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field


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
