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
from proof.observe.sessions import admitted

CASE = "http://commcarehq.org/case/transaction/v2"
VELLUM = "http://commcarehq.org/xforms/vellum"
CONFIGURATION = Configuration(privileges={"CLOUDCARE", "VELLUM_SAVE_TO_CASE"})
TYPE = "if(/data/selection = 'house', 'household', if(/data/selection = 'reserved', 'commcare-user', 'visit'))"


def _source(xmlns):
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}"
      xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="{VELLUM}" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <h:head><h:title>Choose a type</h:title><model>
        <instance><data xmlns="{xmlns}" uiVersion="1" version="1" name="Choose a type">
          <selection/><make_case vellum:role="SaveToCase" vellum:case_type="visit">
            <case xmlns="{CASE}" case_id="" date_modified="" user_id="">
              <create><case_type/><case_name/><owner_id/></create>
            </case>
          </make_case>
        </data></instance>
        <bind nodeset="/data/selection" type="xsd:string"/>
        <bind nodeset="/data/make_case/case/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>
        <bind nodeset="/data/make_case/case/@user_id" calculate="/data/meta/userID"/>
        <bind nodeset="/data/make_case/case/create/case_type" calculate="{TYPE}"/>
        <bind nodeset="/data/make_case/case/create/case_name" calculate="'Case from calculation'"/>
        <bind nodeset="/data/make_case/case/create/owner_id" calculate="/data/meta/userID"/>
        <setvalue event="xforms-ready" ref="/data/make_case/case/@case_id" value="uuid()"/>
        <itext><translation lang="en" default=""><text id="selection-label"><value>Selection</value></text></translation></itext>
      </model></h:head>
      <h:body><input ref="/data/selection"><label ref="jr:itext('selection-label')"/></input></h:body>
    </h:html>"""


def test_computed_create_case_type_survives_editing_and_reaches_both_case_stores(
    hq, core_runner, editor_driver, tmp_path
):
    with hq_check(CONFIGURATION) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        form = operations.held_app(state, app_id).modules[0].forms[0]
        _patched(state, app_id, form.unique_id, _source(form.xmlns), "case type calculation")

        saved = vellum.fresh_open_and_save(editor_driver, state, app_id, form.unique_id)
        assert saved.loaded and saved.saved and saved.stored_source, (saved.load_error, saved.save_refusal)
        source = etree.fromstring(saved.stored_source.encode())
        block, = source.xpath("//*[local-name()='make_case']")
        assert block.get(f"{{{VELLUM}}}case_type") == ""
        bind, = source.xpath("//*[local-name()='bind' and @nodeset='/data/make_case/case/create/case_type']")
        assert bind.get("calculate") == TYPE

        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        archive = arrange(built.files, tmp_path)
        with admitted(core_runner, archive) as admission:
            assert admission["admitted"], admission["problems"]
            for answer, expected in (("house", "household"), ("visit", "visit"), ("reserved", "commcare-user")):
                table = load_answer_table()
                table["novaKinds"]["type-selection"] = [answer]
                trace = core_runner.session(
                    admission["app"],
                    restore=TEMPLATE_RESTORE.read_bytes(),
                    answer_table=table,
                    question_kinds={"/data/selection": "type-selection"},
                )
                step, = (
                    step for run in trace["runs"]
                    if (step := form_step(run)) and step.get("xmlns") == form.xmlns and run["end"] == "submitted"
                )
                submission = step["submission"].encode()
                case, = etree.fromstring(submission).iter(f"{{{CASE}}}case")
                case_id = case.get("case_id")
                assert case.findtext(f"{{{CASE}}}create/{{{CASE}}}case_type") == expected
                device, = etree.fromstring(step["caseDb"].encode()).xpath(f"/*/case[@case_id='{case_id}']")
                assert device.get("case_type") == expected
                result = operations.process_case_blocks(state, submission)
                assert result.refusal is None
                assert result.touched[case_id].case.type == expected
