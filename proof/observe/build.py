"""HQ's build of one app state, every step's verdict kept, and Core's admission of it.

``build_state`` runs the steps ``proof.hq.operations.build`` runs, one at a
time, so that each step HQ fails is recorded and the steps after it still
run: ``validate_app()`` (its list of errors, or what it raised),
``create_all_files()``, and ``create_all_files(build_profile_id)`` for each
build profile. Only what HQ raises is recorded. A harness refusal (a network
reach, an unanswered view, a seam asked what it does not answer) is a
``BaseException``, and a failure of the Core runner answering Formplayer's
validation (``CoreRunnerError``, a deadline included) is the harness's too:
HQ catches neither on its validation path (``formplayer_api/form_validation.py::
validate_form`` catches only ``RequestException``), and either ends the check.

Every form HQ's validation reaches must reach Formplayer's validation (the
Core runner). HQ sends a form there only while its own validation of that
form found nothing else (``helpers/validators.py::FormBaseValidator.
validate_for_build``: a blank form, invalid XML or a question list it cannot
read stops it, each listed as that form's error), so a form is excused only
by such an error of its own, and only when ``validate_app`` returned.

``arrange`` writes a build's files as HQ's archive download arranges them
(``hqmedia/views.py::iter_index_files``, which reads ``create_all_files()``
for an app that is not a saved build, ``views/download.py::
download_index_files``): the media profile becomes ``profile.ccpr`` and the
plain profiles are left out. It runs HQ's own arrangement over the files the
build wrote, so Core admits exactly what was built. ``admit_build`` has the
Core runner install that arrangement as Core's archive installer does, and
``admit`` gives Core's admission report of any archive with its app
released and nothing in it that names where or in which runner it was
installed (the runner's handle for the app, the scratch directory), so the
report is the same wherever it is made.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from proof.core.client import CoreRunnerError
from proof.observe.identity import data_namespace
from proof.observe.outcome import BuildOutcome

# The errors of a form's own validation that stop HQ before it asks Formplayer
# (FormBaseValidator.validate_for_build).
UNVALIDATED_FORM_ERRORS = frozenset({"blank form", "invalid xml", "validation error"})
# What an admission report holds in place of the archive's path and the root the runner read it under.
ARCHIVE_PLACEHOLDER = "<archive>"
HANDLE_PLACEHOLDER = "<app>"


class ArrangementRefused(AssertionError):
    """HQ's archive arrangement refused the files of a build; ``errors`` are HQ's."""

    def __init__(self, errors):
        super().__init__(f"HQ's archive download refused the build: {errors}")
        self.errors = errors


def _raised(error):
    return {"class": type(error).__name__, "message": str(error)}


def _json(value):
    return json.loads(json.dumps(value, default=str))


def _step(raised, name, run):
    """One build step's result, or None with what HQ raised recorded under ``name``."""
    try:
        return run()
    except CoreRunnerError:
        raise  # the harness's own failure, not HQ's
    except Exception as error:  # HQ's own failure; harness refusals are BaseExceptions
        raised[name] = _raised(error)
        return None


def _excused(errors):
    """The forms whose own validation errors kept HQ from sending them to Formplayer, by unique id."""
    excused = set()
    for error in errors:
        form = error.get("form") if isinstance(error, dict) else None
        if error.get("type") in UNVALIDATED_FORM_ERRORS and isinstance(form, dict) and form.get("unique_id"):
            excused.add(form["unique_id"])
    return excused


def _bytes(content):
    return content if isinstance(content, bytes) else content.encode("utf-8")


def build_state(app, record, state):
    """HQ's build of ``app`` under the seams the caller opened, as a ``BuildOutcome`` and HQ's ``Build``."""
    from proof.hq import operations

    for form in app.get_forms():
        form.clear_validation_cache()
    sent_before = len(record.form_validations)
    raised = {}
    errors = _step(raised, "validate_app", lambda: _json(app.validate_app()))
    files = _step(raised, "create_all_files", app.create_all_files)
    profile_files = {}
    for profile_id in sorted(app.build_profiles):
        built = _step(raised, f"create_all_files:{profile_id}", lambda p=profile_id: app.create_all_files(p))
        if built is not None:
            profile_files[profile_id] = built
    sent = record.form_validations[sent_before:]
    if "validate_app" not in raised:
        validated = {data_namespace(v.xml) for v in sent}
        excused = _excused(errors)
        missing = [
            form.unique_id
            for form in app.get_forms()
            if form.source and form.unique_id not in excused and form.xmlns not in validated
        ]
        if missing:
            raise operations.FormNotValidated(
                f"HQ validated the app without sending forms {missing} to Formplayer's validation, and"
                " validate_app lists no error of theirs that stops it, so the Core runner never judged them."
            )
    outcome = BuildOutcome(
        state=state,
        app_version=app.version,
        errors=errors,
        raised=raised,
        files={path: _bytes(content) for path, content in files.items()} if files is not None else None,
        profile_files={
            profile_id: {path: _bytes(content) for path, content in built.items()}
            for profile_id, built in profile_files.items()
        },
    )
    hq_build = None
    if files is not None:
        hq_build = operations.Build(
            app=app, errors=errors or [], files=files, profile_files=profile_files, form_validations=sent
        )
    return outcome, hq_build


class _BuiltFiles:
    """An app whose ``create_all_files()`` gives the files one build wrote, for HQ's archive arrangement."""

    copy_of = None

    def __init__(self, files):
        self._files = files

    def create_all_files(self):
        return dict(self._files)


def arrange(files, directory):
    """HQ's build files written into ``directory`` as HQ's archive download arranges them."""
    from corehq.apps.hqmedia.views import iter_index_files

    entries, errors, _ = iter_index_files(_BuiltFiles(files), build_profile_id=None)
    if errors:
        raise ArrangementRefused(errors)
    for name, content in entries:
        target = Path(directory, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(_bytes(content))
    return Path(directory)


def admit_build(core_runner, app, outcome: BuildOutcome):
    """Core's admission of HQ's build, arranged as HQ's archive download arranges it."""
    if outcome.files is None:
        return
    with tempfile.TemporaryDirectory(prefix="proof-observe-build-") as directory:
        try:
            arrange(outcome.files, directory)
        except ArrangementRefused as refused:
            outcome.admission_error = str(refused)
            return
        outcome.admission = admit(core_runner, directory)


def _placed(value, replacements):
    if isinstance(value, str):
        for old, new in replacements:
            if old and old in value:
                value = value.replace(old, new)
        return value
    if isinstance(value, list):
        return [_placed(item, replacements) for item in value]
    if isinstance(value, dict):
        return {_placed(key, replacements): _placed(item, replacements) for key, item in value.items()}
    return value


def admission_placeholders(report, path):
    """What an admission record writes as a placeholder (``_placed``): the archive's path, and the root the runner
    read it under (``jr://archive/<root>/...``, ``archiveRoot``: the runner's handle for the app, numbered by every
    admission it made before, whether Core admitted the archive or refused it)."""
    replacements = [(str(Path(path).resolve()), ARCHIVE_PLACEHOLDER), (str(path), ARCHIVE_PLACEHOLDER)]
    root = report.get("archiveRoot")
    if root:
        replacements.append((f"jr://archive/{root}/", f"jr://archive/{HANDLE_PLACEHOLDER}/"))
    return replacements


def admit(core_runner, path):
    """Core's admission report for an archive or a directory of its entries, its app released, naming neither
    the archive's path nor the root the runner read it under (``admission_placeholders``)."""
    report = core_runner.admit(path)
    app = report.pop("app", None)
    report.pop("appHandle", None)
    replacements = admission_placeholders(report, path)
    report.pop("archiveRoot", None)
    if app is not None and core_runner.holds(app):
        core_runner.release(app)
    return _placed(_json(report), replacements)
