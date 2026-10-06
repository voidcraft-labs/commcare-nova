"""A document's records are a function of its inputs: the same inputs give the same bytes, observed or stored.

Contract (the records the checks judge, ``proof.observe.unit``): a document
observed twice with nothing stored writes the same record, part by part
(each part's canonical digest), no record names where it was made (a
scratch directory, the corpus, the output), and no value a record holds
inline is longer than a kilobyte (bytes are blobs). A part the store holds
is read, not observed again, and what is observed under it is what an
observation with nothing stored writes: under a held ``a``, A is recreated
and the other parts come out byte-identical; under a held ``a`` and ``b``, B
is recreated too and ``b_aligned`` comes out byte-identical. A fresh store
observes every part and hands each to its audit, which finds it equal.
Every input a part reads moves its key (the local archive proof 3's
sessions replay on moves ``b_aligned``'s; what a hook declares it reads
moves its state's), and what only the judges read moves none; the corpus's
input manifest is what its files give. A B-edit whose update sends B's
bytes over B's cases has B's key and is recorded as the same: observing it
all the same gives B's record byte for byte, the hooks' and proof 4's
records included (they run from the same state, key and clock), and its
judgments are B's relabeled B-edit. A publish that sends media has that
upload replayed after its import (``unit._Unit.upload_media``): at A it
maps every file the app references to a medium HQ holds, the same way in
every unit; at B, and at B's recreation, the same files again, to A's
media; and at B-edit what D' adds, which HQ's update alone leaves unmapped.
A publish whose import HQ refused sends no media, as Nova's sends none.

The plausible failures: entropy or a clock reached outside an operation (two
observations mint different ids), a timing, a path or an unordered set in a
record, a recreated A or B that is not the one first observed (the parts
under it then differ), a key that misses an input (a stored part would
stand for one whose inputs changed) or reads a judge-only input (every edit
to the register would observe again), a hook given another state at B-edit
than at B, a same-as that hides what B-edit's own observation shows, and a
part kept with blobs it does not name (every part carrying the blobs of
those observed before it) or without one it does, and a media upload left
unreplayed at any publish or at B's recreation (A keeps Nova's content-hash
ids, which no HQ holds after a publish, and B-edit leaves D''s media
unmapped), replayed from another publish's capture, replayed after an import
HQ refused, or replayed with entropy outside its operation.
"""

from __future__ import annotations

import copy
import json
import sys
import types
from contextlib import contextmanager
from dataclasses import replace

import pytest

from proof.checks import bar, cases, observations, proof1, sharding
from proof.observe import unit
from proof.observe.record import PARTS, Blobs, DocumentRecords, canonical, part_key


class DictStore:
    """A store in memory: the records (and their blobs) it holds by key, and what it was asked to keep or audit."""

    transcripts = None

    def __init__(self, held=None, *, fresh=False):
        self.held = dict(held or {})
        self.fresh = fresh
        self.puts = []
        self.audits = []

    def lookup(self, key):
        found = self.held.get(key)
        return None if found is None else copy.deepcopy(found[0])

    def blobs(self, key):
        return self.held[key][1]

    def put(self, key, record, blobs):
        self.puts.append((key, copy.deepcopy(record), set(blobs.refs())))

    def audit(self, key, record):
        self.audits.append((key, canonical(record) == canonical(self.held[key][0])))


def _cheapest(documents):
    estimate = sharding.estimate(sharding.load_timings())
    edited = [document for document in documents if document.edit is not None and document.edit.exports]
    assert edited, "The corpus holds no edited document, so nothing shows a document's whole tree recorded."
    return min(edited, key=lambda document: (estimate(document.group), document.id))


@pytest.fixture(scope="module")
def document():
    return _cheapest(cases.load_corpus().emitted)


@pytest.fixture(scope="module")
def observed(hq, core_runner, editor_driver, document):
    return unit.observe_document(document, core_runner=core_runner, editor_driver=editor_driver)


def _store_of(records, parts):
    """A store holding ``parts`` ("<configuration>/<part>", "local") of ``records``."""
    held = {}
    for name, configuration in records.configurations.items():
        for part, key in configuration.keys.items():
            if f"{name}/{part}" in parts:
                held[key] = (getattr(configuration, part), records.blobs)
    if "local" in parts:
        held[records.local_key] = (records.local, records.blobs)
    return held


def _assert_each_put_holds_the_blobs_its_record_names(store, blobs):
    """Each part the store was given came with exactly the blobs its record names, every one of them held."""
    assert store.puts, "The store was given no part, so nothing shows what a part is kept with."
    for key, record, handed in store.puts:
        named = {value for _, value in _inline(record) if value.startswith("sha256:") and value in blobs}
        assert handed == named, (
            f"The part {key.hex()[:16]} ({record.get('kind')}) was kept with {len(handed)} blobs, and its record"
            f" names {len(named)}: {sorted(handed ^ named)[:5]}"
        )


def _inline(value, at=""):
    """Every string a record holds inline, with where."""
    if isinstance(value, str):
        yield at, value
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _inline(item, f"{at}/{index}")
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from _inline(item, f"{at}/{key}")


@pytest.mark.under_determinism
def test_a_document_observed_twice_writes_the_same_records_naming_no_place(
    observed, document, core_runner, editor_driver, tmp_path
):
    again = unit.observe_document(document, core_runner=core_runner, editor_driver=editor_driver)
    assert observed.digests() == again.digests()
    names = set(observed.digests())
    assert {f"{name}/{part}" for name in document.exports for part in ("a", "b", "b_aligned")} | {"local"} <= names
    assert {f"{name}/b_edit" for name in document.edit.exports} <= names
    parts = {name: [getattr(held, part) for part in PARTS] for name, held in observed.configurations.items()}
    written = canonical(parts | {"": observed.local}).decode()
    for place in ("/tmp/", str(document.root), "/out/", "proof-observe-"):
        assert place not in written, f"a record names {place!r}, where it was made"
    long = [
        (at, len(value.encode())) for at, value in _inline(parts | {"": observed.local}) if len(value.encode()) > 1024
    ]
    assert long == [], f"a record holds these values inline, each over a kilobyte, rather than as blobs: {long}"
    # The records survive being written and read back, digest for digest.
    assert DocumentRecords.load(observed.save(tmp_path / "records")).digests() == observed.digests()


@pytest.mark.under_determinism
def test_a_stored_part_is_read_and_what_is_observed_under_it_is_unchanged(
    observed, document, core_runner, editor_driver
):
    a_parts = {f"{name}/a" for name in observed.configurations}
    store = DictStore(_store_of(observed, a_parts))
    under = unit.observe_document(document, core_runner=core_runner, editor_driver=editor_driver, store=store)
    assert sorted(under.observed) == sorted(
        [f"{name}/{part}" for name, held in observed.configurations.items() for part in held.keys if part != "a"]
        + ["local"]
    )
    assert under.digests() == observed.digests()
    # Each part observed is kept with the blobs its record names and no others (the local part's are what its
    # hooks read: the exports Nova sends and Core's parse of each archive's forms).
    _assert_each_put_holds_the_blobs_its_record_names(store, under.blobs)

    # Under a held a and b, B is recreated for b_aligned (its local archive changed, say), which comes out the same.
    held_b = a_parts | {f"{name}/b" for name in observed.configurations} | {"local"}
    held_b |= {f"{name}/b_edit" for name in observed.configurations}
    under_b = unit.observe_document(
        document, core_runner=core_runner, editor_driver=editor_driver, store=DictStore(_store_of(observed, held_b))
    )
    assert sorted(under_b.observed) == sorted(f"{name}/b_aligned" for name in observed.configurations)
    assert under_b.digests() == observed.digests()

    # Holding every part, nothing is observed; a fresh store observes every part and finds each equal.
    everything = set(observed.digests())
    held = unit.observe_document(
        document, core_runner=core_runner, editor_driver=editor_driver, store=DictStore(_store_of(observed, everything))
    )
    assert held.observed == [] and held.digests() == observed.digests()
    fresh = DictStore(_store_of(observed, everything), fresh=True)
    audited = unit.observe_document(document, core_runner=core_runner, editor_driver=editor_driver, store=fresh)
    assert sorted(audited.observed) == sorted(everything)
    assert sorted(key for key, _ in fresh.audits) == sorted(fresh.held)
    assert all(equal for _, equal in fresh.audits)
    _assert_each_put_holds_the_blobs_its_record_names(fresh, audited.blobs)
    assert sorted(key for key, _, _ in fresh.puts) == sorted(fresh.held)


def _inputs():
    """A document's inputs as ``inputs.json`` holds them, in miniature: one configuration, every part, every role."""
    return {
        "configurations": {
            "minimum": {
                "a": {"configurations": "sha256:c", "document": "sha256:d", "create.request.body": "sha256:1"},
                "b": {"request.body": "sha256:2", "request.json": "sha256:j"},
                "b_edit": {
                    "request.body": "sha256:3",
                    "request.json": "sha256:j",
                    "document": "sha256:e",
                    "verdict": "sha256:v",
                },
            }
        },
        "local": {"local": "entries-sha256:l", "edit-local": "entries-sha256:e"},
    }


DATABASES = {"b": "sha256:cases", "b_edit": "sha256:edited-cases"}
HOOKS = {"A": {"intent": {"x": 1}}, "B": {"intent": {"x": 2}}, "B-edit": {"intent": {"x": 3}}}


def _changed(change):
    inputs, databases, hooks = _inputs(), dict(DATABASES), json.loads(json.dumps(HOOKS))
    change(inputs, databases, hooks)
    keys = unit.part_keys(inputs, "minimum", databases, hooks)
    unchanged = unit.part_keys(_inputs(), "minimum", DATABASES, HOOKS)
    return {part for part, key in keys.items() if key != unchanged[part]}


def _set(part, role):
    def change(inputs, databases, hooks):
        inputs["configurations"]["minimum"][part][role] = "sha256:changed"

    return change


def _database(part):
    def change(inputs, databases, hooks):
        databases[part] = "sha256:changed"

    return change


def _local(role):
    def change(inputs, databases, hooks):
        inputs["local"][role] = "entries-sha256:changed"

    return change


def _hook(state):
    def change(inputs, databases, hooks):
        hooks[state]["intent"] = {"x": "changed"}

    return change


@pytest.mark.parametrize(
    ("change", "moved"),
    [
        pytest.param(_set("a", "create.request.body"), {"a", "b", "b_aligned", "b_edit"}, id="create"),
        pytest.param(_set("a", "configurations"), {"a", "b", "b_aligned", "b_edit"}, id="configurations"),
        pytest.param(_set("b", "request.body"), {"b", "b_aligned"}, id="republish"),
        pytest.param(_set("b", "lookups.body"), {"b", "b_aligned"}, id="republish workbook"),
        # The media upload each publish sends after its import, replayed in the part that publishes.
        pytest.param(_set("a", "create.media.body"), {"a", "b", "b_aligned", "b_edit"}, id="create media"),
        pytest.param(_set("b", "media.body"), {"b", "b_aligned"}, id="republish media"),
        pytest.param(_set("b_edit", "media.json"), {"b_edit"}, id="update media sidecar"),
        pytest.param(_set("b_edit", "request.json"), {"b_edit"}, id="update sidecar"),
        pytest.param(_database("b"), {"b", "b_aligned"}, id="D's cases"),
        pytest.param(_local("local"), {"b_aligned"}, id="D's local archive"),
        pytest.param(_local("edit-local"), set(), id="D''s local archive"),
        pytest.param(_hook("A"), {"a", "b", "b_aligned", "b_edit"}, id="a hook's inputs at A"),
        pytest.param(_hook("B"), {"b", "b_aligned"}, id="a hook's inputs at B"),
        pytest.param(_hook("B-edit"), {"b_edit"}, id="a hook's inputs at B-edit"),
        pytest.param(_database("b_edit"), {"b_edit"}, id="D''s cases"),
        # Read through the case database, or only to say whether the corpus holds D''s publish.
        pytest.param(_set("b_edit", "document"), set(), id="D' document"),
        pytest.param(_set("b_edit", "verdict"), set(), id="D' verdict"),
    ],
)
def test_each_input_a_part_reads_moves_its_key_and_its_children_and_no_other(change, moved):
    assert _changed(change) == moved


def test_a_b_edit_with_bs_inputs_has_bs_key_and_a_local_part_reads_only_its_archives():
    inputs = _inputs()
    inputs["configurations"]["minimum"]["b_edit"].update({"request.body": "sha256:2"})
    databases = {"b": "sha256:cases", "b_edit": "sha256:cases"}
    keys = unit.part_keys(inputs, "minimum", databases)
    assert keys["b_edit"] == keys["b"] != keys["a"]
    # What a hook declares it reads at B-edit (D''s intent, say) is B-edit's own: where it differs from B's,
    # B-edit is observed.
    declared = {"A": {}, "B": {"intent": {"intent": "sha256:d"}}, "B-edit": {"intent": {"intent": "sha256:e"}}}
    assert unit.part_keys(inputs, "minimum", databases, declared)["b_edit"] != keys["b"]
    declared["B-edit"] = declared["B"]
    keyed = unit.part_keys(inputs, "minimum", databases, declared)
    assert keyed["b_edit"] == keyed["b"]
    archives = {"local": "entries-sha256:l", "edit-local": "entries-sha256:e"}
    assert unit.local_key(_inputs()) == part_key("local", None, {"archives": archives})
    moved = _inputs()
    moved["local"]["local"] = "entries-sha256:x"
    assert unit.local_key(moved) != unit.local_key(_inputs())
    # What a local hook declares it reads (the publishes the manifest reads, say) moves the local part's key,
    # and what a state's hook declares does not.
    declared = {"local": {"manifest": {"minimum/create.body": "sha256:1"}}}
    assert unit.local_key(_inputs(), declared) != unit.local_key(_inputs())
    assert unit.local_key(_inputs(), {"A": {"intent": {"x": 1}}, "local": {}}) == unit.local_key(_inputs())


def test_a_hook_that_declares_nothing_it_reads_is_refused(monkeypatch):
    hook = types.ModuleType("proof.observe.intent")
    hook.observe = lambda ctx: {}
    monkeypatch.setitem(sys.modules, "proof.observe.intent", hook)
    with pytest.raises(unit.HookContractError, match="defines no inputs"):
        unit.hook_modules()


def test_the_written_manifest_and_the_files_give_the_same_inputs():
    """The corpus writes every document's input manifest (``proof/corpus/emitCorpus.ts``), and it holds exactly
    the digests of the files it names."""
    documents = cases.load_corpus().emitted
    lacking = [document.id for document in documents if not (document.root / "inputs.json").exists()]
    assert lacking == [], f"The corpus wrote no inputs.json for {lacking[:10]} ({len(lacking)} documents)."
    differing = [
        document.id for document in documents if unit.document_inputs(document) != unit.computed_inputs(document)
    ]
    assert differing == [], f"inputs.json does not hold what the files give for {differing[:10]}."


def _same_as_subject():
    """The cheapest document with a configuration whose B-edit is keyed as its B."""
    found = []
    for document in cases.load_corpus().emitted:
        if document.edit is None:
            continue
        databases = unit.case_databases(document)
        inputs = unit.document_inputs(document)
        for name in sorted(document.edit.exports):
            keys = unit.part_keys(inputs, name, databases)
            if keys.get("b_edit") == keys["b"]:
                found.append((document, name))
                break
    assert found, (
        "No corpus document's update sends its republish's bytes over the same cases, so nothing shows a B-edit"
        " recorded as its B."
    )
    estimate = sharding.estimate(sharding.load_timings())
    return min(found, key=lambda pair: (estimate(pair[0].group), pair[0].id))


def _relabeled(differences):
    return sorted(
        (replace(d, artifact=d.artifact.replace("@B", "@B-edit")) for d in differences),
        key=lambda d: json.dumps(d.as_json(), sort_keys=True),
    )


def _sorted(differences):
    return sorted(differences, key=lambda d: json.dumps(d.as_json(), sort_keys=True))


def _recording_hooks():
    """Observation hooks that record the state they are given: the unit's key and clock, and HQ's app there.

    Each runs one operation of its own, as a hook runs each HQ call, so its
    record shows what the unit's entropy and clock would make of it.
    """

    def seen(ctx, label):
        from proof.hq import operations

        with ctx.unit.operation(label, b"probe"):
            app = operations.held_app(ctx.unit, ctx.app_id)
        return {"key": ctx.unit.key.hex(), "depth": ctx.unit.depth, "app": [app.version, app.doc_type]}

    hooks = {}
    for name in ("intent", "manifest"):
        module = types.ModuleType(f"proof.observe.{name}")
        module.inputs = lambda document, state: {}
        module.observe = lambda ctx, name=name: seen(ctx, f"{name}-probe")
        module.observe_local = lambda ctx: {"archives": sorted(ctx.archives)}
        hooks[f"proof.observe.{name}"] = module
    proof4 = types.ModuleType("proof.observe.proof4")
    proof4.inputs = lambda document, state: {}
    proof4.observe_b = lambda ctx: {**seen(ctx, "proof4-probe"), "restore": len(ctx.restore or b"")}
    hooks["proof.observe.proof4"] = proof4
    return hooks


@pytest.mark.under_determinism
def test_a_b_edit_with_bs_inputs_is_recorded_as_b_and_judges_as_b_relabeled(hq, core_runner, monkeypatch):
    for module, hook in _recording_hooks().items():
        monkeypatch.setitem(sys.modules, module, hook)
    document, name = _same_as_subject()
    same = unit.observe_document(document, core_runner=core_runner, configurations={name})
    held = same.configurations[name]
    assert held.b_edit == {"same_as": held.keys["b"].hex()} and f"{name}/b_edit" not in same.observed

    own = unit.observe_document(document, core_runner=core_runner, configurations={name}, same_as=False)
    observed_b_edit = own.configurations[name].b_edit
    assert "same_as" not in observed_b_edit
    # B-edit's own observation is B's record byte for byte: the hooks and proof 4 ran from the same state, key
    # and clock, and logged the same operations.
    assert set(held.b["hooks"]) == {"intent"} and "proof4" in held.b
    assert {entry.get("hook") for entry in held.b["operations"]} >= {"intent", "proof4"}
    assert set(same.local["hooks"]) == {"intent", "manifest"}
    assert canonical(observed_b_edit) == canonical(held.b)

    # Judged, the same-as B-edit is B's own B-edit observation, and B's build differences relabeled.
    views = [observations.edit_view(records, name) for records in (same, own)]
    assert _sorted(bar.edit_bar(document.id, views[0])) == _sorted(bar.edit_bar(document.id, views[1]))
    republish = observations.republish_view(same, name)
    assert _sorted(bar.build_differences(document.id, views[0].b.build)) == _relabeled(
        bar.build_differences(document.id, republish.b.build)
    )
    wires = (
        {"modules": document.wire_modules, "languages": document.wire_languages},
        {"modules": document.edit_wire_modules, "languages": document.edit_wire_languages},
    )
    tables = (proof1.lookup_tags(document.document), proof1.lookup_tags(document.edit_document))
    identities = [
        _sorted(proof1.edit_identity(document.id, view, *wires, document.edit.footprint, *tables)) for view in views
    ]
    assert identities[0] == identities[1]


def test_records_name_their_blobs_and_read_back_whole():
    blobs = Blobs()
    ref = blobs.put(b"x" * 2048)
    assert blobs.get(ref) == b"x" * 2048 and ref.startswith("sha256:")
    other = Blobs()
    other.merge(blobs)
    assert other.refs() == [ref]
    with pytest.raises(KeyError, match="blobs it was read with do not hold it"):
        Blobs().get(ref)


# Media: each publish's upload, replayed after its import ------------------------------------------------------


def _cheapest_where(sends, what):
    """The cheapest corpus document and configuration whose capture ``sends(document, name)``: ``(document, name)``."""
    estimate = sharding.estimate(sharding.load_timings())
    found = [
        (estimate(document.group), document.id, name, document)
        for document in cases.load_corpus().emitted
        for name in sorted(document.exports)
        if sends(document, name)
    ]
    assert found, f"The corpus holds no document whose {what}, so nothing shows its upload replayed."
    _, _, name, document = min(found, key=lambda entry: entry[:3])
    return document, name


@contextmanager
def _lane_unit(document, name, core_runner):
    """The lane's unit for one configuration of ``document``, under its ``a`` part's key (``unit._Unit``)."""
    from proof.hq.state import hq_unit
    from proof.observe.record import NULL_STORE

    export = document.exports[name]
    inputs, databases = unit.document_inputs(document), unit.case_databases(document)
    keys = unit.part_keys(inputs, name, databases, unit.hook_inputs(document))
    configuration = export.configuration.hq()
    with hq_unit(configuration, root_key=keys["a"], validate=core_runner.validate_form) as held:
        yield unit._Unit(document, export, configuration, held, core_runner, None, NULL_STORE, Blobs(), {})


def _hq_media(state):
    """Each path of the app's multimedia map whose item names a medium HQ holds, with that medium's id: none of
    Nova's content hashes, which name no medium in HQ."""
    from corehq.apps.hqmedia.models import CommCareMultimedia

    from proof.hq import operations

    found = {}
    for path, item in operations.held_app(state.unit, state.app_id).multimedia_map.items():
        media_class = CommCareMultimedia.get_doc_class(item.media_type)
        if media_class.get_db().doc_exist(item.multimedia_id):
            found[path] = item.multimedia_id
    return found


def _zip_paths(captured):
    """The form paths HQ's bulk upload reads the entries of a captured media upload's ZIP as
    (``hqmedia/tasks.py::process_bulk_upload_zip``, ``CommCareMultimedia.get_form_path``)."""
    import io
    import zipfile

    from corehq.apps.hqmedia.models import CommCareMultimedia

    from proof.hq import operations

    with zipfile.ZipFile(io.BytesIO(operations.upload_field(captured.upload(), "bulk_upload_file"))) as archive:
        return {CommCareMultimedia.get_form_path(entry) for entry in archive.namelist()}


def test_an_admission_record_is_the_archives_whatever_the_runner_admitted_before(core_runner, tmp_path):
    """The root the runner reads an archive under counts every admission it made before, admitted or refused, so
    the record the observation keeps (``proof.observe.build.admit``) holds it as a placeholder either way: the
    same archive admitted again, after others, is recorded alike."""
    from proof.core.artifacts import BASIC_APP, archive_variant
    from proof.observe.build import HANDLE_PLACEHOLDER, admit

    refusing = archive_variant(BASIC_APP, tmp_path / "broken-form.ccz", {"modules-1/forms-0.xml": b"<h:html"})
    refused, admitted = admit(core_runner, refusing), admit(core_runner, BASIC_APP)
    assert (refused["admitted"], admitted["admitted"]) == (False, True)
    for record in (refused, admitted):
        assert f"jr://archive/{HANDLE_PLACEHOLDER}/profile.ccpr" in json.dumps(record)
    assert admit(core_runner, refusing) == refused and admit(core_runner, BASIC_APP) == admitted


def _logo_paths(captured):
    """The form paths the app a captured publish sends names as its logos (``logo_refs``), which HQ's bulk upload
    never maps (``proof.observe.publish._unmatched_cause``: ``logo_refs``)."""
    from corehq.apps.hqmedia.models import CommCareMultimedia

    from proof.hq import operations

    app = json.loads(operations.upload_field(captured.upload(), "app_file"))
    return {CommCareMultimedia.get_form_path(ref["path"]) for ref in (app.get("logo_refs") or {}).values()}


def _matched(media):
    return {entry["path"] for entry in media["matched"]}


@pytest.mark.under_determinism
def test_a_create_that_sends_media_maps_it_into_a_the_same_way_in_every_unit(hq, core_runner):
    from proof.hq import operations

    document, name = _cheapest_where(lambda d, n: d.exports[n].create.media is not None, "create sends media")
    made = []
    for _ in range(2):
        with _lane_unit(document, name, core_runner) as state:
            ops = state.ops("a")
            record = state.create_a(ops, full=False)
            media = record["create"]["media"]
            assert media["refused"] is None and _matched(media), document.id
            assert _matched(media) <= _zip_paths(document.exports[name].create.media)
            # Each file HQ matched names a medium HQ holds, where Nova's create named a content hash.
            assert set(_hq_media(state)) == _matched(media)
            mapped = operations.held_app(state.unit, state.app_id).multimedia_map
            made.append(
                (
                    canonical(record),
                    canonical({path: item.to_json() for path, item in mapped.items()}),
                    [(entry["label"], entry["key"], entry["depth"]) for entry in ops.log],
                )
            )
    assert [label for label, _, _ in made[0][2]][:2] == ["create", "media"]
    assert made[0] == made[1]


def _held_app(state):
    from proof.hq import operations

    return canonical(operations.held_app(state.unit, state.app_id).to_json())


@pytest.mark.under_determinism
def test_b_and_its_recreation_send_the_media_again_and_a_publish_hq_refuses_sends_none(hq, core_runner, tmp_path):
    """HQ's update keeps the app's map (``overwrite_app_from_source``), and B's upload maps each file to the
    medium A's upload made, found by its bytes (``CommCareMultimedia.get_by_data``). B recreated for a
    ``b_aligned`` the store lacks (``_Unit.recreate_b``) is the same app, the version its media save stamps
    included. Nova sends no media after HQ refused the import (``lib/deployment/service.ts::publishAppToHq``
    returns the refusal before ``uploadMediaBytes``), so a republish whose import HQ refuses is followed by no
    media operation: here one carrying no app file (``_handle_import_app`` answers 400)."""
    document, name = _cheapest_where(
        lambda d, n: d.exports[n].create.media is not None and d.exports[n].republish.media is not None,
        "create and republish send media",
    )
    republish = document.exports[name].republish
    body = tmp_path / "refused.body"
    body.write_bytes(b'--refused\r\nContent-Disposition: form-data; name="app_id"\r\n\r\ncaptured\r\n--refused--\r\n')
    refused = replace(
        republish, body_path=body, meta={**republish.meta, "contentType": "multipart/form-data; boundary=refused"}
    )
    with _lane_unit(document, name, core_runner) as state:
        created = state.create_a(state.ops("a"), full=False)["create"]
        at_a = _hq_media(state)
        ops = state.ops("b")
        published = state.publish_over_a(ops, republish, "B")
        at_b, held_b = _hq_media(state), _held_app(state)
        state.recreate_b({}, republish)
        recreated = _held_app(state)
        refused_ops = state.ops("refused")
        refused_publish = state.publish_over_a(refused_ops, refused, "B")
    assert [entry["label"] for entry in ops.log] == ["publish", "media"], document.id
    assert published["refused"] is None and published.get("media") is not None, document.id
    assert published["media"]["refused"] is None
    assert _matched(published["media"]) == _matched(created["media"]) == set(at_a)
    assert at_b == at_a
    assert recreated == held_b
    assert refused_publish["refused"] == {
        "status": 400,
        "response": {"success": False, "error": "app_file is required"},
    }
    assert "media" not in refused_publish
    assert [entry["label"] for entry in refused_ops.log] == ["publish"]


def test_b_edit_maps_the_media_its_update_adds_over_an_a_that_had_none(hq, core_runner):
    """HQ's update keeps A's map (``overwrite_app_from_source`` excludes ``multimedia_map``), so what a D' adds is
    mapped only by the upload its publish sends after the update."""
    document, name = _cheapest_where(
        lambda d, n: (
            d.exports[n].create.media is None
            and d.edit is not None
            and n in d.edit.exports
            and d.edit.exports[n].update.media is not None
            and _zip_paths(d.edit.exports[n].update.media) - _logo_paths(d.edit.exports[n].update)
        ),
        "D' gains media its forms or modules use",
    )
    update = document.edit.exports[name].update
    with _lane_unit(document, name, core_runner) as state:
        created = state.create_a(state.ops("a"), full=False)["create"]
        at_a = _hq_media(state)
        ops = state.ops("b_edit")
        published = state.publish_over_a(ops, update, "B-edit")
        at_b_edit = _hq_media(state)
    assert "media" not in created and at_a == {}, document.id
    assert [entry["label"] for entry in ops.log] == ["publish", "media"], document.id
    assert published["refused"] is None and published.get("media") is not None, document.id
    assert published["media"]["refused"] is None
    matched = _matched(published["media"])
    assert matched and matched <= _zip_paths(update.media)
    assert set(at_b_edit) == matched
