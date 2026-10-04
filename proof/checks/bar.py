"""The bar, on every Nova export: HQ builds it, and Core admits everything HQ generates.

Over the records of a document (``proof.checks.observations``):

- HQ accepted each of Nova's uploads (``import@<state>``, ``refused`` at
  ``/status/<HTTP status>``), and
  each lookup workbook Nova's push sends before it (``lookups@<state>``, one
  ``refused`` per error HQ's upload reports);
- HQ mapped every file of the media upload Nova's publish sends after it
  (``media@<state>``, ``media_differences``);
- for A, B and B-edit, ``validate_app()`` returned no error
  (``validate_app@<state>``, one ``error`` per error HQ listed, at
  ``/modules/*/forms/*/<error type>`` as far as the error names a module and
  form) and raised nothing, and ``create_all_files()`` and each build
  profile's ``create_all_files(build_profile_id)`` succeeded (``<step>@<state>``
  at ``/raised/<exception class>``);
- the Core runner admitted HQ's build of A, B and B-edit, and each of Nova's
  local archives (``admission@<state or archive>``, one ``refused`` per
  resource Core refused, at ``/problems/*/<stage>/<exception class>``; at
  ``/archive-refused`` where HQ's archive download refused the build, and
  ``/not_admitted`` where Core listed no problem);
- every soft assertion HQ noted while it published and built
  (``soft_assert:<operation>@<state>``, ``observations.soft_assertion_differences``):
  HQ notes them and goes on, as production does (``proof.hq.boot``), so each
  is evidence the register classifies.
"""

from __future__ import annotations

from proof.checks.differences import Difference, pointer_token


def error_path(error):
    """The structural and concrete path of one ``validate_app`` error: its module and form as far as it names them,
    then its type (``/modules/*/forms/*/<error type>``)."""
    module = (error.get("module") or {}).get("id") if isinstance(error.get("module"), dict) else None
    form = (error.get("form") or {}).get("id") if isinstance(error.get("form"), dict) else None
    kind = pointer_token(error.get("type", "error"))
    structural, concrete = "", ""
    if module is not None:
        structural, concrete = "/modules/*", f"/modules/{module}"
    if form is not None:
        structural, concrete = f"{structural}/forms/*", f"{concrete}/forms/{form}"
    return f"{structural}/{kind}", f"{concrete}/{kind}"


def build_differences(document, outcome):
    """What the bar holds against one HQ build."""
    found = []
    state = outcome.state
    for error in outcome.errors or []:
        path, at = error_path(error)
        found.append(Difference("bar", document, f"validate_app@{state}", path, at, "error", None, error))
    for step, raised in sorted(outcome.raised.items()):
        path = f"/raised/{pointer_token(raised['class'])}"
        found.append(Difference("bar", document, f"{step}@{state}", path, path, "error", None, raised))
    found.extend(admission_differences(document, state, outcome.admission, outcome.admission_error))
    return found


def problem_value(problem):
    """One problem Core's admission lists, as a difference holds it: everything but its resource, which names
    where it is (the difference's ``at``)."""
    return {key: value for key, value in problem.items() if key != "resource"}


def admission_differences(document, name, report, error=None):
    """What the bar holds against one Core admission report.

    Each refusal names its cause in its path: each problem Core lists
    (``/problems/*/<stage>/<class>``), HQ's archive download refusing the
    build before Core could read it (``/archive-refused``,
    ``proof.observe.build.ArrangementRefused``), or Core admitting nothing
    with no problem listed (``/not_admitted``). A problem's resource (the
    form's ``unique_id``, an identity each publish may mint anew) is where it
    is, in ``at``, and the problem as the difference holds it is the rest
    (``problem_value``), so one symptom has one value on A and on B.
    """
    artifact = f"admission@{name}"
    if error is not None:
        return [Difference("bar", document, artifact, "/archive-refused", "/archive-refused", "refused", None, error)]
    if report is None:
        return []
    found = []
    for problem in report.get("problems", []):
        stage = pointer_token(problem.get("stage", "?"))
        cls = pointer_token(problem.get("class", "?"))
        resource = pointer_token(problem.get("resource") or "-")
        found.append(
            Difference(
                "bar",
                document,
                artifact,
                f"/problems/*/{stage}/{cls}",
                f"/problems/{resource}/{stage}/{cls}",
                "refused",
                None,
                problem_value(problem),
            )
        )
    if not report.get("admitted") and not found:
        found.append(
            Difference(
                "bar",
                document,
                artifact,
                "/not_admitted",
                "/not_admitted",
                "refused",
                None,
                "Core did not admit the archive.",
            )
        )
    return found


def refusal_differences(document, refusals, check="bar"):
    """HQ's refusal of each of Nova's uploads, its cause the HTTP status HQ answered (``/status/<code>``)."""
    found = []
    for refusal in refusals:
        cause = f"/status/{refusal.status}"
        found.append(
            Difference(
                check,
                document,
                f"import@{refusal.state}",
                cause,
                cause,
                "refused",
                None,
                {"status": refusal.status, "response": refusal.response},
            )
        )
    return found


def lookup_differences(document, uploads, states):
    """HQ's refusals of Nova's lookup workbook, for the publishes that made ``states``."""
    found = []
    for state in states:
        upload = uploads.get(state)
        if upload is None:
            continue
        artifact = f"lookups@{state}"
        for index, error in enumerate(upload["errors"]):
            found.append(Difference("bar", document, artifact, "/errors/*", f"/errors/{index}", "refused", None, error))
        if not upload["success"] and not upload["errors"]:
            found.append(Difference("bar", document, artifact, "/success", "/success", "refused", None, upload))
    return found


def media_differences(document, uploads, states):
    """What HQ did not map of Nova's media upload, for the publishes that made ``states``.

    HQ's processing (``hqmedia/tasks.py::process_bulk_upload_zip``, as
    ``proof.observe.publish.upload_media`` records it) maps each file of the
    ZIP that the app references; each refusal names its cause in its path:
    the upload refused (``/status/<HTTP status>``), each file it did not
    match (``/unmatched/*/<cause>``, the cause
    ``proof.observe.publish._unmatched_cause`` read: ``logo_refs`` for a file
    the app references only as its logo, app-level media the upload never
    maps and Nova tells the person is not carried; ``no_reference``,
    ``other_type``, ``not_stored`` or ``unreadable`` otherwise), each it
    skipped as no media it knows (``/skipped/*``), and each error it noted
    (``/errors/*``, an ``error``). Each file is ``*`` in the path and named
    in ``at``; what HQ reported of it is the value.
    """
    found = []
    for state in states:
        upload = uploads.get(state)
        if upload is None:
            continue
        artifact = f"media@{state}"
        if upload["refused"] is not None:
            cause = f"/status/{upload['refused']['status']}"
            found.append(Difference("bar", document, artifact, cause, cause, "refused", None, upload["refused"]))
            continue
        for entry in upload["unmatched"]:
            cause = entry["cause"]
            at = f"/unmatched/{pointer_token(entry['path'])}/{cause}"
            found.append(Difference("bar", document, artifact, f"/unmatched/*/{cause}", at, "refused", None, entry))
        for entry in upload["skipped"]:
            at = f"/skipped/{pointer_token(entry['path'])}"
            found.append(Difference("bar", document, artifact, "/skipped/*", at, "refused", None, entry))
        for index, error in enumerate(upload["errors"]):
            found.append(Difference("bar", document, artifact, "/errors/*", f"/errors/{index}", "error", None, error))
    return found


def republish_bar(document, observed):
    found = refusal_differences(document, observed.refusals)
    found += lookup_differences(document, observed.lookup_uploads, ("A", "B"))
    found += media_differences(document, observed.media_uploads, ("A", "B"))
    for state in (observed.a, observed.b):
        if state is not None:
            found.extend(build_differences(document, state.build))
    return found


def edit_bar(document, observed):
    found = refusal_differences(document, [r for r in observed.refusals if r.state != "A"])
    found += lookup_differences(document, observed.lookup_uploads, ("B-edit",))
    found += media_differences(document, observed.media_uploads, ("B-edit",))
    if observed.b is not None:
        found.extend(build_differences(document, observed.b.build))
    return found


def local_bar(document, reports):
    found = []
    for name, report in sorted(reports.items()):
        found.extend(admission_differences(document, name, report))
    return found


def document_bar(document, records):
    """The bar's differences on one document, judged from its records: every publish, build and local archive."""
    from proof.checks import observations

    found = []
    for name in sorted(document.exports):
        found += republish_bar(document.id, observations.republish_view(records, name))
    if document.edit is not None:
        for name in document.edit.exports:
            found += edit_bar(document.id, observations.edit_view(records, name))
    found += local_bar(document.id, observations.local_reports(records))
    return found + observations.soft_assertion_differences(records, "bar")
