"""One worker's mixed case restore, read by the retained untyped case itemset on both clients."""

from lxml import etree

from proof.formplayer import apps, hq
from proof.observe import casedata

DOCUMENT = "targeted-case-choice-reopen"
NODESET = "instance('casedb')/casedb/case"
STAMP = "2025-12-01T08:00:00.000Z"
EXPECTED = {
    "known-clinic": "Known clinic",
    "former-service": "Former service",
    "worker-profile": "Worker profile",
    "closed-host": "Closed host",
}


def _case(case_id, case_type, label, owner=casedata.USER_ID, indices=()):
    return casedata.CaseRecord(case_id, case_type, label, owner, STAMP, STAMP, None, (), indices)


def database():
    return casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        _case("closed-host", "former", EXPECTED["closed-host"]),
        _case("known-clinic", "clinic", EXPECTED["known-clinic"], indices=(
            ("parent", "former", "closed-host", "child"),
        )),
        _case("former-service", "former", EXPECTED["former-service"]),
        _case("worker-profile", "commcare-user", EXPECTED["worker-profile"]),
        _case("closed-orphan", "former", "Closed unreferenced"),
        _case("private-clinic", "clinic", "Unshared clinic", owner="another-worker"),
    ))


def _unfiltered(source):
    form = etree.fromstring(source.encode() if isinstance(source, str) else source)
    (itemset,) = form.xpath("//*[local-name()='select1' and @ref='/data/clinic']/*[local-name()='itemset']")
    assert itemset.get("nodeset").startswith(NODESET + "[@case_type")
    assert itemset.xpath("./*[local-name()='label']/@ref") == ["case_name"]
    assert itemset.xpath("./*[local-name()='value']/@ref") == ["@case_id"]
    itemset.set("nodeset", NODESET)
    return etree.tostring(form, encoding="unicode")


def release_unfiltered(holder):
    """Write the exact retained itemset expression and close the host and unreferenced record in HQ."""
    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.hqcase.utils import submit_case_blocks

    write = apps.form_written(holder, {"0.0": _unfiltered})

    def change(stored):
        blocks = [
            etree.tostring(CaseBlock(
                case_id=case_id, close=True, user_id=casedata.USER_ID,
                date_modified=casedata._datetime("2025-12-02T08:00:00.000Z"),
            ).as_xml(), encoding="unicode")
            for case_id in ("closed-host", "closed-orphan")
        ]
        submit_case_blocks(blocks, holder.unit.domain,
                           username=hq.worker_username(holder.unit.domain), user_id=casedata.USER_ID)
        write(stored)

    return change
