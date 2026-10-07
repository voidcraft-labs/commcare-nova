"""The checks read the corpus in its layout, and refuse one they cannot read.

Contract (the corpus-and-checks contract, "The corpus on disk"): ``corpus.load``
reads ``index.json`` and each document's directory, resolving each export's
configuration from ``configurations.json`` into the configuration HQ's
seams take, with Nova's verdict beside every export and the wire layout and
languages in ``document.json``. The plausible failures: a document silently
dropped (an index naming a directory that is not there), an export checked
under a configuration nobody defined or one Nova's publish refuses, a
configuration or verdict read loosely (a key misspelled, so a flag or
privilege the document needs is off), and an edit's entities placed without
the layout Nova emitted. A corpus the queue builder sampled
(``proof.store.queue.sampled``) is checked over its sample alone and still
reads, by id, every document it emitted; the plausible failure is a test
that names a document the sample left out failing every sampled run.

The emission never starts HQ, so a configuration's privileges are what the
lane derives from the apps Nova sends (``configurations.privileges_for``)
plus those the document names. The plausible failures there: the derivation
reading another capture than the minimum configuration's create and D′'s
update (so a privilege the content needs is off), a privilege the document
names lost, and a process that never booted HQ silently reading a
configuration with no privileges at all.

The input manifest (``inputs.json``) is what the lane keys every
observation by, so a digest that is not the bytes the checks read would let
a stale record stand in for a changed input; it is recomputed here from the
files with Python's own ``hashlib`` and ``zipfile``.

The accepted case is a real corpus document copied as it was emitted; each
refusal changes one thing in a copy of it.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import zipfile

import pytest

from proof.checks import cases, configurations, corpus
from proof.hq.configuration import DEFAULT_COMMCARE_VERSION


@pytest.fixture
def copied(tmp_path):
    source = cases.load_corpus().emitted[0]
    shutil.copytree(source.root, tmp_path / source.id)
    (tmp_path / "index.json").write_text(json.dumps({"seed": 1, "sample": 0, "documents": [{"id": source.id}]}))
    return tmp_path, source.id


def test_a_document_is_read_with_every_export_and_its_configuration(copied):
    root, document_id = copied
    document = corpus.load(root).document(document_id)
    assert document.exports, "the document is exported under at least its minimum configuration"
    for name, export in document.exports.items():
        assert export.configuration.name == name
        assert export.create.upload().body and export.republish.upload().body
    assert document.local_ccz is not None and document.local_again_ccz is not None
    assert [language["tag"] for language in document.wire_languages], "every document has a language"


def test_a_sampled_corpus_checks_its_sample_and_reads_every_document_it_emitted(tmp_path):
    from proof.store import queue

    names = ("one", "two", "three")
    for name in names:
        (tmp_path / name).mkdir()
    index = {"seed": 1, "sample": 0, "documents": [{"id": name, "source": f"producer:{name}"} for name in names]}
    (tmp_path / "index.json").write_text(json.dumps(index))
    assert corpus.load(tmp_path).unsampled == ()

    kept = queue.sampled(tmp_path, 1)
    left = sorted(set(names) - set(kept))
    loaded = corpus.load(tmp_path)
    assert [document.id for document in loaded.documents] == kept
    assert sorted(document.id for document in loaded.unsampled) == left
    assert sorted(document.id for document in loaded.emitted) == sorted(names)
    assert loaded.document(left[0]).source == f"producer:{left[0]}"
    # A sample of the sample still lists every document the corpus emitted.
    queue.sampled(tmp_path, 1)
    assert sorted(document.id for document in corpus.load(tmp_path).emitted) == sorted(names)
    # A document the sample left out is read from its directory, so the directory must be there.
    shutil.rmtree(tmp_path / left[0])
    with pytest.raises(corpus.CorpusLayoutError, match=f"lists {left[0]}, and"):
        corpus.load(tmp_path)


def _corpus_document(document_id):
    found = [document for document in cases.load_corpus().emitted if document.id == document_id]
    if not found:
        pytest.fail(f"The corpus holds no {document_id}, which this test reads.")
    return found[0]


@pytest.mark.parametrize(
    ("document_id", "expected"),
    [
        # A lookup workbook pushed and forms reading tables, and Save to Case blocks.
        ("lookup-app", ["CLOUDCARE", "LOOKUP_TABLES", "VELLUM_SAVE_TO_CASE"]),
        # A survey writing the worker's record.
        ("case-worker-survey", ["CLOUDCARE", "USERCASE"]),
        # A case list and its forms, which need only what every app does: Web Apps.
        ("case-list-local", ["CLOUDCARE"]),
    ],
)
def test_a_configuration_grants_the_privileges_hq_derives_from_what_nova_sends(hq, document_id, expected):
    document = _corpus_document(document_id)
    for name, export in document.exports.items():
        assert configurations.privileges_for(document.root, name) == expected, name
        assert list(export.configuration.privileges) == expected, name
        assert set(export.configuration.hq().privileges) == set(expected), name


def test_a_configuration_keeps_the_privileges_its_document_names(hq, copied):
    root, document_id = copied
    path = _configurations(root, document_id)
    value = json.loads(path.read_text())
    value["maximum"]["namedPrivileges"] = ["GEOCODER"]
    path.write_text(json.dumps(value))
    document = corpus.load(root).document(document_id)
    content = configurations.privileges_for(document.root, "minimum")
    assert "GEOCODER" not in content
    assert configurations.privileges_for(document.root, "maximum") == sorted({*content, "GEOCODER"})


def test_privileges_are_refused_for_an_unknown_configuration_or_a_lost_capture(hq, copied):
    root, document_id = copied
    directory = root / document_id
    assert configurations.privileges_for(directory, "minimum") is not None
    with pytest.raises(configurations.PrivilegeInputError, match="nobody-defined-this"):
        configurations.privileges_for(directory, "nobody-defined-this")
    lost = root / "lost"
    shutil.copytree(directory, lost)
    (lost / "export" / "minimum" / "create.json").unlink()
    with pytest.raises(configurations.PrivilegeInputError, match="create.json"):
        configurations.privileges_for(lost, "minimum")


def test_a_process_that_never_booted_hq_reads_no_privileges(copied, monkeypatch):
    """Without HQ the corpus holds no derived privileges, so reading them is refused rather than empty."""
    root, document_id = copied
    configuration = corpus.load(root).document(document_id).configurations["minimum"]
    monkeypatch.setattr(corpus, "hq_booted", lambda: False)
    assert configuration.named_privileges == ()
    with pytest.raises(corpus.CorpusLayoutError, match="privileges_for"):
        _ = configuration.privileges


def test_every_configuration_builds_at_the_harness_version():
    """``proof/corpus/configurations.ts::CORPUS_COMMCARE_VERSION`` is the harness's own."""
    versions = {
        configuration.commcare_version
        for document in cases.load_corpus().emitted
        for configuration in document.configurations.values()
    }
    assert versions == {DEFAULT_COMMCARE_VERSION}


def _digest(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _entries_digest(path):
    with zipfile.ZipFile(path) as archive:
        entries = sorted(
            (info.filename, hashlib.sha256(archive.read(info)).hexdigest())
            for info in archive.infolist()
            if not info.is_dir()
        )
    text = json.dumps([list(entry) for entry in entries], separators=(",", ":"), ensure_ascii=False)
    return "entries-sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_the_input_manifest_names_the_bytes_each_part_reads():
    corpus_root = cases.load_corpus().root
    listed = json.loads((corpus_root / "inputs.json").read_text())["documents"]
    documents = cases.load_corpus().emitted
    assert set(listed) == {document.id for document in documents}
    edited = 0
    media_documents = set()
    for document in documents:
        assert listed[document.id] == _digest(document.root / "inputs.json"), document.id
        manifest = document.inputs
        assert manifest["document"] == document.id
        assert set(manifest["configurations"]) == set(document.exports), document.id
        for name, parts in manifest["configurations"].items():
            for part, inputs in parts.items():
                for role, entry in inputs.items():
                    assert entry["digest"] == _digest(document.root / entry["path"]), (document.id, name, part, role)
            export = document.exports[name]
            assert parts["a"]["create.request.body"]["path"] == f"export/{name}/create.body"
            assert parts["b"]["request.body"]["path"] == f"export/{name}/republish.body"
            if export.republish.lookups is not None:
                assert parts["b"]["lookups.body"]["path"] == f"export/{name}/{export.republish.lookups.body_path.name}"
            # The media upload each publish sent after its import is read by the part that replays it.
            for part, role, captured in (
                ("a", "create.media.body", export.create),
                ("b", "media.body", export.republish),
            ):
                if captured.media is None:
                    assert role not in parts[part], (document.id, name, part)
                else:
                    assert parts[part][role]["path"] == f"export/{name}/{captured.media.body_path.name}"
                    media_documents.add(document.id)
            if name in (document.edit.exports if document.edit else {}):
                edited += 1
                assert parts["b_edit"]["request.body"]["path"] == f"edit/export/{name}/update.body"
                assert parts["b_edit"]["document"]["path"] == "edit/document.json"
                update = document.edit.exports[name].update
                if update.media is None:
                    assert "media.body" not in parts["b_edit"], (document.id, name)
                else:
                    assert parts["b_edit"]["media.body"]["path"] == f"edit/export/{name}/{update.media.body_path.name}"
                    media_documents.add(document.id)
            else:
                assert "b_edit" not in parts
        for role, entry in manifest["local"].items():
            assert entry["digest"] == _entries_digest(document.root / entry["path"]), (document.id, role)
        if document.edit is not None:
            assert manifest["judge"]["batch"]["digest"] == _digest(document.root / "edit" / "batch.json")
    assert edited > 0, "some document's edit is published, so b_edit was compared"
    assert media_documents, "some document's publish sends media, so its upload's roles were compared"


def _configurations(root, document_id):
    return root / document_id / "configurations.json"


def test_an_index_naming_a_missing_document_is_refused(copied):
    root, document_id = copied
    (root / "index.json").write_text(json.dumps({"documents": [{"id": document_id}, {"id": "missing.document"}]}))
    with pytest.raises(corpus.CorpusLayoutError, match="missing.document"):
        corpus.load(root)


def test_a_misspelled_configuration_key_is_refused(copied):
    root, document_id = copied
    path = _configurations(root, document_id)
    value = json.loads(path.read_text())
    value["minimum"]["namedPrivilege"] = value["minimum"].pop("namedPrivileges")
    path.write_text(json.dumps(value))
    with pytest.raises(corpus.CorpusLayoutError, match="namedPrivilege"):
        _ = corpus.load(root).document(document_id).exports


def test_an_export_under_an_undefined_configuration_is_refused(copied):
    root, document_id = copied
    export = next((root / document_id / "export").iterdir())
    export.rename(export.with_name("nobody-defined-this"))
    with pytest.raises(corpus.CorpusLayoutError, match="nobody-defined-this"):
        _ = corpus.load(root).document(document_id).exports


def test_an_export_without_its_create_is_refused(copied):
    root, document_id = copied
    export = next((root / document_id / "export").iterdir())
    (export / "create.json").unlink()
    with pytest.raises(corpus.CorpusLayoutError, match="create"):
        _ = corpus.load(root).document(document_id).exports


def test_an_export_under_a_configuration_nova_refuses_is_refused(copied):
    """Decision 19: a configuration lacking a flag Nova's publish requires is never checked."""
    root, document_id = copied
    verdict_path = root / document_id / "verdict.json"
    verdict = json.loads(verdict_path.read_text())
    verdict.setdefault("minimumConfiguration", {}).setdefault("flags", []).append("NOT_IN_ANY_CONFIGURATION")
    verdict_path.write_text(json.dumps(verdict))
    with pytest.raises(corpus.CorpusLayoutError, match="decision 19"):
        _ = corpus.load(root).document(document_id).exports


def test_an_export_without_novas_verdict_is_refused(copied):
    """Decision 19 needs Nova's verdict beside every export, so an export without one is not checked."""
    root, document_id = copied
    verdict_path = root / document_id / "verdict.json"
    verdict = json.loads(verdict_path.read_text())
    del verdict["minimumConfiguration"]["caseSearchEnabled"]
    verdict_path.write_text(json.dumps(verdict))
    with pytest.raises(corpus.CorpusLayoutError, match="minimumConfiguration"):
        _ = corpus.load(root).document(document_id).exports
    verdict_path.unlink()
    with pytest.raises(corpus.CorpusLayoutError, match="verdict.json"):
        _ = corpus.load(root).document(document_id).exports


def test_the_wire_layout_is_read_from_the_document_and_refused_without_it(copied):
    root, document_id = copied
    document = corpus.load(root).document(document_id)
    assert document.wire_modules and all(module["uuid"] for module in document.wire_modules)
    assert document.wire_languages and all(language["code"] for language in document.wire_languages)
    path = root / document_id / "document.json"
    value = json.loads(path.read_text())
    del value["wire"]
    path.write_text(json.dumps(value))
    with pytest.raises(corpus.CorpusLayoutError, match="wire.modules"):
        _ = corpus.load(root).document(document_id).wire_modules
    with pytest.raises(corpus.CorpusLayoutError, match="wire.languages"):
        _ = corpus.load(root).document(document_id).wire_languages
