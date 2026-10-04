"""One HQ build of one app state as data, and as a record holds it.

``BuildOutcome`` is what a build left: ``validate_app()``'s list of errors
(None when it raised), what each step raised, the default files and each
build profile's, and Core's admission report of the default build arranged
as HQ's archive download arranges it. The observation
(``proof.observe.build``) makes it and writes it into a record with
``outcome_record``; a judge reads it back with ``outcome_from_record``,
naming the state it reads it as (``A``, ``B``, ``B-edit``, ``B-aligned``), so
one record serves B and a B-edit whose inputs equal B's.

The record format is the observation's, so it lives here; the judges read
it through ``proof.checks.hqbuild``.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class BuildOutcome:
    """What one build of one app state left, as data: nothing here reaches HQ again."""

    state: str
    app_version: int
    errors: list | None
    raised: dict
    files: dict | None
    profile_files: dict = field(default_factory=dict)
    admission: dict | None = None
    admission_error: str | None = None

    @property
    def complete(self):
        return not self.raised and self.files is not None


def _files_record(files, blobs):
    return {path: blobs.put(content) for path, content in sorted(files.items())}


def outcome_record(outcome: BuildOutcome, blobs) -> dict:
    """The outcome as a record's JSON, each built file a blob of its own; the state it was built as is not kept."""
    return {
        "appVersion": outcome.app_version,
        "errors": outcome.errors,
        "raised": outcome.raised,
        "files": None if outcome.files is None else _files_record(outcome.files, blobs),
        "profileFiles": {
            profile_id: _files_record(files, blobs) for profile_id, files in sorted(outcome.profile_files.items())
        },
        "admission": outcome.admission,
        "admissionError": outcome.admission_error,
    }


def outcome_from_record(record: dict, blobs, state: str) -> BuildOutcome:
    """The outcome a record holds, read as the build of ``state``."""

    def files(refs):
        return {path: blobs.get(ref) for path, ref in refs.items()}

    return BuildOutcome(
        state=state,
        app_version=record["appVersion"],
        errors=record["errors"],
        raised=record["raised"],
        files=None if record["files"] is None else files(record["files"]),
        profile_files={profile_id: files(refs) for profile_id, refs in record["profileFiles"].items()},
        admission=record["admission"],
        admission_error=record["admissionError"],
    )
