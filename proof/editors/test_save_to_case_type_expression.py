"""HQ's Form Designer, Core and HQ processing observe the same calculated create."""

from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE, XFORMS
from proof.core.client import load_answer_table
from proof.core.test_session import form_step
from proof.editors import compare, vellum
from proof.editors.conftest import TWO_LANGUAGE_APP, publish_hq_app
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.observe.build import arrange
from proof.observe.hqside import _patched
from proof.observe.sessions import admitted, unmarked_submission

CASE = "http://commcarehq.org/case/transaction/v2"
VELLUM = "http://commcarehq.org/xforms/vellum"
CONFIGURATION = Configuration(privileges={"CLOUDCARE", "VELLUM_SAVE_TO_CASE"})
TYPE = "if(/data/selection = 'house', 'household', if(/data/selection = 'reserved', 'commcare-user', 'visit'))"


def _source(xmlns, type_calculation, *, guard=False):
    type_guard = f"""<scalar_guard vellum:role="SaveToCase" vellum:case_type="">
            <case xmlns="{CASE}" case_id="" date_modified="" user_id="">
              <update><case_type/></update>
            </case>
          </scalar_guard>""" if guard else ""
    guard_binds = """
        <bind nodeset="/data/scalar_guard/case/@case_id" calculate="current()/../../../make_case/case/@case_id"/>
        <bind nodeset="/data/scalar_guard/case/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>
        <bind nodeset="/data/scalar_guard/case/@user_id" calculate="/data/meta/userID"/>
        <bind nodeset="/data/scalar_guard/case/update/case_type" calculate="current()/../../../../make_case/case/create/case_type"/>
    """ if guard else ""
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}"
      xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="{VELLUM}" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <h:head><h:title>Choose a type</h:title><model>
        <instance><data xmlns="{xmlns}" uiVersion="1" version="1" name="Choose a type">
          <selection/><make_case vellum:role="SaveToCase" vellum:case_type="visit">
            <case xmlns="{CASE}" case_id="" date_modified="" user_id="">
              <create><case_type/><case_name/><owner_id/></create>
            </case>
          </make_case>{type_guard}
        </data></instance>
        <bind nodeset="/data/selection" type="xsd:string"/>
        <bind nodeset="/data/make_case/case/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>
        <bind nodeset="/data/make_case/case/@user_id" calculate="/data/meta/userID"/>
        <bind nodeset="/data/make_case/case/create/case_type" calculate="{type_calculation}"/>
        <bind nodeset="/data/make_case/case/create/case_name" calculate="'Case from calculation'"/>
        <bind nodeset="/data/make_case/case/create/owner_id" calculate="/data/meta/userID"/>
        {guard_binds}<setvalue event="xforms-ready" ref="/data/make_case/case/@case_id" value="uuid()"/>
        <itext><translation lang="en" default=""><text id="selection-label"><value>Selection</value></text></translation></itext>
      </model></h:head>
      <h:body><input ref="/data/selection"><label ref="jr:itext('selection-label')"/></input></h:body>
    </h:html>"""


def _saved_form(state, app_id, editor_driver, form, calculation, *, expected_metadata, guard=False):
    _patched(
        state, app_id, form.unique_id, _source(form.xmlns, calculation, guard=guard), "case type calculation",
    )
    saved = vellum.fresh_open_and_save(editor_driver, state, app_id, form.unique_id)
    assert saved.loaded and saved.saved and saved.stored_source, (saved.load_error, saved.save_refusal)
    source = etree.fromstring(saved.stored_source.encode())
    block, = source.xpath("//*[local-name()='make_case']")
    assert block.get(f"{{{VELLUM}}}case_type") == expected_metadata
    bind, = source.xpath("//*[local-name()='bind' and @nodeset='/data/make_case/case/create/case_type']")
    assert bind.get("calculate") == calculation
    if guard:
        scalar_guard, = source.xpath("//*[local-name()='scalar_guard']")
        assert scalar_guard.get(f"{{{VELLUM}}}case_type") == ""
        guard_bind, = source.xpath(
            "//*[local-name()='bind' and @nodeset='/data/scalar_guard/case/update/case_type']"
        )
        assert guard_bind.get("calculate") == "current()/../../../../make_case/case/create/case_type"
    return source


def _built_archive(state, app_id, record, directory):
    built = compare.build(state, app_id, record)
    assert not built.errors, built.errors
    return arrange(built.files, directory)


def _observe(state, core_runner, app, form, answer, *, guard=False):
    table = load_answer_table()
    table["novaKinds"]["type-selection"] = [answer]
    trace = core_runner.session(
        app,
        restore=TEMPLATE_RESTORE.read_bytes(),
        answer_table=table,
        question_kinds={"/data/selection": "type-selection"},
    )
    (run, step), = (
        (run, step) for run in trace["runs"]
        if (step := form_step(run)) and step.get("xmlns") == form.xmlns and run["end"] == "submitted"
    )
    case, *following = etree.fromstring(step["submission"].encode()).iter(f"{{{CASE}}}case")
    if guard:
        update, = following
        assert update.get("case_id") == case.get("case_id")
        assert update.findtext(f"{{{CASE}}}update/{{{CASE}}}case_type") == case.findtext(
            f"{{{CASE}}}create/{{{CASE}}}case_type"
        )
    else:
        assert not following
    case_id = case.attrib["case_id"]
    device, = etree.fromstring(step["caseDb"].encode()).xpath(f"/*/case[@case_id='{case_id}']")
    submission, generated = unmarked_submission(run)
    result = operations.process_case_blocks(state, submission)
    assert result.refusal is None
    server = result.touched[generated.get(case_id, case_id)].case
    return (
        case.findtext(f"{{{CASE}}}create/{{{CASE}}}case_type"),
        device.get("case_type"),
        server.type,
        server.name,
        server.owner_id,
        server.closed,
        server.case_json,
    )


def test_computed_create_case_type_survives_editing_and_reaches_both_case_stores(
    hq, core_runner, editor_driver, tmp_path
):
    with hq_check(CONFIGURATION) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        form = operations.held_app(state, app_id).modules[0].forms[0]
        _saved_form(state, app_id, editor_driver, form, TYPE, expected_metadata="")

        archive = _built_archive(state, app_id, record, tmp_path)
        with admitted(core_runner, archive) as admission:
            assert admission["admitted"], admission["problems"]
            for answer, expected in (("house", "household"), ("visit", "visit"), ("reserved", "commcare-user")):
                observed = _observe(state, core_runner, admission["app"], form, answer)
                assert observed[:3] == (expected,) * 3


def test_literal_concat_and_literal_write_the_same_case_but_report_different_type_metadata(
    hq, core_runner, editor_driver, tmp_path
):
    with hq_check(CONFIGURATION) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        form = operations.held_app(state, app_id).modules[0].forms[0]
        written = []
        catalog_keys = []
        for label, calculation, metadata in (
            ("calculated", "concat('house', 'hold')", ""),
            ("literal", "'household'", "household"),
        ):
            _saved_form(state, app_id, editor_driver, form, calculation, expected_metadata=metadata)
            held = operations.held_app(state, app_id).get_form(form.unique_id)
            catalog_keys.append(set(held.get_save_to_case_updates()))
            archive = _built_archive(state, app_id, record, tmp_path / label)
            with admitted(core_runner, archive) as admission:
                assert admission["admitted"], admission["problems"]
                written.append(_observe(state, core_runner, admission["app"], form, "visit"))

    assert written[0] == written[1]
    assert written[0][:3] == ("household",) * 3
    assert catalog_keys == [{""}, {"household"}]


def test_a_following_guard_keeps_the_resolved_create_type_on_device_and_hq(
    hq, core_runner, editor_driver, tmp_path
):
    with hq_check(CONFIGURATION) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        form = operations.held_app(state, app_id).modules[0].forms[0]
        _saved_form(
            state, app_id, editor_driver, form,
            "if(/data/selection = 'house', 'household', 'visit')",
            expected_metadata="", guard=True,
        )
        held = operations.held_app(state, app_id).get_form(form.unique_id)
        assert set(held.get_save_to_case_updates()) == {""}
        archive = _built_archive(state, app_id, record, tmp_path)
        with admitted(core_runner, archive) as admission:
            assert admission["admitted"], admission["problems"]
            for answer, expected in (("house", "household"), ("visit", "visit")):
                observed = _observe(state, core_runner, admission["app"], form, answer, guard=True)
                assert observed[:3] == (expected,) * 3


def test_bare_create_name_and_guard_match_the_native_case_writes(
    hq, core_runner, editor_driver, tmp_path,
):
    """Observe the text on the wire and in both native case stores."""
    with hq_check(CONFIGURATION) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        form = operations.held_app(state, app_id).modules[0].forms[0]
        source = _source(form.xmlns, "'visit'", guard=True)
        source = source.replace(
            'calculate="\'Case from calculation\'"', 'calculate="/data/selection"',
        ).replace(
            'calculate="current()/../../../make_case/case/@case_id"',
            'calculate="if(string-length(current()/../../../make_case/case/create/case_name) &gt; 0 '
            'and string-length(current()/../../../make_case/case/create/case_name) &lt;= 255, '
            "current()/../../../make_case/case/@case_id, '')\"",
        )
        _patched(state, app_id, form.unique_id, source, "bare create name")
        saved = vellum.fresh_open_and_save(editor_driver, state, app_id, form.unique_id)
        assert saved.loaded and saved.saved and saved.stored_source, (saved.load_error, saved.save_refusal)
        opened = etree.fromstring(saved.stored_source.encode())
        name, = opened.xpath("//*[local-name()='bind' and @nodeset='/data/make_case/case/create/case_name']")
        assert name.get("calculate") == "/data/selection"
        with admitted(core_runner, _built_archive(state, app_id, record, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            outcomes = {}
            for answer in ("North", "  East  ", "\u00a0West\u00a0", " " + "N" * 254 + " "):
                table = load_answer_table()
                table["novaKinds"]["bare-case-name"] = [answer]
                trace = core_runner.session(
                    admission["app"],
                    restore=TEMPLATE_RESTORE.read_bytes(),
                    answer_table=table,
                    question_kinds={"/data/selection": "bare-case-name"},
                )
                (run, step), = (
                    (run, step) for run in trace["runs"]
                    if (step := form_step(run)) and step.get("xmlns") == form.xmlns
                )
                if run["end"] != "submitted":
                    outcomes[answer] = {"end": run["end"]}
                    continue
                source = etree.fromstring(step["submission"].encode())
                create = next(node for node in source.iter(f"{{{CASE}}}case") if node.find(f"{{{CASE}}}create") is not None)
                case_id = create.get("case_id")
                device, = etree.fromstring(step["caseDb"].encode()).xpath(f"/*/case[@case_id='{case_id}']")
                submission, generated = unmarked_submission(run)
                result = operations.process_case_blocks(state, submission)
                outcomes[answer] = {
                    "wire": create.findtext(f"{{{CASE}}}create/{{{CASE}}}case_name"),
                    "device": device.findtext("{*}case_name"),
                    "refusal": str(result.refusal) if result.refusal else None,
                    "server": result.touched.get(generated.get(case_id, case_id)).case.name if result.refusal is None else None,
                }
            assert outcomes == {
                "North": {"wire": "North", "device": "North", "refusal": None, "server": "North"},
                "  East  ": {"wire": "  East  ", "device": "East", "refusal": None, "server": "  East  "},
                "\u00a0West\u00a0": {"wire": "\u00a0West\u00a0", "device": "\u00a0West\u00a0", "refusal": None, "server": "\u00a0West\u00a0"},
                " " + "N" * 254 + " ": {"end": "submission-refused"},
            }, outcomes
