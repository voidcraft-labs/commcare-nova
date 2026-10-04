"""Proof 3's sessions as the records hold them: a run, its script and submission, and what decides they run.

The observation (``proof.observe.sessions``) runs sessions only on a build
a runtime installs (``unbuildable``), derives the script on ``build(A)`` and
replays it (``script_of``), gives HQ each run's submission
(``submission_of``) with Core's generated ids as fixed ids
(``GENERATED_PREFIX``, ``GENERATED_NAMESPACE``), and maps the local
archive's form ``xmlns`` to ``build(A)``'s (``xmlns_alignment``). The judge
(``proof.checks.proof3``) reads the records through the same functions, so
what decides a record and what reads it are one.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

# The runner marks each id Core generated as "@generated:uuid:N"; HQ is given
# a fixed id for each mark (a UUID 5 in this namespace), the same on both sides.
GENERATED_PREFIX = "@generated:uuid:"
GENERATED_NAMESPACE = uuid.UUID("5b0f6f0e-3d0b-4b8e-9b1a-6f0c2a1e9d3f")


@dataclass
class Run:
    """One build's sessions: which side ran them (the baseline ``A``, or the build its differences are named
    after: ``local.ccz``, ``B``, an editor), Core's admission of the build, and the trace (None when Core did
    not admit it)."""

    side: str
    admission: dict
    trace: dict | None


def script_of(trace):
    """The script a trace's runs followed, for the same sessions to replay on another build."""
    return [run["script"] for run in trace["runs"]]


def submission_of(run):
    """The run's submission (its last form screen's), or None when the run submitted nothing."""
    forms = [step for step in run.get("trace", []) if step.get("screen") == "form" and "submission" in step]
    return forms[-1]["submission"] if forms else None


def unbuildable(outcome):
    """Why HQ makes no archive a runtime installs from one build, as data; None when it makes one.

    HQ builds a release only when ``validate_app()`` lists no error and
    raises nothing (``app_manager/models/applications.py::
    Application.make_build`` raises ``AppValidationError``), and serves Web
    Apps the saved app's archive on the same condition
    (``app_manager/views/cli.py::get_direct_ccz`` answers 400); either then
    writes the default files (``create_all_files()``), so a build profile HQ
    could not write does not decide it.
    """
    if outcome.files is None or "validate_app" in outcome.raised:
        return {"state": outcome.state, "raised": outcome.raised}
    if outcome.errors:
        return {"state": outcome.state, "validate_app": outcome.errors}
    return None


def entry_xmlns(admission):
    """Each suite entry's form xmlns, by command id, as Core's admission read the suites."""
    found = {}
    for suite in admission.get("suites") or []:
        for entry in suite.get("entries") or []:
            if entry.get("xmlns"):
                found[entry["command"]] = entry["xmlns"]
    return found


def xmlns_alignment(other_admission, baseline_admission):
    """The other build's form xmlns mapped to the baseline's, by suite entry (command id)."""
    other, baseline = entry_xmlns(other_admission), entry_xmlns(baseline_admission)
    return {other[command]: baseline[command] for command in other if command in baseline}
