"""HQ's advanced Case Management editor and both case stores preserve a hyphenated index."""

from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE
from proof.core.client import load_answer_table
from proof.core.test_session import form_step, person_cases
from proof.editors import compare, pages
from proof.editors.conftest import ADVANCED_APP, publish_hq_app
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.test_case_processing import _case, _create, _submission
from proof.observe.build import arrange
from proof.observe.sessions import admitted, unmarked_submission

CASE = "http://commcarehq.org/case/transaction/v2"
PARENT = "chosen-clinic"
REFERENCE = "my-parent"
CHILD_NAME = "One requisition"


def _restore():
    root = etree.fromstring(person_cases(TEMPLATE_RESTORE.read_bytes(), [PARENT]))
    case = root.find(f"{{{CASE}}}case[@case_id='{PARENT}']")
    case.find(f"{{{CASE}}}create/{{{CASE}}}case_type").text = "clinic"
    return etree.tostring(root)


def test_advanced_case_management_keeps_a_hyphenated_index(editor_driver, hq, core_runner, tmp_path):
    with hq_check(Configuration(privileges={"CHILD_CASES"})) as (state, record):
        app_id = publish_hq_app(state, ADVANCED_APP)
        app = operations.held_app(state, app_id)
        form = app.modules[1].forms[1]
        form.actions.open_cases[0].case_indices[0].reference_id = REFERENCE
        app.save()

        # Each call opens a fresh browser view and posts the native editor's model.
        for _ in range(2):
            saved = pages.fresh_section_save(
                editor_driver, state, pages.ADVANCED_CASE_MANAGEMENT, app_id, form.unique_id,
            )
            assert saved.save is not None and not saved.refused, (saved.unsent, saved.alerts, saved.response)
            current = operations.held_app(state, app_id).get_form(form.unique_id)
            index, = current.actions.open_cases[0].case_indices
            assert (index.tag, index.reference_id, index.relationship) == ("load_clinic0", REFERENCE, "child")

        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        emitted = etree.fromstring(built.files["modules-1/forms-1.xml"])
        link, = emitted.xpath("//*[local-name()='index']/*[local-name()='my-parent']")
        assert link.get("case_type") == "clinic"
        bind, = emitted.xpath("//*[local-name()='bind'][contains(@nodeset, '/index/my-parent')]")
        assert bind.get("calculate").endswith("/case_id_load_clinic0")
        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            table = load_answer_table()
            table["novaKinds"]["requisition-name"] = [CHILD_NAME]
            trace = core_runner.session(
                admission["app"], restore=_restore(), answer_table=table,
                question_kinds={"/data/req_name": "requisition-name"},
            )

        run, = (
            run for run in trace["runs"]
            if (step := form_step(run)) and step.get("xmlns") == form.xmlns
        )
        assert run["end"] == "submitted", run.get("refusal")
        submission, tokens = unmarked_submission(run)
        payload = etree.fromstring(submission)
        transaction, = [block for block in payload.iter(f"{{{CASE}}}case") if block.find(f"{{{CASE}}}create") is not None]
        case_id = transaction.get("case_id")
        assert case_id and case_id != PARENT
        index, = transaction.find(f"{{{CASE}}}index")
        assert (etree.QName(index).localname, index.get("case_type"), index.text) == (REFERENCE, "clinic", PARENT)
        snapshot = etree.fromstring(form_step(run)["caseDb"].encode())
        local_case_id = next((token for token, value in tokens.items() if value == case_id), case_id)
        created = snapshot.find(f"case[@case_id='{local_case_id}']")
        assert (created.get("case_type"), created.findtext("case_name")) == ("requisition", CHILD_NAME)
        retained, = created.find("index")
        assert (retained.tag, retained.get("case_type"), retained.text) == (REFERENCE, "clinic", PARENT)

        seeded = operations.process_case_blocks(state, _submission(_case(PARENT, _create("clinic", "Chosen clinic"))))
        assert seeded.refusal is None
        read = operations.process_case_blocks(state, submission, cases=[seeded.touched[PARENT].case])
        assert read.refusal is None
        child = read.touched[case_id].case
        assert (child.type, child.name) == ("requisition", CHILD_NAME)
        link, = child.indices
        assert (link.identifier, link.referenced_id, link.referenced_type) == (REFERENCE, PARENT, "clinic")
