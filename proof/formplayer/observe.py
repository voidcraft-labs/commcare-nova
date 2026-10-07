"""Formplayer's sessions for one configuration of a document, as a record (``proof/README.md``).

Where proof 3 runs Core's sessions (``proof.observe.sessions.observe``),
this runs Formplayer's over the same builds and the same restores: its walk
is derived on ``build(A)`` (``proof.formplayer.walk``) and replayed on B's
build aligned to A wherever the raw builds differ, exactly where Core's
sessions replay. Nova's local archive is not walked: Web Apps installs only
what HQ builds, and a local archive's profile names no submission URL, so
Formplayer cannot submit its forms (``FormSession.getPostUrl``).

Each side's walk runs inside one operation of the unit, since what HQ
answers Formplayer with is HQ's own code over the unit's state: its reading
of each search's request and its fixture of the results
(``proof.formplayer.apps.search_results``). What is recorded, under
``formplayer`` of the ``b_aligned`` record's ``sessions``:

- ``runtime``: Formplayer's commit and the Core it vendors, as the runner
  announced them;
- per side (``A``, ``B``): ``trace``, the marked trace as a blob
  (``proof.formplayer.canonical``); ``asked``, how many times Formplayer
  asked HQ for each thing but the app's archive (whether it asks for that
  again depends on what the same Formplayer process installed before, so
  the count is the process's history and not the build's); ``searches``,
  each search's parameters as HQ's view reads them; and ``submissions``,
  how many HQ received.

The record holds no id Formplayer drew and no path, so the same inputs give
the same bytes (``proof/formplayer/test_walk.py``).
"""

from __future__ import annotations

from collections import Counter

from proof.formplayer import apps
from proof.formplayer.walk import Walk, marked, script_of
from proof.observe import casedata
from proof.observe.record import digest
from proof.observe.runs import unbuildable


def _side(unit, runner, blobs, operation, *, side, app_id, files, restore, database, toggles, script=None):
    """One build's walk, as a record, and its trace."""
    archive = apps.build_archive(files)
    build = apps.build_id(app_id, archive)
    hq = apps.answers(unit, database, {build: archive}, restore, toggles=toggles)
    with operation(f"formplayer:{side}", digest([build, digest(restore.hex()), script]).encode()):
        trace = Walk(runner, hq, domain=unit.domain, app_id=build).run(script)
    trace = marked(trace, archives=[archive], restore=restore)
    recorded = {
        "trace": blobs.put_json(trace),
        "asked": dict(sorted(Counter(what for what, _ in hq.asked if what != "archive").items())),
        "searches": [[[key, list(values)] for key, values in search.params] for search in hq.searches],
        "submissions": len(hq.submissions),
    }
    return recorded, trace


def observe(
    unit, *, document, export, app_id, a_build, b_aligned, b_differs, restore_a, restore_b, runner, blobs, operation
):
    """Formplayer's sessions on ``build(A)``, and on B aligned to A where the raw builds differ; None where A
    cannot be walked (no build, or no restore HQ served)."""
    if a_build is None or unbuildable(a_build) is not None or restore_a is None:
        return None
    database = casedata.document_case_database(document)
    toggles = tuple(sorted(export.configuration.flags))
    ready = runner.ready or {}
    recorded = {"runtime": dict(ready.get("formplayer") or {})}
    shared = dict(unit=unit, runner=runner, blobs=blobs, operation=operation, database=database, toggles=toggles)
    recorded["A"], baseline = _side(side="A", app_id=app_id, files=a_build.files, restore=restore_a, **shared)
    if b_aligned is None or b_aligned.files is None or not b_differs or unbuildable(b_aligned) is not None:
        return recorded
    if restore_b is None:
        return recorded
    recorded["B"], _ = _side(
        side="B", app_id=app_id, files=b_aligned.files, restore=restore_b, script=script_of(baseline), **shared
    )
    return recorded
