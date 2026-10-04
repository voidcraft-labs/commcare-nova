"""One HQ build of one app state, as the judges read it: every step's verdict, the files, Core's admission.

``BuildOutcome`` and its record format (``outcome_record``,
``outcome_from_record``) are the observation's (``proof.observe.outcome``):
what a record holds is decided where it is written. A judge reads a build
back from a record with ``outcome_from_record``, naming the state it reads
it as (``A``, ``B``, ``B-edit``, ``B-aligned``), so one record serves B and a
B-edit whose inputs equal B's.

``build_state`` is the observation's (``proof.observe.build``), named here
for the checks that still build in a state of their own.
"""

from __future__ import annotations

from proof.observe.outcome import BuildOutcome, outcome_from_record, outcome_record

__all__ = ["BuildOutcome", "build_state", "outcome_from_record", "outcome_record"]


def build_state(app, record, state):
    """HQ's build of ``app`` (``proof.observe.build.build_state``)."""
    from proof.observe.build import build_state as observed

    return observed(app, record, state)
