"""What the lane retains of a base it authored (``proof/hq-apps/<base>/``), and the reading of each variant over it.

``retain(authoring, base, app_id, credential, core_runner)`` writes the
files of a base to ``$PROOF_OUT/hq-apps/<base>/`` (``proof.matrix.retained``),
which ``test_retained.py`` holds the committed tree to:

- ``base.json``: the registry's row (``Base.as_json``);
- ``app.json``: the app as HQ stores it, ``to_json()`` after one ``wrap``
  round (``dbaccessors.py::wrap_app``), so the file is a fixed point of the
  model, with ``_attachments`` as ``{"<form unique id>.xml": "<source
  text>"}`` from ``get_attachments`` (``lazy_fetch_attachment`` of each
  form) and no blob metadata (``external_blobs``);
- ``media.json`` and ``media/<n>.<ext>``: one row a mapped path whose
  document HQ holds, in path order, its file the bytes HQ holds for it
  (``CommCareMultimedia.get_display_file``), one file a document;
- ``tables.json`` and ``places.json``, where the project space holds lookup
  tables or places: each as HQ's models hold it (``fixtures/models.py``,
  ``locations/models.py``), parents first, each place with the
  ``location_id`` HQ gave it, and the places with the project space's
  location fields (``places_of``);
- ``seed.json``: the case seed made from A (``proof.matrix.seed``);
- HQ's answers to the reads Nova makes of the app, through HQ's API with the
  seeded key, each in an operation ``matrix:<base>:reads``, in the order
  Nova's own read makes them: the application resource, the source, the
  version, the two project space lists (whole, and filtered by
  ``SAVE_ONLY_EDITED_FORM_FIELDS``), the lookup table list and each table's
  rows, the levels and the places, and each mapped file at the address HQ
  gives its map item (``HQMediaMapItem.url``);
- ``expected.json``: ``{reads, declaration, claimed, firstPublish}``, from
  the reader bundle's first reading of those answers
  (``proof.checks.readerbundle.run_reader``): the declaration the base was
  read under, the entry ids its claim log counts, sorted, and that
  declaration's first-publish ids.

``app-source.json``, ``application.json`` and ``current-version.json`` are
always kept. Each other answer is kept only where the first reading asked
for it (the bundle's ``asked``): a base keeps only the answers a reading
uses. ``media-reads.json`` keeps a row a mapped path the reading read: a file
the reading never asks for (one only a setting kept in HQ names, as the
Android logos, one nothing references, a second path of a file read under its
first) has its row in ``media.json`` and none there, and is no file of the
base's document (``proof/corpus/hqAuthored.ts``).

Nothing is written under ``hq-apps/<base>/`` until the first reading comes
in. A base the reader does not read (or whose retaining raises before) is
written instead under ``$PROOF_OUT/hq-apps-unread/<base>/``, which ``python3
-m proof.matrix.adopt`` never copies: the files above that were made, every
answer HQ gave under the same names (so ``lane_input.first_read_input`` reads
the directory as the run's request), and ``reading.json``, the bundle's whole
answer. ``BaseNotRead`` names each finding's code, standing, place and the key
or path it names.

``read_variant`` makes one row of ``variants.json`` in a fork of the base's
state and reads it as the row's own answers: its application resource,
source, version and project space lists, and each file its media map names
(a change may attach one the base does not hold), beside the base's lookup
table, level and place answers. A set-json value is served where HQ's source
read holds what the row set (``holds``), each menu or form the value names by
position read as the id the source read serves for it (``served_ids``). It
retains nothing; it returns what the row is held to.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re

from proof.matrix import lane_input
from proof.matrix.retained import Retained, output_root

# The flag a bring-in reads of its source project space, by the project-space list's filter (part of Nova's read
# of a source that holds a write saved only if changed).
SAVE_ONLY_EDITED = "SAVE_ONLY_EDITED_FORM_FIELDS"
ATTACHMENT = re.compile(r"[^/]*\.xml")
KIND_OF_CLASS = {"CommCareImage": "image", "CommCareAudio": "audio", "CommCareVideo": "video"}


class BaseNotRead(AssertionError):
    """Nova's reader did not read a base the lane authored."""


def _body(answer):
    return json.loads(answer.body)


def stored_document(app) -> dict:
    """The app as ``app.json`` holds it: ``to_json()`` after one ``wrap`` round, its form sources under
    ``_attachments`` and no blob metadata."""
    from corehq.apps.app_manager.dbaccessors import wrap_app

    document = json.loads(json.dumps(wrap_app(json.loads(json.dumps(app.to_json()))).to_json()))
    document.pop("external_blobs", None)
    document.pop("_attachments", None)
    attachments = app.get_attachments()
    document["_attachments"] = {
        name: content.decode("utf-8") if isinstance(content, bytes) else content
        for name, content in sorted(attachments.items())
        if ATTACHMENT.fullmatch(name)
    }
    return document


def media_files(app):
    """``[(row, bytes)]``: one ``media.json`` row a mapped path whose document HQ holds, in path order, each with
    the bytes HQ holds for it; a document two paths map is one file."""
    from corehq.apps.hqmedia.models import CommCareMultimedia
    from couchdbkit import ResourceNotFound

    rows = []
    files = {}
    for path, item in sorted(app.multimedia_map.items()):
        media_class = CommCareMultimedia.get_doc_class(item.media_type)
        try:
            multimedia = media_class.get(item.multimedia_id)
        except ResourceNotFound:
            continue
        data = multimedia.get_display_file(return_type=False)
        if data is None:
            continue
        extension = path.rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""
        if item.multimedia_id not in files:
            files[item.multimedia_id] = f"media/{len(files)}.{extension}"
        rows.append(
            (
                {
                    "path": path,
                    "file": files[item.multimedia_id],
                    "mediaClass": item.media_type,
                    "kind": KIND_OF_CLASS[item.media_type],
                    "mimeType": CommCareMultimedia.get_mime_type(data, filename=path),
                    "extension": extension,
                },
                data,
            )
        )
    return rows


def tables_of(state):
    """Every lookup table of the project space as HQ's models hold it, in tag order, its rows in ``sort_key``
    order (``proof/hq/operations.py::save_authored_tables`` makes them again from this)."""
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow

    found = []
    for table in LookupTable.objects.filter(domain=state.domain).order_by("tag"):
        rows = LookupTableRow.objects.filter(domain=state.domain, table=table).order_by("sort_key", "id")
        found.append(
            {
                "tag": table.tag,
                "is_global": table.is_global,
                "description": table.description,
                "fields": [
                    {"name": field.name, "properties": list(field.properties), "is_indexed": field.is_indexed}
                    for field in table.fields
                ],
                "item_attributes": list(table.item_attributes),
                "rows": [
                    {
                        "fields": {
                            name: [{"value": value.value, "properties": dict(value.properties)} for value in values]
                            for name, values in row.fields.items()
                        },
                        "item_attributes": dict(row.item_attributes),
                    }
                    for row in rows
                ],
            }
        )
    return found


def places_of(state):
    """Every level and place of the project space as HQ's models hold them, parents first, and its location fields
    definition (``custom_data_fields/models.py::CustomDataFieldsDefinition`` of
    ``locations/views.py::LocationFieldsView.field_type``, each field's ``slug`` and ``label`` in the definition's
    order, ``[]`` where it has none), without which HQ's flat location list writes no ``location_data``
    (``locations/fixtures.py::get_location_data_fields``). ``proof/hq/operations.py::save_authored_places`` makes
    them again from this."""
    from corehq.apps.custom_data_fields.models import CustomDataFieldsDefinition
    from corehq.apps.locations.models import LocationType, SQLLocation
    from corehq.apps.locations.views import LocationFieldsView

    levels = list(LocationType.objects.filter(domain=state.domain).order_by("id"))
    places = list(SQLLocation.objects.filter(domain=state.domain))
    if not levels and not places:
        return None

    def depth(item, parent_of):
        found, parent = 0, parent_of(item)
        while parent is not None:
            found += 1
            parent = parent_of(parent)
        return found

    levels.sort(key=lambda level: (depth(level, lambda found: found.parent_type), level.code))
    places.sort(key=lambda place: (depth(place, lambda found: found.parent), place.site_code))
    definition = CustomDataFieldsDefinition.get(state.domain, LocationFieldsView.field_type)
    fields = [] if definition is None else definition.get_fields()
    return {
        "levels": [
            {
                "name": level.name,
                "code": level.code,
                "parent": None if level.parent_type is None else level.parent_type.code,
                "shares_cases": level.shares_cases,
                "view_descendants": level.view_descendants,
            }
            for level in levels
        ],
        "places": [
            {
                "location_id": place.location_id,
                "name": place.name,
                "site_code": place.site_code,
                "level": place.location_type.code,
                "parent": None if place.parent is None else place.parent.site_code,
                "metadata": dict(place.metadata),
                "archived": place.is_archived,
            }
            for place in places
        ],
        "fields": [{"slug": field.slug, "label": field.label} for field in fields],
    }


def app_reads(authoring, app_id, credential):
    """HQ's answers to the reads Nova makes of the app itself, each in an operation ``matrix:<base>:reads``, in the
    order Nova's read makes them: the application resource, the source and the version (the bracket of the app's
    read), then the project space list whole and filtered by ``SAVE_ONLY_EDITED_FORM_FIELDS``."""
    from corehq import toggles

    from proof.hq import operations

    state = authoring.state
    found = {}
    for name, read in (
        ("application", lambda: operations.application_read(state, app_id, credential)),
        ("source", lambda: operations.source_read(state, app_id, credential)),
        ("currentVersion", lambda: operations.current_version_read(state, app_id, credential)),
        ("projectSpaces:all", lambda: operations.project_spaces_read(state, credential)),
        (
            "projectSpaces:flagged",
            lambda: operations.project_spaces_read(
                state, credential, feature_flag=toggles.SAVE_ONLY_EDITED_FORM_FIELDS.slug
            ),
        ),
    ):
        with authoring.step("reads", name.encode()):
            found[name] = read()
    return found


def project_data_reads(authoring, app_id, credential):
    """HQ's answers to the reads a first reading makes beyond the app, each in an operation ``matrix:<base>:reads``:
    the lookup table list and each table's rows, the levels and the places, and each mapped file at the address HQ
    gives its map item. Returns ``(answers by name, media reads)``, each media read ``(row, bytes)``."""
    from proof.hq import operations

    state = authoring.state
    found = {}
    with authoring.step("reads", b"lookupTables"):
        found["lookupTables"] = operations.lookup_tables_read(state, credential)
    tables = _body(found["lookupTables"]).get("objects", []) if found["lookupTables"].status == 200 else []
    for table in tables:
        with authoring.step("reads", f"fixtureRows:{table['tag']}".encode()):
            found[f"fixtureRows:{table['tag']}"] = operations.fixture_rows_read(state, table["id"], credential)
    with authoring.step("reads", b"locationTypes"):
        found["locationTypes"] = operations.location_types_read(state, credential)
    with authoring.step("reads", b"locations"):
        found["locations"] = operations.locations_read(state, credential)
    return found, media_reads(authoring, app_id, credential)


def media_reads(authoring, app_id, credential):
    """Each file the app's media map names, read at the address HQ gives its map item, in path order, in the
    operation ``matrix:<base>:reads``: ``[(row, bytes)]``."""
    from proof.hq import operations

    state = authoring.state
    media = []
    app = operations.held_app(state, app_id)
    with authoring.step("reads", b"media"):
        for path, item in sorted(app.multimedia_map.items()):
            answer = operations.media_file_read(state, item.url, credential)
            media.append(
                (
                    {
                        "path": path,
                        "mediaType": item.media_type,
                        "multimediaId": item.multimedia_id,
                        "status": answer.status,
                        "sha256": hashlib.sha256(answer.data).hexdigest(),
                        "length": len(answer.data),
                    },
                    answer.data,
                )
            )
    return media


def reading_input(app_id_answers, project_answers, media, base, *, claims) -> dict:
    """The bundle's first-read input over answers made in this run (``lane_input.first_read_input``'s shape)."""
    found = {
        "appId": base.id,
        "source": app_id_answers["source"].retained(),
        "application": app_id_answers["application"].retained(),
        "currentVersion": app_id_answers["currentVersion"].retained(),
        "projectSpaces": {
            "all": app_id_answers["projectSpaces:all"].retained(),
            "flagged": app_id_answers["projectSpaces:flagged"].retained(),
        },
        "projectData": {
            "lookupTables": project_answers["lookupTables"].retained(),
            "fixtureRows": {
                name.split(":", 1)[1]: answer.retained()
                for name, answer in project_answers.items()
                if name.startswith("fixtureRows:")
            },
            "locationTypes": project_answers["locationTypes"].retained(),
            "locations": project_answers["locations"].retained(),
            "media": [
                {
                    **{key: row[key] for key in ("path", "mediaType", "multimediaId", "status")},
                    **({"base64": base64.b64encode(data).decode("ascii")} if row["status"] == 200 else {}),
                }
                for row, data in media
            ],
        },
        "identity": "mint",
        "claims": claims,
    }
    if base.declaration is not None:
        found["declaration"] = base.declaration.as_json()
    return found


def run_bundle(requests):
    """The reader bundle's answers to ``requests`` (``proof/checks/readerbundle.py::run_reader``)."""
    from proof.checks import readerbundle

    return readerbundle.run_reader(requests)


def claimed(answer) -> list[str]:
    """The entry ids an answer's claim log counts: under ``counts``, the keys of its JSON; under ``full``, the
    ``entry`` of each line ``serializeClaimLog`` writes. Every answer of the bundle holds ``claims``
    (``proof/reader/cli.ts``), so one without it is refused rather than read as counting nothing."""
    if "claims" not in answer:
        raise AssertionError(
            f"The reader bundle's answer for {answer.get('id')} ({answer.get('kind')}) holds no claims, and every"
            " answer it writes holds the reading's claims. Look at proof/reader/cli.ts::answer, which builds it."
        )
    text = answer["claims"]
    if not text:
        return []
    try:
        counts = json.loads(text)
    except ValueError:
        counts = None
    if isinstance(counts, dict):
        return sorted(entry for entry, count in counts.items() if count)
    entries = set()
    for line in text.splitlines():
        if line.strip():
            record = json.loads(line)
            if record.get("entry"):
                entries.add(record["entry"])
    return sorted(entries)


# What a base the lane authored and Nova's reader did not read leaves, beside the run's ``hq-apps/`` and never
# adopted from it (``proof.matrix.adopt``): the files ``retain`` makes, every answer HQ gave, and the reading.
UNREAD_TREE = "hq-apps-unread"
# The most findings a not-read message lists, and the most characters of a finding's name it shows; the reading
# itself (``reading.json`` under ``UNREAD_TREE``) holds every one whole.
LISTED_FINDINGS = 12
NAME_SHOWN = 120


def _shown(text, limit=NAME_SHOWN):
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def finding_line(finding) -> str:
    """One finding as the not-read message names it: its code, standing and place, and the key or path it names
    (``detail.name``) and the checker's reason where it holds them."""
    place = json.dumps(finding.get("place"), ensure_ascii=False, sort_keys=True, separators=(", ", ": "))
    line = f"{finding.get('code')} ({finding.get('standing')}) at {place}"
    detail = finding.get("detail") or {}
    if detail.get("name") is not None:
        line += f" naming {_shown(detail['name'])!r}"
    if detail.get("reason") is not None:
        line += f" ({_shown(detail['reason'])})"
    return line


def not_read_message(base_id, answer, kept) -> str:
    """Why the base ``base_id`` the lane made is not retained: each distinct finding of the reading once, with how
    many times it was found, the first ``LISTED_FINDINGS`` of them, and where the run kept HQ's answers."""
    lines: dict[str, int] = {}
    for finding in answer.get("findings") or []:
        line = finding_line(finding)
        lines[line] = lines.get(line, 0) + 1
    listed = [f"{line} ({count} times)" if count > 1 else line for line, count in lines.items()]
    shown = "; ".join(listed[:LISTED_FINDINGS])
    if len(listed) > LISTED_FINDINGS:
        shown += f"; and {len(listed) - LISTED_FINDINGS} more"
    if answer.get("kind") == "declaration-not-offered":
        shown = f"it states {answer.get('declaration')}, and the reading offers {answer.get('offered')}"
    return (
        f"Nova's reader did not read the base {base_id} the lane made in CommCare HQ ({answer.get('kind')}):"
        f" {shown or 'no finding'}. A base is made only of what Nova holds, so either the reader is wrong about that"
        f" place or the builder in proof/matrix/bases/ made more than it should. HQ's answers and the whole reading"
        f" are under {kept}."
    )


def keep_answers(retained, answers, project_answers, media, asked=None):
    """HQ's answers kept under ``retained``: the source, application and version always, and each other answer
    where ``asked`` names it (every one where ``asked`` is None)."""

    def wanted(name):
        return asked is None or name in asked

    retained.keep("application", answers["application"])
    retained.keep("app-source", answers["source"])
    retained.keep("current-version", answers["currentVersion"])
    if wanted("projectSpaces:all") and wanted("projectSpaces:flagged"):
        retained.keep("project-spaces", answers["projectSpaces:all"])
        retained.keep("project-spaces-flag", answers["projectSpaces:flagged"])
    for name, file_name in (
        ("lookupTables", "lookup-tables"),
        ("locationTypes", "location-types"),
        ("locations", "locations"),
    ):
        if name in project_answers and wanted(name):
            retained.keep(file_name, project_answers[name])
    for name, read in sorted(project_answers.items()):
        if name.startswith("fixtureRows:") and wanted(name):
            retained.keep(f"fixture-rows-{name.split(':', 1)[1]}", read)
    read_rows = [row for row, _ in media if wanted(f"media:{row['path']}")]
    if read_rows:
        retained.keep("media-reads", read_rows)


def retain(authoring, base, app_id, credential, core_runner) -> Retained:
    """Write ``proof/hq-apps/<base>/`` to the run's output (the module's docstring), once the reader bundle's first
    reading of it comes in. Where it does not, or anything before it raises, nothing is written under ``hq-apps/``:
    what was made, every answer HQ gave and the reading are written under ``UNREAD_TREE`` and the error stands.
    Returns the ``Retained``, whose ``answers`` and ``project_answers`` hold every answer made, kept or not, for the
    variants, which read their media files themselves."""
    from proof.hq import operations
    from proof.matrix import seed

    state = authoring.state
    retained = Retained(base.id, tree="hq-apps", held=True)
    answers = project_answers = media = answer = None
    try:
        retained.keep("base", base.as_json())
        with authoring.step("retain"):
            app = operations.held_app(state, app_id)
            retained.keep("app", stored_document(app))
            rows = media_files(app)
            if rows:
                retained.keep("media", [row for row, _ in rows])
                written = set()
                for row, data in rows:
                    if row["file"] not in written:
                        retained.keep_bytes(row["file"], data)
                        written.add(row["file"])
            tables = tables_of(state)
            if tables:
                retained.keep("tables", tables)
            places = places_of(state)
            if places is not None:
                retained.keep("places", places)
            retained.keep("seed", seed.case_seed(state, app, core_runner, worker_location=base.worker_location))
        answers = app_reads(authoring, app_id, credential)
        project_answers, media = project_data_reads(authoring, app_id, credential)

        (answer,) = run_bundle(
            [
                {
                    "id": base.id,
                    "mode": "first-read",
                    "input": reading_input(answers, project_answers, media, base, claims="counts"),
                }
            ]
        )
        if answer.get("kind") != "read":
            raise BaseNotRead(not_read_message(base.id, answer, output_root() / UNREAD_TREE / base.id))
        expected = {
            "reads": True,
            "declaration": answer["declaration"],
            "claimed": claimed(answer),
            "firstPublish": list(answer.get("firstPublish") or []),
        }
    except BaseException:
        unread = retained.moved(UNREAD_TREE)
        if answers is not None:
            keep_answers(unread, answers, project_answers or {}, media or [])
        if answer is not None:
            unread.keep("reading", answer)
        raise
    keep_answers(retained, answers, project_answers, media, set(answer.get("asked") or ()))
    retained.keep("expected", expected)
    retained.settle()
    retained.answers = answers
    retained.project_answers = project_answers
    retained.reading = answer
    return retained


# Variants ----------------------------------------------------------------------------------------------------------


class VariantOutcome:
    """What one variant's making and reading gave: the exception HQ raised making its change (its class name), or
    else whether HQ's source read serves each set-json value, HQ's own answers, and the bundle's answer."""

    def __init__(self, variant, *, raised=None, unserved=(), answers=None, answer=None, base_source=None, holds=()):
        self.variant = variant
        self.raised = raised
        self.unserved = tuple(unserved)
        self.answers = answers
        self.answer = answer
        self.base_source = base_source
        # The row's holds as the bundle was asked them, each key the external key's text.
        self.holds = tuple(holds)


def _value_at(document, pointer):
    """The value at ``pointer`` of ``document``, or ``_MISSING``."""
    from proof.matrix.ops import _pointer_tokens

    here = document
    for token in _pointer_tokens(pointer):
        if isinstance(here, list):
            if not token.isdigit() or int(token) >= len(here):
                return _MISSING
            here = here[int(token)]
        elif isinstance(here, dict) and token in here:
            here = here[token]
        else:
            return _MISSING
    return here


_MISSING = object()


def holds(served, value) -> bool:
    """Whether ``served``, what HQ's source read holds at a row's pointer, holds ``value``, what the row set there:
    an object holds each key the row set at the value it set, beside any key HQ's source read adds of its own (a
    logo slot's ``url``, ``icon_class`` and ``humanized_content_length``, which it writes from the media map); a list
    holds each item in its place; any other value is the value."""
    if isinstance(value, dict):
        return isinstance(served, dict) and all(
            key in served and holds(served[key], item) for key, item in value.items()
        )
    if isinstance(value, list):
        return (
            isinstance(served, list)
            and len(served) == len(value)
            and all(holds(one, item) for one, item in zip(served, value, strict=True))
        )
    return served is not _MISSING and served == value


def served_ids(base_source, source):
    """A ``resolve`` for ``ops.resolve_references`` over HQ's source read of a variant (``source``): a menu at a
    position is the base's menu there, by the id HQ keeps for it; a form at a position is the base's form there, by the
    id the variant's source read serves for the one form of its ``xmlns``, since a source read gives every form a new
    id (``util.py::update_form_unique_ids``); a form's ``xmlns`` at a position is the base's form's, which that read
    keeps. A reference the read serves no one form for resolves to no value, so the value it stands in is not served.
    Positions are the base's, so a row names by position only the menus and forms its earlier changes leave where the
    base holds them."""

    def resolve(kind, position):
        try:
            menu = base_source["modules"][position[0]]
            if kind == "menu":
                return menu["unique_id"]
            xmlns = menu["forms"][position[1]]["xmlns"]
        except (KeyError, IndexError, TypeError):
            return _MISSING
        if kind == "xmlns":
            return xmlns
        served = [
            form.get("unique_id")
            for module in source.get("modules") or []
            for form in module.get("forms") or []
            if form.get("xmlns") == xmlns
        ]
        return served[0] if len(served) == 1 else _MISSING

    return resolve


def hold_key(key, base_source) -> str:
    """A ``holds`` fragment's key as the bundle reads it, the external key's text (``identity.ts::externalKeyText``,
    ``JSON.stringify`` of ``[kind, ...parts]``): text as written, or a list whose menu references
    (``{"$menu": m}``) are the id HQ keeps for the base's menu at that position and whose ``xmlns`` references
    (``{"$xmlns": [m, f]}``) the ``xmlns`` of the base's form there, so the key names the same entity however often
    the base is authored again."""
    from proof.matrix.ops import ids_at, resolve_references

    if isinstance(key, str):
        return key
    return json.dumps(resolve_references(key, ids_at(base_source)), separators=(",", ":"), ensure_ascii=False)


def make_change(authoring, app_id, change):
    """One change of a row, made in HQ: a ``set-json`` through ``ops.set_json``, a ``named`` change through its
    function of ``proof/matrix/variants/``, which is handed the ``Authoring`` and the app's id."""
    from proof.matrix import ops, registry

    if change["op"] == "set-json":
        ops.set_json(authoring, app_id, change["pointer"], change["value"])
    else:
        registry.named_change(change["name"])(authoring, app_id)


def read_variant(authoring, base, app_id, credential, variant, kept) -> VariantOutcome:
    """The row ``variant`` made over the base's state (the caller's fork), read through HQ's API and by the reader
    bundle: the app's answers and each file its media map names are the variant's own (a change may attach a file
    the base does not hold), the project space's other answers the base's. HQ raising while the change is made is
    the outcome itself (``raised``); nothing is read then."""
    from proof.matrix.ops import MatrixChangeRefused, SourceNotHeld, ValueNotSet

    base_source = json.loads(kept.answers["source"].body)
    try:
        for change in variant.changes():
            make_change(authoring, app_id, change)
    except (ValueNotSet, SourceNotHeld):
        # A row that names no place in the app, or a source that did not land, is the lane's own, never HQ's.
        raise
    except MatrixChangeRefused as error:
        # HQ's view refused the change: the class of what it raised, or the refusal itself where it answered one.
        cause = error.__cause__
        return VariantOutcome(
            variant, raised=type(cause if cause is not None else error).__name__, base_source=base_source
        )
    except AssertionError:
        raise
    except Exception as error:  # noqa: BLE001 (the class of what HQ raised is what the row records)
        return VariantOutcome(variant, raised=type(error).__name__, base_source=base_source)
    answers = app_reads(authoring, app_id, credential)
    media = media_reads(authoring, app_id, credential)
    source = json.loads(answers["source"].body) if answers["source"].status == 200 else {}
    from proof.matrix.ops import resolve_references

    resolve = served_ids(base_source, source)
    unserved = [
        change["pointer"]
        for change in variant.changes()
        if change["op"] == "set-json"
        and not holds(_value_at(source, change["pointer"]), resolve_references(change["value"], resolve))
    ]
    request = {
        "id": variant.id,
        "mode": "first-read",
        "input": reading_input(answers, kept.project_answers, media, base, claims="full"),
    }
    held = [{**hold, "key": hold_key(hold["key"], base_source)} for hold in variant.holds]
    if held:
        request["holds"] = held
    (answer,) = run_bundle([request])
    return VariantOutcome(
        variant, unserved=unserved, answers=answers, answer=answer, base_source=base_source, holds=held
    )


def committed_input(directory) -> dict:
    """A committed base's first-read input (``lane_input.first_read_input``)."""
    return lane_input.first_read_input(directory)
