"""Proof 6, the fixed point: Nova reads back from CommCare HQ the document that made what HQ serves.

The unit reads each state through HQ's API in a fork, as Nova's own reading
reads an app (``proof.observe.unit._Unit.api_reads``, the records'
``apiReads``), and this judge hands those answers to Nova's reader, the
bundle the corpus carries (``proof.checks.readerbundle``), one Node process a
document:

- a Nova-born document: ``read(served(D)) = canonDocument(D)`` at A (label
  ``published``), and ``read(served(D′)) = canonDocument(D′)`` at B-edit;
- a migration witness: ``read(served(D)) = canonDocument(D)`` at B, its A
  being an export from before a migration, which no claim is made of;
- a document whose ``hq-side.json`` states the republish ``brings-in``: at B,
  the read after the republish against the document the bring-in gave, with
  ``canon``, and nothing at A: its ``document.json`` is that document
  (``proof/corpus/entryWriter.ts::republishedDocument``), while the A Nova's
  first publish left serves the document before the person's saves, which the
  corpus keeps only as the bodies that publish sent. Its ``saved`` read is a
  person's save and no export of Nova's, so no fixed point is claimed of it;
- a document whose republish runs Nova's review of a person's saves
  (``brings-in`` or ``records``): the review read the capture's peer, which
  models HQ's saves, so HQ's own answer after the same saves (its ``saved``
  read at A) must read as the review read the peer
  (``broughtIn.reading``, ``saved_requests``), with ``canon``. The ids HQ
  mints for a menu or form a person adds are not modeled, so a row of the
  review's identity naming ids HQ's source does not hold is HQ's entity at
  that position (``aligned_identity``). Its differences are
  ``document@saved`` and ``reading@saved``;
- a document made in CommCare HQ (``hq-authored``): ``read(A) = D``, a first
  reading under the declaration ``document.json``'s ``hqAuthored`` records,
  with the project data answers and media statuses of the same record and the
  media files of ``authored/``; ``read(served(D)) = D`` at B; and
  ``read(served(D′)) = canonDocument(D′)`` at B-edit. No canonical form is
  applied to D: it is in the reader's image.

A read back compares the documents with the expected document's declaration
taken out and requires that declaration among the reading's offered ones
(``lib/deployment/reading/readBack.ts::readBackDifferences``); ``read(A) = D``
is compared whole. Each difference is ``Difference(check="proof6")``:

- the reading gave another document: artifact ``document@<state>``, path the
  differing entity's place and slot with every UUID and position as ``*``
  (kept in ``at``), kind ``changed``, ``removed`` (only the expected document
  holds it) or ``added``, ``before`` what the expected document holds there and
  ``after`` what the reading gave (``None`` for nothing);
- the reading is an account: one a finding, artifact ``reading@<state>``,
  path ``/<finding code>``, the finding's place in ``at``;
- the first reading of a base does not offer the declaration the document was
  read under: ``document@A`` ``/appSettings/runsOnlyOn``;
- a recorded media read whose bytes are not the document's own file:
  ``reading@A`` ``/media/sha256``;
- a state HQ holds with no reads recorded: ``reading@<state>`` ``/no-reads``.

A bundle that exits non-zero or runs past its deadline fails the test by name
(``readerbundle.ReaderBundleFailed``): no difference stands for a broken judge.

Pure: it reads records and files and imports neither HQ nor Django.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re

from proof.checks import observations, readerbundle
from proof.checks.differences import Difference, pointer_token

CHECK = "proof6"
# The parts a read is recorded in, the label of each, and the state it reads.
STATES = {"A": "a", "B": "b", "B-edit": "b_edit"}
KINDS = {"value": "changed", "missing": "removed", "added": "added"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class ReadsMissing(AssertionError):
    """A record lacks what the reader is handed: a first reading's project data answers or a document's facts."""


def _hq_authored(document) -> bool:
    return bool(getattr(document, "hq_authored", False))


def _brings_in(document):
    """The document a bring-in of a person's saves in HQ gave, where ``hq-side.json`` states the republish brings
    them in, else None."""
    return document.brings_in


def planned_reads(document):
    """The reads proof 6 judges on ``document``, each ``(state, label, mode, canon)``, in state order: the claims
    of the module's docstring."""
    if document.migration_witness:
        return [("B", "published", "read-back", True)]
    if _hq_authored(document):
        reads = [("A", "authored", "first-read", False), ("B", "published", "read-back", False)]
        if document.edit is not None:
            reads.append(("B-edit", "published", "read-back", True))
        return reads
    if _brings_in(document) is not None:
        # ``document.json`` is the document the bring-in gave, which the republish sends; the A Nova's first publish
        # left served the document before the saves, which the corpus keeps only as the bodies that publish sent.
        return [("B", "published", "read-back", True)]
    reads = [("A", "published", "read-back", True)]
    if document.edit is not None and document.hq_side is None:
        reads.append(("B-edit", "published", "read-back", True))
    return reads


def app_id(document) -> str:
    doc = (document.document or {}).get("doc") or {}
    if not isinstance(doc.get("appId"), str):
        raise ReadsMissing(f"{document.document_path} holds no doc.appId, the id Nova's reading mints or matches by.")
    return doc["appId"]


def _answers(reads):
    found = {key: reads[key] for key in ("source", "application", "currentVersion")}
    if reads.get("projectSpaces") is not None:
        found["projectSpaces"] = reads["projectSpaces"]
    return found


def authored_media(document, rows):
    """``LaneReadInput.projectData.media`` for a first reading of a document made in HQ: each recorded read of a
    mapped file (``rows``, the record's ``media``), with the bytes of the document's own file at that path where HQ
    answered 200. Returns ``(media, mismatches)``, each mismatch ``(path, recorded sha256, the file's sha256)``."""
    authored = document.authored
    files = {row["path"]: authored.media_file(row) for row in authored.media_rows()}
    media, mismatches = [], []
    for row in rows:
        held = {
            "path": row["path"],
            "mediaType": row["mediaType"],
            "multimediaId": row["multimediaId"],
            "status": row["status"],
        }
        path = files.get(row["path"])
        if row["status"] == 200 and path is not None:
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest != row.get("sha256"):
                mismatches.append((row["path"], row.get("sha256"), digest))
            held["base64"] = base64.b64encode(data).decode("ascii")
        media.append(held)
    return media, mismatches


def first_read_input(document, reads, *, claims="counts"):
    """The ``LaneReadInput`` of a first reading of a document made in HQ over one recorded read (its ``authored``
    read of part ``a``): ``identity: "mint"``, the declaration ``hqAuthored`` records, and the recorded project data
    with the document's own media files. Returns ``(input, media mismatches)``."""
    data = reads.get("projectData")
    if data is None:
        raise ReadsMissing(
            f"{document.id}'s authored read holds no projectData: a first reading always lists the project space's"
            " lookup tables (lib/deployment/reading/projectData/lookupTableStore.ts::readHqLookupTablesForReading),"
            " so the unit reads them for every document made in HQ (proof/observe/unit.py::_Unit.api_reads)."
        )
    media, mismatches = authored_media(document, reads.get("media") or [])
    facts = document.hq_authored_facts
    declaration = facts["declaration"]
    lane_input = {
        "appId": app_id(document),
        **_answers(reads),
        "projectData": {**data, "media": media},
        "declaration": {
            "runsOnlyOn": declaration.get("runsOnlyOn"),
            "splitDatetime": bool(declaration.get("splitDatetime")),
        },
        "identity": "mint",
        "claims": claims,
    }
    return lane_input, mismatches


def _stored(document, *, edit):
    """The document a read back matches against (``LaneReadInput.document``) and the stored doc it must give:
    D's ``document.json`` (or D′'s, keeping D's ``hqAuthored`` facts, which name the ids HQ holds), or, at B of a
    document whose republish brings a person's saves in, the document that bring-in gave."""
    if edit:
        stored = dict(document.edit_document)
        if "hqAuthored" in document.document and "hqAuthored" not in stored:
            stored["hqAuthored"] = document.document["hqAuthored"]
        return stored
    return document.document


def read_back_input(document, reads, stored):
    return {
        "appId": app_id(document),
        "document": stored,
        **_answers(reads),
        "identity": "match",
        "claims": "counts",
    }


def structural(path) -> tuple[str, str]:
    """A document difference's path (a list of keys) as ``(path, at)``: JSON Pointers over the document, every
    UUID and every position ``*`` in the first and kept in the second."""
    shown, concrete = [], []
    for key in path:
        text = str(key)
        concrete.append(pointer_token(text))
        shown.append("*" if UUID.match(text) or text.isdigit() else pointer_token(text))
    return "/" + "/".join(shown), "/" + "/".join(concrete)


def _place_text(place) -> str:
    return json.dumps(place, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def answer_differences(document_id, state, answer, *, stated=None) -> list[Difference]:
    """One answer of the bundle as proof 6's differences (the module's docstring)."""
    kind = answer.get("kind")
    if kind == "read":
        found = []
        for difference in answer.get("differences") or []:
            path, at = structural(difference["path"])
            found.append(
                Difference(
                    CHECK,
                    document_id,
                    f"document@{state}",
                    path,
                    at,
                    KINDS.get(difference.get("kind"), "changed"),
                    difference.get("expected"),
                    difference.get("found"),
                )
            )
        return found
    if kind == "account":
        found = []
        for finding in answer.get("findings") or []:
            code = str(finding.get("code"))
            path = f"/{pointer_token(code)}"
            at = f"{path}/{pointer_token(_place_text(finding.get('place')))}"
            found.append(Difference(CHECK, document_id, f"reading@{state}", path, at, "error", None, finding))
        return found
    if kind == "declaration-not-offered":
        path = "/appSettings/runsOnlyOn"
        return [
            Difference(
                CHECK,
                document_id,
                f"document@{state}",
                path,
                path,
                "changed",
                answer.get("declaration", stated),
                answer.get("offered"),
            )
        ]
    raise readerbundle.ReaderBundleFailed(
        f"Nova's reader answered {document_id} at {state} with the kind {kind!r}; proof/reader/cli.ts answers read,"
        " account or declaration-not-offered."
    )


def requests_for(document, records):
    """Every request proof 6 makes of the bundle for ``document``, each with what judges its answer:
    ``[(request, state, stated declaration or None)]``, and the differences found before any reading (a state with
    no reads, a media file whose bytes are not the document's)."""
    planned, before = [], []
    for name in sorted(document.exports):
        held = records.configurations[name]
        for state, label, mode, canon in planned_reads(document):
            part = STATES[state]
            record = held.part(part)
            if not (record or {}).get("state"):
                continue  # HQ holds no such state: the bar reports why
            reads = observations.api_reads(records, name, part, label)
            if reads is None:
                path = "/no-reads"
                before.append(
                    Difference(
                        CHECK,
                        document.id,
                        f"reading@{state}",
                        path,
                        f"{path}/{name}",
                        "refused",
                        None,
                        f"The unit recorded no {label} read of {name}/{part} (proof/observe/unit.py::_Unit.api_reads).",
                    )
                )
                continue
            request_id = f"{document.id}@{name}@{state}"
            if mode == "first-read":
                lane_input, mismatches = first_read_input(document, reads)
                for path_name, recorded, held_digest in mismatches:
                    before.append(
                        Difference(
                            CHECK,
                            document.id,
                            f"reading@{state}",
                            "/media/sha256",
                            f"/media/{pointer_token(path_name)}/sha256",
                            "changed",
                            held_digest,
                            recorded,
                        )
                    )
                request = {
                    "id": request_id,
                    "mode": "first-read",
                    "input": lane_input,
                    "expected": document.document["doc"],
                    "canon": canon,
                }
                planned.append((request, state, lane_input["declaration"]))
                continue
            edit = state == "B-edit"
            brought = _brings_in(document) if state == "B" else None
            stored = _stored(document, edit=edit)
            if brought is not None:
                export = document.exports[name]
                identities = export.brought_in.identities if export.brought_in is not None else []
                stored = {**stored, "doc": brought, "identity": identities}
            request = {
                "id": request_id,
                "mode": "read-back",
                "input": read_back_input(document, reads, stored),
                "expected": stored["doc"],
                "canon": canon,
            }
            planned.append((request, state, None))
    saved, missing = saved_requests(document, records)
    return planned + saved, before + missing


# The statements of ``hq-side.json`` under which Nova's republish runs its review of a person's saves in HQ
# (``proof/corpus/publish.ts::bringInOverPeer``), and the label and state of HQ's own read after those saves.
REVIEWED = ("brings-in", "records")
SAVED = "saved"


def _source_of(answer, where):
    """The app source HQ's answer to the source read holds, parsed."""
    try:
        source = json.loads((answer or {}).get("body") or "")
    except ValueError as error:
        raise ReadsMissing(f"{where} holds no source HQ served as JSON ({error}).") from error
    if not isinstance(source, dict):
        raise ReadsMissing(f"{where} holds {type(source).__name__}, not the app source HQ serves.")
    return source


def aligned_identity(doc, rows, source):
    """The review's identity rows (``WireIdentityOverride``: ``entityKind``, ``novaEntityUuid``, ``uniqueId``,
    ``xmlns``) for a read back of HQ's ``source`` against the review's reading ``doc``.

    The capture's peer models each save a person makes but not the ids HQ mints for a menu or form the save adds
    (``views/modules.py::new_module``, ``views/forms.py::new_form``), so a row naming a menu id, form id or
    ``xmlns`` the source holds nowhere is given the one the source holds for the entity at that row's position (its
    menu's index in ``moduleOrder``, its form's index in its menu's ``formOrder``), where no other row names that
    id. Every other row is kept as it is."""
    modules = [module for module in source.get("modules") or [] if isinstance(module, dict)]
    forms = [[form for form in module.get("forms") or [] if isinstance(form, dict)] for module in modules]
    held = {
        "module": {module.get("unique_id") for module in modules},
        "form": {form.get("unique_id") for listed in forms for form in listed},
        "xmlns": {form.get("xmlns") for listed in forms for form in listed},
    }
    named = {
        "module": {row.get("uniqueId") for row in rows if row.get("entityKind") == "module"},
        "form": {row.get("uniqueId") for row in rows if row.get("entityKind") == "form"},
        "xmlns": {row.get("xmlns") for row in rows if row.get("entityKind") == "form"},
    }
    position = {}
    for at, module_uuid in enumerate(doc.get("moduleOrder") or []):
        position[module_uuid] = (at, None)
        for index, form_uuid in enumerate((doc.get("formOrder") or {}).get(module_uuid) or []):
            position[form_uuid] = (at, index)

    def entity_at(where):
        menu, form = where
        if menu >= len(modules):
            return None
        if form is None:
            return modules[menu]
        return forms[menu][form] if form < len(forms[menu]) else None

    def repointed(value, kind, given):
        if value is None or value in held[kind] or given is None or given in named[kind]:
            return value
        return given

    aligned = []
    for row in rows:
        where = position.get(row.get("novaEntityUuid"))
        entity = None if where is None else entity_at(where)
        if entity is None:
            aligned.append(dict(row))
        elif row.get("entityKind") == "module":
            aligned.append({**row, "uniqueId": repointed(row.get("uniqueId"), "module", entity.get("unique_id"))})
        else:
            aligned.append(
                {
                    **row,
                    "uniqueId": repointed(row.get("uniqueId"), "form", entity.get("unique_id")),
                    "xmlns": repointed(row.get("xmlns"), "xmlns", entity.get("xmlns")),
                }
            )
    return aligned


def held_media_paths(stored, reading):
    """The path HQ holds each held file under for the ``saved`` read, by asset id: the document's own (under
    ``hqAuthored`` for an app made in HQ, else at its top level), then each the review's reading resolved a file HQ
    holds under a path its content does not derive to (``broughtIn.reading.mediaPaths``: a picture a person
    replaced under Nova's path), which a read back's media index takes before any content path
    (``proof/reader/laneReading.ts::publishedFiles``)."""
    return {
        **((stored.get("hqAuthored") or {}).get("mediaPaths") or {}),
        **(stored.get("mediaPaths") or {}),
        **(reading.get("mediaPaths") or {}),
    }


def saved_requests(document, records):
    """The hold of the review's reading, on a document whose republish runs Nova's review of a person's saves
    (``REVIEWED``): one read back, a configuration, of HQ's own answer after the saves (part ``a``'s ``saved`` read)
    against the reading the review made of the capture's peer (``broughtIn.reading``), under that reading's identity
    aligned to HQ's (``aligned_identity``), with ``canon``. Returns ``([(request, "saved", None)], the differences
    found before any reading)``. A review that found changes always read the app, so one with no reading is refused
    by name; a review that found nothing to bring in holds a reading only where Nova's check read the app (not where
    it answered ``unchanged``, nor where the files alone read as the baseline's), and asks the hold only then."""
    if (document.hq_side or {}).get("republish") not in REVIEWED:
        return [], []
    planned, before = [], []
    for name in sorted(document.exports):
        brought = getattr(document.exports[name], "brought_in", None)
        if brought is None:
            continue  # sent with no review: ``Document.republished_as_stated`` holds the statement
        reading = brought.reading
        if reading is None:
            if brought.review.get("kind") != "changes":
                continue  # a review that found nothing to bring in: by the files alone, or with no change read
            raise ReadsMissing(
                f"{document.id}'s {name} republish records a review that found changes in CommCare HQ's app and no"
                " broughtIn.reading, the reading the HQ side holds HQ's own answer after the same saves to. The"
                " capture writes it wherever Nova's check read the app (proof/corpus/publish.ts::BringInRecord)."
            )
        record = records.configurations[name].part("a")
        if not (record or {}).get("state"):
            continue  # HQ holds no A: the bar reports why
        reads = observations.api_reads(records, name, "a", SAVED)
        if reads is None:
            path = "/no-reads"
            before.append(
                Difference(
                    CHECK,
                    document.id,
                    f"reading@{SAVED}",
                    path,
                    f"{path}/{name}",
                    "refused",
                    None,
                    f"The unit recorded no {SAVED} read of {name}/a (proof/observe/unit.py::_Unit.api_reads).",
                )
            )
            continue
        source = _source_of(reads["source"], f"{document.id}'s {name}/a {SAVED} read")
        stored = {
            **document.document,
            **reading,
            "identity": aligned_identity(reading["doc"], reading["identity"], source),
        }
        held = held_media_paths(document.document, reading)
        if held:
            stored["mediaPaths"] = held
        request = {
            "id": f"{document.id}@{name}@{SAVED}",
            "mode": "read-back",
            "input": read_back_input(document, reads, stored),
            "expected": reading["doc"],
            "canon": True,
        }
        planned.append((request, SAVED, None))
    return planned, before


def differences(document, records) -> list[Difference]:
    """Proof 6's differences on one document, from its records, through the reader bundle the corpus carries."""
    planned, found = requests_for(document, records)
    if planned:
        answers = readerbundle.run_reader([request for request, _, _ in planned], log_name=f"proof6-{document.id}")
        for (_, state, stated), answer in zip(planned, answers, strict=True):
            found += answer_differences(document.id, state, answer, stated=stated)
    return found + observations.soft_assertion_differences(records, CHECK)


def fixed_point_message(document_id, found) -> str:
    """The message for the first state that read back to another document, or an empty string where none did."""
    by_state = {}
    for difference in found:
        artifact = difference.artifact
        if artifact.startswith("document@"):
            by_state.setdefault(artifact.removeprefix("document@"), []).append(difference)
    for state in STATES:
        held = by_state.get(state)
        if held:
            count = "one difference" if len(held) == 1 else f"{len(held)} differences"
            return (
                f"Nova read {document_id} back from CommCare HQ ({state}) and got a different document: {count},"
                f" the first at {held[0].path}. Nova's own export must read back to the document that made it. If"
                " the two documents print the same bytes, the pair belongs in CANONICALIZATIONS"
                " (lib/commcare/reader/canon.ts) with its test; otherwise the reader lost or changed something there."
            )
    held = by_state.get(SAVED)
    if held:
        count = "one difference" if len(held) == 1 else f"{len(held)} differences"
        return (
            f"CommCare HQ's app after a person's saves on {document_id} does not read as Nova's review read the"
            f" capture's model of those saves: {count}, the first at {held[0].path}. The capture's peer"
            " (proof/corpus/targetPeer.ts) stores each save as HQ's view does; look at what it stores there, since"
            " the review's verdict was reached over that model."
        )
    return ""
