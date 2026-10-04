"""Proof 1's identities: what must be equal between A and B, read where HQ keeps each.

The identities are the research's "External identity" table, each read
from HQ's own state or build as its consumers read it:

- ``app.json``, the app document HQ stores (``Application.to_json``): the
  app id; the language codes and each build profile's languages; every
  multimedia path; each module's ``unique_id``, case type and session
  endpoint ids (``session_endpoint_id``, ``case_list_session_endpoint_id``, a
  shadow module's ``form_session_endpoints``, the case search endpoint); and
  each form's ``unique_id``, ``xmlns``, session endpoint id and
  ``case_references_data``. Each module and form also holds the media paths
  it references as HQ lists them (``all_media``, ``hqmedia/models.py``'s
  module and form media mixins), each with whether the app's media map
  holds it (``media``). Paths are the document's own JSON Pointers
  (``/modules/*/forms/*/xmlns``), so menu and form order are the positions.
- ``form:<m>.<f>``, each form: its data node's namespace in the stored
  source; every question as HQ's own reader lists it
  (``FormBase.get_questions``, which HQ's form exports read): its full data
  path, the repeat it sits in, its question type class
  (``FormExportDataSchema.datatype_mapping``: scalar, multiple choice,
  geopoint, media, label) and its select values, keyed by path, and the
  questions' order in the body (``order``); the case properties HQ learns the form
  writes, per case type (``IndexedFormBase.get_all_case_updates``); and
  every case transaction block in the XForm HQ built (each ``case`` element
  in the case transaction namespace), by its element path.
- ``suite.xml``, the suite HQ built: each entry's session datum ids (the
  ids form logic reads through ``instance('commcaresession')/session/data``;
  every datum an entry declares is listed) and every session endpoint id.
- ``case_types``: the case types HQ learns from the app, each with the case
  properties and index identifiers (relationships) HQ derives
  (``app_schemas/case_properties.py::ParentCasePropertyBuilder``).
- ``project``, what the project space holds that apps read by name: lookup
  tables by tag (the table's id and description, its field names and field
  properties and its row attributes, and each row in the table's order with
  its id, attributes and owners), location type codes and custom data field
  slugs.

``local.ccz`` holds the local path's identities, as Core's installer read
each archive: the profile's ``uniqueid`` and ``version``, and each suite
entry's form ``xmlns``.

Reading the records is the observation's (``proof.observe.identity``),
from HQ's objects and from data alike (a stored document, a built file),
since what a record holds is decided where it is written; what is read from
an admission report and how two records compare are here.
"""

from __future__ import annotations

from proof.checks.compare.json_tree import compare_json

# The objects in each identity record whose keys are values (paths, codes,
# names), which the structural path writes as "*".
DATA_MAPS = {
    "app.json": frozenset(
        {
            "/build_profiles",
            "/multimedia_map",
            "/modules/*/forms/*/case_references_data/load",
            "/modules/*/forms/*/case_references_data/save",
            "/modules/*/media",
            "/modules/*/forms/*/media",
        }
    ),
    "form": frozenset({"/questions", "/case_updates", "/case_updates/*"}),
    "suite.xml": frozenset(),
    "case_types": frozenset({"/", "/*/properties", "/*/indices"}),
    "project": frozenset(
        {
            "/lookup_tables",
            "/lookup_tables/*/fields",
            "/lookup_tables/*/rows/*/item_attributes",
            "/location_types",
            "/custom_data_fields",
            "/custom_data_fields/*",
        }
    ),
    "local.ccz": frozenset(),
}


def app_identity(app, built_files, domain):
    """Every identity record of one app state, by artifact (``proof.observe.identity.app_identity``)."""
    from proof.observe.identity import app_identity as observed

    return observed(app, built_files, domain)


def local_identity(admission):
    """The ``local.ccz`` identities Core's installer read from one local archive."""
    profile = admission.get("profile") or {}
    entries = []
    for suite in admission.get("suites") or []:
        for entry in suite.get("entries", []):
            entries.append({"command": entry.get("command"), "xmlns": entry.get("xmlns")})
    entries.sort(key=lambda entry: str(entry["command"]))
    return {"profile": {"uniqueid": profile.get("uniqueid"), "version": profile.get("version")}, "entries": entries}


def data_maps(artifact):
    return DATA_MAPS["form"] if artifact.startswith("form:") else DATA_MAPS.get(artifact, frozenset())


def compare_identities(before, after, *, document, accepted_artifacts=None):
    """Every difference between two identity records (artifact -> record)."""
    from proof.checks.differences import Difference

    found = []
    for artifact in sorted(set(before) | set(after)):
        if accepted_artifacts is not None and artifact not in accepted_artifacts:
            continue
        if artifact not in after:
            found.append(Difference("proof1", document, artifact, "/", "/", "removed", before[artifact], None))
            continue
        if artifact not in before:
            found.append(Difference("proof1", document, artifact, "/", "/", "added", None, after[artifact]))
            continue
        found.extend(
            compare_json(
                before[artifact],
                after[artifact],
                check="proof1",
                document=document,
                artifact=artifact,
                data_maps=data_maps(artifact),
            )
        )
    return found
