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
- each local archive Nova's download makes, or its refusal: a document that
  declares Android carries D's local archive, or states the download's
  refusal in its place where A's app keeps a custom base URL whose origin is
  not the server's own (``workers-sent-elsewhere``), and never both
  (``local@D`` and ``local@D'``, ``local_outcome``);
- every soft assertion HQ noted while it published and built
  (``soft_assert:<operation>@<state>``, ``observations.soft_assertion_differences``):
  HQ notes them and goes on, as production does (``proof.hq.boot``), so each
  is evidence the register classifies.

On a migration witness (``proof.checks.corpus.Document.migration_witness``)
A is the retained export of the app from before a migration, which the
current code did not write, so the bar judges B, its build and its bodies,
and D's local archives, never A.
"""

from __future__ import annotations

import json
import zipfile
from urllib.parse import urlsplit

from proof.checks.corpus import ANDROID
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


def republish_bar(document, observed, states=("A", "B")):
    """The bar over one configuration's first publish and republish: over the publishes that made ``states`` (B
    alone on a migration witness, whose A the current code did not write)."""
    found = refusal_differences(document, [refusal for refusal in observed.refusals if refusal.state in states])
    found += lookup_differences(document, observed.lookup_uploads, states)
    found += media_differences(document, observed.media_uploads, states)
    for name, state in (("A", observed.a), ("B", observed.b)):
        if state is not None and name in states:
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


def base_url_origin(value):
    """Where a custom base URL sends a phone, as ``lib/commcare/targetFacts.ts::heldBaseUrl`` reads it: ``(host,
    origin)``, ``host`` the netloc after its last ``@`` and ``origin`` the ``https`` origin of that host where the
    base is ``https`` with no user information (else None, which is never a server's own); None for a value that is
    no ``http`` or ``https`` URL with a netloc, which HQ's ``urljoin`` sends nowhere else."""
    if not isinstance(value, str):
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return None
    host = parts.netloc.rpartition("@")[2]
    if parts.scheme.lower() != "https" or "@" in parts.netloc:
        return host, None
    return host, server_origin(f"https://{host}/")


def server_origin(url):
    """The WHATWG origin of an ``https`` URL (its host in lower case, its default port dropped), or None."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme.lower() != "https" or not parts.hostname:
        return None
    hostname = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    return f"https://{hostname}" + ("" if port in (None, 443) else f":{port}")


def held_base_url(document):
    """The custom base URL A's app keeps: the stored app's (``authored/app.json``) on a document made in HQ, or the
    one a person saved over A in HQ (``hq-side.json``'s ``appAttributes``), the save winning; None where neither
    holds one."""
    held = None
    authored = document.authored
    if authored is not None:
        held = json.loads(authored.app.read_text(encoding="utf-8")).get("custom_base_url")
    saved = ((document.hq_side or {}).get("appAttributes") or {}).get("custom_base_url")
    return saved if saved is not None else held


def archive_server(path):
    """The origin of the server a local archive's profile signs a worker in on (its ``ota-restore-url``), or None
    where it names none (an archive retained before archives named their project space)."""
    from lxml import etree

    with zipfile.ZipFile(path) as archive:
        profile = etree.fromstring(archive.read("profile.ccpr"))
    for element in profile.iter("{*}property"):
        if element.get("key") == "ota-restore-url":
            return server_origin(element.get("value") or "")
    return None


def local_outcome(document_id, *, android, archive_server_origin, has_archive, refusal, held_base, artifact):
    """The bar over what Nova's download makes of one document for its project space: D's local archive, or the
    refusal the document states in its place (``Document.local_refusal``). Nova makes no ``.ccz`` for a project
    space whose app keeps a custom base URL whose origin is not the server's own
    (``lib/deployment/runtimeTarget.ts::workersSentElsewhere``), and one for every other project space of an app
    that declares Android. So: an app that declares Android carries an archive or states the refusal
    (``/local-outcome/missing``), never both (``/local-outcome/archive-and-refusal``); a stated refusal is what A's
    base calls for, its host the base's and its server's origin not the base's (``/local-outcome/refusal``, the
    refusal at ``before`` and A's base at ``after``), and is stated only for an app that declares Android; and an
    archive is made only where A's base is absent or on the archive's own server
    (``/local-outcome/archive-for-workers-sent-elsewhere``)."""
    found = []

    def report(what, before, after):
        path = f"/local-outcome/{what}"
        found.append(Difference("bar", document_id, artifact, path, path, "refused", before, after))

    base = base_url_origin(held_base)
    if has_archive and refusal is not None:
        report("archive-and-refusal", refusal, held_base)
    if refusal is not None:
        server = server_origin(refusal["server"])
        called_for = android and base is not None and base[0] == refusal["host"] and base[1] != server
        if not called_for:
            report("refusal", refusal, held_base)
    elif android and not has_archive:
        report("missing", None, held_base)
    if has_archive and base is not None and archive_server_origin is not None and base[1] != archive_server_origin:
        report("archive-for-workers-sent-elsewhere", archive_server_origin, held_base)
    return found


def document_local_outcome(document):
    """``local_outcome`` over D and, where the document holds an edit, D', each with the platforms it declares. A
    control retains only the archives its registers' checks read (``proof.checks.controls``), so the outcome is held
    on a corpus document alone."""
    if document.kind == "control":
        return []
    held_base = held_base_url(document)
    found = []
    parts = [(document, False, "local@D")]
    if document.edit is not None:
        parts.append((document.edit, True, "local@D'"))
    for part, edit, artifact in parts:
        archive = part.local_ccz
        found += local_outcome(
            document.id,
            android=ANDROID in document.platforms(edit=edit),
            archive_server_origin=archive_server(archive) if archive is not None else None,
            has_archive=archive is not None,
            refusal=part.local_refusal,
            held_base=held_base,
            artifact=artifact,
        )
    return found


def document_bar(document, records):
    """The bar's differences on one document, judged from its records: every publish, build and local archive, but a
    migration witness's A."""
    from proof.checks import observations

    states = ("B",) if document.migration_witness else ("A", "B")
    found = []
    for name in sorted(document.exports):
        found += republish_bar(document.id, observations.republish_view(records, name), states)
    if document.edit is not None:
        for name in document.edit.exports:
            found += edit_bar(document.id, observations.edit_view(records, name))
    found += local_bar(document.id, observations.local_reports(records))
    found += document_local_outcome(document)
    return found + observations.soft_assertion_differences(records, "bar", states=observations.judged_states(document))
