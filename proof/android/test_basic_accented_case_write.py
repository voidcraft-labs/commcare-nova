"""Nova's Basic write binds an exact accented property in both Android exports."""

import hashlib
import io
import zipfile

import pytest
from lxml import etree

from proof.android import observe
from proof.android.hq import DevicePeer
from proof.android.test_form_reads import _served
from proof.editors.conftest import write_evidence
from proof.editors.test_case_management_accented_property import ACCENTED, ANSWER, ASCII_NEIGHBOR, SELECTED, _assert_wire
from proof.observe import casedata
from proof.observe.record import Blobs
from proof.observe.served import local_archive

pytestmark = pytest.mark.reader("android")


def test_nova_basic_accented_write_reaches_hq_from_each_android_export(android_documents, hq, monkeypatch):
    from corehq.form_processor.models import CommCareCase

    document = android_documents["targeted-basic-accented-case-write"]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    assert document.local_ccz is not None
    stored_properties = []
    original_receipts = DevicePeer._stored

    def receipts(peer, submissions):
        rows = original_receipts(peer, submissions)
        if rows:
            case = CommCareCase.objects.get_case(SELECTED, peer.served.domain)
            stored_properties.append(dict(case.case_json))
        return rows

    monkeypatch.setattr(DevicePeer, "_stored", receipts)
    with _served(document, database=database) as (served, hq_release):
        # Only the test deployment app id is substituted. Read both actual form
        # artifacts before installing each archive with the same Android client.
        for label, archive in (("A", hq_release), ("local", local_archive(document.local_ccz, served.app_id))):
            with zipfile.ZipFile(io.BytesIO(archive)) as compiled:
                form = etree.fromstring(compiled.read("modules-0/forms-0.xml"))
            node, = form.xpath("//*[local-name()='update']/*")
            assert etree.QName(node).localname == ACCENTED
            bind, = form.xpath("//*[local-name()='bind' and @nodeset=$path]", path=f"/data/case/update/{ACCENTED}")
            assert bind.get("calculate") == "/data/note"
            blobs, sent, stored = Blobs(), [], []
            stored_properties.clear()
            record = observe.app(
                served, blobs, label=f"{label}:basic-accented-write", archive=archive, delivered=True,
                commands=["m0-f0"], questions={"/data/note": [ANSWER]}, installation_languages=("en",),
                sent=sent, stored=stored,
            )
            installed = blobs.get_json(record["answer"])
            assert installed["install"] == "Installed", installed
            walk = installed["walks"]["m0-f0"]
            assert len(sent) == 1, walk
            _assert_wire(sent[0])
            receipt, = stored
            assert "raised" not in receipt, receipt
            assert receipt["form"]["normal"] is True
            _assert_wire(receipt["form"]["xml"].encode())
            assert set(receipt["cases"]) == {SELECTED}, receipt
            assert receipt["instanceID"] in receipt["cases"][SELECTED]["forms"], receipt
            assert stored_properties == [{ASCII_NEIGHBOR: "ASCII neighbor", ACCENTED: ANSWER}]
            write_evidence(f"nova-basic-accented-{label}", {
                "archiveSha256": hashlib.sha256(archive).hexdigest(),
                "bind": dict(bind.attrib),
                "walk": walk,
                "receipt": receipt,
                "storedProperties": stored_properties,
            })
