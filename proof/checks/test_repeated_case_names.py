"""Require one reviewed child-case writer and the same submitted repeat occurrence on both builds."""

from dataclasses import replace
from types import SimpleNamespace

from lxml import etree

from proof.checks import repeated_case_names as names
from proof.checks.differences import Difference

RAW = "  Ada   Doe  "
TRIMMED = "Ada   Doe"
SOURCE = "/data/member/full"
CASE_PATH = "/data/member/case/create/case_name"
FIELD = ("form", "1.0", "xform", "data", "member", "full")
XF = names.XF
CASE = names.CASE
SOURCE_FORM = {
    "xmlns": "urn:form",
    "actions": {
        "subcases": [{"repeat_context": "/data/member", "case_type": "child", "name_update": {"question_path": SOURCE}}]
    },
}


def state(*, old):
    data = etree.Element("{urn:form}data")
    model = etree.Element(XF + "model")
    etree.SubElement(etree.SubElement(model, XF + "instance"), data.tag)
    etree.SubElement(
        model, XF + "bind", nodeset=CASE_PATH, calculate=SOURCE if old else "/data/member/nova_trimmed_full"
    )
    if not old:
        etree.SubElement(
            model,
            XF + "bind",
            nodeset="/data/member/nova_trimmed_full",
            calculate=rf"replace({SOURCE}, '^[\x00-\x20]+|[\x00-\x20]+$', '')",
        )
    installed = etree.Element("form")
    installed.append(model)
    etree.SubElement(installed, XF + "repeat", nodeset="/data/member")
    blocks = []
    for identity in ("first", "second"):
        member = etree.SubElement(data, "{urn:form}member")
        # Both repeats have the same values. Only their identity and occurrence can distinguish them.
        for name in ("full", "other"):
            etree.SubElement(member, "{urn:form}" + name).text = RAW
        if not old:
            etree.SubElement(member, "{urn:form}nova_trimmed_full").text = TRIMMED
        case = etree.SubElement(member, CASE + "case", case_id=identity)
        create = etree.SubElement(case, CASE + "create")
        etree.SubElement(create, CASE + "case_type").text = "child"
        etree.SubElement(create, CASE + "case_name").text = RAW if old else TRIMMED
        blocks.append(
            {
                "@case_id": identity,
                "@xmlns": CASE[1:-1],
                "create": {"case_type": "child", "case_name": RAW if old else TRIMMED},
            }
        )
    run = {"end": "submitted", "script": [{"command": "m1-f0"}], "trace": [{"screen": "form", "xmlns": "urn:form"}]}
    applied = {"submitted": True, "blocks": blocks, "blockPaths": [["member"], ["member"]]}
    return data, installed, run, applied


TRACE_ROW = Difference(
    "proof3",
    "app",
    "trace@B",
    names.TRACE,
    "/runs/0/trace/0/submission/data/member[1]/case[1]/create[1]/case_name[1]/text()",
    "changed",
    RAW,
    TRIMMED,
)
BLOCK_ROW = Difference(
    "proof3",
    "app",
    "case_blocks@B",
    names.BLOCK,
    "/runs/0/blocks/first/member~1case/0/create/case_name",
    "changed",
    RAW,
    TRIMMED,
)


def judged(*, mutate=None, rows=(TRACE_ROW, BLOCK_ROW)):
    states = {side: state(old=side == "baseline") for side in ("baseline", "b")}
    if mutate:
        mutate(*states["b"])
    stored, sessions, builds = {}, {}, {}
    for side, (data, installed, run, applied) in states.items():
        run["trace"][0]["submission"] = etree.tostring(data)
        stored[side + "-trace"] = {"runs": [run]}
        stored[side + "-blocks"] = {"runs": [applied]}
        sessions[side] = {"trace": side + "-trace", "processed": side + "-blocks"}
        builds[side] = {
            "modules-1/forms-0.xml": etree.tostring(installed),
            "suite.xml": '<suite><entry><form>urn:form</form><command id="m1-f0"/></entry></suite>',
        }
    records = SimpleNamespace(
        configurations={"m": SimpleNamespace(b_aligned={"sessions": sessions})},
        blobs=SimpleNamespace(get_json=stored.__getitem__),
    )
    observed = SimpleNamespace(
        a=SimpleNamespace(build=SimpleNamespace(files=builds["baseline"])), b_aligned=SimpleNamespace(files=builds["b"])
    )
    return names.classify(
        rows,
        records=records,
        configuration="m",
        observed=observed,
        local_files=None,
        source={"modules": [{}, {"forms": [SOURCE_FORM]}]},
    )


def test_same_named_repeats_require_the_same_form_writer_and_case():
    rows, sites = judged()
    assert all(d.path.endswith(":trimmed") for d in rows)
    assert list(sites.served.values()) == [FIELD, FIELD]

    def change_writer(_, installed, *unused):
        bind = next(b for b in installed.iter(XF + "bind") if b.get("nodeset") == "/data/member/nova_trimmed_full")
        bind.set("calculate", bind.get("calculate").replace(SOURCE, "/data/member/other"))

    def another_write(_, installed, *unused):
        etree.SubElement(
            installed.find(XF + "model"), XF + "setvalue", ref="/data/member/nova_trimmed_full", value="'Ada   Doe'"
        )

    def wrong_form(_data, _installed, run, _blocks):
        run["script"] = [{"command": "m2-f0"}]

    def swap(data, _installed, _run, applied):
        for case, block, new_id in zip(data.iter(CASE + "case"), applied["blocks"], ("second", "first"), strict=True):
            case.set("case_id", new_id)
            block["@case_id"] = new_id

    def foreign_name(data, *unused):
        create = next(data.iter(CASE + "create"))
        create.insert(0, etree.Element("{urn:foreign}case_name"))

    def foreign_repeat(data, *unused):
        data.insert(0, etree.Element("{urn:foreign}member"))

    for mutation in (change_writer, another_write, wrong_form, swap, foreign_name, foreign_repeat):
        rows, sites = judged(mutate=mutation)
        assert rows == [TRACE_ROW, BLOCK_ROW] and not sites.served, mutation.__name__

    def wrong_block_path(_data, _installed, _run, applied):
        applied["blockPaths"][0] = ["other"]

    rows, sites = judged(mutate=wrong_block_path)
    assert rows == [replace(TRACE_ROW, path=names.TRACE + ":trimmed"), BLOCK_ROW]
    assert (BLOCK_ROW.artifact, BLOCK_ROW.at) not in sites.served


def test_repeat_name_never_holds_an_authored_interior_change_or_another_field():
    original = [
        replace(TRACE_ROW, after="Ada Doe"),
        replace(BLOCK_ROW, at=BLOCK_ROW.at.replace("/create/", "/update/")),
    ]
    rows, sites = judged(rows=original)
    assert rows == original and not sites.served
